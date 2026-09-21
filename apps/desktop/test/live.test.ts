import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_SNAPSHOT, liveSnapshot, progressOf, TRAY_ITEMS, trayMenu, trayTooltip, type LiveChat, type LiveOrchestration } from '../src/live.ts';

const chat = (id: string, state: LiveChat['state'], updatedAt: string, title = `chat ${id}`): LiveChat => ({ id, title, state, updatedAt });
const graph = (id: string, statuses: string[], status = 'running', createdAt = '2026-09-21T10:00:00Z'): LiveOrchestration => ({
  id,
  name: `graph ${id}`,
  status,
  createdAt,
  tasks: statuses.map((s) => ({ status: s })),
});
const counts = (chatsWorking: number, chatsWaiting: number, orchestrationsRunning: number) => ({ chatsWorking, chatsWaiting, orchestrationsRunning });

test('lists waiting chats first, then working ones, then running orchestrations, newest first', () => {
  const snapshot = liveSnapshot({
    counts: counts(2, 1, 1),
    chats: [chat('a', 'working', '2026-09-21T10:00:00Z'), chat('b', 'working', '2026-09-21T11:00:00Z'), chat('c', 'waiting', '2026-09-21T09:00:00Z')],
    orchestrations: [graph('g', ['completed', 'running']), graph('old', ['completed'], 'completed')],
  });
  assert.deepEqual(
    snapshot.items.map((i) => i.id),
    ['c', 'b', 'a', 'g'],
  );
  assert.equal(snapshot.items[0]?.path, '/chats/c');
  assert.equal(snapshot.items[3]?.path, '/orchestration/g');
});

test('a chat present in both lists is listed once, in its latest state; idle chats are dropped', () => {
  const snapshot = liveSnapshot({
    counts: counts(0, 1, 0),
    chats: [chat('a', 'working', '2026-09-21T10:00:00Z'), chat('a', 'waiting', '2026-09-21T10:05:00Z'), chat('z', 'idle', '2026-09-21T12:00:00Z')],
    orchestrations: [],
  });
  assert.deepEqual(snapshot.items, [{ kind: 'chat', id: 'a', path: '/chats/a', title: 'chat a', state: 'waiting' }]);
});

test('the counts come from the overview, not from the capped lists', () => {
  const snapshot = liveSnapshot({ counts: counts(25, 3, 0), chats: [chat('a', 'working', '2026-09-21T10:00:00Z')], orchestrations: [] });
  assert.equal(snapshot.working, 25);
  assert.equal(snapshot.waiting, 3);
  assert.equal(trayTooltip(snapshot), 'Agentry — 25 working · 3 waiting');
});

test('the tooltip says when nothing runs, and names orchestrations', () => {
  assert.equal(trayTooltip(EMPTY_SNAPSHOT), 'Agentry — nothing running');
  assert.equal(trayTooltip({ ...EMPTY_SNAPSHOT, running: 1 }), 'Agentry — 1 orchestration');
  assert.equal(trayTooltip({ ...EMPTY_SNAPSHOT, working: 2, running: 2 }), 'Agentry — 2 working · 2 orchestrations');
});

test('the tray menu: status line, open, new chat, the live items, quit', () => {
  const snapshot = liveSnapshot({
    counts: counts(1, 1, 1),
    chats: [chat('a', 'working', '2026-09-21T10:00:00Z', 'Fix the login'), chat('b', 'waiting', '2026-09-21T10:00:00Z', 'Deploy')],
    orchestrations: [graph('g', ['completed', 'failed', 'running', 'pending'])],
  });
  assert.deepEqual(trayMenu(snapshot), [
    { type: 'item', label: '1 working · 1 waiting · 1 orchestration', action: null },
    { type: 'separator' },
    { type: 'item', label: 'Open Agentry', action: { kind: 'show' } },
    { type: 'item', label: 'New chat', action: { kind: 'open', path: '/chats/new' } },
    { type: 'separator' },
    { type: 'item', label: 'Deploy — waiting for you', action: { kind: 'open', path: '/chats/b' } },
    { type: 'item', label: 'Fix the login — working', action: { kind: 'open', path: '/chats/a' } },
    { type: 'item', label: 'graph g — 2/4', action: { kind: 'open', path: '/orchestration/g' } },
    { type: 'separator' },
    { type: 'item', label: 'Quit Agentry', action: { kind: 'quit' } },
  ]);
});

test('the tray menu has no live section when nothing runs, and caps a long one', () => {
  const idle = trayMenu(EMPTY_SNAPSHOT);
  assert.equal(idle[0]?.type === 'item' && idle[0].label, 'Nothing running');
  assert.equal(idle.filter((e) => e.type === 'separator').length, 2);

  const many = liveSnapshot({
    counts: counts(12, 0, 0),
    chats: Array.from({ length: 12 }, (_, i) => chat(String(i), 'working', `2026-09-21T10:${String(i).padStart(2, '0')}:00Z`)),
    orchestrations: [],
  });
  const menu = trayMenu(many);
  const opens = menu.filter((e) => e.type === 'item' && e.action?.kind === 'open' && /^\/chats\/\d+$/.test(e.action.path));
  assert.equal(opens.length, TRAY_ITEMS);
  assert.ok(menu.some((e) => e.type === 'item' && e.label === '4 more…'));
});

test('long titles are clipped, untitled chats get a name', () => {
  const snapshot = liveSnapshot({
    counts: counts(2, 0, 0),
    chats: [chat('a', 'working', '2026-09-21T10:00:00Z', 'x'.repeat(80)), chat('b', 'working', '2026-09-21T09:00:00Z', '')],
    orchestrations: [],
  });
  const labels = trayMenu(snapshot).flatMap((e) => (e.type === 'item' && e.action?.kind === 'open' && e.action.path !== '/chats/new' ? [e.label] : []));
  assert.equal(labels[0], `${'x'.repeat(47)}… — working`);
  assert.equal(labels[1], 'Untitled chat — working');
});

test('progress: cleared when nothing runs, the settled share of every task otherwise', () => {
  assert.deepEqual(progressOf(EMPTY_SNAPSHOT), { mode: 'none' });
  const snapshot = liveSnapshot({
    counts: counts(0, 0, 2),
    chats: [],
    // 3 of 10 settled plus 1 of 2: weighed by tasks, 4/12
    orchestrations: [graph('a', ['completed', 'failed', 'skipped', ...Array<string>(7).fill('pending')]), graph('b', ['completed', 'running'])],
  });
  assert.deepEqual(progressOf(snapshot), { mode: 'normal', value: 4 / 12 });
});

test('progress is indeterminate for running orchestrations that have no tasks or are not listed yet', () => {
  const workflow = liveSnapshot({ counts: counts(0, 0, 1), chats: [], orchestrations: [graph('w', [])] });
  assert.deepEqual(progressOf(workflow), { mode: 'indeterminate' });
  assert.deepEqual(progressOf({ ...EMPTY_SNAPSHOT, running: 1 }), { mode: 'indeterminate' });
});
