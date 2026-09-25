import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopClasses } from '../src/lib/desktop.ts';
import { chatActivity, fabFor, hidesTabBar, liveSummary, orchestrationProgress, pickUsageWindows, type LiveChatInput, type LiveOrchestrationInput } from '../src/lib/shell-live.ts';

// The shell is where a person sees at a glance what is alive. What it lists has to be in the order
// that needs them most, never twice, and a shape it does not expect must not break a row.

const chat = (id: string, state: LiveChatInput['state'], updatedAt: string, extra: Partial<LiveChatInput> = {}): LiveChatInput => ({
  id,
  title: `chat ${id}`,
  state,
  updatedAt,
  project: null,
  ...extra,
});

const orchestration = (id: string, status: LiveOrchestrationInput['status'], createdAt: string, statuses: LiveOrchestrationInput['tasks'][number]['status'][] = []): LiveOrchestrationInput => ({
  id,
  name: `graph ${id}`,
  status,
  createdAt,
  tasks: statuses.map((s) => ({ status: s })),
});

test('chats waiting for a person come before working ones, newest first within each', () => {
  const summary = liveSummary({
    chats: [chat('a', 'working', '2026-09-21T10:00:00Z'), chat('b', 'waiting', '2026-09-21T09:00:00Z'), chat('c', 'working', '2026-09-21T11:00:00Z'), chat('d', 'waiting', '2026-09-21T12:00:00Z')],
    orchestrations: [],
  });
  assert.deepEqual(
    summary.items.map((i) => i.id),
    ['d', 'b', 'c', 'a'],
  );
  assert.equal(summary.working, 2);
  assert.equal(summary.waiting, 2);
});

test('a chat present in both lists is shown once, in its latest state', () => {
  const summary = liveSummary({
    chats: [chat('a', 'working', '2026-09-21T10:00:00Z'), chat('a', 'waiting', '2026-09-21T10:00:05Z')],
    orchestrations: [],
  });
  assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0]?.kind === 'chat' && summary.items[0].state, 'waiting');
  assert.equal(summary.working, 0);
  assert.equal(summary.waiting, 1);
});

test('idle chats and orchestrations that are not running are not live', () => {
  const summary = liveSummary({
    chats: [chat('a', 'idle', '2026-09-21T10:00:00Z')],
    orchestrations: [orchestration('o1', 'completed', '2026-09-21T10:00:00Z'), orchestration('o2', 'waiting', '2026-09-21T10:00:00Z')],
  });
  assert.deepEqual(summary.items, []);
  assert.equal(summary.running, 0);
});

test('running orchestrations follow the chats, with their progress counted by status', () => {
  const summary = liveSummary({
    chats: [chat('a', 'working', '2026-09-21T10:00:00Z')],
    orchestrations: [orchestration('o1', 'running', '2026-09-21T08:00:00Z', ['completed', 'completed', 'running', 'failed', 'pending', 'blocked', 'skipped'])],
  });
  const last = summary.items[1];
  assert.equal(last?.kind, 'orchestration');
  if (last?.kind !== 'orchestration') return;
  assert.equal(last.href, '/orchestration/o1');
  assert.deepEqual(last.progress, { done: 2, running: 1, failed: 1, pending: 2, skipped: 1 });
  assert.equal(last.done, 2);
  assert.equal(last.total, 7);
  assert.equal(summary.running, 1);
});

test('a stopped or interrupted task counts as failed, not as work still to come', () => {
  assert.deepEqual(orchestrationProgress([{ status: 'stopped' }, { status: 'interrupted' }]), { done: 0, running: 0, failed: 2, pending: 0, skipped: 0 });
});

test('a working chat carries its activity; a waiting one does not claim to be doing anything', () => {
  const activity = { kind: 'tool', tool: 'Edit', target: 'src/App.tsx', since: '2026-09-21T10:00:00Z' };
  const summary = liveSummary({
    chats: [chat('a', 'working', '2026-09-21T10:00:00Z', { activity }), chat('b', 'waiting', '2026-09-21T09:00:00Z', { activity })],
    orchestrations: [],
  });
  const [waiting, working] = summary.items;
  assert.equal(waiting?.kind === 'chat' && waiting.activity, null);
  assert.deepEqual(working?.kind === 'chat' && working.activity, activity);
});

test('an activity of an unexpected shape is ignored instead of breaking the row', () => {
  assert.equal(chatActivity({}), null);
  assert.equal(chatActivity({ activity: null }), null);
  assert.equal(chatActivity({ activity: 'Editing' }), null);
  assert.equal(chatActivity({ activity: { kind: 'dancing', since: '2026-09-21T10:00:00Z' } }), null);
  assert.equal(chatActivity({ activity: { kind: 'tool' } }), null);
  assert.deepEqual(chatActivity({ activity: { kind: 'thinking', since: 'x', tool: 3 } }), { kind: 'thinking', since: 'x' });
});

test('chat ids in links are encoded', () => {
  const summary = liveSummary({ chats: [chat('a/b c', 'working', '2026-09-21T10:00:00Z')], orchestrations: [] });
  assert.equal(summary.items[0]?.href, '/chats/a%2Fb%20c');
});

test('the tab bar steps aside on a chat and on an orchestration, not on their lists or on New chat', () => {
  // A new chat is that page too: the box sits at the bottom of the window, where the bar would be
  for (const path of ['/chats/abc', '/chats/abc/', '/chats/new', '/orchestration/o1']) assert.equal(hidesTabBar(path), true, path);
  for (const path of ['/', '/chats', '/orchestration', '/settings', '/projects']) assert.equal(hidesTabBar(path), false, path);
});

test('the phone FAB follows the page: words on Home, an icon on the lists, none where the tab bar steps aside', () => {
  assert.deepEqual(fabFor('/'), { action: 'chat', labelled: true });
  for (const path of ['/chats', '/chats/', '/projects']) assert.deepEqual(fabFor(path), { action: 'chat', labelled: false }, path);
  assert.deepEqual(fabFor('/orchestration'), { action: 'orchestration', labelled: false });
  for (const path of ['/chats/abc', '/chats/new', '/orchestration/o1', '/settings', '/accounts', '/usage', '/nowhere']) assert.equal(fabFor(path), null, path);
});

test('the status bar reads the account-wide 5 h and 7 d windows, never a per-model one', () => {
  const picked = pickUsageWindows({
    seven_day_opus: { utilization: 0.9, resetsAt: 3 },
    seven_day: { utilization: 0.054, resetsAt: 2 },
    five_hour: { utilization: 0.449, resetsAt: 1 },
  });
  assert.deepEqual(picked.fiveHour, { name: 'five_hour', percent: 45, resetsAt: 1 });
  assert.deepEqual(picked.sevenDay, { name: 'seven_day', percent: 5, resetsAt: 2 });
  // A window the CLI did not report is missing, not zero, and a reading over 100 % is capped
  assert.deepEqual(pickUsageWindows(undefined), { fiveHour: null, sevenDay: null });
  assert.equal(pickUsageWindows({ five_hour: { utilization: 1.3, resetsAt: 0 } }).fiveHour?.percent, 100);
  assert.equal(pickUsageWindows({ five_hour: { utilization: 0.2, resetsAt: 0 } }).sevenDay, null);
});

test('the desktop app marks the page with its platform; a browser marks nothing', () => {
  assert.deepEqual(desktopClasses(undefined), []);
  assert.deepEqual(desktopClasses({ platform: 'linux', version: '1.0.0' }), ['is-desktop', 'desktop-linux']);
  assert.deepEqual(desktopClasses({ platform: 'Darwin' }), ['is-desktop', 'desktop-darwin']);
  // A platform that is not a plain word still marks the desktop, but never becomes a class name
  assert.deepEqual(desktopClasses({ platform: 'linux x" onload' }), ['is-desktop']);
});
