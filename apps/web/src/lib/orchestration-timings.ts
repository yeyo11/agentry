import type { Orchestration, OrchestrationPhaseTiming, TaskWaitKind } from '@agentry/shared';
import type { ProgressStatus } from '@agentry/ui/lib/progress';

/** Cells the phase bar is cut into: enough for a one-minute integration to show next to a two-hour task phase. */
export const PHASE_CELLS = 32;

/**
 * The two neutral tones a phase bar alternates, so each phase reads as its own run of cells without
 * a status colour: a phase is neither done nor failed, it is only time.
 */
const NEUTRALS: readonly ProgressStatus[] = ['skipped', 'pending'];

/**
 * How many cells each phase gets: its share of the whole, by largest remainder, and at least one,
 * so a short phase is never left out of a bar that lists it.
 */
export function phaseCellCounts(phases: readonly Pick<OrchestrationPhaseTiming, 'durationMs'>[], total = PHASE_CELLS): number[] {
  if (phases.length === 0) return [];
  const cells = Math.max(total, phases.length);
  const sum = phases.reduce((acc, p) => acc + Math.max(0, p.durationMs), 0);
  if (sum === 0) return phases.map(() => 1);
  const spare = cells - phases.length;
  const exact = phases.map((p) => (Math.max(0, p.durationMs) / sum) * spare);
  const counts = exact.map((x) => 1 + Math.floor(x));
  let left = cells - counts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest);
  for (const { i } of order) {
    if (left <= 0) break;
    counts[i] = (counts[i] ?? 0) + 1;
    left -= 1;
  }
  return counts;
}

/** The neutral tone of a phase's cells and legend swatch; it alternates from one phase to the next. */
export const phaseTone = (index: number): ProgressStatus => NEUTRALS[index % NEUTRALS.length] ?? 'pending';

/** The phase bar's cells, in neutral tones that alternate from one phase to the next. */
export function phaseCells(phases: readonly Pick<OrchestrationPhaseTiming, 'durationMs'>[], total = PHASE_CELLS): ProgressStatus[] {
  return phaseCellCounts(phases, total).flatMap((count, i) => Array<ProgressStatus>(count).fill(phaseTone(i)));
}

/** A wait's status colour: a limit or a slot is warn (held back, near a limit), a retry is idle (waiting on someone). */
export const WAIT_TONE: Record<TaskWaitKind, 'warn' | 'idle'> = { slot: 'warn', limit: 'warn', retry: 'idle' };

/**
 * What moves a graph from one phase to the next, so its timings are read again then: its status, and
 * the status of its integration and its checks.
 */
export const timingsPhaseKey = (orch: Pick<Orchestration, 'status' | 'integration' | 'verification' | 'synthesisRunId'>): string =>
  [orch.status, orch.integration?.status ?? '', orch.verification?.status ?? '', orch.synthesisRunId ? 'synthesis' : ''].join(':');
