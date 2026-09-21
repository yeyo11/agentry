import { Bell } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAgentryEvents } from '../lib/events';
import {
  getPrefs,
  hasUrgent,
  ingest,
  isRedundant,
  markRead,
  seedWaiting,
  showBrowserNotification,
  unreadCount,
  useNotifications,
  waitingDrafts,
  type AppNotification,
  type NotificationDraft,
} from '../lib/notifications';
import '../notifications.css';
import { Tooltip } from './controls/Tooltip';
import { ICON } from './icons';
import { useToast } from './Toast';

// The panel (list, preferences, motion) loads on the first click; the shell only carries the bell
const NotificationPanel = lazy(() => import('./NotificationPanel').then((m) => ({ default: m.NotificationPanel })));

/** Bell with the unread count. Opens the notification panel under it. */
export function NotificationBell() {
  const items = useNotifications();
  const unread = unreadCount(items);
  const urgent = hasUrgent(items);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const { t } = useTranslation(['components', 'common']);
  const label = unread > 0 ? t(urgent ? 'notifications.bellUnreadUrgent' : 'notifications.bellUnread', { count: unread }) : t('notifications.bell');

  return (
    <>
      <Tooltip content={t('notifications.bell')}>
        <button
          ref={button}
          type="button"
          className={`theme-toggle bell ${urgent ? 'bell-urgent' : ''}`}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          <Bell {...ICON} />
          {unread > 0 && (
            <span className="bell-badge" aria-hidden>
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </Tooltip>
      {open && (
        <Suspense fallback={null}>
          <NotificationPanel id={panelId} anchor={button} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

/**
 * Turns the event feed into notifications, toasts and system notifications. Renders nothing; it
 * sits in the shell because it needs the router and the toast provider, and must live as long as
 * the app does.
 */
export function NotificationHost() {
  const toast = useToast();
  const { t } = useTranslation(['components', 'common']);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Read at event time: the person may have moved since the last render
  const where = useRef(pathname);
  where.current = pathname;

  const open = useCallback((href: string | null) => href && navigate(href), [navigate]);

  const announce = (added: AppNotification[]) => {
    const prefs = getPrefs();
    for (const n of added) {
      // Low priority stays in the center: a busy run finishes subagents all the time
      if (n.priority === 'low') continue;
      if (prefs.toasts) {
        toast.show({
          tone: n.tone,
          title: n.title,
          detail: n.body || undefined,
          key: n.key,
          persistent: n.priority === 'high',
          urgent: n.priority === 'high',
          action: n.href
            ? {
                label: n.kind === 'waiting' ? t('notifications.answer') : t('common:actions.open'),
                onClick: () => {
                  markRead(n.id);
                  open(n.href);
                },
              }
            : undefined,
        });
      }
      showBrowserNotification(n, (href) => {
        markRead(n.id);
        open(href);
      });
    }
  };
  const seen = (draft: NotificationDraft) => isRedundant(draft, where.current, document.visibilityState === 'visible');

  useAgentryEvents((event) => {
    const { added, settled } = ingest(event, seen);
    for (const n of settled) toast.dismissKey(n.key);
    announce(added);
  });

  // A chat that was already waiting when the page opened sent its `run.waiting` to nobody
  const announceLatest = useRef(announce);
  announceLatest.current = announce;
  useEffect(() => {
    const checkedAt = Date.now();
    let cancelled = false;
    void (async () => {
      try {
        const chats = await api.chats({ state: 'waiting' });
        const drafts = (await Promise.all(chats.map(async (chat) => waitingDrafts(chat, await api.chatPermissions(chat.id))))).flat();
        if (cancelled) return;
        const { added, settled } = seedWaiting(drafts, checkedAt, seen);
        for (const n of settled) toast.dismissKey(n.key);
        announceLatest.current(added);
      } catch {
        // The feed still tells of what comes next; a failed read only loses what came before
      }
    })();
    return () => {
      cancelled = true;
    };
    // Once per load: `seen` reads the location through a ref
  }, []);

  return null;
}
