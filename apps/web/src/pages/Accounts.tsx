import type { AccountSummary, AccountUsageWindow, AutoSwitchSettings } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CirclePause, CirclePlay, CircleX, KeyRound, RefreshCw, Trash2, TriangleAlert, Users } from 'lucide-react';
import { useState } from 'react';
import { api, keys, useAccountEvents, useAccounts } from '../api';
import { NumberInput, Select, Slider, Switch, Tooltip } from '../components/controls';
import { useConfirm } from '../components/Dialog';
import { ICON_SM } from '../components/icons';
import { useToast } from '../components/Toast';
import { Card, Empty, ErrorBox, Field, PageHeader, Skeleton, StatusBadge, Tag } from '../components/ui';
import { formatDateTime, timeAgo } from '../lib/format';

const STRATEGIES = ['best', 'consume-first'] as const;

function tone(pct: number): string {
  return pct >= 90 ? 'is-bad' : pct >= 70 ? 'is-warn' : '';
}

function Meter({ label, window: win }: { label: string; window: AccountUsageWindow | null }) {
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
          {pct}% {pct >= 90 ? <span className="sr-only">used, nearly out </span> : pct >= 70 ? <span className="sr-only">used, running high </span> : null}
          {win.countdown ? `· resets in ${win.countdown}` : ''}
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
  busy,
  onSwitch,
  onToggle,
  onRemove,
}: {
  account: AccountSummary;
  busy: boolean;
  onSwitch: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  return (
    <Card
      title={
        <span className="meta">
          <span className="strong break">{account.alias ?? account.email}</span>
          {account.active && <Tag tone="ok">active</Tag>}
          {account.disabled && <Tag tone="muted">out of rotation</Tag>}
          {account.usageStatus !== 'ok' && <StatusBadge status={account.usageStatus} />}
        </span>
      }
      actions={
        <span className="toolbar">
          {!account.active && (
            <button type="button" className="btn btn-small" onClick={onSwitch} disabled={busy} aria-label={`Use ${account.alias ?? account.email}`}>
              <CirclePlay {...ICON_SM} /> Use
            </button>
          )}
          <Tooltip content={account.disabled ? 'Return to the rotation' : 'Hold out of the rotation'}>
            <button
              type="button"
              className="btn btn-small"
              onClick={onToggle}
              disabled={busy}
              aria-label={`${account.disabled ? 'Return to the rotation' : 'Hold out of the rotation'}: ${account.alias ?? account.email}`}
            >
              {account.disabled ? <CircleCheck {...ICON_SM} /> : <CirclePause {...ICON_SM} />}
            </button>
          </Tooltip>
          <Tooltip content="Remove the account">
            <button type="button" className="btn btn-small btn-danger" onClick={onRemove} disabled={busy} aria-label={`Remove the account ${account.alias ?? account.email}`}>
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
          {account.headroomPct !== null && <span>{account.headroomPct}% quota left</span>}
        </div>
        {account.usage ? (
          <>
            <Meter label="5 hours" window={account.usage.fiveHour} />
            <Meter label="7 days" window={account.usage.sevenDay} />
            {account.usage.scoped.map((win) => (
              <Meter key={win.name ?? 'model'} label="7 days" window={win} />
            ))}
          </>
        ) : (
          <div className="muted small">No usage reported{account.usageStatus !== 'ok' ? ` (${account.usageStatus})` : ''}.</div>
        )}
        {account.usageFetchedAt && <div className="muted small">usage read {timeAgo(account.usageFetchedAt)}</div>}
      </div>
    </Card>
  );
}

function AddAccount({ onAdded }: { onAdded: () => void }) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const mutation = useMutation({
    mutationFn: () => api.addAccount({ token, email: email.trim() || undefined }),
    onSuccess: () => {
      setToken('');
      setEmail('');
      toast.success('Account registered');
      onAdded();
    },
    onError: (err) => toast.error('Could not register the account', err),
  });

  return (
    <Card title="Add an account">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) mutation.mutate();
        }}
      >
        <Field label="Token" hint="Run `claude setup-token` while logged in as that account, or paste an API key. It is stored by claude-swap and never returned by the API.">
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="sk-ant-oat…" autoComplete="off" />
        </Field>
        <Field label="Label (optional)" hint="Shown until claude-swap resolves the real email.">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="work@example.com" autoComplete="off" />
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!token.trim() || mutation.isPending}>
            <KeyRound {...ICON_SM} /> {mutation.isPending ? 'Registering…' : 'Register'}
          </button>
        </div>
      </form>
    </Card>
  );
}

function AutoSwitchPanel({ settings, running }: { settings: AutoSwitchSettings; running: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState(settings);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const mutation = useMutation({
    mutationFn: (next: Partial<AutoSwitchSettings>) => api.setAutoSwitch(next),
    onSuccess: (saved) => {
      setDraft(saved);
      toast.success('Auto-rotation updated');
      void queryClient.invalidateQueries({ queryKey: keys.accounts });
    },
    onError: (err) => toast.error('Could not update auto-rotation', err),
  });

  return (
    <Card
      title="Auto-rotation"
      actions={running ? <Tag tone="ok">supervisor running</Tag> : <Tag tone="muted">stopped</Tag>}
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(draft);
        }}
      >
        <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })}>
          Rotate before the active account runs out (`cswap auto`)
        </Switch>
        <Switch checked={draft.rotateOnLimit} onChange={(rotateOnLimit) => setDraft({ ...draft, rotateOnLimit })}>
          Rotate and resume a run that dies against its limit
        </Switch>
        <div className="form-grid">
          <Field label={`Threshold · ${draft.threshold}%`} hint="Utilization of the binding 5h/7d window that triggers a switch.">
            <Slider
              aria-label="Threshold"
              min={50}
              max={99}
              value={draft.threshold}
              onChange={(threshold) => setDraft({ ...draft, threshold })}
            />
          </Field>
          <Field label="Strategy" hint="`best` stays until the limit; `consume-first` spends the soonest-resetting account first.">
            <Select<AutoSwitchSettings['strategy']>
              value={draft.strategy}
              onChange={(strategy) => setDraft({ ...draft, strategy })}
              options={STRATEGIES.map((s) => ({ value: s, label: s }))}
            />
          </Field>
          <Field label="Poll interval (s)" hint="Minimum 15.">
            <NumberInput
              min={15}
              max={3600}
              step={15}
              value={draft.intervalSec}
              onChange={(intervalSec) => setDraft({ ...draft, intervalSec: intervalSec ?? 0 })}
            />
          </Field>
          <Field label="Per-model windows" hint="Comma-separated display names (Fable, Opus…) or `all`. Empty watches only the account-wide windows.">
            <input
              value={draft.models.join(',')}
              onChange={(e) => setDraft({ ...draft, models: e.target.value.split(',').map((m) => m.trim()).filter(Boolean) })}
              placeholder="Fable,Opus"
            />
          </Field>
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!dirty || mutation.isPending}>
            Save
          </button>
          {dirty && (
            <button type="button" className="btn btn-small" onClick={() => setDraft(settings)}>
              Reset
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

export function Accounts() {
  const { data, error, isLoading, refetch, isFetching } = useAccounts();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // The overview carries the most recent window; the rest of the history is one query away
  const [fullHistory, setFullHistory] = useState(false);
  const history = useAccountEvents(fullHistory);

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.accounts });

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      toast.success(label);
      await refresh();
    } catch (err) {
      toast.error(`${label} failed`, err);
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
        title="Accounts"
        subtitle={
          data.cswap.installed
            ? `claude-swap ${data.cswap.version ?? ''} · ${data.accounts.length} account${data.accounts.length === 1 ? '' : 's'}`
            : 'Multi-account support needs claude-swap'
        }
        actions={
          <button type="button" className="btn btn-small" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw {...ICON_SM} /> Refresh usage
          </button>
        }
      />

      {!data.cswap.installed ? (
        <Empty icon={Users} title="claude-swap is not installed">
          Several accounts and automatic rotation are delegated to{' '}
          <a href="https://github.com/realiti4/claude-swap" target="_blank" rel="noreferrer">
            claude-swap
          </a>
          . Install it with <code className="mono">uv tool install claude-swap</code> (it ships in the Docker image), then
          register each account with a token from <code className="mono">claude setup-token</code>.
          {data.cswap.error && <div className="muted small">{data.cswap.error}</div>}
        </Empty>
      ) : (
        <>
          <div className="grid-2">
            {data.accounts.map((account) => (
              <AccountCard
                key={account.number}
                account={account}
                busy={busy}
                onSwitch={() => void act(`Switched to ${account.email}`, () => api.switchAccount({ target: String(account.number) }))}
                onToggle={() =>
                  void act(
                    account.disabled ? `${account.email} back in rotation` : `${account.email} held out of rotation`,
                    () => api.setAccountEnabled(account.number, account.disabled),
                  )
                }
                onRemove={() =>
                  void confirm({
                    title: `Remove ${account.email}?`,
                    body: 'claude-swap drops its stored credential. You can register it again with a new setup-token.',
                    confirmLabel: 'Remove',
                    danger: true,
                  }).then(async (ok) => {
                    if (ok) await act(`Removed ${account.email}`, () => api.removeAccount(account.number));
                  })
                }
              />
            ))}
          </div>

          {data.accounts.length === 0 && (
            <Empty icon={Users} title="No accounts registered yet">
              Register the first one below. Until then the wrapper keeps using the credential from its own configuration.
            </Empty>
          )}

          {liveRotationWarning && (
            <div className="muted small">
              Switching rewrites the shared credential file. Runs already in flight keep the account they started with; new
              runs and resumed turns use the active one.
            </div>
          )}

          <div className="grid-2">
            <AddAccount onAdded={() => void refresh()} />
            <AutoSwitchPanel settings={data.autoSwitch} running={data.autoSwitchRunning} />
          </div>

          <Card
            title="Rotation log"
            actions={
              <button type="button" className="btn btn-small" onClick={() => setFullHistory((v) => !v)}>
                {fullHistory ? 'Recent only' : 'Full history'}
              </button>
            }
          >
            {events.length === 0 ? (
              <Empty icon={RefreshCw} title="Nothing yet">
                Switches, polls and quarantines show up here once auto-rotation runs.
              </Empty>
            ) : (
              <ul className="list">
                {[...events].reverse().slice(0, fullHistory ? 500 : 40).map((event) => (
                  <li key={event.seq} className="list-row small">
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
