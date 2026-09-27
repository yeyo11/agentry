// The unified diff the API serves, read in the browser (docs/plans/changes-review.md, decision 2:
// no diff library). Parses one file's `git diff` text into numbered hunks, cuts each hunk into
// change blocks with its removed and added lines paired by similarity, and lays out the rows each
// mode of the comparator draws. Pure: DiffView only renders what comes out of here.
import { similarity } from './word-diff';

export type LineKind = 'ctx' | 'add' | 'del';

export interface DiffLine {
  kind: LineKind;
  text: string;
  /** The line's number in the old file; null for an added line */
  old: number | null;
  /** The line's number in the new file; null for a removed line */
  new: number | null;
  /** Git's "\ No newline at end of file" followed it */
  noNewline?: true;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** What git prints after the second `@@`: the line the hunk's function starts with */
  section: string;
  lines: DiffLine[];
}

/** Unchanged lines the diff leaves out, between two hunks or at either end of the file */
export interface Gap {
  /** Its place: gap `i` sits before hunk `i`, and gap `hunks.length` after the last one */
  index: number;
  size: number;
  /** The function the next hunk is in, from git's hunk header; null when it names none */
  where: string | null;
  oldStart: number;
  newStart: number;
  /** The hidden lines themselves, when the diff carries them (a folded `full` diff) */
  lines: DiffLine[] | null;
}

export type DiffStatus = 'modified' | 'added' | 'deleted' | 'renamed';

export interface ParsedDiff {
  hunks: Hunk[];
  /** `hunks.length + 1` places, null where nothing is left out */
  gaps: (Gap | null)[];
  status: DiffStatus;
  oldPath: string | null;
  newPath: string | null;
  /** Git printed "Binary files … differ": there is no text to compare */
  binary: boolean;
  /** The server cut the diff (`… diff truncated`): what is here is only its start */
  truncated: boolean;
  /** The server did not send the diff at all (`… diff too large to show`) */
  tooLarge: boolean;
  /** The diff carries the whole file (`context=full`), so every gap can open without asking again */
  full: boolean;
  /** Lines of the new file as far as the diff knows: exact for a full diff, the last hunk's end otherwise */
  newLength: number;
}

const TRUNCATED = '… diff truncated';
const TOO_LARGE = '… diff too large to show';
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** One file's `git diff` text, its header dropped and every line numbered on the side it exists on */
export function parseUnified(text: string, full = false): ParsedDiff {
  const out: ParsedDiff = {
    hunks: [],
    gaps: [null],
    status: 'modified',
    oldPath: null,
    newPath: null,
    binary: false,
    truncated: false,
    tooLarge: false,
    full,
    newLength: 0,
  };
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const marker = line.trim();
    if (marker === TRUNCATED) {
      out.truncated = true;
      break;
    }
    if (marker === TOO_LARGE) {
      out.tooLarge = true;
      break;
    }
    const head = HUNK.exec(line);
    if (head) {
      hunk = {
        oldStart: Number(head[1]),
        oldLines: head[2] === undefined ? 1 : Number(head[2]),
        newStart: Number(head[3]),
        newLines: head[4] === undefined ? 1 : Number(head[4]),
        section: (head[5] ?? '').trim(),
        lines: [],
      };
      out.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      continue;
    }
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const sign = line[0];
      const body = line.slice(1);
      if (sign === '+') {
        hunk.lines.push({ kind: 'add', text: body, old: null, new: newNo++ });
        newLeft--;
        continue;
      }
      if (sign === '-') {
        hunk.lines.push({ kind: 'del', text: body, old: oldNo++, new: null });
        oldLeft--;
        continue;
      }
      // Some tools strip the space off an empty context line
      if (sign === ' ' || line === '') {
        hunk.lines.push({ kind: 'ctx', text: body, old: oldNo++, new: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
    }
    if (line.startsWith('\\')) {
      const last = hunk?.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    // A second file's header: this diff draws one file
    if (hunk && line.startsWith('diff --git ')) break;
    if (!hunk) readHeader(line, out);
  }

  out.gaps = gapsOf(out.hunks, null);
  const last = out.hunks[out.hunks.length - 1];
  out.newLength = last ? last.newStart + last.newLines - 1 : 0;
  return out;
}

function readHeader(line: string, out: ParsedDiff) {
  if (line.startsWith('Binary files ') || line === 'GIT binary patch') out.binary = true;
  else if (line.startsWith('new file mode')) out.status = 'added';
  else if (line.startsWith('deleted file mode')) out.status = 'deleted';
  else if (line.startsWith('rename from ')) {
    out.status = 'renamed';
    out.oldPath = line.slice('rename from '.length);
  } else if (line.startsWith('rename to ')) out.newPath = line.slice('rename to '.length);
  else if (line.startsWith('--- ')) {
    const path = line.slice(4);
    if (path === '/dev/null') out.status = 'added';
    else out.oldPath ??= path.replace(/^a\//, '');
  } else if (line.startsWith('+++ ')) {
    const path = line.slice(4);
    if (path === '/dev/null') out.status = 'deleted';
    else out.newPath ??= path.replace(/^b\//, '');
  }
}

/** The last old and new line a hunk covers; a hunk of no old lines sits after its `oldStart` */
const oldEnd = (h: Hunk) => (h.oldLines === 0 ? h.oldStart : h.oldStart + h.oldLines - 1);
const newEnd = (h: Hunk) => (h.newLines === 0 ? h.newStart : h.newStart + h.newLines - 1);

/** The unchanged lines between hunks, and after the last one when the file's length is known */
function gapsOf(hunks: Hunk[], length: { old: number; new: number } | null, hidden?: (DiffLine[] | null)[]): (Gap | null)[] {
  const gaps: (Gap | null)[] = [];
  for (let i = 0; i <= hunks.length; i++) {
    const prev = hunks[i - 1];
    const next = hunks[i];
    const oldStart = prev ? oldEnd(prev) + 1 : 1;
    const newStart = prev ? newEnd(prev) + 1 : 1;
    let size: number;
    if (next) size = (next.oldLines === 0 ? next.oldStart + 1 : next.oldStart) - oldStart;
    else size = length ? length.old - oldStart + 1 : 0;
    gaps.push(size > 0 ? { index: i, size, where: next ? whereOf(next.section) : null, oldStart, newStart, lines: hidden?.[i] ?? null } : null);
  }
  return gaps;
}

/**
 * The name a hunk header's section stands for, as the fold says it ("in `aheadCount()`"): the
 * function or type it declares, or the section itself, clipped, when it declares neither.
 */
export function whereOf(section: string): string | null {
  const s = section.trim();
  if (!s) return null;
  const declared = /\b(?:function\*?|def|fn|func|sub|proc)\s+([A-Za-z_$][\w$]*)/.exec(s);
  if (declared) return `${declared[1]}()`;
  const type = /\b(?:class|interface|type|struct|enum|trait|impl|module|namespace|object)\s+([A-Za-z_$][\w$]*)/.exec(s);
  if (type) return type[1]!;
  const assigned = /([A-Za-z_$][\w$]*)\s*[=:]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/.exec(s);
  if (assigned) return `${assigned[1]}()`;
  const called = /^(?:(?:export|default|public|private|protected|static|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\(/.exec(s);
  if (called) return `${called[1]}()`;
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

// ---------------------------------------------------------------------------------------------
// Blocks: a run of removals, then of additions, with each removed line paired to its new self

/** Lines this alike or less are not the same line edited */
const PAIR_THRESHOLD = 0.45;
/** Past this many comparisons a block is a rewrite, and nothing in it is paired */
const PAIR_BUDGET = 40_000;

export interface Block {
  type: 'block';
  dels: DiffLine[];
  adds: DiffLine[];
  /** For each removed line, the index of the added line it became, or -1 */
  pairs: number[];
  /** The new line the block starts at, or the one its removed lines sat before */
  newLine: number;
  oldLine: number;
}

export type HunkItem = { type: 'ctx'; line: DiffLine } | Block;

/**
 * A hunk as context lines and change blocks. Each removed line is paired with the most similar
 * added line after the last pair, so a line that moved down a row still faces its old self.
 */
export function blocksOf(hunk: Hunk): HunkItem[] {
  const items: HunkItem[] = [];
  let newNo = hunk.newStart;
  let oldNo = hunk.oldStart;
  let open: Block | null = null;
  for (const line of hunk.lines) {
    if (line.kind === 'ctx') {
      open = null;
      items.push({ type: 'ctx', line });
      newNo++;
      oldNo++;
      continue;
    }
    // A removal after additions starts a new block: the block is removals, then additions
    if (!open || (line.kind === 'del' && open.adds.length > 0)) {
      open = { type: 'block', dels: [], adds: [], pairs: [], newLine: newNo, oldLine: oldNo };
      items.push(open);
    }
    if (line.kind === 'del') {
      open.dels.push(line);
      oldNo++;
    } else {
      open.adds.push(line);
      newNo++;
    }
  }
  for (const item of items) if (item.type === 'block') item.pairs = pair(item.dels, item.adds);
  return items;
}

function pair(dels: DiffLine[], adds: DiffLine[]): number[] {
  const pairs = dels.map(() => -1);
  if (dels.length * adds.length > PAIR_BUDGET) return pairs;
  let after = -1;
  dels.forEach((del, d) => {
    let best = -1;
    let score = PAIR_THRESHOLD;
    for (let a = after + 1; a < adds.length; a++) {
      const s = similarity(del.text, adds[a]!.text);
      if (s > score) {
        score = s;
        best = a;
      }
    }
    if (best >= 0) {
      pairs[d] = best;
      after = best;
    }
  });
  return pairs;
}

// ---------------------------------------------------------------------------------------------
// Rows: what each mode draws

export interface Pill {
  block: number;
  /** Removed lines the pill stands for */
  count: number;
  open: boolean;
}

export interface LineRow {
  type: 'line';
  key: string;
  /** `mod` is an added line that replaced a removed one (Reading only) */
  kind: 'ctx' | 'add' | 'del' | 'mod';
  line: DiffLine;
  /** The line on the other side it was paired with, whose words it is held against */
  pair: DiffLine | null;
  /** The change block it belongs to; null for context */
  block: number | null;
  /** The first row of its block: where `j`/`k` land */
  blockStart: boolean;
  /** Reading: the removed lines of the block, folded, on the rail of its first new line */
  pill: Pill | null;
}

/** Reading: removed lines nothing replaced, folded into a pill on a dashed seam */
export interface SeamRow {
  type: 'seam';
  key: string;
  block: number;
  blockStart: true;
  pill: Pill;
}

export interface GapRow {
  type: 'gap';
  key: string;
  gap: Gap;
}

export interface SplitCell {
  kind: 'ctx' | 'add' | 'del';
  line: DiffLine;
  pair: DiffLine | null;
}

/** Side by side: a line on each side, or padding (null) on the shorter one */
export interface SplitRow {
  type: 'split';
  key: string;
  left: SplitCell | null;
  right: SplitCell | null;
  block: number | null;
  blockStart: boolean;
}

export type DiffRow = LineRow | SeamRow | GapRow;

export interface RowOptions {
  /** Only these hunks (Step by step shows one patch); their gaps are left out */
  hunks?: ReadonlySet<number>;
}

/** Every block of the diff in order, with its global index, and the gaps between hunks */
function* walk(diff: ParsedDiff, options: RowOptions): Generator<{ gap: Gap } | { item: HunkItem; block: number }> {
  let block = 0;
  for (const [h, hunk] of diff.hunks.entries()) {
    const shown = !options.hunks || options.hunks.has(h);
    const gap = diff.gaps[h];
    if (shown && gap && !options.hunks) yield { gap };
    for (const item of blocksOf(hunk)) {
      if (shown) yield { item, block };
      if (item.type === 'block') block++;
    }
  }
  const tail = diff.gaps[diff.hunks.length];
  if (tail && !options.hunks) yield { gap: tail };
}

const lineKey = (line: DiffLine) => (line.new !== null ? `n${line.new}` : `o${line.old}`);
const gapRow = (gap: Gap): GapRow => ({ type: 'gap', key: `g${gap.oldStart}`, gap });
const ctxRow = (line: DiffLine): LineRow => ({ type: 'line', key: lineKey(line), kind: 'ctx', line, pair: null, block: null, blockStart: false, pill: null });

/** What the removed line at `d` became, and what the added line at `a` was */
const pairOfDel = (b: Block, d: number) => b.adds[b.pairs[d] ?? -1] ?? null;
const pairOfAdd = (b: Block, a: number) => {
  const d = b.pairs.indexOf(a);
  return d >= 0 ? b.dels[d]! : null;
};

/**
 * Reading: the file as it is now. Context and new lines; each block's removed lines folded into a
 * pill on its first new line, or on a seam when nothing replaced them, and drawn in place, before
 * the new lines, when the block is in `opened`.
 */
export function readingRows(diff: ParsedDiff, opened: ReadonlySet<number> = new Set(), options: RowOptions = {}): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const step of walk(diff, options)) {
    if ('gap' in step) {
      rows.push(gapRow(step.gap));
      continue;
    }
    const { item, block } = step;
    if (item.type === 'ctx') {
      rows.push(ctxRow(item.line));
      continue;
    }
    const open = opened.has(block);
    const pill = item.dels.length > 0 ? { block, count: item.dels.length, open } : null;
    const own: (LineRow | SeamRow)[] = [];
    if (item.adds.length === 0) own.push({ type: 'seam', key: `s${block}`, block, blockStart: true, pill: pill! });
    if (open) {
      item.dels.forEach((line, d) =>
        own.push({ type: 'line', key: lineKey(line), kind: 'del', line, pair: pairOfDel(item, d), block, blockStart: false, pill: null }),
      );
    }
    item.adds.forEach((line, a) => {
      const was = pairOfAdd(item, a);
      own.push({ type: 'line', key: lineKey(line), kind: was ? 'mod' : 'add', line, pair: was, block, blockStart: false, pill: a === 0 ? pill : null });
    });
    // An opened block starts at its first removed line, a folded one at its pill
    own[0]!.blockStart = true;
    rows.push(...own);
  }
  return rows;
}

/** Unified: old and new interleaved, each block's removed lines before its added ones */
export function unifiedRows(diff: ParsedDiff, options: RowOptions = {}): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const step of walk(diff, options)) {
    if ('gap' in step) {
      rows.push(gapRow(step.gap));
      continue;
    }
    const { item, block } = step;
    if (item.type === 'ctx') {
      rows.push(ctxRow(item.line));
      continue;
    }
    item.dels.forEach((line, d) =>
      rows.push({ type: 'line', key: lineKey(line), kind: 'del', line, pair: pairOfDel(item, d), block, blockStart: d === 0, pill: null }),
    );
    item.adds.forEach((line, a) =>
      rows.push({
        type: 'line',
        key: lineKey(line),
        kind: 'add',
        line,
        pair: pairOfAdd(item, a),
        block,
        blockStart: a === 0 && item.dels.length === 0,
        pill: null,
      }),
    );
  }
  return rows;
}

/**
 * Side by side: paired lines face each other; between two pairs, the unpaired removed and added
 * lines face each other in order, and the shorter side is padded.
 */
export function splitRows(diff: ParsedDiff, options: RowOptions = {}): (SplitRow | GapRow)[] {
  const rows: (SplitRow | GapRow)[] = [];
  for (const step of walk(diff, options)) {
    if ('gap' in step) {
      rows.push(gapRow(step.gap));
      continue;
    }
    const { item, block } = step;
    if (item.type === 'ctx') {
      const cell: SplitCell = { kind: 'ctx', line: item.line, pair: null };
      rows.push({ type: 'split', key: lineKey(item.line), left: cell, right: { ...cell }, block: null, blockStart: false });
      continue;
    }
    let first = true;
    const push = (left: SplitCell | null, right: SplitCell | null) => {
      const line = (left ?? right)!.line;
      rows.push({ type: 'split', key: `${lineKey(line)}${right && left ? lineKey(right.line) : ''}`, left, right, block, blockStart: first });
      first = false;
    };
    const facing = (dels: number[], adds: number[]) => {
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const d = dels[k];
        const a = adds[k];
        push(
          d === undefined ? null : { kind: 'del', line: item.dels[d]!, pair: null },
          a === undefined ? null : { kind: 'add', line: item.adds[a]!, pair: null },
        );
      }
    };
    let d = 0;
    let a = 0;
    item.pairs.forEach((to, from) => {
      if (to < 0) return;
      facing(range(d, from), range(a, to));
      push({ kind: 'del', line: item.dels[from]!, pair: item.adds[to]! }, { kind: 'add', line: item.adds[to]!, pair: item.dels[from]! });
      d = from + 1;
      a = to + 1;
    });
    facing(range(d, item.dels.length), range(a, item.adds.length));
  }
  return rows;
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);

// ---------------------------------------------------------------------------------------------
// A whole file, folded

/** Unchanged runs longer than this fold away in a full diff */
const FOLD_OVER = 8;
/** Context kept around each change when a run folds */
const KEEP = 3;

/**
 * A `full` diff (one hunk, the whole file) cut back into hunks with 3 lines of context each side,
 * like git's default, except that each gap keeps its hidden lines: "Show" opens it without asking
 * the server again. Runs of more than 8 unchanged lines fold.
 */
export function foldFull(diff: ParsedDiff): ParsedDiff {
  if (!diff.full || diff.hunks.length !== 1) return diff;
  const all = diff.hunks[0]!.lines;
  const lastOld = [...all].reverse().find((l) => l.old !== null)?.old ?? 0;
  const lastNew = [...all].reverse().find((l) => l.new !== null)?.new ?? 0;
  // Which lines stay: every change, and KEEP lines of context on each side of it
  const keep = new Uint8Array(all.length);
  const changed = all.map((l) => l.kind !== 'ctx');
  all.forEach((_, k) => {
    if (changed[k]) for (let n = Math.max(0, k - KEEP); n <= Math.min(all.length - 1, k + KEEP); n++) keep[n] = 1;
  });
  // A run short enough stays whole: a fold of a line or two costs more than it saves
  const anyChange = changed.some(Boolean);
  let k = 0;
  while (k < all.length) {
    if (keep[k]) {
      k++;
      continue;
    }
    let end = k;
    while (end < all.length && !keep[end]) end++;
    const edge = k === 0 || end === all.length;
    const run = end - k + (edge ? KEEP : 2 * KEEP);
    if (run <= FOLD_OVER && anyChange) keep.fill(1, k, end);
    k = end;
  }
  if (keep.every(Boolean)) return { ...diff, gaps: gapsOf(diff.hunks, { old: lastOld, new: lastNew }) };

  const groups: { at: number; lines: DiffLine[] }[] = [];
  const hidden: (DiffLine[] | null)[] = [];
  let pending: DiffLine[] = [];
  let current: DiffLine[] | null = null;
  for (const [n, line] of all.entries()) {
    if (keep[n]) {
      if (!current) {
        hidden.push(pending.length ? pending : null);
        pending = [];
        current = [];
        groups.push({ at: n, lines: current });
      }
      current.push(line);
    } else {
      current = null;
      pending.push(line);
    }
  }
  hidden.push(pending.length ? pending : null);
  const hunks = groups.map(({ at, lines }) => hunkOf(lines, all, at));
  return { ...diff, hunks, gaps: gapsOf(hunks, { old: lastOld, new: lastNew }, hidden), newLength: lastNew };
}

function hunkOf(lines: DiffLine[], all: DiffLine[], at: number): Hunk {
  // Git's own rule for the hunk header: the last line above that starts with a letter, `_` or `$`
  let section = '';
  for (let n = at - 1; n >= 0; n--) {
    const text = all[n]!.text;
    if (all[n]!.kind !== 'del' && /^[A-Za-z_$]/.test(text)) {
      section = text.trim();
      break;
    }
  }
  // A side with no lines in the hunk starts, as git writes it, at the line before
  const before = (side: 'old' | 'new') => all.slice(0, at).reverse().find((l) => l[side] !== null)?.[side] ?? 0;
  return {
    oldStart: lines.find((l) => l.old !== null)?.old ?? before('old'),
    oldLines: lines.filter((l) => l.kind !== 'add').length,
    newStart: lines.find((l) => l.new !== null)?.new ?? before('new'),
    newLines: lines.filter((l) => l.kind !== 'del').length,
    section,
    lines,
  };
}

/** The diff with gap `index` opened: its lines join the hunks on either side into one */
export function openGap(diff: ParsedDiff, index: number): ParsedDiff {
  const gap = diff.gaps[index];
  if (!gap?.lines) return diff;
  const before = diff.hunks[index - 1];
  const after = diff.hunks[index];
  const lines = [...(before?.lines ?? []), ...gap.lines, ...(after?.lines ?? [])];
  const first = lines[0]!;
  const merged: Hunk = {
    oldStart: before?.oldStart ?? first.old ?? gap.oldStart,
    newStart: before?.newStart ?? first.new ?? gap.newStart,
    oldLines: lines.filter((l) => l.kind !== 'add').length,
    newLines: lines.filter((l) => l.kind !== 'del').length,
    section: before?.section ?? after?.section ?? '',
    lines,
  };
  const from = before ? index - 1 : index;
  const to = after ? index + 1 : index;
  const hunks = [...diff.hunks.slice(0, from), merged, ...diff.hunks.slice(to)];
  const gaps = [...diff.gaps.slice(0, from), before ? diff.gaps[index - 1]! : null, after ? diff.gaps[index + 1]! : null, ...diff.gaps.slice(to + 1)];
  return { ...diff, hunks, gaps: gaps.map((g, i) => (g ? { ...g, index: i } : null)) };
}

// ---------------------------------------------------------------------------------------------
// Summaries

export interface DiffStats {
  additions: number;
  deletions: number;
  hunks: number;
  blocks: number;
}

export function statsOf(diff: ParsedDiff): DiffStats {
  const stats: DiffStats = { additions: 0, deletions: 0, hunks: diff.hunks.length, blocks: 0 };
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') stats.additions++;
      else if (line.kind === 'del') stats.deletions++;
    }
    stats.blocks += blocksOf(hunk).filter((i) => i.type === 'block').length;
  }
  return stats;
}

export interface BlockMark {
  index: number;
  kind: 'add' | 'del' | 'mod';
  /** Where it sits in the new file: its first new line, or the line its removals sat before */
  newLine: number;
  oldLine: number;
  adds: number;
  dels: number;
}

/** Every change block in order, for the block rail and `j`/`k` */
export function blockStarts(diff: ParsedDiff): BlockMark[] {
  const marks: BlockMark[] = [];
  for (const hunk of diff.hunks) {
    for (const item of blocksOf(hunk)) {
      if (item.type !== 'block') continue;
      const kind = item.adds.length && item.dels.length ? 'mod' : item.adds.length ? 'add' : 'del';
      marks.push({ index: marks.length, kind, newLine: item.newLine, oldLine: item.oldLine, adds: item.adds.length, dels: item.dels.length });
    }
  }
  return marks;
}

/**
 * A short, stable fingerprint of a diff's text (cyrb53), for "seen": a file whose diff changes
 * again reads as unseen again.
 */
export function diffHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
