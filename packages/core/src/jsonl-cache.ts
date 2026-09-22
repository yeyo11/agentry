import { open } from 'node:fs/promises';
import { fingerprint, parseLine, scanLines, type JsonLine } from './transcript-index.ts';

/** How a JSONL file is folded into a value, one line at a time. */
export interface JsonlFold<S> {
  init(): S;
  /** A copy the next lines can be folded into while the original is still handed out */
  clone(state: S): S;
  add(state: S, line: JsonLine): void;
  /** Lines without this text are skipped unparsed, for a fold that only cares about a few */
  mentions?: string;
}

interface FileState<S> {
  ino: number;
  size: number;
  mtimeMs: number;
  /** Offset just past the last complete line: everything before it is final */
  end: number;
  /** The bytes just before `end`, which a file that only grew still has */
  fingerprint: Buffer;
  /** Over the complete lines only, so the next pass can go on from `end` */
  complete: S;
  /** What callers get: a half-written last line folded in too, when it already parses */
  view: S;
}

/**
 * Folds of JSONL files the CLI appends to, kept per file so that a file that grew is read from
 * where the last pass stopped instead of from the start: the lists that need them are polled every
 * couple of seconds, and a live transcript runs to tens of megabytes while growing a line at a time.
 * A file that shrank or was replaced is read again whole. Callers asking for one file while it is
 * being read share that read.
 */
export class JsonlCache<S> {
  private readonly settled = new Map<string, FileState<S>>();
  private readonly pending = new Map<string, Promise<FileState<S> | null>>();

  /** `maxFiles` bounds the memory of a fold that keeps whole entries, least recently read going first */
  constructor(
    private readonly fold: JsonlFold<S>,
    private readonly maxFiles = Infinity,
  ) {}

  /** The fold of the file as it is on disk now; null when there is no such file. */
  async read(file: string): Promise<S | null> {
    let next = this.pending.get(file);
    if (!next) {
      const started = this.load(file, this.settled.get(file) ?? null);
      next = started.finally(() => {
        if (this.pending.get(file) === next) this.pending.delete(file);
      });
      this.pending.set(file, next);
    }
    return (await next)?.view ?? null;
  }

  /** Forgets the files `drop` picks, or every file. */
  forget(drop: (file: string) => boolean = () => true): void {
    for (const file of [...this.settled.keys()]) if (drop(file)) this.settled.delete(file);
  }

  private remember(file: string, state: FileState<S>): void {
    this.settled.delete(file);
    this.settled.set(file, state);
    for (const oldest of this.settled.keys()) {
      if (this.settled.size <= this.maxFiles) break;
      this.settled.delete(oldest);
    }
  }

  private async load(file: string, old: FileState<S> | null): Promise<FileState<S> | null> {
    const handle = await open(file, 'r').catch(() => null);
    if (!handle) {
      this.settled.delete(file);
      return null;
    }
    try {
      const info = await handle.stat();
      if (old && old.ino === info.ino && old.size === info.size && old.mtimeMs === info.mtimeMs) {
        this.remember(file, old);
        return old;
      }
      const grew = old !== null && old.ino === info.ino && info.size > old.size && (await fingerprint(handle, old.end)).equals(old.fingerprint);
      const base = grew ? old : null;
      const complete = base ? this.fold.clone(base.complete) : this.fold.init();
      const { end, tail } = await scanLines(handle, base?.end ?? 0, info.size, (line) => this.fold.add(complete, line), this.fold.mentions);
      // A last line without its newline yet counts if it parses, but stays out of what the next
      // pass goes on from: it is read again once it is finished
      const tailLine = this.fold.mentions === undefined || tail.includes(this.fold.mentions) ? parseLine(tail) : null;
      let view = complete;
      if (tailLine) {
        view = this.fold.clone(complete);
        this.fold.add(view, tailLine);
      }
      const state: FileState<S> = { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, end, fingerprint: await fingerprint(handle, end), complete, view };
      this.remember(file, state);
      return state;
    } finally {
      await handle.close();
    }
  }
}
