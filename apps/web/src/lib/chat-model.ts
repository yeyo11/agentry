import { CONTEXT_FULL, CONTEXT_WARN, type ChatOrigin, type ChatState, type ChatSummary, type Execution } from '@agentry/shared';
import i18n from '../i18n';
import { formatCost } from './format';

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
  if (usd === null) return i18n.t('chats:model.notAvailable');
  return formatCost(usd);
}

// The label maps read their text through getters: the language can change after this module has
// loaded, and every caller indexes the map at render time.
export const STATE_LABEL: Record<ChatState, string> = {
  get working() {
    return i18n.t('chats:model.state.working');
  },
  get waiting() {
    return i18n.t('chats:model.state.waiting');
  },
  get idle() {
    return i18n.t('chats:model.state.idle');
  },
};

export const ORIGIN_LABEL: Record<ChatOrigin, string> = {
  get agentry() {
    return i18n.t('chats:model.origin.agentry');
  },
  get external() {
    return i18n.t('chats:model.origin.external');
  },
  get orchestration() {
    return i18n.t('chats:model.origin.orchestration');
  },
  get internal() {
    return i18n.t('chats:model.origin.internal');
  },
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
  get activity() {
    return i18n.t('chats:model.sort.activity');
  },
  get started() {
    return i18n.t('chats:model.sort.started');
  },
  get context() {
    return i18n.t('chats:model.sort.context');
  },
  get messages() {
    return i18n.t('chats:model.sort.messages');
  },
};

export const SORTERS: Record<ChatSort, (a: ChatSummary, b: ChatSummary) => number> = {
  activity: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  started: (a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''),
  // A chat with no known share sorts after every chat that has one
  context: (a, b) => (contextShare(b) ?? -1) - (contextShare(a) ?? -1) || SORTERS.activity(a, b),
  messages: (a, b) => b.messageCount - a.messageCount,
};
