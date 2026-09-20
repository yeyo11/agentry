import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { AgentryEvent, AgentryEventType, StreamHelloEvent, StreamResyncEvent } from '@agentry/shared';
import { keys } from '../api';
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
  'sessions.changed': true,
};

type Target = readonly [QueryKey, number];

// Open panels read from these; a query nobody has mounted is only marked stale, not refetched
const detail = (delay: number): Target[] => [
  [keys.agentDetail, delay],
  [keys.taskOutput, delay],
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
      return [[keys.tasks, NOW], ...detail(NOW), [keys.overview, OVERVIEW]];
    case 'subagent.started':
    case 'subagent.ended':
      return [[keys.subagents, NOW], ...detail(NOW), [keys.overview, OVERVIEW]];
    case 'subagent.updated':
      return [[keys.subagents, NOW], [keys.agentDetail, NOW]];
    case 'workflow.progress':
      return [[keys.workflows, NOW], [keys.agentDetail, NOW]];
    case 'workflow.ended':
      return [[keys.workflows, NOW], [keys.agentDetail, NOW], [keys.overview, OVERVIEW]];
    case 'orchestration.updated':
    case 'orchestration.conflict':
      return [
        [keys.orchestrations, NOW], [keys.orchestration(event.orchestrationId), NOW], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW],
      ];
    case 'orchestration.removed':
      return [[keys.orchestrations, NOW], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW]];
    case 'orchestration.task':
      return [[keys.orchestrations, NOW], [keys.orchestration(event.orchestrationId), NOW]];
    case 'sessions.changed':
      // Chats begun in a terminal are read from disk, so their tasks, subagents and workflows move with it
      return [
        [keys.chats, CHATS], [['chat'], CHATS], [keys.projects, CHATS], [keys.overview, CHATS], [['usage'], CHATS], ...activity(CHATS),
      ];
  }
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
    invalidations.schedule(targetsFor(event));
    dispatchEvent(event);
  };

  const connect = () => {
    setFeedState('connecting');
    const es = new EventSource(`/api/events${lastId ? `?since=${lastId}` : ''}`);
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
