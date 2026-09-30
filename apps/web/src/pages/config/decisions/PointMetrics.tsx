import type { DecisionPointStats } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { formatCost, formatNumber } from '../../../lib/format';
import { percent } from './model';

/** The window the per-point numbers cover: last week's, as the plan says. */
export const METRICS_DAYS = 7;

const DASH = '—';
const pct = (value: number | null) => (value === null ? DASH : `${formatNumber(value)} %`);

/**
 * A point's week in nine figures (D14). The confidence is a dash for the CLI, which has none, and
 * the agreement carries its n: 88 % of 3 answers says less than 88 % of 24.
 */
export function PointMetrics({ stats, onHistory }: { stats: DecisionPointStats | undefined; onHistory?: () => void }) {
  const { t } = useTranslation('decisions');
  const count = stats?.count ?? 0;
  const cells: Array<{ id: string; label: string; value: string; n?: string }> = [
    { id: 'count', label: t('metrics.count'), value: formatNumber(count) },
    { id: 'acted', label: t('metrics.acted'), value: pct(stats ? percent(stats.acted, stats.count) : null) },
    {
      id: 'confidence',
      label: t('metrics.confidence'),
      value: stats?.meanConfidence == null ? DASH : formatNumber(stats.meanConfidence, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    },
    {
      id: 'agreement',
      label: t('metrics.agreement'),
      value: pct(stats ? percent(stats.agreed, stats.resolved) : null),
      ...(stats && stats.resolved > 0 ? { n: t('metrics.n', { n: formatNumber(stats.resolved) }) } : {}),
    },
    { id: 'useful', label: t('metrics.useful'), value: formatNumber(stats?.useful ?? 0) },
    { id: 'notUseful', label: t('metrics.notUseful'), value: formatNumber(stats?.notUseful ?? 0) },
    { id: 'unavailable', label: t('metrics.unavailable'), value: formatNumber(stats?.unavailable ?? 0) },
    { id: 'cost', label: t('metrics.cost'), value: formatCost(stats?.costUsd ?? 0) },
    { id: 'saved', label: t('metrics.saved'), value: formatNumber(stats?.runsSaved ?? 0) },
  ];

  return (
    <div className="dp-metrics-line">
      <div className="dp-metrics" role="group" aria-label={t('metrics.label', { days: METRICS_DAYS })}>
        {cells.map((cell) => (
          <div key={cell.id} className="dp-metric">
            <span>{cell.label}</span>
            <span>
              {cell.value}
              {cell.n && <span className="dp-metric-n"> {cell.n}</span>}
            </span>
          </div>
        ))}
      </div>
      {onHistory && (
        <button type="button" className="btn btn-ghost btn-small" onClick={onHistory}>
          {t('metrics.inHistory')}
        </button>
      )}
    </div>
  );
}
