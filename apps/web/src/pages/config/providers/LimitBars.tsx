import type { ProviderStatus } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { usageTone } from '@agentry/ui/components/motion';
import { Tag } from '@agentry/ui/components/ui';
import { formatDateTime, timeAgo } from '@agentry/ui/lib/format';
import { limitRows } from './rotation';

/**
 * A provider's usage limit inside its row: one thin bar per window in the usage thresholds (neutral
 * below 60 %, warn from 60 %, bad from 75 % or when the limit is reached), the reset beside it and
 * the age of the reading. A reading whose reset has passed is `unknown` and says so: Agentry never
 * reads a stale figure as "fine". Nothing here moves.
 */
export function LimitBars({ status }: { status: ProviderStatus }) {
  const { t } = useTranslation('providers');
  const limit = status.limit;
  if (!limit) return null;
  const rows = limitRows(limit);
  const exhausted = limit.state === 'exhausted';
  // The windows with a short name of their own; any other is shown as the provider calls it
  const name = (window: string) => (window === '5h' ? t('limit.window.5h') : window === '7d' ? t('limit.window.7d') : window);
  const source = limit.source === 'stream' ? t('limit.source.stream') : limit.source === 'probe' ? t('limit.source.probe') : t('limit.source.failure');

  return (
    <div className="prov-limit" role="group" aria-label={t('limit.group', { name: status.label })}>
      <div className="prov-limit-head">
        <span className="section-label">{t('limit.title')}</span>
        {limit.state === 'near' && <Tag tone="warn">{t('limit.near')}</Tag>}
        {exhausted && <Tag tone="bad">{t('limit.exhausted')}</Tag>}
        <span className="asof">{t('limit.asof', { time: timeAgo(limit.observedAt), source })}</span>
      </div>
      {rows.length > 0 ? (
        <div className="prov-limit-bars">
          {rows.map((row) => {
            const tone = usageTone(row.percent, exhausted && row.name === limit.window);
            return (
              <div className="lim-row" key={row.name}>
                <span className="win">{name(row.name)}</span>
                <div className="meter-track meter-thin" role="img" aria-label={t('limit.used', { window: name(row.name), percent: row.percent })}>
                  <span className={`meter-fill ${tone === 'neutral' ? '' : `is-${tone}`}`.trim()} style={{ width: `${row.percent}%` }} />
                </div>
                <span className="pct">{row.percent} %</span>
                <span className="reset">{row.resetsAt ? t('limit.resets', { when: formatDateTime(row.resetsAt) }) : t('limit.resetUnknown')}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="prov-limit-note">{limit.state === 'unknown' ? t('limit.unknown') : t('limit.noWindows')}</p>
      )}
    </div>
  );
}
