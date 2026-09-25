import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Info, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, keys, useAccountEvents, useAccounts } from '../api';
import { useConfirm } from '../components/Dialog';
import { ICON_SM } from '../components/icons';
import { useToast } from '../components/Toast';
import { Card, Empty, ErrorBox, PageHeader, Skeleton, StatusBadge } from '../components/ui';
import { formatDateTime, timeAgo, toMs } from '../lib/format';
import { AccountCard } from './accounts/AccountCard';
import { AddAccountDialog } from './accounts/AddAccountDialog';
import { AutoSwitchCard } from './accounts/AutoSwitchCard';
import { PoliciesCard } from './accounts/PoliciesCard';
import { UsageHistoryCard } from './accounts/UsageHistoryCard';
import { sortAccounts } from './accounts/usage';
import '../insights.css';

const CSWAP_URL = 'https://github.com/realiti4/claude-swap';

export function Accounts() {
  const { t } = useTranslation(['accountsConfig', 'config', 'common']);
  const { data, error, isLoading, refetch, isFetching } = useAccounts();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  // The dialog refocuses whenever its onClose changes, so it gets the same function every render
  const closeAdd = useCallback(() => setAdding(false), []);
  // The overview carries the most recent window; the rest of the history is one query away
  const [fullHistory, setFullHistory] = useState(false);
  const history = useAccountEvents(fullHistory);

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.accounts });

  const act = async (label: string, failure: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      toast.success(label);
      await refresh();
    } catch (err) {
      toast.error(failure, err);
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <Skeleton rows={6} height={20} />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const installed = data.cswap.installed;
  const accounts = sortAccounts(data.accounts);
  // Falls back to the overview's window while the history query is still in flight
  const events = fullHistory ? (history.data ?? data.events) : data.events;
  const lastRead = data.accounts.reduce<string | null>((latest, a) => ((toMs(a.usageFetchedAt) ?? 0) > (toMs(latest) ?? 0) ? a.usageFetchedAt : latest), null);
  const addButton = (
    <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
      <Plus {...ICON_SM} /> {t('page.add')}
    </button>
  );

  return (
    <div className="stack accounts-page">
      <PageHeader
        title={t('config:accounts.title')}
        subtitle={
          installed
            ? [
                t('page.subtitle', { accounts: t('config:accounts.count', { count: data.accounts.length }), version: data.cswap.version ?? '' }).trim(),
                lastRead ? t('config:accounts.usageRead', { ago: timeAgo(lastRead) }) : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : t('config:accounts.needsCswap')
        }
        actions={
          <>
            <button type="button" className="btn" onClick={() => void refetch()} disabled={isFetching} aria-label={t('config:accounts.refreshUsage')}>
              <RefreshCw {...ICON_SM} /> <span className="accounts-action-text">{t('config:accounts.refreshUsage')}</span>
            </button>
            {installed && data.accounts.length > 0 && addButton}
          </>
        }
      />

      {adding && <AddAccountDialog onClose={closeAdd} onAdded={() => void refresh()} />}

      {!installed ? (
        <Empty
          illustration="cli-missing"
          tone="warn"
          title={t('config:accounts.notInstalled')}
          action={
            <a className="btn btn-primary" href={CSWAP_URL} target="_blank" rel="noreferrer">
              <ExternalLink {...ICON_SM} /> {t('page.installGuide')}
            </a>
          }
        >
          <Trans
            t={t}
            i18nKey="config:accounts.notInstalledHint"
            components={{
              anchor: <a href={CSWAP_URL} target="_blank" rel="noreferrer" />,
              code: <code className="mono" />,
            }}
          />
          {data.cswap.error && <div className="muted small">{data.cswap.error}</div>}
        </Empty>
      ) : data.accounts.length === 0 ? (
        <Empty illustration="signed-out" tone="warn" title={t('config:accounts.none')} action={addButton}>
          {t('page.noneHint')}
        </Empty>
      ) : (
        <>
          <ul className="account-grid">
            {accounts.map((account) => (
              <AccountCard
                key={account.number}
                account={account}
                config={data.configs.find((c) => c.number === account.number)}
                busy={busy}
                onSwitch={() =>
                  void act(
                    t('config:accounts.switched', { email: account.email }),
                    t('config:accounts.switchFailed', { email: account.email }),
                    () => api.switchAccount({ target: String(account.number) }),
                  )
                }
                onToggle={() =>
                  void act(
                    account.disabled ? t('config:accounts.backInRotation', { email: account.email }) : t('config:accounts.heldOut', { email: account.email }),
                    account.disabled
                      ? t('config:accounts.backInRotationFailed', { email: account.email })
                      : t('config:accounts.heldOutFailed', { email: account.email }),
                    () => api.setAccountEnabled(account.number, account.disabled),
                  )
                }
                onRemove={() =>
                  void confirm({
                    title: t('config:accounts.removeTitle', { email: account.email }),
                    body: t('config:accounts.removeBody'),
                    confirmLabel: t('common:actions.remove'),
                    danger: true,
                  }).then(async (ok) => {
                    if (ok) {
                      await act(
                        t('config:accounts.removed', { email: account.email }),
                        t('config:accounts.removeFailed', { email: account.email }),
                        () => api.removeAccount(account.number),
                      );
                    }
                  })
                }
              />
            ))}
          </ul>

          {data.accounts.length > 1 && (
            <div className="alert alert-note">
              <Info {...ICON_SM} className="alert-icon" aria-hidden />
              <div className="alert-body">{t('config:accounts.switchNote')}</div>
            </div>
          )}

          <AutoSwitchCard settings={data.autoSwitch} running={data.autoSwitchRunning} />

          <PoliciesCard policies={data.policies} accounts={data.accounts} />

          <UsageHistoryCard accounts={data.accounts} threshold={data.autoSwitch.threshold} />

          <Card
            className="rotation-log"
            title={t('config:accounts.log')}
            actions={
              <button type="button" className="btn btn-small" onClick={() => setFullHistory((v) => !v)}>
                {fullHistory ? t('config:accounts.recentOnly') : t('config:accounts.fullHistory')}
              </button>
            }
          >
            {events.length === 0 ? (
              <Empty icon={RefreshCw} title={t('config:accounts.nothingYet')}>
                {t('config:accounts.logHint')}
              </Empty>
            ) : (
              <ul className="list">
                {[...events].reverse().slice(0, fullHistory ? 500 : 40).map((event) => (
                  <li key={event.seq} className="list-row list-row-flow small">
                    <StatusBadge status={event.event} />
                    <span className="muted nowrap mono" title={formatDateTime(event.ts)}>
                      {timeAgo(event.ts)}
                    </span>
                    <span className="break">
                      {event.from && event.to ? `${event.from} → ${event.to}` : (event.reason ?? event.detail ?? '')}
                      {event.from && event.to && event.reason ? ` · ${event.reason}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
