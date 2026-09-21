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
  /** Project ids, `loose` for the chats under none; empty or absent is every project */
  projects?: ReadonlySet<string>;
  /** Model ids; empty or absent is every model, and a chat that never said its model passes only then */
  models?: ReadonlySet<string>;
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
  if (filters.projects?.size && !filters.projects.has(projectKey(chat))) return false;
  if (filters.models?.size && (chat.model === null || !filters.models.has(chat.model))) return false;
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

/** The key a chat's project goes by in a filter: its id, or `loose` when it is under none. */
export const projectKey = (chat: Pick<ChatSummary, 'project'>): string => chat.project?.id ?? 'loose';

/** How many chats each state tab would show with every other filter as it is. */
export function stateCounts(chats: readonly ChatSummary[], filters: ChatFilters): Record<ChatState | 'all', number> {
  const counts = { all: 0, working: 0, waiting: 0, idle: 0 };
  for (const chat of chats) {
    if (!matchesFilters(chat, { ...filters, state: null })) continue;
    counts.all++;
    counts[chat.state]++;
  }
  return counts;
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

/**
 * The values a facet can take, read from the chats themselves: offering a model nobody used would
 * only ever filter the list down to nothing. Most used first, then by name.
 */
export function facetOptions(chats: readonly ChatSummary[], facet: 'project' | 'model', looseLabel = ''): FacetOption[] {
  const found = new Map<string, FacetOption>();
  for (const chat of chats) {
    const value = facet === 'project' ? projectKey(chat) : chat.model;
    // `<synthetic>` is what the CLI writes on messages it made up itself, not a model anyone chose
    if (value === null || (facet === 'model' && value.startsWith('<'))) continue;
    const label = facet === 'project' ? (chat.project?.name ?? looseLabel) : value;
    const held = found.get(value);
    if (held) held.count++;
    else found.set(value, { value, label, count: 1 });
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export type DayGroup = 'today' | 'yesterday' | 'week' | 'earlier';

/**
 * Which heading a moment falls under, by the reader's calendar rather than by 24-hour windows: a
 * chat touched at 23:50 is yesterday's at 00:10. "This week" is the five days before yesterday.
 */
export function dayGroup(iso: string | null, now: Date = new Date()): DayGroup {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return 'earlier';
  const day = (back: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).getTime();
  // A clock running ahead of this one still means today
  if (at >= day(0)) return 'today';
  if (at >= day(1)) return 'yesterday';
  if (at >= day(6)) return 'week';
  return 'earlier';
}

/** Chats already in order, cut into consecutive runs of the same day group. */
export function groupByDay<T extends Pick<ChatSummary, 'updatedAt'>>(chats: readonly T[], now: Date = new Date()): Array<{ group: DayGroup; chats: T[] }> {
  const groups: Array<{ group: DayGroup; chats: T[] }> = [];
  for (const chat of chats) {
    const group = dayGroup(chat.updatedAt, now);
    const last = groups[groups.length - 1];
    if (last && last.group === group) last.chats.push(chat);
    else groups.push({ group, chats: [chat] });
  }
  return groups;
}

export type RowTag = 'interactive' | 'readOnly' | 'fork' | 'worktree';

/**
 * What a row says about a chat beside its title, two things at most. Resumable is what nearly every
 * chat is, so only the other control modes earn a tag; then whether it is a copy of another chat and
 * whether it works in a worktree of its own.
 */
export function rowTags(chat: Pick<ChatSummary, 'control' | 'derivedFrom' | 'worktree'>): RowTag[] {
  const tags: RowTag[] = [];
  if (chat.control.mode !== 'resumable') tags.push(chat.control.mode);
  if (chat.derivedFrom) tags.push('fork');
  if (chat.worktree) tags.push('worktree');
  return tags.slice(0, 2);
}

/**
 * Why a chat cannot be deleted now, or null when it can. The server refuses a chat something runs
 * on; one something else holds is left alone, as the chat's own page leaves it.
 */
export function deleteBlocker(chat: Pick<ChatSummary, 'execution' | 'state' | 'control'>): 'live' | 'held' | null {
  if (chat.execution || chat.state !== 'idle') return 'live';
  if (chat.control.mode === 'readOnly') return 'held';
  return null;
}

/** Where the keyboard cursor lands after `j` (+1) or `k` (-1): it stops at either end. */
export function stepCursor(count: number, current: number | null, delta: number): number | null {
  if (count <= 0) return null;
  if (current === null || current < 0 || current >= count) return delta < 0 ? count - 1 : 0;
  return Math.min(count - 1, Math.max(0, current + delta));
}
