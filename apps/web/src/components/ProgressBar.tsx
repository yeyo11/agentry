import { useTranslation } from 'react-i18next';
import { progressBlocks, progressSegments, progressTotal, type ProgressCounts } from '../lib/progress';

const BLOCK_FULL = '▰';
const BLOCK_EMPTY = '▱';

/**
 * A bar cut up by status, not a percentage: "11 of 17 done, 1 failed" is what a person needs, and a
 * single gradient cannot tell a failure from a pause. `blocks` is the same thing in five mono
 * characters, for a row or a widget where a bar does not fit.
 */
export function ProgressBar({
  counts,
  variant = 'bar',
  blocks = 5,
  unit,
  label,
  className = '',
}: {
  counts: ProgressCounts;
  variant?: 'bar' | 'blocks';
  /** How many cells the `blocks` variant draws */
  blocks?: number;
  /** What is being counted, already translated ("tasks", "steps"); left out, the name is "11 of 17 done" */
  unit?: string;
  /** Overrides the whole accessible name, for a caller that has a better sentence */
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation('primitives');
  const total = progressTotal(counts);
  const done = Math.max(0, Math.trunc(counts.done ?? 0));
  const segments = progressSegments(counts);

  const parts = [unit ? t('progress.doneOf', { done, total, unit }) : t('progress.done', { done, total })];
  for (const status of ['running', 'failed', 'skipped'] as const) {
    const count = Math.max(0, Math.trunc(counts[status] ?? 0));
    if (count > 0) parts.push(t(`progress.${status}`, { count }));
  }
  const name = label ?? (total === 0 ? t('progress.nothing') : parts.join(', '));

  const shared = {
    role: 'progressbar' as const,
    'aria-label': name,
    'aria-valuemin': 0,
    'aria-valuemax': Math.max(total, 1),
    'aria-valuenow': done,
    'aria-valuetext': name,
  };

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

  return (
    <span className={`progress ${className}`.trim()} {...shared}>
      {segments.map((segment) => (
        <span key={segment.status} className={`progress-seg is-${segment.status}`} style={{ width: `${segment.percent}%` }} aria-hidden />
      ))}
    </span>
  );
}
