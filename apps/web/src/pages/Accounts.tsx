import { useQueryClient } from '@tanstack/react-query';
import type { AccountSummary, AutoSwitchSettings } from '@agentry/shared';
import { ChevronLeft, ChevronRight, Info, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api, keys, useAccountEvents, useAccounts } from '../api';
import { MoreActions } from '../components/controls';
import { useConfirm } from '../components/Dialog';
import { ICON, ICON_SM } from '../components/icons';
import { useToast } from '../components/Toast';
import { Card, Empty, ErrorBox, PageHeader, Skeleton, StatusBadge, usePageTitle } from '../components/ui';
import { cswapInstalling, cswapRemovable } from '../lib/cswap';
import { formatDateTime, timeAgo, toMs } from '../lib/format';
import { NARROW, useMediaQuery } from '../lib/media';
import { AccountCard, ExhaustedAccountRow } from './accounts/AccountCard';
import { AddAccountDialog } from './accounts/AddAccountDialog';
import { AutoSwitchCard } from './accounts/AutoSwitchCard';
import { CswapMissing, CswapNotice } from './accounts/CswapSetup';
import { PoliciesCard } from './accounts/PoliciesCard';
import { UsageHistoryCard } from './accounts/UsageHistoryCard';
import { accountExhausted, sortAccounts } from './accounts/usage';
import '../insights.css';

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
  // On a phone automatic rotation is a screen of its own, reached from a cell under the accounts
  const narrow = useMediaQuery(NARROW);
  const [params, setParams] = useSearchParams();

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.accounts });

  const [starting, setStarting] = useState(false);
  const install = async () => {
    setStarting(true);
    try {
      const cswap = await api.installCswap();
      // Shows the progress at once instead of at the next read
      queryClient.setQueryData(keys.accounts, (old: typeof data) => (old ? { ...old, cswap } : old));
      await refresh();
    } catch (err) {
      toast.error(t('cswap.installStartFailed'), err);
    } finally {
      setStarting(false);
    }
  };

  // The install ends on its own, in the background: the page catches the moment claude-swap turns
  // up and, with no account yet, goes straight on to adding the first one
  const installing = data ? cswapInstalling(data.cswap) : false;
  const wasInstalling = useRef(false);
  useEffect(() => {
    if (wasInstalling.current && !installing && data?.cswap.installed) {
      void refresh();
      if (data.accounts.length === 0) setAdding(true);
    }
    wasInstalling.current = installing;
  }, [installing, data?.cswap.installed]);

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
  const removeCswap = () =>
    void confirm({
      title: t('cswap.removeTitle'),
      body: t('cswap.removeBody'),
      confirmLabel: t('common:actions.remove'),
      danger: true,
    }).then(async (ok) => {
      if (ok) await act(t('cswap.removed'), t('cswap.removeFailed'), () => api.removeCswap());
    });
  const toggle = (account: AccountSummary) =>
    void act(
      account.disabled ? t('config:accounts.backInRotation', { email: account.email }) : t('config:accounts.heldOut', { email: account.email }),
      account.disabled ? t('config:accounts.backInRotationFailed', { email: account.email }) : t('config:accounts.heldOutFailed', { email: account.email }),
      () => api.setAccountEnabled(account.number, account.disabled),
    );
  const remove = (account: AccountSummary) =>
    void confirm({
      title: t('config:accounts.removeTitle', { email: account.email }),
      body: t('config:accounts.removeBody'),
      confirmLabel: t('common:actions.remove'),
      danger: true,
    }).then(async (ok) => {
      if (ok) {
        await act(t('config:accounts.removed', { email: account.email }), t('config:accounts.removeFailed', { email: account.email }), () => api.removeAccount(account.number));
      }
    });

  if (narrow && installed && data.accounts.length > 0 && params.get('view') === 'rotation') {
    // Back is a step up to the accounts, not through history: a deep link has nothing behind it
    return <PhoneRotation onBack={() => setParams({})} settings={data.autoSwitch} running={data.autoSwitchRunning} />;
  }

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
                data.cswap.source === 'managed' ? t('cswap.managedSource') : null,
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
            {cswapRemovable(data.cswap) && (
              <MoreActions
                label={t('cswap.more')}
                title={t('cswap.more')}
                entries={[{ id: 'remove-cswap', label: t('cswap.remove'), icon: Trash2, destructive: true, disabled: busy, onSelect: removeCswap }]}
              />
            )}
          </>
        }
      />

      {adding && <AddAccountDialog onClose={closeAdd} onAdded={() => void refresh()} />}

      {installed && <CswapNotice cswap={data.cswap} onInstall={() => void install()} starting={starting} />}

      {!installed ? (
        <CswapMissing cswap={data.cswap} onInstall={() => void install()} starting={starting} />
      ) : data.accounts.length === 0 ? (
        <Empty illustration="signed-out" tone="warn" title={t('config:accounts.none')} action={addButton}>
          {t('page.noneHint')}
        </Empty>
      ) : (
        <>
          <ul className="account-grid">
            {accounts.map((account) =>
              narrow && !account.active && accountExhausted(account) ? (
                <ExhaustedAccountRow key={account.number} account={account} busy={busy} onToggle={() => toggle(account)} onRemove={() => remove(account)} />
              ) : (
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
                  onToggle={() => toggle(account)}
                  onRemove={() => remove(account)}
                />
              ),
            )}
          </ul>

          {data.accounts.length > 1 && (
            <div className="alert alert-note">
              <Info {...ICON_SM} className="alert-icon" aria-hidden />
              <div className="alert-body">{t('config:accounts.switchNote')}</div>
            </div>
          )}

          {narrow ? (
            <Link to="/accounts?view=rotation" className="card rotation-cell">
              <span className="rotation-cell-text">
                <span className="rotation-cell-title">{t('config:accounts.autoRotation')}</span>
                <span className="rotation-cell-sub">
                  {data.autoSwitchRunning ? t('rotation.running') : data.autoSwitch.enabled ? t('rotation.stopped') : t('rotation.off')} ·{' '}
                  {t('rotation.thresholdShort', { pct: data.autoSwitch.threshold })}
                </span>
              </span>
              <ChevronRight className="rotation-cell-chevron" {...ICON} />
            </Link>
          ) : (
            <AutoSwitchCard settings={data.autoSwitch} running={data.autoSwitchRunning} />
          )}

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

/** Automatic rotation on a phone: its card on a screen of its own, with the way back to the accounts above it. */
function PhoneRotation({ onBack, settings, running }: { onBack: () => void; settings: AutoSwitchSettings; running: boolean }) {
  const { t } = useTranslation(['accountsConfig', 'config']);
  usePageTitle(t('config:accounts.autoRotation'));
  return (
    <div className="stack accounts-page">
      <header className="settings-phone-head">
        <button type="button" className="icon-btn settings-phone-back" aria-label={t('rotation.back')} onClick={onBack}>
          <ChevronLeft {...ICON} />
        </button>
        <h1 className="settings-phone-title">{t('config:accounts.autoRotation')}</h1>
      </header>
      <AutoSwitchCard settings={settings} running={running} />
    </div>
  );
}
