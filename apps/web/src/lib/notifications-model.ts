import type { AgentryEvent } from '@agentry/shared';
import { detailHref } from './detail';

/*
 * What a notification is and which events make one. Pure on purpose (no React, no DOM, no
 * storage): the store, the toasts and the tests all build on these functions, and this file is the
 * one place that decides what deserves a person's attention.
 */

export type NotificationKind = 'waiting' | 'run' | 'orchestration' | 'conflict' | 'limit' | 'activity';
/** `high` needs the person, `normal` is worth knowing, `low` stays in the center without a toast. */
export type NotificationPriority = 'high' | 'normal' | 'low';
export type NotificationTone = 'ok' | 'bad' | 'warn' | 'info';

export interface AppNotification {
  id: string;
  /** What makes two notifications the same news; see `dedupeMs` */
  key: string;
  at: string;
  kind: NotificationKind;
  priority: NotificationPriority;
  tone: NotificationTone;
  title: string;
  body: string;
  /** Where clicking it goes */
  href: string | null;
  runId: string | null;
  orchestrationId: string | null;
  read: boolean;
  /** A `waiting` notification whose question has been answered or withdrawn */
  resolved: boolean;
}

/** A notification before the store gives it a read state. */
export type NotificationDraft = Omit<AppNotification, 'read' | 'resolved'> & {
  /** Another draft with the same key inside this window is dropped; 0 keeps the key unique forever */
  dedupeMs: number;
};

type DraftFields = Omit<NotificationDraft, 'id' | 'at' | 'dedupeMs' | 'runId' | 'orchestrationId'> &
  Partial<Pick<NotificationDraft, 'dedupeMs' | 'runId' | 'orchestrationId'>>;

export interface NotificationPrefs {
  kinds: Record<NotificationKind, boolean>;
  toasts: boolean;
  /** Browser notifications for a hidden tab; only ever true after the person opted in */
  browser: boolean;
}

export const KIND_LABEL: Record<NotificationKind, string> = {
  waiting: 'A run is waiting for me',
  run: 'A run finished or failed',
  orchestration: 'An orchestration finished or failed',
  conflict: 'An integration conflict',
  limit: 'A rate limit or account rotation',
  activity: 'A background task, subagent or workflow finished',
};

export const KINDS = Object.keys(KIND_LABEL) as NotificationKind[];

export const MAX_NOTIFICATIONS = 200;
const DEDUPE_MS = 60_000;

export function defaultPrefs(): NotificationPrefs {
  return { kinds: Object.fromEntries(KINDS.map((kind) => [kind, true])) as Record<NotificationKind, boolean>, toasts: true, browser: false };
}

// A run is an execution of a chat and carries its id, so both name the same page
const chatHref = (id: string) => `/chats/${encodeURIComponent(id)}`;
const orchestrationHref = (id: string) => `/orchestration/${encodeURIComponent(id)}`;

/** Where work delegated inside a chat is shown: the chat, which is the session, whoever started it. */
function activityHref(runId: string, sessionId: string | null): string {
  const chat = runId || sessionId;
  return chat ? chatHref(chat) : '/';
}

// The event id alone would collide after a server restart, which restarts the ids
const draft = (event: AgentryEvent, fields: DraftFields): NotificationDraft => ({
  id: `${event.at}#${event.id}`,
  at: event.at,
  dedupeMs: DEDUPE_MS,
  runId: null,
  orchestrationId: null,
  ...fields,
});

const WAITING_BODY = {
  permission: (tool: string) => `Approve or deny ${tool} to let it continue.`,
  question: () => 'It is waiting for your answer.',
  plan: () => 'Review the plan and approve it, or ask for changes.',
} as const;

const ACTIVITY_FAILED = new Set(['failed', 'killed', 'stopped', 'error']);

/** The notifications an event calls for; empty for nearly all of them. */
export function notificationsFor(event: AgentryEvent): NotificationDraft[] {
  switch (event.type) {
    case 'run.waiting': {
      // Housekeeping runs (planner, auth check) never wait for a person
      if (event.internal) return [];
      return [
        draft(event, {
          // The permission id, not the run: a run can hold several prompts and each is its own news
          key: `wait:${event.runId}:${event.permissionId}`,
          dedupeMs: 0,
          kind: 'waiting',
          priority: 'high',
          tone: 'warn',
          title: event.title,
          body: WAITING_BODY[event.reason](event.toolName),
          href: chatHref(event.runId),
          runId: event.runId,
          orchestrationId: event.orchestrationId,
        }),
      ];
    }

    case 'run.updated': {
      // busy → idle is a finished turn: what an interactive run's "done" looks like. `run.ended`
      // covers the process exiting, and shares this key so that a one-shot run tells it once.
      if (event.internal || event.orchestrationId || event.previousStatus !== 'busy' || event.status !== 'idle') return [];
      return [
        draft(event, {
          key: `run-done:${event.runId}:${event.turns}`,
          kind: 'run',
          priority: 'normal',
          tone: 'ok',
          title: `${event.runName} finished`,
          body: 'It is ready for your next message.',
          href: chatHref(event.runId),
          runId: event.runId,
        }),
      ];
    }

    case 'run.ended': {
      // A worker of an orchestration reports through the orchestration; a stop is the person's own doing
      if (event.internal || event.orchestrationId || event.status === 'stopped') return [];
      const failed = event.status === 'failed';
      return [
        draft(event, {
          key: `${failed ? 'run-failed' : 'run-done'}:${event.runId}:${event.turns}`,
          kind: 'run',
          priority: 'normal',
          tone: failed ? 'bad' : 'ok',
          title: event.title,
          body: failed ? (event.error ?? 'It ended with an error.') : `${event.turns} ${event.turns === 1 ? 'turn' : 'turns'}`,
          href: chatHref(event.runId),
          runId: event.runId,
        }),
      ];
    }

    case 'run.rateLimited':
      if (event.internal) return [];
      return [
        draft(event, {
          key: `limit:${event.runId}`,
          kind: 'limit',
          priority: 'normal',
          tone: 'warn',
          title: `${event.runName} hit a rate limit`,
          body: 'The turn stopped because the account ran out of quota.',
          href: chatHref(event.runId),
          runId: event.runId,
          orchestrationId: event.orchestrationId,
        }),
      ];

    case 'run.accountRotated':
      if (event.internal) return [];
      return [
        draft(event, {
          key: `rotated:${event.runId}`,
          kind: 'limit',
          priority: 'normal',
          tone: 'info',
          title: `${event.runName} moved to another account`,
          body: `${event.from ?? 'The previous account'} → ${event.to ?? 'the next account'}${event.resumed ? ', and the turn was replayed' : ''}.`,
          href: chatHref(event.runId),
          runId: event.runId,
          orchestrationId: event.orchestrationId,
        }),
      ];

    case 'orchestration.updated': {
      if (event.previousStatus === null || event.previousStatus === event.status) return [];
      if (event.status !== 'completed' && event.status !== 'failed') return [];
      const failed = event.status === 'failed';
      return [
        draft(event, {
          key: `orchestration:${event.orchestrationId}:${event.status}`,
          kind: 'orchestration',
          priority: 'normal',
          tone: failed ? 'bad' : 'ok',
          title: `Orchestration ${event.orchestrationName} ${failed ? 'failed' : 'finished'}`,
          body: failed ? 'A task failed and the graph stopped.' : 'Every task completed.',
          href: orchestrationHref(event.orchestrationId),
          orchestrationId: event.orchestrationId,
        }),
      ];
    }

    case 'orchestration.conflict':
      return [
        draft(event, {
          key: `conflict:${event.orchestrationId}:${event.branch}:${event.integrationStatus}`,
          kind: 'conflict',
          priority: 'normal',
          tone: 'warn',
          title: event.title,
          body: `${event.paths.length} ${event.paths.length === 1 ? 'file' : 'files'} in ${event.branch}${event.resolving ? '' : ' need your attention'}.`,
          href: orchestrationHref(event.orchestrationId),
          orchestrationId: event.orchestrationId,
        }),
      ];

    case 'task.ended': {
      const failed = ACTIVITY_FAILED.has(event.status);
      return [
        draft(event, {
          key: `task:${event.runId}:${event.taskId}`,
          kind: 'activity',
          priority: failed ? 'normal' : 'low',
          tone: failed ? 'bad' : 'info',
          title: event.title,
          body: event.summary ?? (event.fromSubagent ? 'Started by a subagent.' : ''),
          href: event.sessionId ? detailHref({ kind: 'task', sessionId: event.sessionId, taskId: event.taskId }, chatHref(event.sessionId)) : activityHref(event.runId, event.sessionId),
          runId: event.runId || null,
        }),
      ];
    }

    case 'subagent.ended': {
      const failed = event.status !== 'completed';
      return [
        draft(event, {
          key: `subagent:${event.runId}:${event.toolUseId}`,
          kind: 'activity',
          priority: failed ? 'normal' : 'low',
          tone: failed ? 'bad' : 'info',
          title: event.title,
          body: event.description,
          href:
            event.sessionId && event.agentId
              ? detailHref({ kind: 'subagent', sessionId: event.sessionId, agentId: event.agentId }, chatHref(event.sessionId))
              : activityHref(event.runId, event.sessionId),
          runId: event.runId || null,
        }),
      ];
    }

    case 'workflow.ended': {
      const failed = event.status === 'failed';
      return [
        draft(event, {
          key: `workflow:${event.runId}:${event.workflowId}`,
          kind: 'activity',
          priority: failed ? 'normal' : 'low',
          tone: failed ? 'bad' : 'info',
          title: event.title,
          body: event.summary ?? '',
          href: activityHref(event.runId, event.sessionId),
          runId: event.runId || null,
        }),
      ];
    }

    default:
      return [];
  }
}

/**
 * Which existing notifications an event settles. A `waiting` one is over when its question is
 * answered, withdrawn, or its run is gone: the person no longer has anything to do about it.
 */
export function settlesWaiting(event: AgentryEvent): ((notification: AppNotification) => boolean) | null {
  switch (event.type) {
    case 'permission.resolved':
      return (n) => n.key === `wait:${event.runId}:${event.permissionId}`;
    case 'run.ended':
    case 'run.removed':
      return (n) => n.kind === 'waiting' && n.runId === event.runId;
    default:
      return null;
  }
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
