import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderLimit } from '@agentry/shared';
import { desktopClasses } from '../src/lib/desktop.ts';
import { chatActivity, fabFor, hidesTabBar, hidesTopBar, liveSummary, moreNotes, orchestrationProgress, cardProvider, limitReading, type LiveChatInput, type LiveOrchestrationInput } from '../src/lib/shell-live.ts';

// The shell is where a person sees at a glance what is alive. What it lists has to be in the order
// that needs them most, never twice, and a shape it does not expect must not break a row.

const chat = (id: string, state: LiveChatInput['state'], updatedAt: string, extra: Partial<LiveChatInput> = {}): LiveChatInput => ({
  id,
  title: `chat ${id}`,
  firstPrompt: null,
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

test('a live chat reads as its first prompt when its title is only the generated name', () => {
  const id = 'e2b36e0c-1111-2222-3333-444455556666';
  const summary = liveSummary({
    chats: [
      chat(id, 'working', '2026-09-21T10:00:00Z', { title: 'workspace-e2b36e', firstPrompt: 'Fix the login bug\nand test it' }),
      chat('b', 'waiting', '2026-09-21T10:00:00Z', { title: 'Login work', firstPrompt: 'Fix the login bug' }),
    ],
    orchestrations: [],
  });
  assert.deepEqual(
    summary.items.map((i) => i.title),
    ['Login work', 'Fix the login bug'],
  );
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
  for (const path of ['/chats/abc', '/chats/abc/', '/chats/new', '/orchestration/o1', '/projects/new', '/projects/p1/assistant', '/tasks/AGN-12', '/tasks/AGN-12/']) assert.equal(hidesTabBar(path), true, path);
  for (const path of ['/', '/chats', '/orchestration', '/settings', '/projects', '/tasks', '/tasks/milestones']) assert.equal(hidesTabBar(path), false, path);
  // A member, the flow and an open document bring their own Save bar; the lists around them keep the tab bar
  for (const search of ['?project=p&view=team&member=developer', '?project=p&view=team&section=flow', '?project=p&view=documents&doc=docs%2Fa.md', '?view=documents&doc=a.md&mode=edit', '?project=p&view=resources&proposal=x', '?project=p&view=resources&res=agents%3Areviewer', '?project=p&view=settings'])
    assert.equal(hidesTabBar('/', search), true, search);
  for (const search of ['', '?project=p&view=team', '?project=p&view=documents', '?project=p&view=documents&dir=docs%2Fspecs', '?project=p&view=memory', '?project=p&view=resources', '?project=p&view=resources&section=agents'])
    assert.equal(hidesTabBar('/', search), false, search);
  assert.equal(hidesTabBar('/chats', '?view=team&member=developer'), false);
});

test('the review of changes hides the tab bar, for a chat, a task, the integration branch and a work item', () => {
  for (const path of ['/chats/abc/changes', '/chats/abc/changes/', '/orchestration/o1/changes', '/orchestration/o1/tasks/t1/changes', '/tasks/AGN-12/changes']) assert.equal(hidesTabBar(path), true, path);
  for (const path of ['/chats/abc/other', '/orchestration/o1/tasks/t1', '/orchestration/o1/tasks']) assert.equal(hidesTabBar(path), false, path);
  assert.equal(fabFor('/chats/abc/changes'), null);
});

test('the phone FAB follows the page: the same round button where it starts something, none where the tab bar steps aside', () => {
  for (const path of ['/', '/chats', '/chats/', '/projects']) assert.deepEqual(fabFor(path), { action: 'chat' }, path);
  assert.deepEqual(fabFor('/orchestration'), { action: 'orchestration' });
  // Tasks starts a new task on the board and the list; a work item's page has its own actions, and
  // the milestones start a milestone from their header
  for (const path of ['/tasks', '/tasks/']) assert.deepEqual(fabFor(path), { action: 'task' }, path);
  assert.deepEqual(fabFor('/tasks', '?view=list'), { action: 'task' });
  // A project's tab is a page of its own, whose settings end in a Save the button would cover
  assert.deepEqual(fabFor('/', '?project=p1'), { action: 'chat' });
  for (const search of ['?view=settings', '?project=p1&view=board']) assert.equal(fabFor('/', search), null, search);
  for (const path of ['/tasks/milestones', '/chats/abc', '/chats/new', '/orchestration/o1', '/tasks/AGN-12', '/projects/new', '/settings', '/accounts', '/usage', '/nowhere']) {
    assert.equal(fabFor(path), null, path);
  }
});

const limit = (over: Partial<ProviderLimit>): ProviderLimit => ({
  provider: 'claude-code',
  state: 'ok',
  window: '5h',
  utilization: 0.449,
  resetsAt: '2026-10-02T14:05:00.000Z',
  windows: {},
  observedAt: '2026-10-02T12:00:00.000Z',
  source: 'stream',
  ...over,
});

test("a provider's limit reads as a whole percentage of the window that binds, capped at 100", () => {
  assert.deepEqual(limitReading(limit({})), { state: 'ok', percent: 45, resetsAt: '2026-10-02T14:05:00.000Z', window: '5h' });
  assert.equal(limitReading(limit({ utilization: 1.3, state: 'exhausted' }))?.percent, 100);
  // A provider that gives the windows and no single figure: the binding window's own
  assert.equal(limitReading(limit({ utilization: null, windows: { '5h': { utilization: 0.72, resetsAt: 0 } } }))?.percent, 72);
  // One that reports no figure at all still says it is near or at its limit
  assert.deepEqual(limitReading(limit({ state: 'near', utilization: null, window: null })), { state: 'near', percent: null, resetsAt: '2026-10-02T14:05:00.000Z', window: null });
});

test('a limit that is not known says nothing: a stale reading is never "fine"', () => {
  assert.equal(limitReading(limit({ state: 'unknown' })), null);
  assert.equal(limitReading(null), null);
  assert.equal(limitReading(undefined), null);
});

test("the phone's More card speaks for the default provider, else the first that is ready", () => {
  const statuses = [
    { id: 'claude-code', state: 'degraded' },
    { id: 'codex', state: 'ready' },
    { id: 'copilot', state: 'ready' },
  ] as const;
  assert.equal(cardProvider(statuses, 'copilot')?.id, 'copilot');
  assert.equal(cardProvider(statuses, null)?.id, 'codex');
  assert.equal(cardProvider(statuses, 'gemini')?.id, 'codex');
  assert.equal(cardProvider([{ id: 'claude-code', state: 'degraded' }], null)?.id, 'claude-code');
  assert.equal(cardProvider([], null), null);
});

test('the desktop app marks the page with its platform; a browser marks nothing', () => {
  assert.deepEqual(desktopClasses(undefined), []);
  assert.deepEqual(desktopClasses({ platform: 'linux', version: '1.0.0' }), ['is-desktop', 'desktop-linux']);
  assert.deepEqual(desktopClasses({ platform: 'Darwin' }), ['is-desktop', 'desktop-darwin']);
  // A platform that is not a plain word still marks the desktop, but never becomes a class name
  assert.deepEqual(desktopClasses({ platform: 'linux x" onload' }), ['is-desktop']);
});

test('the More sheet says a problem before a count, and nothing it does not know yet', () => {
  assert.deepEqual(moreNotes({}), {});
  assert.deepEqual(
    moreNotes({ projects: 3, accounts: { total: 4, exhausted: 2 }, schedules: 0, todayCost: 1145.86, connectors: { total: 3, pending: 1 } }),
    {
      '/projects': { kind: 'count', value: 3 },
      '/accounts': { kind: 'exhausted', value: 2 },
      '/schedules': { kind: 'count', value: 0 },
      '/usage': { kind: 'cost', value: 1145.86 },
      '/connectors': { kind: 'pending', value: 1 },
    },
  );
  // No account spent and none waiting for authorisation: the plain count, not a zero badge
  const calm = moreNotes({ accounts: { total: 4, exhausted: 0 }, connectors: { total: 3, pending: 0 } });
  assert.deepEqual(calm['/accounts'], { kind: 'count', value: 4 });
  assert.deepEqual(calm['/connectors'], { kind: 'count', value: 3 });
  // Before the account list is read, the overview's total; a day with no cost is said, not left blank
  assert.deepEqual(moreNotes({ accounts: { total: 2 } })['/accounts'], { kind: 'count', value: 2 });
  assert.deepEqual(moreNotes({ todayCost: null })['/usage'], { kind: 'cost', value: null });
});

test('Tasks in the More sheet says its open items with the word, and nothing where there is no board', () => {
  assert.deepEqual(moreNotes({ tasks: 15 })['/tasks'], { kind: 'open', value: 15 });
  assert.deepEqual(moreNotes({ tasks: 0 })['/tasks'], { kind: 'open', value: 0 });
  assert.equal(moreNotes({ tasks: undefined })['/tasks'], undefined);
});

test("a phone's detail screens head themselves: no top bar on them, and the bar everywhere else (gap 21)", () => {
  // A project's page and its tabs (a member, a document) live at `/` with a project in scope
  assert.equal(hidesTopBar('/', true), true, "a project's page");
  assert.equal(hidesTopBar('/', false), false, 'Home of every project keeps the scope in the bar');
  for (const path of ['/tasks', '/tasks/', '/tasks/milestones', '/tasks/AGN-12', '/tasks/agn-12/', '/projects/p1/assistant', '/projects/p1/assistant/', '/projects/new'])
    assert.equal(hidesTopBar(path), true, path);
  for (const path of ['/chats', '/chats/abc', '/orchestration', '/projects', '/settings', '/usage', '/tasks/AGN-12/changes'])
    assert.equal(hidesTopBar(path, false), false, path);
  // The flag is about `/` alone: another page with a project in scope keeps its bar
  assert.equal(hidesTopBar('/chats', true), false);
});
