import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect } from 'react';
import type {
  AgentryEvent,
  AgentryEventType,
  ChatActivityEvent,
  ChatDetail,
  ChatSummary,
  Orchestration,
  Overview,
  StreamHelloEvent,
  StreamResyncEvent,
} from '@agentry/shared';
import { keys } from '../api';
import { withToken } from './auth';
import { dispatchEvent, setFeedState, useFeedState, type FeedState } from './feed';

export {
  FALLBACK_POLL_MS,
  subscribeEvents,
  useAgentryEvents,
  useFallbackInterval,
  useFeedState,
  type AgentryEventListener,
  type FeedState,
} from './feed';

/*
 * The one connection to `GET /api/events`, shared by the whole app.
 *
 * It keeps the react-query caches fresh (so pages do not poll) and lets other code hear the same
 * events without opening a second connection:
 *
 *   subscribeEvents(listener)      plain subscription; returns the unsubscribe function
 *   useAgentryEvents(listener)     the same inside a component, always calling its latest closure
 *   useFeedState()                 'connecting' | 'open' | 'closed'
 *   useFallbackInterval(ms)        a refetchInterval that is `false` while the stream is open
 *
 * `useEventFeed()` starts the connection and must be mounted exactly once, in App.
 */

const RECONNECT_MAX_MS = 15_000;

// Delays group the invalidations of a burst into one refetch. Chats get the longest: a process
// writing its transcript makes the server say "changed" every second, and the lists it touches
// are the expensive ones to read.
const NOW = 100;
const OVERVIEW = 800;
const CHATS = 2500;

/** Every event name the server sends; typed as a record so a new event type cannot be forgotten. */
const EVENT_TYPES: Record<AgentryEventType, true> = {
  'run.created': true,
  'run.updated': true,
  'run.ended': true,
  'run.removed': true,
  'run.waiting': true,
  'permission.requested': true,
  'permission.resolved': true,
  'run.rateLimited': true,
  'run.accountRotated': true,
  'account.switched': true,
  'task.started': true,
  'task.ended': true,
  'subagent.started': true,
  'subagent.updated': true,
  'subagent.ended': true,
  'workflow.progress': true,
  'workflow.ended': true,
  'orchestration.updated': true,
  'orchestration.removed': true,
  'orchestration.task': true,
  'orchestration.conflict': true,
  'changes.updated': true,
  'chat.activity': true,
  'health.changed': true,
  'sessions.changed': true,
  'schedule.changed': true,
  'schedule.fired': true,
  'supervisor.proposed': true,
};

type Target = readonly [QueryKey, number];

// Open panels read from these; a query nobody has mounted is only marked stale, not refetched
const detail = (delay: number): Target[] => [
  [keys.agentDetail, delay],
  [keys.taskOutput, delay],
];

// Work delegated inside a chat names the chat by its session when no process of ours runs it. The
// chat's page shows that work as its branches, so it reads again when the work moves.
const chatOf = (event: { runId: string; sessionId: string | null }): Target[] => {
  const id = event.runId || event.sessionId;
  return id ? [[keys.chatScope(id), NOW]] : [];
};

const activity = (delay: number): Target[] => [
  [keys.tasks, delay],
  [keys.subagents, delay],
  [keys.workflows, delay],
  ...detail(delay),
];

/** The cached queries an event makes stale, and how soon each should be refetched. */
export function targetsFor(event: AgentryEvent): Target[] {
  switch (event.type) {
    // A run is an execution of a chat, and its id is the chat's: what it changes is that chat
    case 'run.created':
      return [[keys.chats, NOW], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW], [['environments'], NOW]];
    case 'run.updated':
      // Only a status change moves counts elsewhere; the rest is a chat's own numbers and text
      return event.previousStatus === null
        ? [[keys.chats, NOW], [['chat', event.runId], NOW]]
        : [[keys.chats, NOW], [['chat', event.runId], NOW], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW], [['environments'], NOW]];
    case 'run.ended':
      return [
        [keys.chats, NOW], [['chat', event.runId], NOW], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW], [['usage'], OVERVIEW],
        [['environments'], NOW], ...activity(OVERVIEW),
      ];
    case 'run.removed':
      return [[keys.chats, NOW], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW], [['usage'], OVERVIEW]];
    case 'run.waiting':
    case 'permission.requested':
    case 'permission.resolved':
      return [[keys.chatPermissions(event.runId), NOW], [keys.chats, NOW], [keys.overview, NOW]];
    case 'run.rateLimited':
    case 'run.accountRotated':
    case 'account.switched':
      return [[keys.accounts, NOW], [keys.overview, NOW], [keys.auth, NOW], [keys.chats, NOW]];
    case 'task.started':
    case 'task.ended':
      return [[keys.tasks, NOW], ...detail(NOW), ...chatOf(event), [keys.chats, NOW], [keys.overview, OVERVIEW]];
    case 'subagent.started':
    case 'subagent.ended':
      return [[keys.subagents, NOW], ...detail(NOW), ...chatOf(event), [keys.chats, NOW], [keys.overview, OVERVIEW]];
    case 'subagent.updated':
      return [[keys.subagents, NOW], [keys.agentDetail, NOW], ...chatOf(event)];
    case 'workflow.progress':
      return [[keys.workflows, NOW], [keys.agentDetail, NOW], ...chatOf(event)];
    case 'workflow.ended':
      return [[keys.workflows, NOW], [keys.agentDetail, NOW], ...chatOf(event), [keys.overview, OVERVIEW]];
    case 'orchestration.updated':
    case 'orchestration.conflict':
      return [
        [keys.orchestrations, NOW], [keys.orchestration(event.orchestrationId), NOW], [keys.chats, NOW], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW],
      ];
    case 'orchestration.removed':
      return [[keys.orchestrations, NOW], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW]];
    case 'orchestration.task':
      return [[keys.orchestrations, NOW], [keys.orchestration(event.orchestrationId), NOW], [keys.chats, NOW]];
    case 'changes.updated':
      // Whatever the board reads about this graph's branches sits under its key, changes included
      return [[keys.orchestration(event.orchestrationId), NOW]];
    case 'chat.activity':
      // Nothing is refetched: the event carries the whole line, and `patchActivity` writes it into
      // the caches that show it. A working agent changes it every few seconds, and reading every
      // list again for one line of text is what the server's throttle was meant to spare.
      return [];
    case 'schedule.changed':
    case 'schedule.fired':
      // The runs of every schedule sit under the same prefix as the list
      return [[keys.schedules, NOW]];
    case 'health.changed':
    case 'supervisor.proposed':
      // Health is read with the chat, and with the graph for a worker; a proposal hangs on it
      return [
        [keys.chats, NOW], [['chat', event.runId], NOW],
        ...(event.orchestrationId ? ([[keys.orchestration(event.orchestrationId), NOW], [keys.orchestrations, NOW]] as Target[]) : []),
      ];
    case 'sessions.changed':
      // Chats begun in a terminal are read from disk, so their tasks, subagents and workflows move with it
      return [
        [keys.chats, CHATS], [['chat'], CHATS], [keys.projects, CHATS], [keys.overview, CHATS], [['usage'], CHATS], ...activity(CHATS),
      ];
  }
}

/**
 * Writes what a chat is doing into the caches that show it, in place. Lists, the overview and an
 * orchestration's board all carry the chat as a summary or as a task, so each is patched where it
 * holds one; a cache that does not have the chat is left alone, and nothing is refetched.
 */
export function patchActivity(client: QueryClient, event: ChatActivityEvent): void {
  const chatId = event.sessionId ?? event.runId;
  if (!chatId) return;
  const { activity } = event;
  const patchChat = (chat: ChatSummary): ChatSummary => (chat.id === chatId ? { ...chat, activity } : chat);

  client.setQueriesData<ChatSummary[]>({ queryKey: keys.chats }, (chats) =>
    chats?.some((chat) => chat.id === chatId) ? chats.map(patchChat) : chats,
  );
  // The chat's own page: its ticker falls back to this line between the blocks its stream shows
  for (const sidechains of [false, true]) {
    client.setQueryData<ChatDetail>(keys.chat(chatId, sidechains), (detail) => (detail ? { ...detail, chat: { ...detail.chat, activity } } : detail));
  }
  client.setQueriesData<Overview>({ queryKey: keys.overview }, (overview) =>
    overview?.recentChats.some((chat) => chat.id === chatId) ? { ...overview, recentChats: overview.recentChats.map(patchChat) } : overview,
  );
  if (!event.orchestrationId || !event.taskId) return;
  const patchGraph = (orch: Orchestration): Orchestration =>
    orch.id === event.orchestrationId ? { ...orch, tasks: orch.tasks.map((task) => (task.id === event.taskId ? { ...task, activity } : task)) } : orch;
  client.setQueriesData<Orchestration>({ queryKey: keys.orchestration(event.orchestrationId) }, (orch) => (orch ? patchGraph(orch) : orch));
  client.setQueriesData<Orchestration[]>({ queryKey: keys.orchestrations }, (list) => list?.map(patchGraph));
}

/**
 * Folds a burst of events into one refetch per query. A request never postpones one already
 * waiting, but it can bring it forward: a slow refresh of the overview must not delay the fast
 * one an ended run asks for.
 */
class Invalidations {
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; due: number }>();

  constructor(private readonly client: QueryClient) {}

  schedule(targets: readonly Target[]): void {
    for (const [key, delay] of targets) {
      const id = JSON.stringify(key);
      const due = Date.now() + delay;
      const waiting = this.pending.get(id);
      if (waiting && waiting.due <= due) continue;
      if (waiting) clearTimeout(waiting.timer);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        void this.client.invalidateQueries({ queryKey: key });
      }, delay);
      this.pending.set(id, { timer, due });
    }
  }

  cancel(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}

// ---------- the connection ----------

/** Opens the connection and wires it to the caches; returns what closes it. */
function startEventFeed(client: QueryClient): () => void {
  const invalidations = new Invalidations(client);
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let stopped = false;
  let lastId = 0;
  let bootId: string | null = null;

  // Everything on screen may have changed while events were being missed
  const resync = () => {
    invalidations.cancel();
    void client.invalidateQueries();
  };

  const onEvent = (raw: MessageEvent) => {
    let event: AgentryEvent;
    try {
      event = JSON.parse(String(raw.data)) as AgentryEvent;
    } catch {
      return;
    }
    if (event.id <= lastId) return;
    lastId = event.id;
    if (event.type === 'chat.activity') patchActivity(client, event);
    invalidations.schedule(targetsFor(event));
    dispatchEvent(event);
  };

  const connect = () => {
    setFeedState('connecting');
    const es = new EventSource(withToken(`/api/events${lastId ? `?since=${lastId}` : ''}`));
    source = es;
    es.onopen = () => {
      attempts = 0;
      setFeedState('open');
    };
    es.addEventListener('stream.hello', (raw) => {
      const hello = JSON.parse(String((raw as MessageEvent).data)) as StreamHelloEvent;
      // Ids restart with the server, so a new boot id means the cursor is meaningless
      if (bootId !== null && bootId !== hello.bootId) {
        lastId = hello.lastEventId;
        resync();
      }
      bootId = hello.bootId;
    });
    es.addEventListener('stream.resync', (raw) => {
      lastId = (JSON.parse(String((raw as MessageEvent).data)) as StreamResyncEvent).lastEventId;
      resync();
    });
    for (const type of Object.keys(EVENT_TYPES)) es.addEventListener(type, (raw) => onEvent(raw as MessageEvent));
    es.onerror = () => {
      // While the browser is retrying by itself it says CONNECTING; CLOSED means it gave up (the
      // server answered with an error), and only a new EventSource can recover
      if (es.readyState !== EventSource.CLOSED) return setFeedState('connecting');
      setFeedState('closed');
      es.close();
      if (stopped) return;
      retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, RECONNECT_MAX_MS));
    };
  };
  const disconnect = () => {
    if (retry) clearTimeout(retry);
    retry = undefined;
    source?.close();
    source = null;
  };
  connect();

  // A page kept in the back/forward cache is frozen but its connection stays open, and browsers
  // allow only six per origin over HTTP/1.1: a few navigations later nothing else can load. Let go
  // when the page is hidden that way, and pick up from the last id when it comes back.
  const onPageHide = () => {
    disconnect();
    setFeedState('closed');
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted && !stopped) connect();
  };
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);

  return () => {
    stopped = true;
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    disconnect();
    invalidations.cancel();
    setFeedState('connecting');
  };
}

/** Starts the app-wide event connection. Call it once, from App. */
export function useEventFeed(): FeedState {
  const client = useQueryClient();
  useEffect(() => startEventFeed(client), [client]);
  return useFeedState();
}
