import type { AccountConfig, AccountSummary, AccountUsageWindow } from '@agentry/shared';
import { CircleCheck, CirclePause, Ellipsis, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, Sheet, type MenuItem } from '../../components/controls';
import { ICON_SM } from '../../components/icons';
import { usageTone } from '../../components/motion';
import { StatusBadge, Tag } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { NARROW, useMediaQuery } from '../../lib/media';
import { ConfigDirPanel } from './ConfigDirPanel';
import { accountExhausted, bindingReset, timeToReset, windowExhausted } from './usage';

/** `in 2 d 10 h`, or `back in 19 min` for a window that is spent: sentence case, never a title. */
function useResetText() {
  const { t } = useTranslation('accountsConfig');
  return (win: AccountUsageWindow, spent: boolean): string | null => {
    const left = timeToReset(win);
    if (left === null) return null;
    if (left === 0) return t('reset.now');
    return spent ? t('reset.back', { duration: left }) : t('reset.in', { duration: left });
  };
}

function WindowMeter({ label, win, resetInHead }: { label: string; win: AccountUsageWindow | null; resetInHead: boolean }) {
  const { t } = useTranslation('accountsConfig');
  const resetText = useResetText();
  if (!win) return null;
  const pct = Math.min(100, Math.round(win.pct));
  const spent = windowExhausted(win);
  const tone = usageTone(pct, spent);
  // Neutral below the threshold on every account, as in the status bar: the active one already
  // wears the brand on its card, and a coloured bar would read as a warning
  const fill = tone === 'neutral' ? '' : `is-${tone}`;
  const reset = spent && resetInHead ? null : resetText(win, spent);
  return (
    <div className="account-meter">
      <div className="account-meter-head">
        <span className="account-meter-label">
          {label}
          {win.name ? ` · ${win.name}` : ''}
        </span>
        {spent ? <Tag tone="bad">{t('card.exhausted')}</Tag> : tone !== 'neutral' ? <Tag tone={tone === 'bad' ? 'bad' : 'warn'}>{t('card.runningHigh')}</Tag> : null}
        {reset && <span className="account-meter-reset">{reset}</span>}
        {win.resetsAt && <span className="sr-only">({formatDateTime(win.resetsAt)})</span>}
        <span className="account-meter-pct">
          {pct}%<span className="sr-only"> {t('card.used')}</span>
        </span>
      </div>
      <div className="meter-track" aria-hidden>
        <div className={`meter-fill ${fill}`.trim()} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** The `⋯` of a card: a menu by the button on a desktop, a sheet from the bottom on a phone. */
function MoreActions({ label, title, items }: { label: string; title: string; items: MenuItem[] }) {
  const narrow = useMediaQuery(NARROW);
  const [open, setOpen] = useState(false);
  if (!narrow) return <Menu entries={items} label={label} className="account-more" />;
  return (
    <>
      <button type="button" className="icon-btn account-more" aria-label={label} onClick={() => setOpen(true)}>
        <Ellipsis {...ICON_SM} />
      </button>
      <Sheet open={open} onOpenChange={setOpen} title={title}>
        <div className="account-sheet-actions">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`btn btn-block ${item.destructive ? 'btn-danger' : ''}`.trim()}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {Icon && <Icon {...ICON_SM} />}
                {item.label}
              </button>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}

export function AccountCard({
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
  const { t } = useTranslation(['accountsConfig', 'config']);
  const resetText = useResetText();
  const name = account.alias ?? account.email;
  const exhausted = accountExhausted(account);
  const binding = exhausted ? bindingReset(account) : null;
  const backIn = binding ? resetText(binding, true) : null;
  const sub = [account.alias ? account.email : null, account.organizationName].filter(Boolean).join(' · ');
  const toggleLabel = account.disabled ? t('config:accounts.returnToRotation') : t('config:accounts.holdOut');

  const toggleItem: MenuItem = { id: 'toggle', label: toggleLabel, icon: account.disabled ? CircleCheck : CirclePause, disabled: busy, onSelect: onToggle };
  const removeItem: MenuItem = { id: 'remove', label: t('config:accounts.removeAccount'), icon: Trash2, destructive: true, disabled: busy, onSelect: onRemove };
  // The account in use shows its hold-out as a button; the others keep it with removal behind the ⋯
  const menu = account.active ? [removeItem] : [toggleItem, removeItem];

  const classes = ['card', 'account-card', account.active ? 'grad-border glow-top is-active' : '', exhausted ? 'is-exhausted' : ''].filter(Boolean).join(' ');

  return (
    <li className={classes}>
      <div className="account-head">
        <span className="account-avatar" aria-hidden>
          {name.charAt(0).toUpperCase()}
        </span>
        <span className="account-id">
          <span className="account-name">
            <span className="account-email">{name}</span>
            {account.active && <span className="badge badge-grad">{t('card.inUse')}</span>}
            {account.disabled && <Tag tone="muted">{t('config:accounts.outOfRotation')}</Tag>}
            {account.usageStatus !== 'ok' && <StatusBadge status={account.usageStatus} />}
          </span>
          <span className="account-sub">
            {sub && <span className="account-org">{sub}</span>}
            <span className="mono">#{account.number}</span>
          </span>
        </span>
        {account.headroomPct !== null && (
          <span className="account-figure">
            <span className={`account-figure-value ${exhausted ? 'text-bad' : account.active ? 'grad-text' : ''}`.trim()}>
              {account.headroomPct}%<span className="sr-only"> {t('card.free')}</span>
            </span>
            <span className="section-label" aria-hidden={!backIn}>
              {backIn ?? t('card.free')}
            </span>
          </span>
        )}
      </div>

      <div className="account-meters">
        {account.usage ? (
          <>
            <WindowMeter label={t('config:accounts.fiveHours')} win={account.usage.fiveHour} resetInHead={!!backIn} />
            <WindowMeter label={t('config:accounts.sevenDays')} win={account.usage.sevenDay} resetInHead={!!backIn} />
            {account.usage.scoped.map((win) => (
              <WindowMeter key={win.name ?? 'model'} label={t('config:accounts.sevenDays')} win={win} resetInHead={false} />
            ))}
          </>
        ) : (
          <p className="muted small">
            {account.usageStatus !== 'ok' ? t('config:accounts.noUsageStatus', { status: account.usageStatus }) : t('config:accounts.noUsage')}
          </p>
        )}
      </div>

      <div className="account-foot">
        <ConfigDirPanel account={account} config={config} />
        <span className="account-actions">
          {account.active ? (
            <button type="button" className="btn btn-small" onClick={onToggle} disabled={busy} aria-label={`${toggleLabel}: ${name}`}>
              {account.disabled ? <CircleCheck {...ICON_SM} /> : <CirclePause {...ICON_SM} />}
              <span className="account-action-text">{toggleLabel}</span>
            </button>
          ) : (
            <button
              type="button"
              className={`btn btn-small ${exhausted ? '' : 'btn-primary'}`.trim()}
              onClick={onSwitch}
              disabled={busy || exhausted}
              aria-label={t('card.useNamed', { name })}
            >
              {t('card.use')}
            </button>
          )}
          <MoreActions label={t('card.more', { name })} title={name} items={menu} />
        </span>
      </div>
    </li>
  );
}
