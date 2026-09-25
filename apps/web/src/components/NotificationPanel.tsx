import type { PermissionDecision } from '@agentry/shared';
import * as Popover from '@radix-ui/react-popover';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCheck, CircleAlert, CircleCheck, CircleHelp, Gauge, GitMerge, Timer, TriangleAlert, Trash2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, keys } from '../api';
import { timeAgo } from '../lib/format';
import { clearNotifications, markAllRead, markRead, removeNotification, unreadCount, useNotifications, type AppNotification } from '../lib/notifications';
import { Collapsible } from './controls/Collapsible';
import { LAYER_ATTR } from './controls/layer';
import { Tooltip } from './controls/Tooltip';
import { ICON, ICON_SM } from './icons';
import { NotificationPreferences } from './NotificationPreferences';
import { useToast } from './Toast';

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

/**
 * Allow and Deny for a tool permission, answered where the person already is. Only a plain yes or
 * no fits two buttons: a question, a plan or edited arguments keep the link that opens the prompt.
 */
function PermissionAnswer({ notification, chatId, requestId, describedBy }: { notification: AppNotification; chatId: string; requestId: string; describedBy: string }) {
  const { t } = useTranslation('components');
  const queryClient = useQueryClient();
  const toast = useToast();
  const answer = useMutation({
    mutationFn: (decision: PermissionDecision) => api.answerPermission(chatId, requestId, decision),
    onSuccess: () => {
      // The prompt is settled: its toast and its row go, rather than staying on as "answered"
      toast.dismissKey(notification.key);
      removeNotification(notification.id);
      void queryClient.invalidateQueries({ queryKey: keys.chatPermissions(chatId) });
      void queryClient.invalidateQueries({ queryKey: keys.chats });
    },
    onError: (err) => toast.error(t('notificationPanel.answerFailed'), err),
  });

  return (
    <div className="notif-actions notif-high" role="group" aria-label={t('notificationPanel.answerGroup')}>
      <button
        type="button"
        className="btn btn-primary btn-small"
        aria-describedby={describedBy}
        disabled={answer.isPending}
        onClick={() => answer.mutate({ behavior: 'allow' })}
      >
        <Check {...ICON_SM} /> {t('notificationPanel.allow')}
      </button>
      <button
        type="button"
        className="btn btn-danger btn-small"
        aria-describedby={describedBy}
        disabled={answer.isPending}
        onClick={() => answer.mutate({ behavior: 'deny' })}
      >
        <X {...ICON_SM} /> {t('notificationPanel.deny')}
      </button>
    </div>
  );
}

function NotificationItem({ n, onOpen }: { n: AppNotification; onOpen: (n: AppNotification) => void }) {
  const { t } = useTranslation('components');
  const titleId = useId();
  const Icon = iconFor(n);

  return (
    <li>
      <button
        type="button"
        className={`notif-item notif-${n.tone} ${n.priority === 'high' && !n.resolved ? 'notif-high' : ''} ${n.read ? '' : 'is-unread'}`}
        onClick={() => onOpen(n)}
      >
        <span className="notif-icon">
          <Icon {...ICON} />
        </span>
        <span className="notif-text">
          <span className="notif-title" id={titleId}>
            {n.title}
          </span>
          {n.body && <span className="notif-body">{n.body}</span>}
          <span className="notif-meta">
            {timeAgo(n.at)}
            {n.kind === 'waiting' && n.resolved && ` · ${t('notificationPanel.answered')}`}
            {!n.read && <span className="sr-only"> · {t('notificationPanel.unread')}</span>}
          </span>
        </span>
        {!n.read && <span className="notif-dot" aria-hidden />}
      </button>
      {n.kind === 'waiting' && !n.resolved && n.runId && n.permissionId && <PermissionAnswer notification={n} chatId={n.runId} requestId={n.permissionId} describedBy={titleId} />}
    </li>
  );
}

/**
 * The same switches Settings → Notifications shows, where the person reading a notification is:
 * the panel owns the disclosure, `NotificationPreferences` owns what is inside it.
 */
function Preferences() {
  const { t } = useTranslation('components');

  return (
    <Collapsible title={t('notificationPanel.preferences')} className="notif-prefs" triggerClassName="small muted">
      <NotificationPreferences />
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
              <Tooltip content={t('notificationPanel.markAllRead')}>
                <button type="button" className="icon-btn" aria-label={t('notificationPanel.markAllRead')} disabled={unread === 0} onClick={markAllRead}>
                  <CheckCheck {...ICON_SM} />
                </button>
              </Tooltip>
              <Tooltip content={t('notificationPanel.clear')}>
                <button type="button" className="icon-btn" aria-label={t('notificationPanel.clear')} disabled={items.length === 0} onClick={clearNotifications}>
                  <Trash2 {...ICON_SM} />
                </button>
              </Tooltip>
            </span>
          </div>

          {items.length === 0 ? (
            <p className="muted small notif-empty">{t('notificationPanel.empty')}</p>
          ) : (
            <ul className="notif-list" onKeyDown={onListKey}>
              {items.map((n) => (
                <NotificationItem key={n.id} n={n} onOpen={open} />
              ))}
            </ul>
          )}

          <Preferences />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
