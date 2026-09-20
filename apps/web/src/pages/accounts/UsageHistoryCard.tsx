import type { AccountSummary, UsageWindowKind } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { ChartLine } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Collapsible, Select } from '../../components/controls';
import { ICON_SM } from '../../components/icons';
import { Card, Empty, ErrorBox, Loading, Segmented } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { seriesOf, sinceOf, summarise, USAGE_RANGES, type UsageRange } from '../../lib/usage-history';
import { UsageChart } from './UsageChart';

const WINDOWS: readonly UsageWindowKind[] = ['5h', '7d'];
/** The window slides every few minutes; a key that changed every render would refetch on each one. */
const SLIDE_MS = 5 * 60_000;

/**
 * How much of each rate-limit window an account used, over time: the readings Agentry keeps
 * every few minutes while claude-swap is installed. One line per account, or one account alone.
 */
export function UsageHistoryCard({ accounts, threshold }: { accounts: AccountSummary[]; threshold: number }) {
  const { t } = useTranslation(['accountsConfig', 'config']);
  const [window, setWindow] = useState<UsageWindowKind>('5h');
  const [range, setRange] = useState<UsageRange>('24h');
  const [account, setAccount] = useState<'all' | string>('all');

  const now = Math.floor(Date.now() / SLIDE_MS) * SLIDE_MS;
  const since = sinceOf(range, now);
  const selected = account === 'all' ? undefined : Number(account);
  const history = useQuery({
    queryKey: keys.accountUsage(selected ?? 'all', window, since),
    queryFn: () => api.accountUsageHistory({ window, since, ...(selected !== undefined ? { account: selected } : {}) }),
    refetchInterval: 60_000,
  });

  const labelOf = (n: number) => {
    const found = accounts.find((a) => a.number === n);
    return found ? (found.alias ?? found.email) : t('history.removedAccount');
  };
  const series = seriesOf(history.data ?? []);
  const summary = summarise(series);

  return (
    <Card
      title={
        <span className="title-icon">
          <ChartLine {...ICON_SM} /> {t('history.title')}
        </span>
      }
    >
      <p className="muted small">{t('history.intro')}</p>
      <div className="toolbar">
        <Segmented<UsageWindowKind>
          label={t('history.window')}
          value={window}
          onChange={setWindow}
          options={WINDOWS.map((w) => ({ value: w, label: w === '5h' ? t('config:accounts.fiveHours') : t('config:accounts.sevenDays') }))}
        />
        <Segmented<UsageRange>
          label={t('history.range')}
          value={range}
          onChange={setRange}
          options={USAGE_RANGES.map((r) => ({ value: r, label: t(`history.ranges.${r}`) }))}
        />
        <Select<string>
          aria-label={t('history.account')}
          value={account}
          onChange={setAccount}
          options={[
            { value: 'all', label: t('history.allAccounts') },
            ...accounts.map((a) => ({ value: String(a.number), label: `#${a.number} · ${a.alias ?? a.email}` })),
          ]}
        />
      </div>
      <ErrorBox error={history.error} />
      {history.isLoading ? (
        <Loading />
      ) : summary.length === 0 ? (
        <Empty icon={ChartLine} title={t('history.none')}>
          {t('history.noneHint')}
        </Empty>
      ) : (
        <>
          <UsageChart series={series} from={Date.parse(since)} to={now + SLIDE_MS} threshold={threshold} labelOf={labelOf} />
          <Collapsible className="fold" title={t('history.table')}>
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">{t('history.tableCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('history.account')}</th>
                    <th scope="col">{t('history.latest')}</th>
                    <th scope="col">{t('history.peak')}</th>
                    <th scope="col">{t('history.readings')}</th>
                    <th scope="col">{t('history.lastReading')}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((row) => (
                    <tr key={row.account}>
                      <th scope="row">
                        #{row.account} · {labelOf(row.account)}
                      </th>
                      <td>{Math.round(row.latest)}%</td>
                      <td>{Math.round(row.peak)}%</td>
                      <td>{row.readings}</td>
                      <td className="small muted">{formatDateTime(row.latestAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Collapsible>
        </>
      )}
    </Card>
  );
}
