import type { FileHandle } from 'node:fs/promises';

/** How much of a transcript is read at a time while indexing it */
const CHUNK_BYTES = 1024 * 1024;

/**
 * Lines of a window closer than this are read in one go: fewer reads beat skipping the odd
 * non-entry line (a snapshot, a mode change) between two messages.
 */
const MERGE_GAP_BYTES = 64 * 1024;

/** How many bytes before the indexed end are kept to tell a file that grew from one rewritten */
const FINGERPRINT_BYTES = 64;

const NEWLINE = 0x0a;

export type JsonLine = Record<string, unknown>;

/** A line's JSON, or null for a blank or half-written one. */
export function parseLine(buffer: Buffer, start = 0, end = buffer.length): JsonLine | null {
  if (end <= start) return null;
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8', start, end));
    return value && typeof value === 'object' ? (value as JsonLine) : null;
  } catch {
    return null;
  }
}

/**
 * Walks the complete lines in bytes [from, to) of a file, handing each parsed one to `visit` with
 * the byte range it came from. A line counts as complete once its newline is written; what follows
 * the last newline is returned as `tail`, since a live session may still be writing it.
 */
export async function scanLines(
  handle: FileHandle,
  from: number,
  to: number,
  visit: (line: JsonLine, start: number, end: number) => void,
): Promise<{ end: number; tail: Buffer }> {
  // A line longer than a chunk is kept in pieces and joined once, so a huge line is copied once
  let pieces: Buffer[] = [];
  let pendingStart = from;
  let pos = from;
  while (pos < to) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, to - pos));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, pos);
    if (bytesRead === 0) break; // truncated while being read
    const chunk = buffer.subarray(0, bytesRead);
    let lineStart = 0;
    for (let nl = chunk.indexOf(NEWLINE); nl !== -1; nl = chunk.indexOf(NEWLINE, lineStart)) {
      if (pieces.length > 0) {
        const joined = Buffer.concat([...pieces, chunk.subarray(0, nl)]);
        const line = parseLine(joined);
        if (line) visit(line, pendingStart, pos + nl);
        pieces = [];
      } else {
        const line = parseLine(chunk, lineStart, nl);
        if (line) visit(line, pos + lineStart, pos + nl);
      }
      lineStart = nl + 1;
      pendingStart = pos + lineStart;
    }
    if (lineStart < chunk.length) pieces.push(chunk.subarray(lineStart));
    pos += bytesRead;
  }
  return { end: pendingStart, tail: Buffer.concat(pieces) };
}

/** The JSON of each byte range, in order; null where a range no longer holds a line. */
export async function readLines(handle: FileHandle, ranges: ReadonlyArray<readonly [number, number]>): Promise<(JsonLine | null)[]> {
  const out: (JsonLine | null)[] = [];
  let i = 0;
  while (i < ranges.length) {
    const first = ranges[i];
    if (!first) break;
    // Take the following ranges that are close enough to share one read
    let j = i + 1;
    let spanEnd = first[1];
    for (let next = ranges[j]; next && next[0] >= spanEnd && next[0] - spanEnd <= MERGE_GAP_BYTES; next = ranges[++j]) spanEnd = next[1];
    const buffer = Buffer.allocUnsafe(spanEnd - first[0]);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, first[0]);
    for (; i < j; i++) {
      const range = ranges[i];
      const start = (range?.[0] ?? 0) - first[0];
      const end = (range?.[1] ?? 0) - first[0];
      out.push(end <= bytesRead ? parseLine(buffer, start, end) : null);
    }
  }
  return out;
}

/** The last bytes before `end`: what a file that only grew still has there. */
export async function fingerprint(handle: FileHandle, end: number): Promise<Buffer> {
  const start = Math.max(0, end - FINGERPRINT_BYTES);
  const buffer = Buffer.alloc(end - start);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  return buffer.subarray(0, bytesRead);
}

/**
 * Byte ranges of the lines of a transcript that make entries, in file order, for both views of it:
 * every entry, and the main thread without sidechains. Lines are only ever appended to it, so a
 * reader that took its ranges keeps valid ones while a newer version of the file is indexed.
 */
export class EntryIndex {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  /** Positions in `starts` of the lines that are not sidechains */
  private readonly main: number[] = [];
  /** An entry after the last newline: complete JSON, but its line may not be finished */
  private tail: { start: number; end: number; sidechain: boolean } | null = null;

  add(start: number, end: number, sidechain: boolean): void {
    if (!sidechain) this.main.push(this.starts.length);
    this.starts.push(start);
    this.ends.push(end);
  }

  setTail(tail: { start: number; end: number; sidechain: boolean } | null): void {
    this.tail = tail;
  }

  private hasTail(includeSidechains: boolean): boolean {
    return this.tail !== null && (includeSidechains || !this.tail.sidechain);
  }

  count(includeSidechains: boolean): number {
    return (includeSidechains ? this.starts.length : this.main.length) + (this.hasTail(includeSidechains) ? 1 : 0);
  }

  /** The byte ranges of entries [from, to) of a view. */
  ranges(from: number, to: number, includeSidechains: boolean): [number, number][] {
    const indexed = includeSidechains ? this.starts.length : this.main.length;
    const out: [number, number][] = [];
    for (let i = from; i < to; i++) {
      if (i >= indexed) {
        if (this.tail && this.hasTail(includeSidechains)) out.push([this.tail.start, this.tail.end]);
        break;
      }
      const line = includeSidechains ? i : (this.main[i] ?? 0);
      out.push([this.starts[line] ?? 0, this.ends[line] ?? 0]);
    }
    return out;
  }
}
