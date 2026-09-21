import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useOverview, useUsage } from '../../../api';
import { ProgressRing } from '../../../components/motion';
import { Skeleton } from '../../../components/ui';
import { formatCost, formatNumber, timeUntil } from '../../../lib/format';
import type { WidgetProps } from '../registry';
import { WidgetCard } from '../WidgetCard';

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The account's usage windows as rings: they belong to the account, so they read the same on every dashboard. */
export function LimitsWidget({ title, id }: WidgetProps) {
  const { t } = useTranslation('home');
  const overview = useOverview();
  const windows = Object.entries(overview.data?.rateLimit?.windows ?? {});
  return (
    <WidgetCard id={id} title={title}>
      {overview.isLoading ? (
        <Skeleton rows={2} height={16} />
      ) : windows.length === 0 ? (
        <p className="muted small">{t('widgets.limits.none')}</p>
      ) : (
        <div className="gauges" role="group" aria-label={t('activity.usageLimits')}>
          {windows.map(([name, win]) => {
            const pct = Math.min(100, Math.round(win.utilization * 100));
            return (
              <div key={name} className="gauge">
                <ProgressRing value={pct / 100} size={56} stroke={6} tone={pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'accent'}>
                  <span className="gauge-value">{pct}%</span>
                </ProgressRing>
                <div className="gauge-text">
                  <span className="gauge-name">{t('activity.limit', { name: name.replace(/_/g, ' ') })}</span>
                  <span className="muted small">{t('activity.resets', { when: timeUntil(win.resetsAt) })}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </WidgetCard>
  );
}

/** What today cost, and the tokens behind it by model; in a project, that project's share. */
export function TodayWidget({ project, title, id }: WidgetProps) {
  const { t } = useTranslation(['home', 'work']);
  const today = dayOf(new Date());
  const usage = useUsage({ from: today, to: today });
  const row = project ? usage.data?.projects.find((p) => p.project?.id === project.id) : usage.data?.total;
  const models = (row?.tokens ?? []).filter((m) => m.total > 0);
  return (
    <WidgetCard
      id={id}
      title={title}
      actions={
        <Link to="/usage" className="link-more">
          {t('widgets.today.usage')}
        </Link>
      }
    >
      {usage.isLoading ? (
        <Skeleton rows={2} height={16} />
      ) : models.length === 0 ? (
        <p className="muted small">{t('activity.nothingSpent')}</p>
      ) : (
        <>
          <div className="meta small">
            <span className="mono strong">
              {row?.costUsd === null || row === undefined ? t('activity.costUnavailable') : t('activity.spent', { cost: formatCost(row.costUsd) })}
            </span>
            {row && row.chatsWithoutCost > 0 && (
              <span className="muted">{t('activity.chatsWithoutCost', { count: row.chatsWithoutCost, n: formatNumber(row.chatsWithoutCost) })}</span>
            )}
          </div>
          <div className="table-wrap" role="region" aria-label={t('activity.tokensToday')} tabIndex={0}>
            <table className="table today-table">
              <thead>
                <tr>
                  <th scope="col">{t('work:shared.model')}</th>
                  <th scope="col" className="num">{t('activity.input')}</th>
                  <th scope="col" className="num">{t('activity.output')}</th>
                  <th scope="col" className="num">{t('activity.cache')}</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.model ?? 'unknown'}>
                    <th scope="row" className="mono">{m.model ?? t('activity.unknownModel')}</th>
                    <td className="num mono">{formatNumber(m.input)}</td>
                    <td className="num mono">{formatNumber(m.output)}</td>
                    <td className="num mono">{formatNumber(m.cacheRead + m.cacheCreation)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </WidgetCard>
  );
}
