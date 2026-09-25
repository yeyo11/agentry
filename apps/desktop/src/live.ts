/**
 * What is live in the local server, reduced to what the tray, the taskbar progress and the badge
 * show. Pure and free of Electron, so the rules are tested with plain data.
 *
 * The shapes below are the parts of `@agentry/shared`'s `Overview`, `ChatSummary` and
 * `Orchestration` the shell reads, declared structurally: the desktop package only talks to the
 * server over HTTP and does not depend on the workspace types.
 */

export interface LiveCounts {
  chatsWorking: number;
  chatsWaiting: number;
  orchestrationsRunning: number;
}

export interface LiveChat {
  id: string;
  title: string;
  state: 'working' | 'waiting' | 'idle';
  updatedAt: string | null;
}

export interface LiveOrchestration {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  tasks: ReadonlyArray<{ status: string }>;
}

export interface LiveInput {
  counts: LiveCounts;
  chats: ReadonlyArray<LiveChat>;
  orchestrations: ReadonlyArray<LiveOrchestration>;
}

export type LiveItem =
  | { kind: 'chat'; id: string; path: string; title: string; state: 'working' | 'waiting' }
  | { kind: 'orchestration'; id: string; path: string; title: string; finished: number; total: number };

export interface LiveSnapshot {
  working: number;
  waiting: number;
  running: number;
  items: LiveItem[];
}

export const EMPTY_SNAPSHOT: LiveSnapshot = { working: 0, waiting: 0, running: 0, items: [] };

/** Task states that no longer move: the part of a graph that is behind it, whatever the outcome */
const SETTLED = new Set(['completed', 'failed', 'skipped', 'stopped', 'interrupted']);

/** Items the tray menu lists before it points at the app for the rest */
export const TRAY_ITEMS = 8;

const time = (iso: string | null | undefined): number => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
};

/**
 * The live items in the order the web's shell lists them: chats waiting for a person first, then
 * working chats, then running orchestrations, most recent first within each. The counts come from
 * the overview, which is exact; the lists are capped, so they only name the first few.
 */
export function liveSnapshot({ counts, chats, orchestrations }: LiveInput): LiveSnapshot {
  const byId = new Map<string, LiveChat>();
  for (const chat of chats) {
    if (chat.state === 'idle') continue;
    const seen = byId.get(chat.id);
    if (!seen || time(chat.updatedAt) >= time(seen.updatedAt)) byId.set(chat.id, chat);
  }
  const live = [...byId.values()].sort((a, b) =>
    a.state !== b.state ? (a.state === 'waiting' ? -1 : 1) : time(b.updatedAt) - time(a.updatedAt),
  );
  const running = orchestrations.filter((o) => o.status === 'running').sort((a, b) => time(b.createdAt) - time(a.createdAt));
  return {
    working: counts.chatsWorking,
    waiting: counts.chatsWaiting,
    running: counts.orchestrationsRunning,
    items: [
      ...live.map(
        (chat): LiveItem => ({
          kind: 'chat',
          id: chat.id,
          path: `/chats/${encodeURIComponent(chat.id)}`,
          title: chat.title,
          state: chat.state === 'waiting' ? 'waiting' : 'working',
        }),
      ),
      ...running.map(
        (o): LiveItem => ({
          kind: 'orchestration',
          id: o.id,
          path: `/orchestration/${encodeURIComponent(o.id)}`,
          title: o.name,
          finished: o.tasks.filter((t) => SETTLED.has(t.status)).length,
          total: o.tasks.length,
        }),
      ),
    ],
  };
}

/** "2 working · 1 waiting · 1 orchestration", or null when nothing is live */
export function liveWords(snapshot: LiveSnapshot): string | null {
  const parts: string[] = [];
  if (snapshot.working) parts.push(`${snapshot.working} working`);
  if (snapshot.waiting) parts.push(`${snapshot.waiting} waiting`);
  if (snapshot.running) parts.push(`${snapshot.running} ${snapshot.running === 1 ? 'orchestration' : 'orchestrations'}`);
  return parts.length ? parts.join(' · ') : null;
}

export function trayTooltip(snapshot: LiveSnapshot): string {
  return `Agentry — ${liveWords(snapshot) ?? 'nothing running'}`;
}

const MAX_LABEL = 48;
const clip = (text: string) => (text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text);

function itemLabel(item: LiveItem): string {
  if (item.kind === 'orchestration') return `${clip(item.title)} — ${item.finished}/${item.total}`;
  return `${clip(item.title || 'Untitled chat')} — ${item.state === 'waiting' ? 'waiting for you' : 'working'}`;
}

export type TrayAction = { kind: 'show' } | { kind: 'open'; path: string } | { kind: 'update' } | { kind: 'quit' };

export type TrayEntry = { type: 'separator' } | { type: 'item'; label: string; action: TrayAction | null };

/**
 * The tray menu as data. The status line comes first as a disabled item: on Linux the tray is an
 * AppIndicator, which never shows the tooltip, so the menu is the only place it can be read.
 * `updateReady` is the version of a downloaded update, offered just above Quit.
 */
export function trayMenu(snapshot: LiveSnapshot, updateReady?: string): TrayEntry[] {
  const entries: TrayEntry[] = [
    { type: 'item', label: liveWords(snapshot) ?? 'Nothing running', action: null },
    { type: 'separator' },
    { type: 'item', label: 'Open Agentry', action: { kind: 'show' } },
    { type: 'item', label: 'New chat', action: { kind: 'open', path: '/chats/new' } },
  ];
  if (snapshot.items.length) {
    entries.push({ type: 'separator' });
    for (const item of snapshot.items.slice(0, TRAY_ITEMS)) {
      entries.push({ type: 'item', label: itemLabel(item), action: { kind: 'open', path: item.path } });
    }
    const hidden = snapshot.items.length - TRAY_ITEMS;
    if (hidden > 0) entries.push({ type: 'item', label: `${hidden} more…`, action: { kind: 'open', path: '/chats' } });
  }
  entries.push({ type: 'separator' });
  if (updateReady) entries.push({ type: 'item', label: `Restart to update to ${updateReady}`, action: { kind: 'update' } });
  entries.push({ type: 'item', label: 'Quit Agentry', action: { kind: 'quit' } });
  return entries;
}

export type Progress = { mode: 'none' } | { mode: 'indeterminate' } | { mode: 'normal'; value: number };

/**
 * The taskbar progress: the settled share of every running orchestration's tasks together, so two
 * graphs of 10 and 2 tasks weigh by their work, not one half each. A running orchestration without
 * tasks (a workflow-engine run) gives no fraction, only "something is running".
 */
export function progressOf(snapshot: LiveSnapshot): Progress {
  const graphs = snapshot.items.filter((i): i is Extract<LiveItem, { kind: 'orchestration' }> => i.kind === 'orchestration');
  if (!graphs.length) return snapshot.running ? { mode: 'indeterminate' } : { mode: 'none' };
  const total = graphs.reduce((sum, g) => sum + g.total, 0);
  if (!total) return { mode: 'indeterminate' };
  const finished = graphs.reduce((sum, g) => sum + g.finished, 0);
  return { mode: 'normal', value: Math.min(1, finished / total) };
}

/** Whether two snapshots draw the same tray, progress and badge; skips redundant native calls */
export function sameSnapshot(a: LiveSnapshot, b: LiveSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
