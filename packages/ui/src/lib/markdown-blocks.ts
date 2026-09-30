/**
 * Cuts a streaming answer into top-level markdown blocks, so the finished ones are parsed once and
 * only the block still growing is parsed again on every frame.
 *
 * A cut is only taken where @tanstack/markdown's own block parser starts a new top-level block right
 * after a blank line, so the pieces parse exactly as the whole does. The scan below mirrors how far
 * each block of that parser reaches (`dist/parser.js` in the pinned 0.0.15); the equivalence tests in
 * test/markdown-blocks.test.ts compare both renderings and catch a parser upgrade that moves these
 * rules. Only complete lines are scanned: whether a block ends at a line can depend on the whole of
 * that line (`-` opens a list item, `-x` does not).
 */

export interface BlockSplit {
  /** Normalised text the offsets point into. */
  text: string;
  /** Where each block starts; the first is always 0 and the last is the block still growing. */
  starts: number[];
  /** The text as it was given, which the next call compares with to tell it only grew. */
  input?: string;
  /** Nothing in it may be cut: see `WHOLE_DOCUMENT`. */
  whole?: boolean;
}

/**
 * Link reference and footnote definitions are pulled out of the whole document before blocks are
 * parsed, and a leading `---` line may open frontmatter: either makes one block depend on text far
 * away from it, so such an answer is not cut at all.
 */
const WHOLE_DOCUMENT = /^ {0,3}\[[^\]\n]+\]:/m;

/** The parser's own input normalisation, so offsets match what it reads. */
export function normalizeMarkdown(value: string): string {
  return value.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * The split of `text`, reusing `previous` when `text` extends it: the blocks already cut stay cut
 * (a cut depends only on the text before it and on the complete line after it), so only the text
 * from the last cut on is scanned again. Streaming calls this on every frame with a longer answer,
 * so an answer that only grew is normalised and checked from where it grew, not from its start.
 */
export function splitMarkdownBlocks(previous: BlockSplit | null, input: string): BlockSplit {
  const held = previous?.input;
  // A byte-order mark only counts at the very start, and a `\r` at the old end may pair with a `\n`
  // that just arrived: in either case the whole text is normalised again
  const grew = previous !== null && held !== undefined && held.length > 0 && !held.endsWith('\r') && input.startsWith(held);
  const text = grew ? previous.text + input.slice(held.length).replace(/\r\n?/g, '\n') : normalizeMarkdown(input);
  // A definition opens a line, so only the line the old text ended in and the new ones are checked
  const recheck = grew ? text.slice(previous.text.lastIndexOf('\n') + 1) : text;
  const whole = (grew && previous.whole === true) || text.startsWith('---\n') || WHOLE_DOCUMENT.test(recheck);
  if (whole) return { text, starts: [0], input, whole };
  const reuse = grew || (previous !== null && text.startsWith(previous.text));
  const starts = reuse && previous ? previous.starts.slice() : [0];
  const from = starts[starts.length - 1] ?? 0;
  const lines = text.slice(from).split('\n');
  // The last piece is a line still being written (or empty after a trailing newline)
  lines.pop();
  let offset = from;
  const lineStarts = lines.map((line) => {
    const start = offset;
    offset += line.length + 1;
    return start;
  });
  for (const index of blockStartsAfterBlank(lines)) {
    const start = lineStarts[index];
    if (start !== undefined) starts.push(start);
  }
  return { text, starts, input };
}

/** Lines, after the first, that open a top-level block right after a blank line. */
function blockStartsAfterBlank(lines: string[]): number[] {
  const starts: number[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (isBlank(line)) {
      index++;
      continue;
    }
    if (index > 0 && isBlank(lines[index - 1] ?? '')) starts.push(index);
    index = blockEnd(lines, index);
  }
  return starts;
}

/** Index of the first line after the top-level block that opens at `start`. */
function blockEnd(lines: string[], start: number): number {
  const line = lines[start] ?? '';
  // Letter-led text cannot open a fence, heading, rule, quote or list (the parser's own shortcut)
  if (!/^[a-z]/i.test(line)) {
    const fence = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/)?.[2];
    if (fence !== undefined) {
      for (let index = start + 1; index < lines.length; index++) {
        const current = lines[index] ?? '';
        if (current.includes(fence) && /^ {0,3}(?:`+|~+)\s*$/.test(current)) return index + 1;
      }
      return lines.length;
    }
    if (/^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.test(line) || /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return start + 1;
    if (/^ {0,3}>/.test(line)) {
      let index = start;
      // A quote runs on across blank lines while quoted lines follow them
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (!/^ {0,3}>/.test(current) && !isBlank(current)) break;
        index++;
      }
      return index;
    }
    const marker = listMarker(line);
    if (marker) return listEnd(lines, start, marker);
  }
  const next = lines[start + 1];
  if (next !== undefined && looksLikeTableHeader(line, next)) {
    let index = start + 2;
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (isBlank(current) || isBlockStart(current, lines[index + 1])) break;
      index++;
    }
    return index;
  }
  let index = start + 1;
  while (index < lines.length) {
    const current = lines[index] ?? '';
    if (isBlank(current) || isBlockStart(current, lines[index + 1])) break;
    index++;
  }
  return index;
}

function listEnd(lines: string[], start: number, first: ListMarker): number {
  let index = start;
  while (index < lines.length) {
    const marker = listMarker(lines[index] ?? '');
    if (!marker || marker.marker !== first.marker || marker.indent !== first.indent) break;
    index++;
    while (index < lines.length) {
      const line = lines[index] ?? '';
      const nextMarker = listMarker(line);
      if (nextMarker && nextMarker.indent === first.indent) break;
      if (isBlank(line)) {
        // Across blank lines the item goes on if the next text is indented into it, and the list
        // goes on if that text is another item of it
        let nextIndex = index;
        while (nextIndex < lines.length && isBlank(lines[nextIndex] ?? '')) nextIndex++;
        const following = lines[nextIndex];
        if (following === undefined) break;
        const followingMarker = listMarker(following);
        if (followingMarker?.indent === first.indent) {
          if (followingMarker.marker === first.marker) index = nextIndex;
          break;
        }
        if (leadingSpaces(following) < marker.contentIndent) break;
        index = nextIndex;
        continue;
      }
      if (leadingSpaces(line) >= marker.contentIndent) {
        index++;
        continue;
      }
      if (isBlockStart(line, lines[index + 1])) break;
      index++;
    }
  }
  return index;
}

interface ListMarker {
  ordered: boolean;
  number: number;
  indent: number;
  marker: string;
  contentIndent: number;
}

function listMarker(line: string): ListMarker | undefined {
  const match = line.match(/^(\s{0,8})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/);
  const indent = match?.[1];
  const marker = match?.[2];
  if (indent === undefined || marker === undefined) return undefined;
  const ordered = /\d/.test(marker[0] ?? '');
  return {
    ordered,
    number: ordered ? Number.parseInt(marker, 10) : 0,
    indent: indent.length,
    marker: ordered ? marker.slice(-1) : marker,
    contentIndent: indent.length + marker.length + (match?.[3]?.length ?? 1),
  };
}

function isBlank(line: string): boolean {
  return /^\s*$/.test(line);
}

function leadingSpaces(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function isBlockStart(line: string, next: string | undefined): boolean {
  const marker = listMarker(line);
  return (
    /^ {0,3}(?:`{3,}|~{3,}|#{1,6}(?:\s|$)|([-*_])(?:\s*\1){2,}\s*$|>)/.test(line) ||
    (marker !== undefined && (!marker.ordered || marker.number === 1)) ||
    (!!next && looksLikeTableHeader(line, next))
  );
}

function looksLikeTableHeader(header: string, delimiter: string): boolean {
  if (!header.includes('|')) return false;
  const cells = splitTableRow(delimiter);
  return cells.length === splitTableRow(header).length && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function splitTableRow(value: string): string[] {
  const row = value.trim();
  const cells: string[] = [];
  let current = '';
  for (let index = row.startsWith('|') ? 1 : 0; index < row.length; index++) {
    const char = row[index];
    if (char === '\\' && row[index + 1] === '|') {
      current += '|';
      index++;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current || !row.endsWith('|') || !cells.length) cells.push(current.trim());
  return cells;
}
