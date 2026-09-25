import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect } from 'react';
import type {
  AgentryEvent,
  AgentryEventType,
  ChatActivityEvent,
  ChatDetail,
  ChatState,
  ChatSummary,
  Orchestration,
  Overview,
  RunStatus,
  RunUpdatedEvent,
  StreamHelloEvent,
  StreamResyncEvent,
} from '@agentry/shared';
import { keys } from '../api';
import { withToken } from './auth';
import { dispatchEvent, setFeedState, useFeedState, type FeedState } from './feed';
import { browserPermission, getPrefs } from './notifications';

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
/** How long a tab stays hidden before it lets go of its connection; a quick switch keeps it. */
const HIDDEN_PARK_MS = 30_000;

// Delays group the invalidations of a burst into one refetch. Chats get the longest: a process
// writing its transcript makes the server say "changed" every second, and the lists it touches
// are the expensive ones to read.
const NOW = 100;
const OVERVIEW = 800;
// Every list of chats is read whole, and a busy server has several runs each moving every 250 ms:
// one read a second at most is plenty for rows whose live numbers are patched in between
const LISTS = 1000;
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
  'system.release': true,
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

// The transcript pages of a chat, not everything under its key: permissions, the checklist and the
// changes have events or intervals of their own, and a turn moving is no news to them
const transcriptOf = (id: string): Target[] => [
  [keys.chat(id, false), NOW],
  [keys.chat(id, true), NOW],
  [['chat', id, 'tail'], NOW],
];

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
      return [[keys.chats, LISTS], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW], [['environments'], NOW]];
    case 'run.updated':
      // Only a status change moves counts elsewhere. The rest is a chat's own numbers, which
      // `patchRun` writes into the rows: the lists are read again only when that moved the state
      return event.previousStatus === null
        ? transcriptOf(event.runId)
        : [[keys.chats, LISTS], [keys.chatScope(event.runId), NOW], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW], [['environments'], NOW]];
    case 'run.ended':
      return [
        [keys.chats, LISTS], [['chat', event.runId], NOW], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW], [['usage'], OVERVIEW],
        [['environments'], NOW], ...activity(OVERVIEW),
      ];
    case 'run.removed':
      return [[keys.chats, LISTS], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW], [['usage'], OVERVIEW]];
    case 'run.waiting':
    case 'permission.requested':
    case 'permission.resolved':
      return [[keys.chatPermissions(event.runId), NOW], [keys.chats, LISTS], [keys.overview, NOW]];
    case 'run.rateLimited':
    case 'run.accountRotated':
    case 'account.switched':
      return [[keys.accounts, NOW], [keys.overview, NOW], [keys.auth, NOW], [keys.chats, LISTS]];
    case 'task.started':
    case 'task.ended':
      return [[keys.tasks, NOW], ...detail(NOW), ...chatOf(event), [keys.chats, LISTS], [keys.overview, OVERVIEW]];
    case 'subagent.started':
    case 'subagent.ended':
      return [[keys.subagents, NOW], ...detail(NOW), ...chatOf(event), [keys.chats, LISTS], [keys.overview, OVERVIEW]];
    case 'subagent.updated':
      return [[keys.subagents, NOW], [keys.agentDetail, NOW], ...chatOf(event)];
    case 'workflow.progress':
      return [[keys.workflows, NOW], [keys.agentDetail, NOW], ...chatOf(event)];
    case 'workflow.ended':
      return [[keys.workflows, NOW], [keys.agentDetail, NOW], ...chatOf(event), [keys.overview, OVERVIEW]];
    case 'orchestration.updated':
    case 'orchestration.conflict':
      return [
        [keys.orchestrations, NOW], [keys.orchestration(event.orchestrationId), NOW], [keys.chats, LISTS], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW],
      ];
    case 'orchestration.removed':
      return [[keys.orchestrations, NOW], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW]];
    case 'orchestration.task':
      return [[keys.orchestrations, NOW], [keys.orchestration(event.orchestrationId), NOW], [keys.chats, LISTS]];
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
        [keys.chats, LISTS], [['chat', event.runId], NOW],
        ...(event.orchestrationId ? ([[keys.orchestration(event.orchestrationId), NOW], [keys.orchestrations, NOW]] as Target[]) : []),
      ];
    case 'sessions.changed':
      // Chats begun in a terminal are read from disk, so their tasks, subagents and workflows move with it
      return [
        [keys.chats, CHATS], [['chat'], CHATS], [keys.projects, CHATS], [keys.overview, CHATS], [['usage'], CHATS], ...activity(CHATS),
      ];
    case 'system.release':
      // Reading it back costs nothing: the server answers from release.json, not from GitHub
      return [[keys.release, NOW]];
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

/** A chat's state while a run of ours drives it: `stateFromRun` in core, which the lists are built with. */
export function runState(status: RunStatus, pendingPrompts: number): ChatState {
  if (status === 'completed' || status === 'failed' || status === 'stopped') return 'idle';
  if (pendingPrompts > 0) return 'waiting';
  return status === 'idle' ? 'idle' : 'working';
}

/**
 * Writes what a `run.updated` without a status change says into the rows that show the chat: its
 * state (a permission prompt makes it wait) and what it has spent, which is the run's total. Returns
 * whether a row changed state, which is when a list filtered by state or counting states is wrong
 * and has to be read again.
 */
export function patchRun(client: QueryClient, event: RunUpdatedEvent): boolean {
  const ids = new Set([event.runId, event.sessionId].filter((id): id is string => Boolean(id)));
  const state = runState(event.status, event.pendingPrompts);
  let moved = false;
  const patchChat = (chat: ChatSummary): ChatSummary => {
    if (!ids.has(chat.id)) return chat;
    if (chat.state !== state) moved = true;
    // A run that has answered nothing has no figure, as the server says it
    const usd = chat.cost.usd === null && event.costUsd === 0 ? null : event.costUsd;
    const spent = usd !== chat.cost.usd;
    if (!spent && chat.state === state) return chat;
    // A new figure comes with a result, which the CLI has just written to the transcript
    const updatedAt = spent && (chat.updatedAt === null || event.at > chat.updatedAt) ? event.at : chat.updatedAt;
    return { ...chat, state, updatedAt, cost: { ...chat.cost, usd } };
  };
  client.setQueriesData<ChatSummary[]>({ queryKey: keys.chats }, (chats) =>
    chats?.some((chat) => ids.has(chat.id)) ? chats.map(patchChat) : chats,
  );
  client.setQueriesData<Overview>({ queryKey: keys.overview }, (overview) =>
    overview?.recentChats.some((chat) => ids.has(chat.id)) ? { ...overview, recentChats: overview.recentChats.map(patchChat) } : overview,
  );
  return moved;
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
    if (event.type === 'run.updated' && event.previousStatus === null && patchRun(client, event)) {
      invalidations.schedule([[keys.chats, LISTS], [keys.overview, OVERVIEW]]);
    }
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
      let hello: StreamHelloEvent;
      try {
        hello = JSON.parse(String((raw as MessageEvent).data)) as StreamHelloEvent;
      } catch {
        return;
      }
      // Ids restart with the server, so a new boot id means the cursor is meaningless
      if (bootId !== null && bootId !== hello.bootId) {
        lastId = hello.lastEventId;
        resync();
      }
      bootId = hello.bootId;
    });
    es.addEventListener('stream.resync', (raw) => {
      // Unreadable, it still says events were missed: everything is read again from where it is
      try {
        lastId = (JSON.parse(String((raw as MessageEvent).data)) as StreamResyncEvent).lastEventId;
      } catch {
        // keep the cursor
      }
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
    // The tab being shown again may have reconnected it already
    if (event.persisted && !stopped && source === null) connect();
  };
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);

  // The same six connections are shared by every tab of the origin, and each tab holds one for this
  // stream: a few tabs left in the background starve the one in front. A tab hidden for a while lets
  // go and resumes from its last id when it is shown again, unless it has to raise the system
  // notifications, which exist for exactly the moments nobody is looking at it.
  let park: ReturnType<typeof setTimeout> | undefined;
  const parkable = () => !(getPrefs().browser && browserPermission() === 'granted');
  const onVisibility = () => {
    clearTimeout(park);
    park = undefined;
    if (document.visibilityState === 'hidden') {
      park = setTimeout(() => {
        park = undefined;
        if (stopped || document.visibilityState !== 'hidden' || !parkable()) return;
        disconnect();
        // Not `closed`: nothing is down, the stream is only paused until the tab is shown again (the
        // fallback intervals this starts do not run in a hidden tab anyway)
        setFeedState('connecting');
      }, HIDDEN_PARK_MS);
    } else if (!stopped && source === null && retry === undefined) {
      connect();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    stopped = true;
    clearTimeout(park);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('visibilitychange', onVisibility);
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
