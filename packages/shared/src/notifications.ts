import { detailHref } from './detail.ts';
import type { AgentryEvent, ChatSummary, LocalizedParams, PermissionRequest, RunWaitingReason } from './types.ts';

/*
 * What a notification is and which events make one. Pure on purpose (no React, no DOM, no storage,
 * nothing that needs a browser): it lives here so that the web's toasts and the server's push
 * sender read the same event through the same function and can never disagree about what "waiting
 * for you" means. The browser's own bookkeeping — the stored list, dedupe against it, read state —
 * stays in `apps/web/src/lib/notifications-model.ts`.
 *
 * The words are given by a `NotificationText`, because the web says them in the person's language
 * and the server has no language to say them in. Its text is made when the notification is made,
 * not when it is shown: a notification is stored with the words it was born with, the way the
 * browser's own notifications are.
 */

export type NotificationKind = 'waiting' | 'run' | 'orchestration' | 'conflict' | 'limit' | 'activity' | 'health';
/** `high` needs the person, `normal` is worth knowing, `low` stays in the center without a toast. */
export type NotificationPriority = 'high' | 'normal' | 'low';
export type NotificationTone = 'ok' | 'bad' | 'warn' | 'info';

/** A notification as an event makes it, before a client gives it a read state. */
export interface NotificationDraft {
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
  /**
   * The request a plain tool permission waits on, which Allow and Deny can answer from the list.
   * Null for a question or a plan, which two buttons cannot answer, and for every other kind.
   */
  permissionId: string | null;
  /** Another draft with the same key inside this window is dropped; 0 keeps the key unique forever */
  dedupeMs: number;
}

/** As much of a stored notification as {@link settlesWaiting} needs to recognise one. */
export type NotificationMatch = Pick<NotificationDraft, 'key' | 'kind' | 'runId'>;

/**
 * The sentences a notification is made of. One method per key of the web's
 * `components:notificationText`, so a client that has translations passes them straight through
 * and nothing here has to know about i18next.
 */
export interface NotificationText {
  waitingPermission(name: string, tool: string): string;
  waitingQuestion(name: string): string;
  waitingPlan(name: string): string;
  permission(tool: string): string;
  question(): string;
  plan(): string;
  runFinished(name: string): string;
  runReady(): string;
  runError(): string;
  turns(count: number): string;
  rateLimited(name: string): string;
  rateLimitedBody(): string;
  rotated(name: string): string;
  previousAccount(): string;
  nextAccount(): string;
  rotatedBody(from: string, to: string): string;
  rotatedBodyReplayed(from: string, to: string): string;
  orchestrationFinished(name: string): string;
  orchestrationFailed(name: string): string;
  orchestrationDoneBody(): string;
  orchestrationFailedBody(): string;
  conflict(count: number, branch: string): string;
  conflictResolving(count: number, branch: string): string;
  fromSubagent(): string;
  supervisorProposed(name: string): string;
  /**
   * A sentence the server wrote, by its stable code. A client with translations says it in the
   * person's language; without them the server's own English is already the sentence.
   */
  serverText(code: string | undefined, params: LocalizedParams | undefined, fallback: string): string;
}

/**
 * The English of `apps/web/src/i18n/locales/en/components.json`, for a caller with no translations
 * of its own — the push sender. `apps/web/test/notifications-text.test.ts` fails when the two drift.
 */
export const englishNotificationText: NotificationText = {
  waitingPermission: (name, tool) => `${name} needs your approval to use ${tool}`,
  waitingQuestion: (name) => `${name} is asking you a question`,
  waitingPlan: (name) => `${name} has a plan for you to approve`,
  permission: (tool) => `Approve or deny ${tool} to let it continue.`,
  question: () => 'It is waiting for your answer.',
  plan: () => 'Review the plan and approve it, or ask for changes.',
  runFinished: (name) => `${name} finished`,
  runReady: () => 'It is ready for your next message.',
  runError: () => 'It ended with an error.',
  turns: (count) => `${count} ${count === 1 ? 'turn' : 'turns'}`,
  rateLimited: (name) => `${name} hit a rate limit`,
  rateLimitedBody: () => 'The turn stopped because the account ran out of quota.',
  rotated: (name) => `${name} moved to another account`,
  previousAccount: () => 'The previous account',
  nextAccount: () => 'the next account',
  rotatedBody: (from, to) => `${from} → ${to}.`,
  rotatedBodyReplayed: (from, to) => `${from} → ${to}, and the turn was replayed.`,
  orchestrationFinished: (name) => `Orchestration ${name} finished`,
  orchestrationFailed: (name) => `Orchestration ${name} failed`,
  orchestrationDoneBody: () => 'Every task completed.',
  orchestrationFailedBody: () => 'A task failed and the graph stopped.',
  conflict: (count, branch) => `${count} ${count === 1 ? 'file' : 'files'} in ${branch} need your attention.`,
  conflictResolving: (count, branch) => `${count} ${count === 1 ? 'file' : 'files'} in ${branch}.`,
  fromSubagent: () => 'Started by a subagent.',
  supervisorProposed: (name) => `${name}: the supervisor proposes a hint`,
  serverText: (_code, _params, fallback) => fallback,
};

/** In the order the preferences list them; their labels are `components:notificationPanel.kinds`. */
export const KINDS: NotificationKind[] = ['waiting', 'run', 'orchestration', 'conflict', 'limit', 'activity', 'health'];

/**
 * How much a notification may interrupt: a toast in the page, a system notification for a hidden
 * tab, a push to a phone. The bell keeps every notification whatever the level; the kinds decide
 * what is kept at all, the level what is worth breaking into someone's work for.
 */
export type NotificationLevel = 'all' | 'important' | 'urgent' | 'silent';
export const LEVELS: NotificationLevel[] = ['all', 'important', 'urgent', 'silent'];
/** A chat finishing a turn is the most frequent news and rarely worth an interruption. */
export const DEFAULT_LEVEL: NotificationLevel = 'important';

/**
 * Whether a notification interrupts at this level. The same function decides for the page and for
 * the push sender, so a phone is never woken for something the open page would only have kept.
 */
export function interrupts(notification: Pick<NotificationDraft, 'kind' | 'priority' | 'tone'>, level: NotificationLevel): boolean {
  if (notification.priority === 'low') return false;
  switch (level) {
    case 'all':
      return true;
    case 'important':
      return (
        notification.priority === 'high' ||
        notification.tone === 'bad' ||
        notification.kind === 'orchestration' ||
        notification.kind === 'conflict'
      );
    case 'urgent':
      return notification.priority === 'high';
    case 'silent':
      return false;
  }
}

const DEDUPE_MS = 60_000;

/** The search param that names the prompt a chat page should bring into view. */
export const PROMPT_PARAM = 'prompt';

// A run id on the wire is the id of the chat it works on. With `promptId`, the chat opens scrolled
// to that prompt instead of at the end of the transcript.
export const chatHref = (chatId: string, promptId?: string): string =>
  `/chats/${encodeURIComponent(chatId)}${promptId ? `?${PROMPT_PARAM}=${encodeURIComponent(promptId)}` : ''}`;
export const orchestrationHref = (id: string): string => `/orchestration/${encodeURIComponent(id)}`;

/** Work delegated inside a chat says which chat by its session, or by its run when it has one of ours. */
const activityChat = (runId: string, sessionId: string | null): string | null => sessionId || runId || null;

type DraftFields = Omit<NotificationDraft, 'id' | 'at' | 'dedupeMs' | 'runId' | 'orchestrationId' | 'permissionId'> &
  Partial<Pick<NotificationDraft, 'dedupeMs' | 'runId' | 'orchestrationId' | 'permissionId'>>;

// The event id alone would collide after a server restart, which restarts the ids
const draft = (event: AgentryEvent, fields: DraftFields): NotificationDraft => ({
  id: `${event.at}#${event.id}`,
  at: event.at,
  dedupeMs: DEDUPE_MS,
  runId: null,
  orchestrationId: null,
  permissionId: null,
  ...fields,
});

const waitingBody = (text: NotificationText, reason: RunWaitingReason, tool: string): string =>
  reason === 'permission' ? text.permission(tool) : reason === 'question' ? text.question() : text.plan();

const waitingTitle = (text: NotificationText, reason: RunWaitingReason, name: string, tool: string): string =>
  reason === 'permission' ? text.waitingPermission(name, tool) : reason === 'question' ? text.waitingQuestion(name) : text.waitingPlan(name);

const ACTIVITY_FAILED = new Set(['failed', 'killed', 'stopped', 'error']);

/** AskUserQuestion and ExitPlanMode reach the host as tool permission requests like any other. */
const reasonOf = (toolName: string): RunWaitingReason => (toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'permission');

/**
 * The `waiting` notifications for prompts a chat was already holding when the page loaded: their
 * `run.waiting` events came before there was anyone to hear them. The key is the live event's, so a
 * prompt that is in the list already is not told twice.
 */
export function waitingDrafts(
  chat: Pick<ChatSummary, 'id' | 'title' | 'orchestration'>,
  requests: readonly PermissionRequest[],
  text: NotificationText = englishNotificationText,
): NotificationDraft[] {
  return requests.map((request) => {
    const reason = reasonOf(request.toolName);
    return {
      id: `${request.requestedAt}#${request.id}`,
      at: request.requestedAt,
      dedupeMs: 0,
      key: `wait:${chat.id}:${request.id}`,
      kind: 'waiting',
      priority: 'high',
      tone: 'warn',
      title: waitingTitle(text, reason, chat.title, request.toolName),
      body: waitingBody(text, reason, request.toolName),
      href: chatHref(chat.id, request.id),
      runId: chat.id,
      orchestrationId: chat.orchestration?.id ?? null,
      // A request that waits on a person by design wants more than a yes or a no
      permissionId: reason === 'permission' && !request.requiresUserInteraction ? request.id : null,
    };
  });
}

/** The notifications an event calls for; empty for nearly all of them. */
export function notificationsFor(event: AgentryEvent, text: NotificationText = englishNotificationText): NotificationDraft[] {
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
          body: waitingBody(text, event.reason, event.toolName),
          href: chatHref(event.runId, event.permissionId),
          runId: event.runId,
          orchestrationId: event.orchestrationId,
          permissionId: event.reason === 'permission' ? event.permissionId : null,
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
          title: text.runFinished(event.runName),
          body: text.runReady(),
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
          body: failed ? (event.error ?? text.runError()) : text.turns(event.turns),
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
          title: text.rateLimited(event.runName),
          body: text.rateLimitedBody(),
          href: chatHref(event.runId),
          runId: event.runId,
          orchestrationId: event.orchestrationId,
        }),
      ];

    case 'run.accountRotated': {
      if (event.internal) return [];
      const from = event.from ?? text.previousAccount();
      const to = event.to ?? text.nextAccount();
      return [
        draft(event, {
          key: `rotated:${event.runId}`,
          kind: 'limit',
          priority: 'normal',
          tone: 'info',
          title: text.rotated(event.runName),
          body: event.resumed ? text.rotatedBodyReplayed(from, to) : text.rotatedBody(from, to),
          href: chatHref(event.runId),
          runId: event.runId,
          orchestrationId: event.orchestrationId,
        }),
      ];
    }

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
          title: failed ? text.orchestrationFailed(event.orchestrationName) : text.orchestrationFinished(event.orchestrationName),
          body: failed ? text.orchestrationFailedBody() : text.orchestrationDoneBody(),
          href: orchestrationHref(event.orchestrationId),
          orchestrationId: event.orchestrationId,
        }),
      ];
    }

    case 'health.changed': {
      // A recovery is not news, and housekeeping runs are not something a person steps into
      if (event.internal || event.level === 'ok') return [];
      return [
        draft(event, {
          // The signals, not the level: a worker that goes from slow to looping is new news
          key: `health:${event.runId}:${event.signals.join(',')}`,
          kind: 'health',
          priority: event.level === 'bad' ? 'high' : 'normal',
          tone: event.level === 'bad' ? 'bad' : 'warn',
          title: event.title,
          body: text.serverText(event.reasonCode, event.params, event.reason),
          href: chatHref(event.runId),
          runId: event.runId,
          orchestrationId: event.orchestrationId,
        }),
      ];
    }

    case 'supervisor.proposed': {
      const { proposal } = event;
      // A task's proposal is acted on where its health is shown with the task's hint route: the board
      const href =
        proposal.orchestrationId && proposal.taskId
          ? `${orchestrationHref(proposal.orchestrationId)}?task=${encodeURIComponent(proposal.taskId)}`
          : chatHref(proposal.chatId);
      return [
        draft(event, {
          // One proposal per signal per chat, so its id is the news
          key: `supervisor:${proposal.id}`,
          dedupeMs: 0,
          kind: 'health',
          priority: 'normal',
          tone: 'info',
          title: text.supervisorProposed(event.taskName ?? event.runName),
          body: proposal.hint,
          href,
          runId: event.runId,
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
          body: event.resolving ? text.conflictResolving(event.paths.length, event.branch) : text.conflict(event.paths.length, event.branch),
          href: orchestrationHref(event.orchestrationId),
          orchestrationId: event.orchestrationId,
        }),
      ];

    case 'task.ended': {
      const chatOf = activityChat(event.runId, event.sessionId);
      const failed = ACTIVITY_FAILED.has(event.status);
      return [
        draft(event, {
          key: `task:${event.runId}:${event.taskId}`,
          kind: 'activity',
          priority: failed ? 'normal' : 'low',
          tone: failed ? 'bad' : 'info',
          title: event.title,
          body: event.summary ?? (event.fromSubagent ? text.fromSubagent() : ''),
          href: chatOf ? detailHref({ kind: 'task', chatId: chatOf, taskId: event.taskId }, chatHref(chatOf)) : null,
          runId: event.runId || null,
        }),
      ];
    }

    case 'subagent.ended': {
      const chatOf = activityChat(event.runId, event.sessionId);
      const failed = event.status !== 'completed';
      return [
        draft(event, {
          key: `subagent:${event.runId}:${event.toolUseId}`,
          kind: 'activity',
          priority: failed ? 'normal' : 'low',
          tone: failed ? 'bad' : 'info',
          title: event.title,
          body: event.description,
          href: chatOf ? (event.agentId ? detailHref({ kind: 'subagent', chatId: chatOf, agentId: event.agentId }, chatHref(chatOf)) : chatHref(chatOf)) : null,
          runId: event.runId || null,
        }),
      ];
    }

    case 'workflow.ended': {
      const chatOf = activityChat(event.runId, event.sessionId);
      const failed = event.status === 'failed';
      return [
        draft(event, {
          key: `workflow:${event.runId}:${event.workflowId}`,
          kind: 'activity',
          priority: failed ? 'normal' : 'low',
          tone: failed ? 'bad' : 'info',
          title: event.title,
          body: event.summary ?? '',
          // Only workflows the CLI ids as `wf_…` have agent transcripts to open, as on the workflow card
          href: chatOf ? (event.agentId && event.workflowId.startsWith('wf_') ? detailHref({ kind: 'workflow-agent', chatId: chatOf, workflowId: event.workflowId, agentId: event.agentId }, chatHref(chatOf)) : chatHref(chatOf)) : null,
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
export function settlesWaiting(event: AgentryEvent): ((notification: NotificationMatch) => boolean) | null {
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
