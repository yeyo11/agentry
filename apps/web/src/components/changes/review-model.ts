// The review screen's decisions that do not need React: which files a scope lists, how the map
// groups them, which one the agent is editing now, and what the transcript says about each.
import type { ChangedFile, ChangeSummary, DecisionPointId, DecisionRecord, EditStep } from '@agentry/shared';

/** What part of the branch is reviewed: all the work, one commit, or what is not committed yet */
export type ReviewScope = { kind: 'all' } | { kind: 'commit'; sha: string } | { kind: 'uncommitted' };

export function scopeOf(param: string | null): ReviewScope {
  if (param === 'uncommitted') return { kind: 'uncommitted' };
  if (param && /^[0-9a-f]{4,64}$/i.test(param)) return { kind: 'commit', sha: param };
  return { kind: 'all' };
}

export const scopeParam = (scope: ReviewScope): string | null => (scope.kind === 'all' ? null : scope.kind === 'commit' ? scope.sha : 'uncommitted');

/** The query a scope adds to the summary and diff requests */
export const scopeQuery = (scope: ReviewScope): { commit?: string; uncommitted?: boolean } =>
  scope.kind === 'commit' ? { commit: scope.sha } : scope.kind === 'uncommitted' ? { uncommitted: true } : {};

/**
 * Every file "All the work" lists: what differs between the base and the working tree. A server
 * older than `working` sends only the committed files and the uncommitted ones; merged by path,
 * the uncommitted entry wins, since it is the newer state of the file.
 */
export function workingFiles(summary: ChangeSummary): ChangedFile[] {
  if (summary.working) return summary.working;
  const byPath = new Map<string, ChangedFile>();
  for (const f of summary.files) byPath.set(f.path, f);
  for (const f of summary.uncommitted) byPath.set(f.path, f);
  return [...byPath.values()];
}

/**
 * The files of a scope. `scoped` is the summary read for that scope (a commit's own files); the
 * unscoped summary answers the other two.
 */
export function filesOf(scope: ReviewScope, summary: ChangeSummary, scoped: ChangeSummary | null): ChangedFile[] {
  if (scope.kind === 'uncommitted') return summary.uncommitted;
  if (scope.kind === 'commit') return scoped?.files ?? [];
  return workingFiles(summary);
}

export function totalsOf(files: ChangedFile[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { additions, deletions };
}

export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { dir: '', name: path } : { dir: path.slice(0, cut), name: path.slice(cut + 1) };
}

/** A file's status as the map's one letter: B for binary, whatever git says of it */
export function statusLetter(file: Pick<ChangedFile, 'status' | 'binary'>): 'M' | 'A' | 'D' | 'R' | 'B' {
  if (file.binary) return 'B';
  return file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M';
}

/** Paths in the order the map lists them: by directory, then by name, the way a tree reads */
export function byTree(a: string, b: string): number {
  const x = splitPath(a);
  const y = splitPath(b);
  return x.dir === y.dir ? x.name.localeCompare(y.name) : x.dir.localeCompare(y.dir);
}

/**
 * The order to draw now. While the pointer is over the map, the rows it is over must not move: the
 * files keep the order they had, those that went away drop out, and new ones wait at the end.
 */
export function stableOrder(paths: string[], held: readonly string[] | null): string[] {
  const sorted = [...paths].sort(byTree);
  if (!held) return sorted;
  const present = new Set(paths);
  const kept = held.filter((p) => present.has(p));
  const known = new Set(kept);
  return [...kept, ...sorted.filter((p) => !known.has(p))];
}

export interface TreeGroup<T> {
  dir: string;
  files: T[];
}

/** Consecutive files of one directory under one heading */
export function groupByDir<T extends { path: string }>(files: T[]): TreeGroup<T>[] {
  const groups: TreeGroup<T>[] = [];
  for (const file of files) {
    const { dir } = splitPath(file.path);
    const last = groups[groups.length - 1];
    if (last && last.dir === dir) last.files.push(file);
    else groups.push({ dir, files: [file] });
  }
  return groups;
}

export function matchesFilter(path: string, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  return !q || path.toLowerCase().includes(q);
}

function normalise(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out;
}

/**
 * The listed file a running call is on, or null. The activity's target is relative to the chat's
 * directory (and cut at 80 characters, which then matches nothing); the files are relative to the
 * git top level, which the chat's directory may sit below.
 */
export function liveFile(target: string | null | undefined, { cwd, top }: { cwd: string | null; top: string | null }, paths: readonly string[]): string | null {
  const raw = target?.trim();
  if (!raw || raw.endsWith('…')) return null;
  const listed = new Set(paths);
  const candidates: string[] = [];
  const root = top ? normalise(top.split('/')) : null;
  const under = (abs: string[]) => (root && abs.length > root.length && root.every((p, i) => abs[i] === p) ? abs.slice(root.length).join('/') : null);
  if (raw.startsWith('/')) {
    const rel = under(normalise(raw.split('/')));
    if (rel) candidates.push(rel);
  } else {
    if (cwd) {
      const rel = under(normalise([...cwd.split('/'), ...raw.split('/')]));
      if (rel) candidates.push(rel);
    }
    candidates.push(normalise(raw.split('/')).join('/'));
  }
  return candidates.find((c) => listed.has(c)) ?? null;
}

/** The steps that touched a file, oldest first */
export function stepsFor(steps: readonly EditStep[] | null | undefined, path: string): EditStep[] {
  return (steps ?? []).filter((s) => s.path === path);
}

/** The next or previous item of a list, or null at its end */
export function neighbour<T>(list: readonly T[], current: T | null, delta: 1 | -1): T | null {
  if (list.length === 0) return null;
  const at = current === null ? -1 : list.indexOf(current);
  if (at < 0) return delta > 0 ? (list[0] ?? null) : (list[list.length - 1] ?? null);
  return list[at + delta] ?? null;
}

/** A step's time as the why line says it: hours and minutes, in the reader's language */
export function hourMinute(iso: string | null, locale: string): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(ms)) return '';
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(ms);
}

/** Keys the review answers to */
export type ReviewKey = 'j' | 'k' | 'n' | 'p' | 'v' | 'm' | 'o' | '[' | '/';
const REVIEW_KEYS = new Set<string>(['j', 'k', 'n', 'p', 'v', 'm', 'o', '[', '/']);

/**
 * The review key a keydown is, or null: never while typing in a field, with a modifier held, or
 * while a menu, dialog or sheet is open over the page.
 */
export function reviewKey(e: Pick<KeyboardEvent, 'key' | 'target' | 'ctrlKey' | 'metaKey' | 'altKey' | 'defaultPrevented'>): ReviewKey | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (!REVIEW_KEYS.has(e.key)) return null;
  const target = e.target as { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown } | null;
  const tag = target?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return null;
  if (typeof document !== 'undefined' && document.querySelector('[data-escape-layer]')) return null;
  return e.key as ReviewKey;
}

/** A fingerprint segment is never thinner than this, with this much between two */
export const PRINT_SEG_MIN = 4;
export const PRINT_SEG_GAP = 2;

export interface PrintSplit<T> {
  /** The files that get a segment of their own, in the order they came */
  shown: T[];
  /** The files folded into the strip's last segment, in the order they came; empty when all fit */
  rest: T[];
}

/**
 * Which files the fingerprint draws on their own in `room` pixels. Every segment needs its minimum
 * width, so past what fits the smallest files fold into one trailing segment, and the largest
 * keep their place: a strip that grew past its box scrolled the whole panel sideways.
 */
export function printSegments<T extends { additions: number; deletions: number }>(files: readonly T[], room: number): PrintSplit<T> {
  const fit = Math.max(1, Math.floor((room + PRINT_SEG_GAP) / (PRINT_SEG_MIN + PRINT_SEG_GAP)));
  if (files.length <= fit) return { shown: [...files], rest: [] };
  const keep = Math.max(0, fit - 1);
  const byChurn = files
    .map((file, at) => ({ file, at, churn: file.additions + file.deletions }))
    .sort((a, b) => b.churn - a.churn || a.at - b.at)
    .slice(0, keep)
    .map((x) => x.at);
  const kept = new Set(byChurn);
  return { shown: files.filter((_, at) => kept.has(at)), rest: files.filter((_, at) => !kept.has(at)) };
}

/** How much of a patch the engine was shown (core's `HUNK_CHARS`): what it was asked is compared as cut */
const HUNK_CHARS = 3000;

/** The point that judges whether the sentence before an edit explains it */
export const UNEXPLAINED_POINT: DecisionPointId = 'changes.unexplained-hunk';

/**
 * The decision that flagged a step's patch as unexplained, or null. The engine's rows are per chat,
 * not per step, so a row belongs to the step whose sentence and patch it was sent; only a "yes" to
 * "does the sentence fail to explain it" flags, and the newest row of a step stands.
 */
export function unexplainedOf(decisions: readonly DecisionRecord[], step: Pick<EditStep, 'diff' | 'intent'>): DecisionRecord | null {
  if (!step.diff) return null;
  const hunk = step.diff.slice(0, HUNK_CHARS);
  const said = step.intent ?? '';
  let found: DecisionRecord | null = null;
  for (const row of decisions) {
    if (row.point !== UNEXPLAINED_POINT || row.status !== 'answered') continue;
    if (row.state.hunk !== hunk || (row.state.step ?? '') !== said) continue;
    if (!found || row.at > found.at) found = row;
  }
  const answer = found?.answers?.unexplained;
  return found && answer?.kind === 'noul' && answer.value ? found : null;
}
