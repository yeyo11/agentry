import { useTranslation } from 'react-i18next';
import { progressBlocks, progressSegments, progressTotal, type ProgressCounts, type ProgressStatus } from '../lib/progress';

const BLOCK_FULL = '▰';
const BLOCK_EMPTY = '▱';

/** Past this many tasks a cell per task is thinner than the gap between cells, so the bar is drawn by share instead. */
const MAX_SEGMENTS = 32;

/** Counts, or the cells themselves when their order says something the counts cannot (one per agent, in turn). */
type ProgressSource = { counts: ProgressCounts; cells?: readonly ProgressStatus[] } | { counts?: undefined; cells: readonly ProgressStatus[] };

function countCells(cells: readonly ProgressStatus[]): ProgressCounts {
  const counts: ProgressCounts = {};
  for (const status of cells) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

/**
 * A bar cut up by status, not a percentage: "11 of 17 done, 1 failed" is what a person needs, and a
 * single gradient cannot tell a failure from a pause. `blocks` is the same thing in five mono
 * characters, for a row or a widget where a bar does not fit. `segments` gives every item a cell of
 * its own (design system §3, "Progress of an orchestration"): a task is a thing you can count.
 */
export function ProgressBar({
  counts: given,
  cells: givenCells,
  variant = 'bar',
  blocks = 5,
  size = 'md',
  maxCells = MAX_SEGMENTS,
  decorative = false,
  unit,
  label,
  className = '',
}: ProgressSource & {
  variant?: 'bar' | 'blocks' | 'segments';
  /** How many cells the `blocks` variant draws */
  blocks?: number;
  /** `sm` is the thin bar of a sidebar row or of a card's footer */
  size?: 'md' | 'sm';
  /** Past this many items `segments` draws by share: a narrow place runs out of room for cells sooner */
  maxCells?: number;
  /** The same numbers are already written beside the bar, so a screen reader would hear them twice */
  decorative?: boolean;
  /** What is being counted, already translated ("tasks", "steps"); left out, the name is "11 of 17 done" */
  unit?: string;
  /** Overrides the whole accessible name, for a caller that has a better sentence */
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation('primitives');
  const counts = given ?? countCells(givenCells ?? []);
  const total = progressTotal(counts);
  const done = Math.max(0, Math.trunc(counts.done ?? 0));
  const segments = progressSegments(counts);

  const parts = [unit ? t('progress.doneOf', { done, total, unit }) : t('progress.done', { done, total })];
  for (const status of ['running', 'failed', 'skipped'] as const) {
    const count = Math.max(0, Math.trunc(counts[status] ?? 0));
    if (count > 0) parts.push(t(`progress.${status}`, { count }));
  }
  const name = label ?? (total === 0 ? t('progress.nothing') : parts.join(', '));

  const shared = decorative
    ? { 'aria-hidden': true }
    : {
        role: 'progressbar' as const,
        'aria-label': name,
        'aria-valuemin': 0,
        'aria-valuemax': Math.max(total, 1),
        'aria-valuenow': done,
        'aria-valuetext': name,
      };
  const classes = (base: string) => [base, size === 'sm' ? 'is-sm' : '', className].filter(Boolean).join(' ');

  if (variant === 'blocks') {
    return (
      <span className={`progress-blocks ${className}`.trim()} {...shared}>
        {progressBlocks(counts, blocks).map((status, index) => (
          <span key={index} className={`progress-cell is-${status}`} aria-hidden>
            {status === 'pending' ? BLOCK_EMPTY : BLOCK_FULL}
          </span>
        ))}
      </span>
    );
  }

  if (variant === 'segments' && total > 0 && total <= maxCells) {
    return (
      <span className={classes('progress-segbar')} {...shared}>
        {(givenCells ?? progressBlocks(counts, total)).map((status, index) => (
          <span key={index} className={`progress-segbar-cell is-${status}`} aria-hidden />
        ))}
      </span>
    );
  }

  return (
    <span className={classes('progress')} {...shared}>
      {segments.map((segment) => (
        <span key={segment.status} className={`progress-seg is-${segment.status}`} style={{ width: `${segment.percent}%` }} aria-hidden />
      ))}
    </span>
  );
}
