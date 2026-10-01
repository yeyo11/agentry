import type { DecisionStats } from '@agentry/shared';
import { Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { formatCost } from '@agentry/ui/lib/format';

/** Nothing when no decision was recorded in the window. */
export function DecisionsLineView({ stats: data }: { stats: DecisionStats }) {
  const { t } = useTranslation('usage');
  if (data.points.reduce((sum, row) => sum + row.count, 0) === 0) return null;
  return (
    <div className="usage-decisions" role="note">
      <Workflow size={14} strokeWidth={1.75} aria-hidden />
      <span className="lead">{t('decisions.label')}</span>
      <span className="sep" aria-hidden>
        ·
      </span>
      <span>{t('decisions.jev', { cost: formatCost(data.jevCostUsd) })}</span>
      <span className="sep" aria-hidden>
        ·
      </span>
      <span>{t('decisions.saved', { count: data.claudeRunsSaved })}</span>
      <Link to="/settings?tab=decisions">{t('decisions.history')}</Link>
    </div>
  );
}
