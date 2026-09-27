// What the review screen remembers per browser (docs/plans/changes-review.md, decisions 4 and 5):
// the comparator's mode, and which files a person has seen. Neither ever reaches the server, and a
// storage that throws (private mode, a full quota) only means nothing is remembered.
import type { ChangedFile } from '@agentry/shared';

export type ReviewMode = 'reading' | 'unified' | 'split';

export const MODE_KEY = 'agentry-diff-mode';
const SEEN_PREFIX = 'agentry-review-seen:v1:';
/** Sources whose seen files are kept; the oldest are forgotten past this */
const SEEN_SOURCES = 60;
const SEEN_INDEX = 'agentry-review-seen:v1';

/** The part of `localStorage` this uses, so a test can hand it a map */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function store(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(s: KeyValueStore | null, key: string): string | null {
  try {
    return s?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(s: KeyValueStore | null, key: string, value: string | null): void {
  try {
    if (value === null) s?.removeItem(key);
    else s?.setItem(key, value);
  } catch {
    // Remembering is a convenience: a storage that refuses it changes nothing else
  }
}

export const isMode = (value: unknown): value is ReviewMode => value === 'reading' || value === 'unified' || value === 'split';

export function readMode(s: KeyValueStore | null = store()): ReviewMode {
  const held = read(s, MODE_KEY);
  return isMode(held) ? held : 'reading';
}

export function writeMode(mode: ReviewMode, s: KeyValueStore | null = store()): void {
  write(s, MODE_KEY, mode);
}

/**
 * The mode a file is drawn in: what was asked for, unless the room or the file rules it out. Side
 * by side needs 1100 px of diff and a file on both sides; a phone offers Reading and Unified only.
 */
export function effectiveMode(wanted: ReviewMode, { width, phone, status }: { width: number; phone: boolean; status: ChangedFile['status'] | null }): ReviewMode {
  if (wanted !== 'split') return wanted;
  if (phone || width < SPLIT_MIN_WIDTH || status === 'deleted' || status === 'added') return 'unified';
  return 'split';
}

export const SPLIT_MIN_WIDTH = 1100;

/**
 * What a file looked like when it was marked seen. `sig` is what the summary says of it, so the map
 * can tell before its diff is read; `hash` is its diff's, checked once the diff is read.
 */
export interface SeenMark {
  sig: string;
  hash: string | null;
}

export type SeenMap = Record<string, SeenMark>;

export const signatureOf = (file: Pick<ChangedFile, 'status' | 'additions' | 'deletions'>): string => `${file.status}:${file.additions}:${file.deletions}`;

export function readSeen(source: string, s: KeyValueStore | null = store()): SeenMap {
  const raw = read(s, SEEN_PREFIX + source);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: SeenMap = {};
    for (const [path, mark] of Object.entries(parsed as Record<string, unknown>)) {
      if (!mark || typeof mark !== 'object') continue;
      const { sig, hash } = mark as { sig?: unknown; hash?: unknown };
      if (typeof sig === 'string') out[path] = { sig, hash: typeof hash === 'string' ? hash : null };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeSeen(source: string, seen: SeenMap, s: KeyValueStore | null = store()): void {
  const empty = Object.keys(seen).length === 0;
  write(s, SEEN_PREFIX + source, empty ? null : JSON.stringify(seen));
  // A list of the sources, newest last, so a browser that reviews for months does not keep them all
  let index: string[] = [];
  try {
    const parsed: unknown = JSON.parse(read(s, SEEN_INDEX) ?? '[]');
    if (Array.isArray(parsed)) index = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    index = [];
  }
  index = index.filter((x) => x !== source);
  if (!empty) index.push(source);
  while (index.length > SEEN_SOURCES) {
    const old = index.shift();
    if (old) write(s, SEEN_PREFIX + old, null);
  }
  write(s, SEEN_INDEX, JSON.stringify(index));
}

/** Whether a file still reads as seen: same counts, and the same diff when its hash is known on both sides */
export function isSeen(seen: SeenMap, file: Pick<ChangedFile, 'path' | 'status' | 'additions' | 'deletions'>, hash: string | null = null): boolean {
  const mark = seen[file.path];
  if (!mark || mark.sig !== signatureOf(file)) return false;
  return hash === null || mark.hash === null || mark.hash === hash;
}

export function markSeen(seen: SeenMap, file: Pick<ChangedFile, 'path' | 'status' | 'additions' | 'deletions'>, hash: string | null, on: boolean): SeenMap {
  const next = { ...seen };
  if (on) next[file.path] = { sig: signatureOf(file), hash };
  else delete next[file.path];
  return next;
}
