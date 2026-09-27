/**
 * Ranks: the order of the work items inside a board column, as strings compared byte by byte.
 *
 * A move writes one row, the moved item's, with a rank strictly between its two new neighbours,
 * so a person reordering one card never rewrites the column and two processes never fight over
 * positions. The digits are in ASCII order, so SQLite's default `ORDER BY rank` and JavaScript's
 * `<` agree with each other.
 *
 * A rank never ends in the lowest digit: nothing sorts strictly between `A` and `A0`, and a rank
 * that ended so could leave no room before it.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

/** Past this length the column is spread out again; appending at the end grows a rank slowly. */
export const RANK_REBALANCE_LENGTH = 24;

function digit(char: string | undefined): number {
  if (char === undefined) return 0;
  const value = DIGITS.indexOf(char);
  if (value < 0) throw new Error(`not a rank digit: ${char}`);
  return value;
}

function midpoint(low: string, high: string | null): string {
  if (high !== null) {
    // A shared prefix stays as it is; the middle is found in what follows it
    let n = 0;
    while (n < high.length && (low[n] ?? DIGITS[0]) === high[n]) n++;
    if (n > 0) return high.slice(0, n) + midpoint(low.slice(n), high.slice(n));
  }
  const a = digit(low[0]);
  const b = high === null ? BASE : digit(high[0]);
  if (b - a > 1) return DIGITS[Math.round((a + b) / 2)] ?? '';
  // Adjacent first digits: take the high one when there is something after it, else go one deeper
  if (high !== null && high.length > 1) return high.slice(0, 1);
  return (DIGITS[a] ?? '') + midpoint(low.slice(1), null);
}

/**
 * The shortest step past `low`: its first digit that can still grow, grown by one. Halving the gap
 * to the end instead would add a character every six cards appended, and a column filled from the
 * bottom would need spreading out every hundred or so; this adds one every sixty.
 */
function next(low: string): string {
  for (let i = 0; i < low.length; i++) {
    const d = digit(low[i]);
    if (d < BASE - 1) return low.slice(0, i) + (DIGITS[d + 1] ?? '');
  }
  return low + (DIGITS[1] ?? '');
}

function checkRank(rank: string): void {
  for (const char of rank) digit(char);
}

/**
 * A rank strictly between `before` and `after`. Null for `before` is the start of the column, null
 * for `after` its end.
 *
 * Throws rather than answer a rank outside the bounds: neighbours a hand edit left without room (a
 * rank ending in the lowest digit, a character that is no digit) have no rank between them, and
 * the caller spreads the column out again instead.
 */
export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null) checkRank(before);
  if (after !== null) checkRank(after);
  if (before !== null && after !== null && before >= after) throw new Error(`rank ${before} is not before ${after}`);
  const rank = before !== null && after === null ? next(before) : midpoint(before ?? '', after);
  if (!rank || (before !== null && rank <= before) || (after !== null && rank >= after)) {
    throw new Error(`no rank between ${before ?? 'the start'} and ${after ?? 'the end'}`);
  }
  return rank;
}

/** `count` ranks in increasing order, evenly spaced and all of one short length. */
export function spreadRanks(count: number): string[] {
  let width = 1;
  while (BASE ** width < (count + 1) * 2) width++;
  const step = Math.floor(BASE ** width / (count + 1));
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    let value = i * step;
    let rank = '';
    for (let w = 0; w < width; w++) {
      rank = (DIGITS[value % BASE] ?? '') + rank;
      value = Math.floor(value / BASE);
    }
    // Trailing zeros go: the order among equal-width ranks is the same without them
    out.push(rank.replace(/0+$/, ''));
  }
  return out;
}
