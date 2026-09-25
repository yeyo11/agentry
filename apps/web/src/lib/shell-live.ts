/**
 * What the shell shows as "live" — the sidebar's Live section, the top bar's live chip, the
 * palette's Live group and the tab bar's badges — reduced to plain data. Pure, so the rules
 * (what counts as live, in what order, how an orchestration's progress is counted) are tested
 * without a browser.
 */
import type { AccountUsage, ChatState, OrchestrationStatus, OrchestrationTaskStatus } from '@agentry/shared';
import { displayTitle } from './chat-model';
import type { TickerActivity } from './live';
import type { ProgressCounts } from './progress';

/** The part of a chat summary the shell reads. `activity` arrives with the live-activity work. */
export interface LiveChatInput {
  id: string;
  title: string;
  firstPrompt: string | null;
  state: ChatState;
  updatedAt: string | null;
  project: { name: string } | null;
  activity?: unknown;
}

export interface LiveOrchestrationInput {
  id: string;
  name: string;
  status: OrchestrationStatus;
  createdAt: string;
  tasks: ReadonlyArray<{ status: OrchestrationTaskStatus }>;
}

export type LiveItem =
  | { kind: 'chat'; id: string; href: string; title: string; state: 'working' | 'waiting'; project: string | null; activity: TickerActivity | null }
  | { kind: 'orchestration'; id: string; href: string; title: string; progress: ProgressCounts; done: number; total: number };

export interface LiveSummary {
  working: number;
  waiting: number;
  running: number;
  items: LiveItem[];
}

const ACTIVITY_KINDS = new Set(['tool', 'writing', 'thinking', 'waiting']);

/**
 * A chat's current activity when the server sends one, `null` otherwise. Read defensively: the
 * field belongs to a type another part of the redesign adds, and a list row must never break on
 * a shape it did not expect.
 */
export function chatActivity(chat: { activity?: unknown }): TickerActivity | null {
  const value = chat.activity;
  if (!value || typeof value !== 'object') return null;
  const { kind, tool, target, since } = value as Record<string, unknown>;
  if (typeof kind !== 'string' || !ACTIVITY_KINDS.has(kind) || typeof since !== 'string') return null;
  return {
    kind: kind as TickerActivity['kind'],
    ...(typeof tool === 'string' ? { tool } : {}),
    ...(typeof target === 'string' ? { target } : {}),
    since,
  };
}

/** A task graph's progress by status, the way `ProgressBar` draws it. */
export function orchestrationProgress(tasks: ReadonlyArray<{ status: OrchestrationTaskStatus }>): ProgressCounts {
  const counts = { done: 0, running: 0, failed: 0, pending: 0, skipped: 0 };
  for (const task of tasks) {
    switch (task.status) {
      case 'completed':
        counts.done += 1;
        break;
      case 'running':
        counts.running += 1;
        break;
      case 'failed':
      case 'stopped':
      case 'interrupted':
        counts.failed += 1;
        break;
      case 'skipped':
        counts.skipped += 1;
        break;
      default:
        counts.pending += 1;
    }
  }
  return counts;
}

const time = (iso: string | null | undefined): number => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
};

/**
 * Everything live, in the order a person should see it: chats waiting for them first (they are
 * blocked on someone), then working chats, then running orchestrations; the most recently active
 * first within each. A chat that shows up in both the working and the waiting list (the lists are
 * fetched separately and can cross) is listed once, in its latest state.
 */
export function liveSummary({
  chats,
  orchestrations,
}: {
  chats: ReadonlyArray<LiveChatInput>;
  orchestrations: ReadonlyArray<LiveOrchestrationInput>;
}): LiveSummary {
  const byId = new Map<string, LiveChatInput>();
  for (const chat of chats) {
    if (chat.state === 'idle') continue;
    const seen = byId.get(chat.id);
    if (!seen || time(chat.updatedAt) >= time(seen.updatedAt)) byId.set(chat.id, chat);
  }
  const live = [...byId.values()].sort((a, b) => {
    if (a.state !== b.state) return a.state === 'waiting' ? -1 : 1;
    return time(b.updatedAt) - time(a.updatedAt);
  });
  const running = orchestrations.filter((o) => o.status === 'running').sort((a, b) => time(b.createdAt) - time(a.createdAt));

  const items: LiveItem[] = [
    ...live.map(
      (chat): LiveItem => ({
        kind: 'chat',
        id: chat.id,
        href: `/chats/${encodeURIComponent(chat.id)}`,
        title: displayTitle(chat),
        state: chat.state === 'waiting' ? 'waiting' : 'working',
        project: chat.project?.name ?? null,
        activity: chat.state === 'working' ? chatActivity(chat) : null,
      }),
    ),
    ...running.map((o): LiveItem => {
      const progress = orchestrationProgress(o.tasks);
      return {
        kind: 'orchestration',
        id: o.id,
        href: `/orchestration/${encodeURIComponent(o.id)}`,
        title: o.name,
        progress,
        done: progress.done ?? 0,
        total: o.tasks.length,
      };
    }),
  ];

  return {
    working: live.filter((c) => c.state === 'working').length,
    waiting: live.filter((c) => c.state === 'waiting').length,
    running: running.length,
    items,
  };
}

/**
 * Pages that bring their own back button and a sticky footer (a chat's composer, an
 * orchestration's summary) take the whole height on a phone, so the tab bar steps aside there.
 */
export function hidesTabBar(pathname: string): boolean {
  // A new chat is the same page as the chat it becomes — a box at the bottom of the window — and
  // the bar would sit over it; its header carries the way back instead
  if (/^\/chats\/[^/]+\/?$/.test(pathname)) return true;
  return /^\/orchestration\/[^/]+\/?$/.test(pathname);
}

/** What the phone's floating button starts on a page, and whether it has room for its words. */
export interface FabPlan {
  action: 'chat' | 'orchestration';
  labelled: boolean;
}

/**
 * The phone's one "start something" button. It follows the page: Home says it in words, the lists
 * keep only the icon so it covers less of them, and Orchestrations starts one of its own. Where
 * the tab bar steps aside the page has its own footer, so the button does too; on the other pages
 * a floating button would only cover a form or a table that has nothing to do with starting a chat.
 */
export function fabFor(pathname: string): FabPlan | null {
  if (hidesTabBar(pathname)) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/') return { action: 'chat', labelled: true };
  if (path === '/chats' || path === '/projects') return { action: 'chat', labelled: false };
  if (path === '/orchestration') return { action: 'orchestration', labelled: false };
  return null;
}

/** A usage window as a whole percentage, for a bar and its label. */
export interface UsageWindowReading {
  /** The window's own name, as the CLI reports it (`five_hour`) */
  name: string;
  percent: number;
  /** Epoch seconds, as the CLI reports it */
  resetsAt: number;
}

/**
 * The 5 h and 7 d windows out of whatever the CLI reported. Per-model weekly windows
 * (`seven_day_opus`) share the prefix of the general one, so the shortest name that matches wins:
 * the bar speaks for the account, not for one model.
 */
export function pickUsageWindows(windows: Record<string, { utilization: number; resetsAt: number }> | undefined): {
  fiveHour: UsageWindowReading | null;
  sevenDay: UsageWindowReading | null;
} {
  const entries = Object.entries(windows ?? {}).filter(([, w]) => Number.isFinite(w.utilization));
  const pick = (pattern: RegExp): UsageWindowReading | null => {
    const found = entries.filter(([name]) => pattern.test(name)).sort(([a], [b]) => a.length - b.length)[0];
    if (!found) return null;
    const [name, win] = found;
    return { name, percent: Math.max(0, Math.min(100, Math.round(win.utilization * 100))), resetsAt: win.resetsAt };
  };
  return { fiveHour: pick(/^(five|5)[_-]?h/i), sevenDay: pick(/^(seven|7)[_-]?d/i) };
}

/**
 * The active account's windows as claude-swap read them, when it is installed: the more precise
 * reading, and the one Home's limits tile shows, so the status bar never disagrees with it.
 */
export function swapUsageWindows(usage: Pick<AccountUsage, 'fiveHour' | 'sevenDay'> | null | undefined): {
  fiveHour: UsageWindowReading | null;
  sevenDay: UsageWindowReading | null;
} {
  const read = (name: string, win: AccountUsage['fiveHour']): UsageWindowReading | null =>
    win && Number.isFinite(win.pct)
      ? { name, percent: Math.max(0, Math.min(100, Math.round(win.pct))), resetsAt: win.resetsAt ? Math.round((Date.parse(win.resetsAt) || 0) / 1000) : 0 }
      : null;
  return { fiveHour: read('five_hour', usage?.fiveHour ?? null), sevenDay: read('seven_day', usage?.sevenDay ?? null) };
}
