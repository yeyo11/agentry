import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect } from 'react';
import type {
  AgentryEvent,
  AgentryEventType,
  AssistantProposalEvent,
  AssistantRun,
  AssistantRunDetail,
  AppSettings,
  ChatActivityEvent,
  ChatDetail,
  ChatState,
  ChatSummary,
  FlowRun,
  MemoryProposalEvent,
  Orchestration,
  Overview,
  ProjectFlow,
  RunStatus,
  RunUpdatedEvent,
  SettingsChangedEvent,
  StreamHelloEvent,
  StreamResyncEvent,
  Team,
  TunnelChangedEvent,
  TunnelStatus,
  WorkItemChange,
} from '@agentry/shared';
import { keys } from '../api';
import { withToken } from './auth';
import { dispatchEvent, setFeedState, useFeedState, type FeedState } from './feed';
import { browserPermission, getPrefs } from './notifications';
import { noticeServerVersion } from './reload';

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
  'workitem.created': true,
  'workitem.updated': true,
  'workitem.moved': true,
  'workitem.removed': true,
  'milestone.changed': true,
  'project.created': true,
  'project.updated': true,
  'project.removed': true,
  'team.changed': true,
  'journal.changed': true,
  'memory.proposal': true,
  'document.changed': true,
  'flow.run': true,
  'assistant.run': true,
  'assistant.proposal': true,
  'settings.changed': true,
  'tunnel.changed': true,
};

/**
 * A cached read an event makes stale: its key prefix, how soon to refetch it, and optionally
 * `'no-diffs'`, which leaves out a work item's changes under the prefix. Those are a `git diff` of
 * its branch, which a run starting, a node moving or a flow run queued does not change: only a turn
 * that ended (`run.ended`) or the item itself does.
 */
export type Target = readonly [QueryKey, number, 'no-diffs'?];

/** A work item's changes and diffs: `['work-item', id, 'changes', …]`. */
const isItemDiff = (key: QueryKey): boolean => key[0] === 'work-item' && key[2] === 'changes';

/** Whether a target reaches a cached key: by prefix, less the diffs a `'no-diffs'` target leaves alone. */
export function targetMatches(target: Target, key: QueryKey): boolean {
  const [prefix, , except] = target;
  if (!prefix.every((part, i) => JSON.stringify(part) === JSON.stringify(key[i]))) return false;
  return except !== 'no-diffs' || !isItemDiff(key);
}

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

// Where a work item shows besides its own page: every board and list of its project and of All
// projects (the sidebar's count reads the unfiltered board), the chats' lists of their items, and the
// milestones whose progress counts it
const workItemViews = (projectId: string): Target[] => [
  [keys.workItemBoards(projectId), NOW],
  [keys.workItemBoards(null), NOW],
  [keys.workItemLists(projectId), NOW],
  [keys.workItemLists(null), NOW],
  [keys.chatWorkItemsAll, NOW],
  [keys.milestones(projectId), NOW],
  [keys.milestoneEach, NOW],
];

/** What another item's page shows of this one: its chip (key, title, type) and the relation itself. */
const REF_CHANGES: ReadonlySet<WorkItemChange> = new Set(['title', 'type', 'epic', 'relation']);

// A card is live while the chat or node on it runs, which the item's own events do not announce when
// a turn fails or stops: the boards and an open item read again when a run changes state. Only the
// mounted ones are fetched, and at the pace of the lists. Their diffs only move when a turn ends
const liveCards = (diffs: boolean): Target[] => [
  [keys.workItems, LISTS],
  diffs ? [keys.workItemDetails, LISTS] : [keys.workItemDetails, LISTS, 'no-diffs'],
];

// What the team's pages show of the flow: who works on what now (the members, the Flow screen)
const flowViews = (projectId: string): Target[] => [
  [keys.team(projectId), NOW],
  [keys.flow(projectId), NOW],
];

/** What an approved proposal wrote: the CLI's memory files, the project's `CLAUDE.md`, or the journal. */
function approvedTarget(event: MemoryProposalEvent): Target[] {
  switch (event.target.kind) {
    case 'memory':
      return [[keys.memoryProjects, NOW]];
    case 'instructions':
      return [[['config', 'instructions', event.projectId], NOW]];
    case 'journal':
      return [[keys.journal(event.projectId), NOW]];
  }
}

/**
 * What an accepted proposal wrote that has no event of its own: a saved resource, in the list of its
 * kind and scope. An item and a member announce themselves (`workitem.created`, `team.changed`).
 */
function savedResource(event: AssistantProposalEvent): Target[] {
  if (event.action !== 'accepted' || !event.resource) return [];
  const scope = event.resource.scope === 'project' ? { projectId: event.projectId } : {};
  return [[keys.resources(scope, event.resource.kind), NOW]];
}

/** The cached queries an event makes stale, and how soon each should be refetched. */
export function targetsFor(event: AgentryEvent): Target[] {
  switch (event.type) {
    // A run is an execution of a chat, and its id is the chat's: what it changes is that chat
    case 'run.created':
      return [[keys.chats, LISTS], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW], [['environments'], NOW], ...liveCards(false)];
    case 'run.updated':
      // Only a status change moves counts elsewhere. The rest is a chat's own numbers, which
      // `patchRun` writes into the rows: the lists are read again only when that moved the state
      return event.previousStatus === null
        ? transcriptOf(event.runId)
        : [[keys.chats, LISTS], [keys.chatScope(event.runId), NOW], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW], [['environments'], NOW], ...liveCards(false)];
    case 'run.ended':
      return [
        [keys.chats, LISTS], [['chat', event.runId], NOW], [keys.overview, OVERVIEW], [keys.projects, OVERVIEW], [['usage'], OVERVIEW],
        [['environments'], NOW], ...activity(OVERVIEW), ...liveCards(true),
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
      return [[keys.orchestrations, NOW], [keys.orchestration(event.orchestrationId), NOW], [keys.chats, LISTS], ...liveCards(true)];
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
    case 'project.created':
    case 'project.removed':
      // The projects' lists, and the All projects views, which take a project's items in or leave them out
      return [[keys.projects, NOW], [keys.overview, OVERVIEW], [keys.workItemBoards(null), NOW], [keys.workItemLists(null), NOW], [keys.chatWorkItemsAll, NOW]];
    case 'project.updated':
      return [
        [keys.projects, NOW], [keys.overview, OVERVIEW], [keys.projectSettings(event.projectId), NOW],
        // Keys are composed with the prefix when read, so every one of the project's is renamed
        ...(event.changes.includes('key') ? [...workItemViews(event.projectId), [keys.workItemDetails, NOW], [keys.workItemKeys, NOW]] as Target[] : []),
        // Column limits, the team's metadata and the flow live in the settings; a module switched on
        // or off changes what is counted and whether the team and the flow are on
        ...(event.changes.includes('settings') || event.changes.includes('modules')
          ? ([[keys.workItemBoards(event.projectId), NOW], [keys.workItemBoards(null), NOW], ...flowViews(event.projectId)] as Target[])
          : []),
      ];
    case 'workitem.created':
      // An epic's page lists its children, so an item created in one is news to it
      return [...workItemViews(event.projectId), [keys.workItemDetails, NOW]];
    case 'workitem.updated':
      return [
        ...workItemViews(event.projectId),
        // Other pages carry this item as a chip (an epic, a relation), and a relation changes both ends
        event.changes.some((change) => REF_CHANGES.has(change)) ? [keys.workItemDetails, NOW] : [keys.workItem(event.itemId), NOW],
      ];
    case 'workitem.moved':
      // The status is on every chip that names the item, and the milestones count it
      return [...workItemViews(event.projectId), [keys.workItemDetails, NOW]];
    case 'workitem.removed':
      return [...workItemViews(event.projectId), [keys.workItemDetails, NOW], [keys.workItemKeys, NOW]];
    case 'milestone.changed':
      return [
        [keys.milestones(event.projectId), NOW], [keys.milestoneEach, NOW],
        // Deleting one takes it off its items, which the cards and pages show
        ...(event.action === 'deleted' ? [...workItemViews(event.projectId), [keys.workItemDetails, NOW]] as Target[] : []),
      ];
    case 'team.changed':
      // A member is an agent file too, which the project's Resources list, and the template writes them
      return [[keys.team(event.projectId), NOW], [keys.resources({ projectId: event.projectId }, 'agents'), NOW]];
    case 'journal.changed':
      return [[keys.journal(event.projectId), NOW]];
    case 'memory.proposal':
      return [[keys.memoryProposalsOf(event.projectId), NOW], ...(event.action === 'approved' ? approvedTarget(event) : [])];
    case 'document.changed':
      return [
        [keys.documentTree(event.projectId), NOW],
        [keys.documentFile(event.projectId, event.path), NOW],
        // A tie is a `document` link of the item, which its page lists
        ...(event.itemId ? ([[keys.workItem(event.itemId), NOW, 'no-diffs']] as Target[]) : []),
      ];
    case 'flow.run':
      // What the run does to its item (a comment, a move, the waiting state) comes as `workitem.*`;
      // this only changes who is working, which the card shows live
      return [
        ...flowViews(event.projectId),
        [keys.workItemBoards(event.projectId), NOW],
        [keys.workItemLists(event.projectId), NOW],
        [keys.workItem(event.itemId), NOW, 'no-diffs'],
      ];
    case 'assistant.run':
      return [
        [keys.assistantRunsOf(event.projectId), NOW],
        [keys.assistantRun(event.runId), NOW],
        // "Suggest again" set the previous run's pending proposals aside
        ...(event.supersedes ? ([[keys.assistantRun(event.supersedes), NOW]] as Target[]) : []),
      ];
    case 'assistant.proposal':
      // The lists carry each run's counts by status ("2 of 6 accepted")
      return [[keys.assistantRun(event.runId), NOW], [keys.assistantRunsOf(event.projectId), NOW], ...savedResource(event)];
    case 'settings.changed':
      // The event carries the document, which `patchSettings` writes; what applies to the next run
      // reaches New chat and Home through the overview's `system.defaultPermissionMode`
      return [[keys.overview, NOW]];
    case 'tunnel.changed':
      // The event carries the whole status, which `patchSettings` writes
      return [];
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
  // A team member at work shows its chat's line, as the Flow screen does for each running run
  const patchRuns = (runs: FlowRun[]): FlowRun[] => (runs.some((run) => run.chatId === chatId) ? runs.map((run) => (run.chatId === chatId ? { ...run, activity } : run)) : runs);
  client.setQueriesData<Team>({ queryKey: ['team'] }, (team) =>
    team?.members.some((member) => member.running.some((run) => run.chatId === chatId))
      ? { ...team, members: team.members.map((member) => ({ ...member, running: patchRuns(member.running) })) }
      : team,
  );
  client.setQueriesData<ProjectFlow>({ queryKey: ['flow'] }, (flow) =>
    flow?.running.some((run) => run.chatId === chatId) ? { ...flow, running: patchRuns(flow.running) } : flow,
  );
  // A running assistant shows its chat's line ("Reading src/webhooks/stripe.ts")
  const patchAssistant = <R extends AssistantRun>(run: R): R => (run.chatId === chatId ? { ...run, activity } : run);
  client.setQueriesData<AssistantRun[]>({ queryKey: ['assistant', 'runs'] }, (runs) =>
    runs?.some((run) => run.chatId === chatId) ? runs.map(patchAssistant) : runs,
  );
  client.setQueriesData<AssistantRunDetail>({ queryKey: keys.assistantRunEach }, (run) => (run?.chatId === chatId ? patchAssistant(run) : run));
  if (!event.orchestrationId || !event.taskId) return;
  const patchGraph = (orch: Orchestration): Orchestration =>
    orch.id === event.orchestrationId ? { ...orch, tasks: orch.tasks.map((task) => (task.id === event.taskId ? { ...task, activity } : task)) } : orch;
  client.setQueriesData<Orchestration>({ queryKey: keys.orchestration(event.orchestrationId) }, (orch) => (orch ? patchGraph(orch) : orch));
  client.setQueriesData<Orchestration[]>({ queryKey: keys.orchestrations }, (list) => list?.map(patchGraph));
}

/**
 * Writes the layered settings and the tunnel's status into their caches, from the event that
 * carries each one whole. A tunnel moving through its states in a few seconds would otherwise cost
 * a request per step, and a refetch could land between two steps and show one already gone.
 */
export function patchSettings(client: QueryClient, event: SettingsChangedEvent | TunnelChangedEvent): void {
  if (event.type === 'settings.changed') client.setQueryData<AppSettings>(keys.appSettings, event.settings);
  else client.setQueryData<TunnelStatus>(keys.tunnel, event.tunnel);
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
    for (const target of targets) {
      const [key, delay] = target;
      const id = JSON.stringify(target);
      const due = Date.now() + delay;
      const waiting = this.pending.get(id);
      if (waiting && waiting.due <= due) continue;
      if (waiting) clearTimeout(waiting.timer);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        void this.client.invalidateQueries(target[2] ? { queryKey: key, predicate: (query) => targetMatches(target, query.queryKey) } : { queryKey: key });
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
    if (event.type === 'settings.changed' || event.type === 'tunnel.changed') patchSettings(client, event);
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
      // Every connection, not only the first: reconnecting after a server restart is how a page
      // left open across a deploy finds out
      noticeServerVersion(hello.version);
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
