import {
  chatHref,
  KINDS,
  notificationsFor as draftsFor,
  orchestrationHref,
  waitingDrafts as waitingDraftsFor,
  type AgentryEvent,
  type ChatSummary,
  type NotificationDraft,
  type NotificationKind,
  type NotificationText,
  type PermissionRequest,
} from '@agentry/shared';
import i18n from '../i18n';
import { displayTitle } from './chat-model';
import { serverText } from './server-strings';

/*
 * The browser's own bookkeeping around notifications: the stored list, what is a repeat of what,
 * read state and the preferences. What a notification *is*, and which events make one, lives in
 * `@agentry/shared` (`packages/shared/src/notifications.ts`) so that the push sender on the server
 * reads the same event through the same function; this file re-exports it, so nothing in the web
 * has to know where it moved to.
 *
 * Its text is translated when the notification is made, not when it is shown: a notification is
 * stored with the words it was born with, the way the browser's own notifications are.
 */

export {
  KINDS,
  PROMPT_PARAM,
  settlesWaiting,
  type NotificationDraft,
  type NotificationKind,
  type NotificationPriority,
  type NotificationTone,
} from '@agentry/shared';

/** A notification once the store has given it a read state. */
export type AppNotification = Omit<NotificationDraft, 'dedupeMs'> & {
  read: boolean;
  /** A `waiting` notification whose question has been answered or withdrawn */
  resolved: boolean;
};

export interface NotificationPrefs {
  kinds: Record<NotificationKind, boolean>;
  toasts: boolean;
  /** Browser notifications for a hidden tab; only ever true after the person opted in */
  browser: boolean;
}

/** The shared mapping asks for its words here, so the page says them in the active language. */
const text: NotificationText = {
  waitingPermission: (name, tool) => i18n.t('components:notificationText.waitingPermission', { name, tool }),
  waitingQuestion: (name) => i18n.t('components:notificationText.waitingQuestion', { name }),
  waitingPlan: (name) => i18n.t('components:notificationText.waitingPlan', { name }),
  permission: (tool) => i18n.t('components:notificationText.permission', { tool }),
  question: () => i18n.t('components:notificationText.question'),
  plan: () => i18n.t('components:notificationText.plan'),
  runFinished: (name) => i18n.t('components:notificationText.runFinished', { name }),
  runReady: () => i18n.t('components:notificationText.runReady'),
  runError: () => i18n.t('components:notificationText.runError'),
  turns: (count) => i18n.t('components:notificationText.turns', { count }),
  rateLimited: (name) => i18n.t('components:notificationText.rateLimited', { name }),
  rateLimitedBody: () => i18n.t('components:notificationText.rateLimitedBody'),
  rotated: (name) => i18n.t('components:notificationText.rotated', { name }),
  previousAccount: () => i18n.t('components:notificationText.previousAccount'),
  nextAccount: () => i18n.t('components:notificationText.nextAccount'),
  rotatedBody: (from, to) => i18n.t('components:notificationText.rotatedBody', { from, to }),
  rotatedBodyReplayed: (from, to) => i18n.t('components:notificationText.rotatedBodyReplayed', { from, to }),
  orchestrationFinished: (name) => i18n.t('components:notificationText.orchestrationFinished', { name }),
  orchestrationFailed: (name) => i18n.t('components:notificationText.orchestrationFailed', { name }),
  orchestrationDoneBody: () => i18n.t('components:notificationText.orchestrationDoneBody'),
  orchestrationFailedBody: () => i18n.t('components:notificationText.orchestrationFailedBody'),
  conflict: (count, branch) => i18n.t('components:notificationText.conflict', { count, branch }),
  conflictResolving: (count, branch) => i18n.t('components:notificationText.conflictResolving', { count, branch }),
  fromSubagent: () => i18n.t('components:notificationText.fromSubagent'),
  supervisorProposed: (name) => i18n.t('components:notificationText.supervisorProposed', { name }),
  serverText,
};

/** The notifications an event calls for, in the active language; empty for nearly all of them. */
export const notificationsFor = (event: AgentryEvent): NotificationDraft[] => draftsFor(event, text);

/** The `waiting` notifications for the prompts a chat is holding right now, in the active language. */
export const waitingDrafts = (chat: Pick<ChatSummary, 'id' | 'title' | 'firstPrompt' | 'orchestration'>, requests: readonly PermissionRequest[]): NotificationDraft[] =>
  waitingDraftsFor({ ...chat, title: displayTitle(chat) }, requests, text);

export const MAX_NOTIFICATIONS = 200;

export function defaultPrefs(): NotificationPrefs {
  return { kinds: Object.fromEntries(KINDS.map((kind) => [kind, true])) as Record<NotificationKind, boolean>, toasts: true, browser: false };
}

/** The person is already looking at what the notification is about, so a toast would only repeat it. */
export function isRedundant(notification: Pick<NotificationDraft, 'runId' | 'orchestrationId'>, pathname: string, tabVisible: boolean): boolean {
  if (!tabVisible) return false;
  if (notification.runId && pathname === chatHref(notification.runId)) return true;
  return notification.orchestrationId !== null && pathname === orchestrationHref(notification.orchestrationId);
}

export interface Applied {
  items: AppNotification[];
  /** The drafts that became notifications, in the order they came */
  added: AppNotification[];
}

/**
 * Adds the drafts that are enabled and not repeats, newest first, and keeps the list bounded.
 * `seen` marks a draft as read from the start: the person was looking at it when it came in.
 */
export function addNotifications(
  items: readonly AppNotification[],
  drafts: readonly NotificationDraft[],
  prefs: NotificationPrefs,
  seen: (draft: NotificationDraft) => boolean,
  now: number = Date.now(),
): Applied {
  let next = [...items];
  const added: AppNotification[] = [];
  for (const d of drafts) {
    if (!prefs.kinds[d.kind]) continue;
    const repeat = next.some((n) => n.key === d.key && (d.dedupeMs === 0 || n.id === d.id || now - Date.parse(n.at) < d.dedupeMs));
    if (repeat) continue;
    const { dedupeMs: _dedupeMs, ...rest } = d;
    const notification: AppNotification = { ...rest, read: seen(d), resolved: false };
    added.push(notification);
    next = [notification, ...next];
  }
  return { items: next.slice(0, MAX_NOTIFICATIONS), added };
}

/** Marks the notifications that match as settled and read; `changed` lists the ones that were open. */
export function settle(items: readonly AppNotification[], matches: (n: AppNotification) => boolean): { items: AppNotification[]; changed: AppNotification[] } {
  const changed: AppNotification[] = [];
  const next = items.map((n) => {
    if (n.resolved || !matches(n)) return n;
    const settled = { ...n, resolved: true, read: true };
    changed.push(settled);
    return settled;
  });
  return { items: next, changed };
}

export function unreadCount(items: readonly AppNotification[]): number {
  return items.reduce((count, n) => (n.read ? count : count + 1), 0);
}

/** A question still open and unread: what the bell should draw the eye to. */
export function hasUrgent(items: readonly AppNotification[]): boolean {
  return items.some((n) => n.priority === 'high' && !n.read && !n.resolved);
}

// ---------- persistence ----------

export const STORAGE_KEY = 'agentry-notifications:v1';
const STORAGE_VERSION = 1;

export interface StoredNotifications {
  items: AppNotification[];
  prefs: NotificationPrefs;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null => (allowed.includes(value as T) ? (value as T) : null);
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function parseItem(value: unknown): AppNotification | null {
  if (!isObject(value)) return null;
  const kind = oneOf(value.kind, KINDS);
  const priority = oneOf(value.priority, ['high', 'normal', 'low'] as const);
  const tone = oneOf(value.tone, ['ok', 'bad', 'warn', 'info'] as const);
  if (!kind || !priority || !tone) return null;
  if (typeof value.id !== 'string' || typeof value.key !== 'string' || typeof value.at !== 'string' || typeof value.title !== 'string') return null;
  return {
    id: value.id,
    key: value.key,
    at: value.at,
    kind,
    priority,
    tone,
    title: value.title,
    body: typeof value.body === 'string' ? value.body : '',
    href: stringOrNull(value.href),
    runId: stringOrNull(value.runId),
    orchestrationId: stringOrNull(value.orchestrationId),
    read: value.read === true,
    resolved: value.resolved === true,
    permissionId: stringOrNull(value.permissionId),
  };
}

function parsePrefs(value: unknown): NotificationPrefs {
  const prefs = defaultPrefs();
  if (!isObject(value)) return prefs;
  if (isObject(value.kinds)) {
    for (const kind of KINDS) {
      const on = value.kinds[kind];
      if (typeof on === 'boolean') prefs.kinds[kind] = on;
    }
  }
  if (typeof value.toasts === 'boolean') prefs.toasts = value.toasts;
  if (typeof value.browser === 'boolean') prefs.browser = value.browser;
  return prefs;
}

/** Reads what was saved, dropping whatever does not fit: a corrupt entry must never break the app. */
export function parseStored(raw: string | null): StoredNotifications {
  const empty: StoredNotifications = { items: [], prefs: defaultPrefs() };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isObject(parsed) || parsed.version !== STORAGE_VERSION) return empty;
  const items = Array.isArray(parsed.items) ? parsed.items.flatMap((item: unknown) => parseItem(item) ?? []) : [];
  return { items: items.slice(0, MAX_NOTIFICATIONS), prefs: parsePrefs(parsed.prefs) };
}

export function serializeStored(stored: StoredNotifications): string {
  return JSON.stringify({ version: STORAGE_VERSION, items: stored.items.slice(0, MAX_NOTIFICATIONS), prefs: stored.prefs });
}
