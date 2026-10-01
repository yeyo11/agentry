/**
 * Progress as counts per status rather than one number: "11 of 17 done, 1 failed" is what an
 * orchestration, a checklist and a stage all have to say, and a bar that is a single gradient
 * cannot say it. Pure, so the maths that decides how a bar is cut up is unit tested.
 */

/** In the order they are drawn, left to right. */
export const PROGRESS_STATUSES = ['done', 'running', 'failed', 'pending', 'skipped'] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];
export type ProgressCounts = Partial<Record<ProgressStatus, number>>;

export interface ProgressSegment {
  status: ProgressStatus;
  count: number;
  /** Share of the bar, as a percentage; the segments of a bar add up to exactly 100 */
  percent: number;
}

export function progressTotal(counts: ProgressCounts): number {
  return PROGRESS_STATUSES.reduce((total, status) => total + Math.max(0, Math.trunc(counts[status] ?? 0)), 0);
}

/**
 * The segments of a bar. Percentages are rounded by largest remainder and the widest segment
 * carries what is left over, so the bar always fills its track exactly and no thin segment
 * disappears to rounding.
 */
export function progressSegments(counts: ProgressCounts): ProgressSegment[] {
  const total = progressTotal(counts);
  if (total === 0) return [];
  const raw = PROGRESS_STATUSES.map((status) => ({ status, count: Math.max(0, Math.trunc(counts[status] ?? 0)) })).filter((s) => s.count > 0);
  const segments = raw.map((s) => ({ ...s, percent: Math.floor((s.count / total) * 100) }));
  let left = 100 - segments.reduce((sum, s) => sum + s.percent, 0);
  const byRemainder = [...segments].sort((a, b) => ((b.count / total) * 100 - b.percent) - ((a.count / total) * 100 - a.percent));
  for (const segment of byRemainder) {
    if (left <= 0) break;
    segment.percent += 1;
    left -= 1;
  }
  return segments;
}

/**
 * `▰▰▰▱▱` for the places a bar does not fit. The cells follow the same order as the bar, and a
 * status with at least one item never rounds down to no cell at all: a single failure has to be
 * visible in five characters.
 */
export function progressBlocks(counts: ProgressCounts, blocks = 5): ProgressStatus[] {
  const cells: ProgressStatus[] = Array.from({ length: Math.max(0, blocks) }, () => 'pending');
  const total = progressTotal(counts);
  if (total === 0 || cells.length === 0) return cells;
  const filled = PROGRESS_STATUSES.filter((status) => status !== 'pending').map((status) => ({
    status,
    count: Math.max(0, Math.trunc(counts[status] ?? 0)),
  }));
  const want = filled.map((s) => ({ ...s, cells: s.count === 0 ? 0 : Math.max(1, Math.round((s.count / total) * cells.length)) }));
  // Rounding up the small ones can ask for more cells than there are: give them back from the
  // largest share, which is the one that loses the least by it.
  let over = want.reduce((sum, s) => sum + s.cells, 0) - cells.length;
  while (over > 0) {
    const biggest = want.reduce((a, b) => (b.cells > a.cells ? b : a));
    if (biggest.cells === 0) break;
    biggest.cells -= 1;
    over -= 1;
  }
  let at = 0;
  for (const segment of want) {
    for (let i = 0; i < segment.cells && at < cells.length; i++, at++) cells[at] = segment.status;
  }
  return cells;
}

/** The states a step of a `Stepper` can be in. */
export const STEP_STATES = ['done', 'current', 'waiting', 'failed', 'skipped', 'pending'] as const;
export type StepState = (typeof STEP_STATES)[number];

/** A step in flight — current or blocked on someone — counts as running in a bar. */
const STEP_TO_PROGRESS: Record<StepState, ProgressStatus> = {
  done: 'done',
  current: 'running',
  waiting: 'running',
  failed: 'failed',
  skipped: 'skipped',
  pending: 'pending',
};

export function stepCounts(states: readonly StepState[]): ProgressCounts {
  const counts: ProgressCounts = {};
  for (const state of states) {
    const status = STEP_TO_PROGRESS[state];
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/**
 * The step a stepper follows: the one being worked on, or the one waiting for a person, or else
 * the first that has not happened yet. `-1` when every step is behind us.
 */
export function currentStepIndex(states: readonly StepState[]): number {
  const current = states.indexOf('current');
  if (current !== -1) return current;
  const waiting = states.indexOf('waiting');
  if (waiting !== -1) return waiting;
  const failed = states.indexOf('failed');
  if (failed !== -1) return failed;
  return states.indexOf('pending');
}
