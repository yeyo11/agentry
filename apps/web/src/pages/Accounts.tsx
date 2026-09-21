import type { AccountConfig, AccountSummary, AccountUsageWindow, AutoSwitchSettings } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CirclePause, CirclePlay, CircleX, KeyRound, RefreshCw, Trash2, TriangleAlert, Users } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, keys, useAccountEvents, useAccounts } from '../api';
import { NumberInput, Select, Slider, Switch, Tooltip } from '../components/controls';
import { useConfirm } from '../components/Dialog';
import { ICON_SM } from '../components/icons';
import { useToast } from '../components/Toast';
import { Card, Empty, ErrorBox, Field, PageHeader, Skeleton, StatusBadge, Tag } from '../components/ui';
import { formatDateTime, timeAgo } from '../lib/format';
import { ConfigDirPanel } from './accounts/ConfigDirPanel';
import { PoliciesCard } from './accounts/PoliciesCard';
import { UsageHistoryCard } from './accounts/UsageHistoryCard';

const STRATEGIES = ['best', 'consume-first'] as const;

function tone(pct: number): string {
  return pct >= 90 ? 'is-bad' : pct >= 70 ? 'is-warn' : '';
}

function Meter({ label, window: win }: { label: string; window: AccountUsageWindow | null }) {
  const { t } = useTranslation(['config', 'common']);
  if (!win) return null;
  const pct = Math.min(100, Math.round(win.pct));
  return (
    <div>
      <div className="meter-head small">
        <span>
          {label}
          {win.name ? ` · ${win.name}` : ''}
        </span>
        <span className="muted meta-icon">
          {/* The bar turns amber and red; the icon and the words say the same to anyone who cannot tell them apart */}
          {pct >= 90 ? (
            <CircleX className="text-bad" {...ICON_SM} />
          ) : pct >= 70 ? (
            <TriangleAlert className="text-warn" {...ICON_SM} />
          ) : null}
          {pct}%{' '}
          {pct >= 90 ? <span className="sr-only">{t('accounts.usedNearlyOut')} </span> : pct >= 70 ? <span className="sr-only">{t('accounts.usedRunningHigh')} </span> : null}
          {win.countdown ? t('accounts.resetsIn', { countdown: win.countdown }) : ''}
          {win.resetsAt && <span className="sr-only"> ({formatDateTime(win.resetsAt)})</span>}
        </span>
      </div>
      <div className="meter-track" aria-hidden>
        <div className={`meter-fill ${tone(pct)}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function AccountCard({
  account,
  config,
  busy,
  onSwitch,
  onToggle,
  onRemove,
}: {
  account: AccountSummary;
  config: AccountConfig | undefined;
  busy: boolean;
  onSwitch: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation(['config', 'common']);
  return (
    <Card
      title={
        <span className="meta">
          <span className="strong break">{account.alias ?? account.email}</span>
          {account.active && <Tag tone="ok">{t('accounts.active')}</Tag>}
          {account.disabled && <Tag tone="muted">{t('accounts.outOfRotation')}</Tag>}
          {account.usageStatus !== 'ok' && <StatusBadge status={account.usageStatus} />}
        </span>
      }
      actions={
        <span className="toolbar">
          {!account.active && (
            <button type="button" className="btn btn-small" onClick={onSwitch} disabled={busy} aria-label={t('accounts.useAccount', { name: account.alias ?? account.email })}>
              <CirclePlay {...ICON_SM} /> {t('accounts.use')}
            </button>
          )}
          <Tooltip content={account.disabled ? t('accounts.returnToRotation') : t('accounts.holdOut')}>
            <button
              type="button"
              className="btn btn-small"
              onClick={onToggle}
              disabled={busy}
              aria-label={`${account.disabled ? t('accounts.returnToRotation') : t('accounts.holdOut')}: ${account.alias ?? account.email}`}
            >
              {account.disabled ? <CircleCheck {...ICON_SM} /> : <CirclePause {...ICON_SM} />}
            </button>
          </Tooltip>
          <Tooltip content={t('accounts.removeAccount')}>
            <button type="button" className="btn btn-small btn-danger" onClick={onRemove} disabled={busy} aria-label={`${t('accounts.removeAccount')} ${account.alias ?? account.email}`}>
              <Trash2 {...ICON_SM} />
            </button>
          </Tooltip>
        </span>
      }
    >
      <div className="meters">
        <div className="meta small">
          <span className="mono">#{account.number}</span>
          <span className="muted break">{account.email}</span>
          {account.organizationName && <span className="muted break">{account.organizationName}</span>}
          {account.headroomPct !== null && <span>{t('accounts.quotaLeft', { pct: account.headroomPct })}</span>}
        </div>
        {account.usage ? (
          <>
            <Meter label={t('accounts.fiveHours')} window={account.usage.fiveHour} />
            <Meter label={t('accounts.sevenDays')} window={account.usage.sevenDay} />
            {account.usage.scoped.map((win) => (
              <Meter key={win.name ?? 'model'} label={t('accounts.sevenDays')} window={win} />
            ))}
          </>
        ) : (
          <div className="muted small">
            {account.usageStatus !== 'ok' ? t('accounts.noUsageStatus', { status: account.usageStatus }) : t('accounts.noUsage')}
          </div>
        )}
        {account.usageFetchedAt && <div className="muted small">{t('accounts.usageRead', { ago: timeAgo(account.usageFetchedAt) })}</div>}
      </div>
      <ConfigDirPanel account={account} config={config} />
    </Card>
  );
}

function AddAccount({ onAdded }: { onAdded: () => void }) {
  const { t } = useTranslation(['config', 'common']);
  const toast = useToast();
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const mutation = useMutation({
    mutationFn: () => api.addAccount({ token, email: email.trim() || undefined }),
    onSuccess: () => {
      setToken('');
      setEmail('');
      toast.success(t('accounts.registered'));
      onAdded();
    },
    onError: (err) => toast.error(t('accounts.registerFailed'), err),
  });

  return (
    <Card title={t('accounts.add')}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) mutation.mutate();
        }}
      >
        <Field label={t('accounts.token')} hint={t('accounts.tokenHint')}>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="sk-ant-oat…" autoComplete="off" />
        </Field>
        <Field label={t('accounts.label')} hint={t('accounts.labelHint')}>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="work@example.com" autoComplete="off" />
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!token.trim() || mutation.isPending}>
            <KeyRound {...ICON_SM} /> {mutation.isPending ? t('accounts.registering') : t('accounts.register')}
          </button>
        </div>
      </form>
    </Card>
  );
}

function AutoSwitchPanel({ settings, running }: { settings: AutoSwitchSettings; running: boolean }) {
  const { t } = useTranslation(['config', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState(settings);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const mutation = useMutation({
    mutationFn: (next: Partial<AutoSwitchSettings>) => api.setAutoSwitch(next),
    onSuccess: (saved) => {
      setDraft(saved);
      toast.success(t('accounts.autoUpdated'));
      void queryClient.invalidateQueries({ queryKey: keys.accounts });
    },
    onError: (err) => toast.error(t('accounts.autoUpdateFailed'), err),
  });

  return (
    <Card
      title={t('accounts.autoRotation')}
      actions={running ? <Tag tone="ok">{t('accounts.supervisorRunning')}</Tag> : <Tag tone="muted">{t('accounts.stopped')}</Tag>}
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(draft);
        }}
      >
        <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })}>
          {t('accounts.rotateBefore')}
        </Switch>
        <Switch checked={draft.rotateOnLimit} onChange={(rotateOnLimit) => setDraft({ ...draft, rotateOnLimit })}>
          {t('accounts.rotateOnLimit')}
        </Switch>
        <div className="form-grid">
          <Field label={t('accounts.thresholdValue', { pct: draft.threshold })} hint={t('accounts.thresholdHint')}>
            <Slider
              aria-label={t('accounts.threshold')}
              min={50}
              max={99}
              value={draft.threshold}
              onChange={(threshold) => setDraft({ ...draft, threshold })}
            />
          </Field>
          <Field label={t('accounts.strategy')} hint={t('accounts.strategyHint')}>
            <Select<AutoSwitchSettings['strategy']>
              value={draft.strategy}
              onChange={(strategy) => setDraft({ ...draft, strategy })}
              options={STRATEGIES.map((s) => ({ value: s, label: s }))}
            />
          </Field>
          <Field label={t('accounts.interval')} hint={t('accounts.intervalHint')}>
            <NumberInput
              min={15}
              max={3600}
              step={15}
              value={draft.intervalSec}
              onChange={(intervalSec) => setDraft({ ...draft, intervalSec: intervalSec ?? 0 })}
            />
          </Field>
          <Field label={t('accounts.models')} hint={t('accounts.modelsHint')}>
            <input
              value={draft.models.join(',')}
              onChange={(e) => setDraft({ ...draft, models: e.target.value.split(',').map((m) => m.trim()).filter(Boolean) })}
              placeholder="Fable,Opus"
            />
          </Field>
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!dirty || mutation.isPending}>
            {t('shared.save')}
          </button>
          {dirty && (
            <button type="button" className="btn btn-small" onClick={() => setDraft(settings)}>
              {t('shared.reset')}
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

export function Accounts() {
  const { t } = useTranslation(['config', 'common']);
  const { data, error, isLoading, refetch, isFetching } = useAccounts();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
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

  const liveRotationWarning = data.accounts.length > 1;
  // Falls back to the overview's window while the history query is still in flight
  const events = fullHistory ? (history.data ?? data.events) : data.events;

  return (
    <div className="stack">
      <PageHeader
        title={t('accounts.title')}
        subtitle={
          data.cswap.installed
            ? `claude-swap ${data.cswap.version ?? ''} · ${t('accounts.count', { count: data.accounts.length })}`
            : t('accounts.needsCswap')
        }
        actions={
          <button type="button" className="btn btn-small" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw {...ICON_SM} /> {t('accounts.refreshUsage')}
          </button>
        }
      />

      {!data.cswap.installed ? (
        <Empty icon={Users} title={t('accounts.notInstalled')}>
          <Trans
            t={t}
            i18nKey="accounts.notInstalledHint"
            components={{
              anchor: <a href="https://github.com/realiti4/claude-swap" target="_blank" rel="noreferrer" />,
              code: <code className="mono" />,
            }}
          />
          {data.cswap.error && <div className="muted small">{data.cswap.error}</div>}
        </Empty>
      ) : (
        <>
          <div className="grid-2">
            {data.accounts.map((account) => (
              <AccountCard
                key={account.number}
                account={account}
                config={data.configs.find((c) => c.number === account.number)}
                busy={busy}
                onSwitch={() =>
                  void act(
                    t('accounts.switched', { email: account.email }),
                    t('accounts.switchFailed', { email: account.email }),
                    () => api.switchAccount({ target: String(account.number) }),
                  )
                }
                onToggle={() =>
                  void act(
                    account.disabled ? t('accounts.backInRotation', { email: account.email }) : t('accounts.heldOut', { email: account.email }),
                    account.disabled
                      ? t('accounts.backInRotationFailed', { email: account.email })
                      : t('accounts.heldOutFailed', { email: account.email }),
                    () => api.setAccountEnabled(account.number, account.disabled),
                  )
                }
                onRemove={() =>
                  void confirm({
                    title: t('accounts.removeTitle', { email: account.email }),
                    body: t('accounts.removeBody'),
                    confirmLabel: t('common:actions.remove'),
                    danger: true,
                  }).then(async (ok) => {
                    if (ok) {
                      await act(
                        t('accounts.removed', { email: account.email }),
                        t('accounts.removeFailed', { email: account.email }),
                        () => api.removeAccount(account.number),
                      );
                    }
                  })
                }
              />
            ))}
          </div>

          {data.accounts.length === 0 && (
            <Empty icon={Users} title={t('accounts.none')}>
              {t('accounts.noneHint')}
            </Empty>
          )}

          {liveRotationWarning && (
            <div className="muted small">
              {t('accounts.switchNote')}
            </div>
          )}

          <div className="grid-2">
            <AddAccount onAdded={() => void refresh()} />
            <AutoSwitchPanel settings={data.autoSwitch} running={data.autoSwitchRunning} />
          </div>

          <UsageHistoryCard accounts={data.accounts} threshold={data.autoSwitch.threshold} />

          <PoliciesCard policies={data.policies} accounts={data.accounts} />

          <Card
            title={t('accounts.log')}
            actions={
              <button type="button" className="btn btn-small" onClick={() => setFullHistory((v) => !v)}>
                {fullHistory ? t('accounts.recentOnly') : t('accounts.fullHistory')}
              </button>
            }
          >
            {events.length === 0 ? (
              <Empty icon={RefreshCw} title={t('accounts.nothingYet')}>
                {t('accounts.logHint')}
              </Empty>
            ) : (
              <ul className="list">
                {[...events].reverse().slice(0, fullHistory ? 500 : 40).map((event) => (
                  <li key={event.seq} className="list-row list-row-flow small">
                    <StatusBadge status={event.event} />
                    <span className="muted nowrap" title={formatDateTime(event.ts)}>
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
