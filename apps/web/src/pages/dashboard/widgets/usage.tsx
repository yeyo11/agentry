import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useUsage } from '../../../api';
import { Skeleton } from '../../../components/ui';
import { formatNumber } from '../../../lib/format';
import { localDay } from '../pulse';
import type { WidgetProps } from '../registry';
import { WidgetCard } from '../WidgetCard';

const compact = (n: number) => formatNumber(n, { notation: 'compact', maximumFractionDigits: 1 });

/**
 * The tokens behind today's spend, by model; in a project, that project's share. The spend itself
 * is a figure of the strip on top, so this is the breakdown, and the Usage page has the rest.
 */
export function TodayWidget({ project, title, id }: WidgetProps) {
  const { t } = useTranslation(['home', 'work']);
  const today = localDay();
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
        <p className="muted small widget-note">{t('activity.nothingSpent')}</p>
      ) : (
        <div className="table-wrap" role="region" aria-label={t('activity.tokensToday')} tabIndex={0}>
          <table className="today-table">
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
                  <th scope="row" className="ellipsis">{m.model ?? t('activity.unknownModel')}</th>
                  <td className="num mono" title={formatNumber(m.input)}>{compact(m.input)}</td>
                  <td className="num mono" title={formatNumber(m.output)}>{compact(m.output)}</td>
                  <td className="num mono" title={formatNumber(m.cacheRead + m.cacheCreation)}>{compact(m.cacheRead + m.cacheCreation)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </WidgetCard>
  );
}
