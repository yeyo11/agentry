/**
 * What the shell shows as "live" — the sidebar's Live section, the top bar's live chip, the
 * palette's Live group and the tab bar's badges — reduced to plain data. Pure, so the rules
 * (what counts as live, in what order, how an orchestration's progress is counted) are tested
 * without a browser.
 */
import type { AccountUsage, ChatState, OrchestrationStatus, OrchestrationTaskStatus } from '@agentry/shared';
import { phoneHeaderOf } from '../components/shell/phone-header';
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
export function hidesTabBar(pathname: string, search = ''): boolean {
  // A team member, the flow, an open document and an open resource end in their own Save bar, as
  // their references do
  if (pathname === '/' && search) {
    const params = new URLSearchParams(search);
    const view = params.get('view');
    if (view === 'team' && (params.has('member') || params.get('section') === 'flow')) return true;
    if (view === 'documents' && params.has('doc')) return true;
    // The project's settings end in "Guardar los cambios" at the bottom (MobileProyectoAjustes)
    if (view === 'settings') return true;
    // So does a resource or an assistant's proposal open in the editor (MobileRecursoPropuesta)
    if (view === 'resources' && (params.has('res') || params.has('proposal'))) return true;
  }
  // A new chat is the same page as the chat it becomes — a box at the bottom of the window — and
  // the bar would sit over it; its header carries the way back instead
  if (/^\/chats\/[^/]+\/?$/.test(pathname)) return true;
  // The new project wizard walks its steps with a bar of its own at the bottom, as a new chat does
  if (/^\/projects\/new\/?$/.test(pathname)) return true;
  // The project assistant, which the wizard hands off to, ends in its own bar ("Ir al proyecto")
  if (/^\/projects\/[^/]+\/assistant\/?$/.test(pathname)) return true;
  // A work item's page on a phone ends in its own bar ("Work on it", or the comment box)
  if (/^\/tasks\/[^/]+\/?$/.test(pathname) && !/^\/tasks\/milestones\/?$/.test(pathname)) return true;
  // The review of a chat's, a task's or the integration branch's changes is a detail screen too:
  // a file's own screen has a bar of its own at the bottom
  if (/^\/chats\/[^/]+\/changes\/?$/.test(pathname)) return true;
  if (/^\/orchestration\/[^/]+\/(?:tasks\/[^/]+\/)?changes\/?$/.test(pathname)) return true;
  // A work item's branch is reviewed on the same screen
  if (/^\/tasks\/[^/]+\/changes\/?$/.test(pathname)) return true;
  return /^\/orchestration\/[^/]+\/?$/.test(pathname);
}

/**
 * Where a phone shows no top bar: the routes marked `phoneHeader: 'page'`
 * (components/shell/phone-header.ts), whose pages draw their own header with the way back.
 */
export function hidesTopBar(pathname: string, projectPage = false): boolean {
  return phoneHeaderOf(pathname, projectPage) === 'page';
}

/** What the phone's floating button starts on a page. */
export interface FabPlan {
  action: 'chat' | 'orchestration' | 'task';
}

/**
 * The phone's one "start something" button: the same round "+" on every page that has it, so it
 * reads as one control, starting a chat or, on Orchestrations and Tasks, one of those. Where
 * the tab bar steps aside the page has its own footer, so the button does too; on the other pages
 * a floating button would only cover a form or a table that has nothing to do with starting a chat.
 * A project's tab (`/?view=`) is one of those: its settings end in a Save the button sat on. The
 * milestones start a milestone from their header, so a New task button there would be a second,
 * different "+" (MobileHitos draws none).
 */
export function fabFor(pathname: string, search = ''): FabPlan | null {
  if (hidesTabBar(pathname, search)) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  // A project's tab is a page of its own, not the dashboard the button starts a chat from
  if (path === '/') return new URLSearchParams(search).has('view') ? null : { action: 'chat' };
  if (path === '/chats' || path === '/projects') return { action: 'chat' };
  if (path === '/orchestration') return { action: 'orchestration' };
  // Tasks starts a task of its own on the board and the list, not on a work item's page
  if (path === '/tasks') return { action: 'task' };
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

/**
 * What a cell of the phone's More sheet says beside its name. A problem outranks a count: an
 * account out of quota or a connector waiting for authorisation is what a person opens the sheet
 * to see, so it is said in words with its status colour; otherwise a plain figure.
 */
export type MoreNote =
  | { kind: 'count'; value: number }
  | { kind: 'open'; value: number }
  | { kind: 'exhausted'; value: number }
  | { kind: 'pending'; value: number }
  | { kind: 'cost'; value: number | null };

export interface MoreNotesInput {
  /** Open work items of the scope; undefined where there is no board to count */
  tasks?: number | undefined;
  projects?: number | undefined;
  /** Accounts claude-swap knows of; `exhausted` only once their usage has been read */
  accounts?: { total: number; exhausted?: number | undefined } | undefined;
  schedules?: number | undefined;
  /** Null when nothing cost anything today */
  todayCost?: number | null | undefined;
  connectors?: { total: number; pending: number } | undefined;
}

/** Keyed by the section's path. A section with nothing known yet has no entry rather than a guess. */
export function moreNotes(input: MoreNotesInput): Record<string, MoreNote> {
  const notes: Record<string, MoreNote> = {};
  // Said with its word, "15 open": a bare figure beside Tasks could be read as the total
  if (input.tasks !== undefined) notes['/tasks'] = { kind: 'open', value: input.tasks };
  if (input.projects !== undefined) notes['/projects'] = { kind: 'count', value: input.projects };
  if (input.accounts) {
    const { total, exhausted } = input.accounts;
    notes['/accounts'] = exhausted ? { kind: 'exhausted', value: exhausted } : { kind: 'count', value: total };
  }
  if (input.schedules !== undefined) notes['/schedules'] = { kind: 'count', value: input.schedules };
  if (input.todayCost !== undefined) notes['/usage'] = { kind: 'cost', value: input.todayCost };
  if (input.connectors) {
    const { total, pending } = input.connectors;
    notes['/connectors'] = pending ? { kind: 'pending', value: pending } : { kind: 'count', value: total };
  }
  return notes;
}
