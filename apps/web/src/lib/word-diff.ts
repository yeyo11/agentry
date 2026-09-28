// What changed inside a pair of lines, as the spans the comparator marks (design system §5: one
// mark per changed phrase, not one per token). Our own token LCS: no diff library.

/** A changed span of a line, `[start, end)` in characters */
export type Range = [start: number, end: number];

export interface WordDiff {
  /** Spans of the old line that are not in the new one */
  old: Range[];
  /** Spans of the new line that are not in the old one */
  new: Range[];
}

/** Past this a line is not worth tokenizing: the whole of it is the change */
const MAX_LINE = 400;
/** Past this many tokens on either side the LCS table costs more than the marks are worth */
const MAX_TOKENS = 200;

interface Token {
  text: string;
  start: number;
  space: boolean;
}

/** Words, runs of whitespace and single punctuation marks */
export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  for (const m of line.matchAll(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu)) {
    out.push({ text: m[0], start: m.index, space: /^\s/.test(m[0]) });
  }
  return out;
}

/**
 * The changed spans of each side. Whitespace alone never counts: the LCS runs over the other
 * tokens only, so re-indenting a line marks nothing, and changed tokens separated by nothing but
 * whitespace are one phrase.
 */
export function wordDiff(oldLine: string, newLine: string): WordDiff {
  if (oldLine === newLine) return { old: [], new: [] };
  if (oldLine.length > MAX_LINE || newLine.length > MAX_LINE) return { old: whole(oldLine), new: whole(newLine) };
  const a = tokenize(oldLine).filter((t) => !t.space);
  const b = tokenize(newLine).filter((t) => !t.space);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return { old: whole(oldLine), new: whole(newLine) };

  // dp[i][j] is the LCS of a[i..] and b[j..], so the walk below goes forwards and, between equal
  // choices, keeps the earlier token: `a, b` → `a, c, b` marks `c,` rather than `, c`
  const w = b.length + 1;
  const dp = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] = a[i]!.text === b[j]!.text ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const keptA = new Uint8Array(a.length);
  const keptB = new Uint8Array(b.length);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]!.text === b[j]!.text) {
      keptA[i++] = 1;
      keptB[j++] = 1;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  return { old: phrases(a, keptA), new: phrases(b, keptB) };
}

/** Runs of changed tokens, joined across the whitespace between them */
function phrases(tokens: Token[], kept: Uint8Array): Range[] {
  const out: Range[] = [];
  let open: Range | null = null;
  tokens.forEach((t, k) => {
    if (kept[k]) {
      open = null;
      return;
    }
    const end = t.start + t.text.length;
    if (open) open[1] = end;
    else {
      open = [t.start, end];
      out.push(open);
    }
  });
  return out;
}

/** The line itself, without its indentation and trailing whitespace */
function whole(line: string): Range[] {
  const start = line.length - line.trimStart().length;
  const end = line.trimEnd().length;
  return end > start ? [[start, end]] : [];
}

/**
 * How alike two lines are, 0 to 1: the Dice coefficient of their character bigrams, whitespace at
 * either end left out. Cheap enough to hold every removed line against every added one of a block.
 */
export function similarity(a: string, b: string): number {
  const x = a.trim();
  const y = b.trim();
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let k = 0; k < x.length - 1; k++) {
    const g = x.slice(k, k + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let shared = 0;
  for (let k = 0; k < y.length - 1; k++) {
    const g = y.slice(k, k + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      shared++;
    }
  }
  return (2 * shared) / (x.length - 1 + y.length - 1);
}
