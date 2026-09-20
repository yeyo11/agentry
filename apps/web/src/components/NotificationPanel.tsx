import * as Popover from '@radix-ui/react-popover';
import { CircleAlert, CircleCheck, CircleHelp, Gauge, GitMerge, Timer, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { timeAgo } from '../lib/format';
import {
  browserPermission,
  clearNotifications,
  enableBrowserNotifications,
  KIND_LABEL,
  KINDS,
  markAllRead,
  markRead,
  setPrefs,
  unreadCount,
  useNotificationPrefs,
  useNotifications,
  type AppNotification,
  type BrowserPermission,
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

const BROWSER_HINT: Record<BrowserPermission, string> = {
  granted: 'Shown only while this tab is hidden.',
  default: 'Shown only while this tab is hidden. The browser will ask for permission.',
  denied: 'Blocked for this site: allow notifications in your browser settings, then turn this on.',
  unsupported: 'This browser does not support notifications.',
};

function Preferences() {
  const prefs = useNotificationPrefs();
  const [permission, setPermission] = useState(browserPermission);

  const toggleBrowser = async (on: boolean) => {
    if (!on) return setPrefs((p) => ({ ...p, browser: false }));
    // Asked here, from the click, because browsers ignore a permission request made any other way
    setPermission(await enableBrowserNotifications());
  };

  return (
    <Collapsible title="Preferences" className="notif-prefs" triggerClassName="small muted">
      <div className="notif-prefs-body">
        <Switch checked={prefs.toasts} onChange={(toasts) => setPrefs((p) => ({ ...p, toasts }))}>
          Pop-up toasts
        </Switch>
        <div>
          <Switch checked={prefs.browser && permission === 'granted'} disabled={permission === 'unsupported'} onChange={toggleBrowser}>
            Browser notifications
          </Switch>
          <div className="field-hint">{BROWSER_HINT[permission]}</div>
        </div>
        <div className="notif-prefs-group">Notify me when</div>
        {KINDS.map((kind) => (
          <Switch key={kind} checked={prefs.kinds[kind]} onChange={(on) => setPrefs((p) => ({ ...p, kinds: { ...p.kinds, [kind]: on } }))}>
            {KIND_LABEL[kind]}
          </Switch>
        ))}
      </div>
    </Collapsible>
  );
}

export function NotificationPanel({ id, anchor, onClose }: { id: string; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
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
          aria-label="Notifications"
          className="popover notif-panel"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          // A click on the bell is "outside" for the popover, which would close it just before the
          // bell's own click reopens it
          onInteractOutside={(e) => anchor.current?.contains(e.target as Node) && e.preventDefault()}
        >
          <div className="notif-head">
            <strong>Notifications</strong>
            <span className="notif-head-actions">
              <button type="button" className="btn btn-small" disabled={unread === 0} onClick={markAllRead}>
                Mark all read
              </button>
              <button type="button" className="btn btn-small" disabled={items.length === 0} onClick={clearNotifications}>
                Clear
              </button>
            </span>
          </div>

          {items.length === 0 ? (
            <p className="muted small notif-empty">Nothing yet. Runs that need you, and what finishes, will show up here.</p>
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
                          {n.kind === 'waiting' && n.resolved && ' · answered'}
                          {!n.read && <span className="sr-only"> · unread</span>}
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
