import { CONTEXT_FULL, CONTEXT_WARN, type ChatOrigin, type ChatState, type ChatSummary, type Execution, type ExecutionOutcome } from '@agentry/shared';

/** The share of the window in use, or null when there is nothing honest to divide by. */
export function contextShare(chat: Pick<ChatSummary, 'context'>): number | null {
  const { context } = chat;
  if (!context || context.window === null || context.window <= 0) return null;
  return context.used / context.window;
}

export type ContextLevel = 'ok' | 'warn' | 'full';

export function contextLevel(share: number): ContextLevel {
  return share >= CONTEXT_FULL ? 'full' : share >= CONTEXT_WARN ? 'warn' : 'ok';
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Dollars, or the words for a cost nobody reported: it is never estimated, so it is never zero either. */
export function formatUsd(usd: number | null): string {
  if (usd === null) return 'not available';
  return usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export const STATE_LABEL: Record<ChatState, string> = {
  working: 'Working',
  waiting: 'Waiting for you',
  idle: 'Idle',
};

export const ORIGIN_LABEL: Record<ChatOrigin, string> = {
  agentry: 'Agentry',
  external: 'Terminal',
  orchestration: 'Orchestration',
  internal: 'Internal',
};

export const OUTCOME_LABEL: Record<ExecutionOutcome, string> = {
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
};

/** The execution that ended last, which is what tells an idle chat that crashed from one that finished. */
export function lastEnded(chat: Pick<ChatSummary, 'executions'>): Execution | null {
  for (let i = chat.executions.length - 1; i >= 0; i--) {
    const execution = chat.executions[i];
    if (execution && execution.endedAt !== null) return execution;
  }
  return null;
}

/** An orchestration's synthesis is its deliverable; every other chat of an orchestration is a worker. */
export const isWorker = (chat: Pick<ChatSummary, 'origin' | 'orchestration'>): boolean =>
  chat.origin === 'orchestration' && chat.orchestration?.taskId !== null;

export type ChatOriginFilter = 'agentry' | 'external' | 'orchestration';

export interface ChatFilters {
  origins: ReadonlySet<ChatOriginFilter>;
  state: ChatState | null;
  /** Workers of orchestrations: out unless asked for, because their home is the board */
  workers: boolean;
  /** Housekeeping chats (the planner, the auth check) */
  internal: boolean;
  search: string;
}

export const ALL_ORIGINS: readonly ChatOriginFilter[] = ['agentry', 'external', 'orchestration'];

/** Which origins the server has to send for these filters: workers and housekeeping are opt-in. */
export function originsToFetch(filters: Pick<ChatFilters, 'internal'>): ChatOrigin[] {
  return [...ALL_ORIGINS, ...(filters.internal ? (['internal'] as const) : [])];
}

export function matchesFilters(chat: ChatSummary, filters: ChatFilters): boolean {
  if (chat.origin === 'internal') {
    if (!filters.internal) return false;
  } else if (isWorker(chat)) {
    if (!filters.workers) return false;
  } else if (!filters.origins.has(chat.origin)) {
    return false;
  }
  if (filters.state && chat.state !== filters.state) return false;
  const needle = filters.search.trim().toLowerCase();
  if (!needle) return true;
  return [chat.title, chat.firstPrompt ?? '', chat.project?.name ?? '', chat.cwd, chat.id, chat.orchestration?.name ?? '', chat.orchestration?.taskName ?? ''].some((v) =>
    v.toLowerCase().includes(needle),
  );
}

export type ChatSort = 'activity' | 'started' | 'context' | 'messages';

export const SORT_LABEL: Record<ChatSort, string> = {
  activity: 'Recent activity',
  started: 'Recently started',
  context: 'Most context in use',
  messages: 'Most messages',
};

export const SORTERS: Record<ChatSort, (a: ChatSummary, b: ChatSummary) => number> = {
  activity: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  started: (a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''),
  // A chat with no known share sorts after every chat that has one
  context: (a, b) => (contextShare(b) ?? -1) - (contextShare(a) ?? -1) || SORTERS.activity(a, b),
  messages: (a, b) => b.messageCount - a.messageCount,
};
