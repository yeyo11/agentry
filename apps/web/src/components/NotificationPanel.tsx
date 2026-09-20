import * as Popover from '@radix-ui/react-popover';
import { CircleAlert, CircleCheck, CircleHelp, Gauge, GitMerge, Timer, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { timeAgo } from '../lib/format';
import {
  browserPermission,
  clearNotifications,
  enableBrowserNotifications,
  KINDS,
  markAllRead,
  markRead,
  setPrefs,
  unreadCount,
  useNotificationPrefs,
  useNotifications,
  type AppNotification,
} from '../lib/notifications';
import { Collapsible } from './controls/Collapsible';
import { LAYER_ATTR } from './controls/layer';
import { Switch } from './controls/Toggle';
import { ICON } from './icons';

function iconFor(n: AppNotification): LucideIcon {
  switch (n.kind) {
    case 'waiting':
      return CircleHelp;
    case 'conflict':
      return GitMerge;
    case 'limit':
      return Gauge;
    case 'activity':
      return n.tone === 'bad' ? CircleAlert : Timer;
    default:
      return n.tone === 'bad' ? CircleAlert : n.tone === 'warn' ? TriangleAlert : CircleCheck;
  }
}

function Preferences() {
  const { t } = useTranslation('components');
  const prefs = useNotificationPrefs();
  const [permission, setPermission] = useState(browserPermission);

  const toggleBrowser = async (on: boolean) => {
    if (!on) return setPrefs((p) => ({ ...p, browser: false }));
    // Asked here, from the click, because browsers ignore a permission request made any other way
    setPermission(await enableBrowserNotifications());
  };

  return (
    <Collapsible title={t('notificationPanel.preferences')} className="notif-prefs" triggerClassName="small muted">
      <div className="notif-prefs-body">
        <Switch checked={prefs.toasts} onChange={(toasts) => setPrefs((p) => ({ ...p, toasts }))}>
          {t('notificationPanel.popupToasts')}
        </Switch>
        <div>
          <Switch checked={prefs.browser && permission === 'granted'} disabled={permission === 'unsupported'} onChange={toggleBrowser}>
            {t('notificationPanel.browserNotifications')}
          </Switch>
          <div className="field-hint">{t(`notificationPanel.browserHint.${permission}`)}</div>
        </div>
        <div className="notif-prefs-group">{t('notificationPanel.notifyMeWhen')}</div>
        {KINDS.map((kind) => (
          <Switch key={kind} checked={prefs.kinds[kind]} onChange={(on) => setPrefs((p) => ({ ...p, kinds: { ...p.kinds, [kind]: on } }))}>
            {t(`notificationPanel.kinds.${kind}`)}
          </Switch>
        ))}
      </div>
    </Collapsible>
  );
}

export function NotificationPanel({ id, anchor, onClose }: { id: string; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const { t } = useTranslation('components');
  const items = useNotifications();
  const navigate = useNavigate();
  const unread = unreadCount(items);
  // Relative times drift while the panel stays open
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const open = (n: AppNotification) => {
    markRead(n.id);
    onClose();
    if (n.href) navigate(n.href);
  };

  // Arrow keys move between notifications; Tab still works as everywhere
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.notif-item')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[event.key === 'ArrowDown' ? Math.min(at + 1, buttons.length - 1) : Math.max(at - 1, 0)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <Popover.Root open onOpenChange={(next) => !next && onClose()}>
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content
          {...LAYER_ATTR}
          id={id}
          role="dialog"
          aria-label={t('notificationPanel.title')}
          className="popover notif-panel"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          // A click on the bell is "outside" for the popover, which would close it just before the
          // bell's own click reopens it
          onInteractOutside={(e) => anchor.current?.contains(e.target as Node) && e.preventDefault()}
        >
          <div className="notif-head">
            <strong>{t('notificationPanel.title')}</strong>
            <span className="notif-head-actions">
              <button type="button" className="btn btn-small" disabled={unread === 0} onClick={markAllRead}>
                {t('notificationPanel.markAllRead')}
              </button>
              <button type="button" className="btn btn-small" disabled={items.length === 0} onClick={clearNotifications}>
                {t('notificationPanel.clear')}
              </button>
            </span>
          </div>

          {items.length === 0 ? (
            <p className="muted small notif-empty">{t('notificationPanel.empty')}</p>
          ) : (
            <ul className="notif-list" onKeyDown={onListKey}>
              {items.map((n) => {
                const Icon = iconFor(n);
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      className={`notif-item notif-${n.tone} ${n.priority === 'high' && !n.resolved ? 'notif-high' : ''} ${n.read ? '' : 'is-unread'}`}
                      onClick={() => open(n)}
                    >
                      <span className="notif-icon">
                        <Icon {...ICON} />
                      </span>
                      <span className="notif-text">
                        <span className="notif-title">{n.title}</span>
                        {n.body && <span className="notif-body">{n.body}</span>}
                        <span className="notif-meta">
                          {timeAgo(n.at)}
                          {n.kind === 'waiting' && n.resolved && ` · ${t('notificationPanel.answered')}`}
                          {!n.read && <span className="sr-only"> · {t('notificationPanel.unread')}</span>}
                        </span>
                      </span>
                      {!n.read && <span className="notif-dot" aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <Preferences />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
