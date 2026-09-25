import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatSummary, Execution } from '@agentry/shared';
import type { ChatFilters } from '../src/lib/chat-model.ts';

// The cost's wording follows navigator.languages; pin it so the result does not depend on the machine.
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'] }, configurable: true });
const {
  ALL_ORIGINS,
  contextLevel,
  contextShare,
  dayGroup,
  deleteBlocker,
  displayTitle,
  facetOptions,
  formatTokens,
  formatUsd,
  groupByDay,
  isWorker,
  lastEnded,
  listRequest,
  matchesFilters,
  originsToFetch,
  rowTags,
  SORTERS,
  stateCounts,
  stepCursor,
} = await import('../src/lib/chat-model.ts');

const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };

const execution = (over: Partial<Execution> = {}): Execution => ({
  id: 'e1',
  startedAt: '2026-01-01T10:00:00Z',
  endedAt: '2026-01-01T10:05:00Z',
  outcome: 'completed',
  error: null,
  permissionMode: 'manual',
  model: null,
  account: null,
  maxBudgetUsd: null,
  costUsd: null,
  tokens,
  turns: 1,
  ...over,
});

const chat = (over: Partial<ChatSummary> = {}): ChatSummary => ({
  id: 'c1',
  title: 'Fix the login bug',
  firstPrompt: null,
  messageCount: 2,
  startedAt: '2026-01-01T10:00:00Z',
  updatedAt: '2026-01-01T10:05:00Z',
  model: null,
  cliVersion: null,
  project: null,
  cwd: '/work/alpha',
  worktree: null,
  origin: 'agentry',
  orchestration: null,
  derivedFrom: null,
  state: 'idle',
  control: { mode: 'resumable' },
  execution: null,
  executions: [],
  context: null,
  cost: { usd: null, tokens: [], total: tokens },
  ...over,
});

const worker = (over: Partial<ChatSummary> = {}) =>
  chat({ origin: 'orchestration', orchestration: { id: 'o1', name: 'Release', taskId: 't1', taskName: 'Write docs' }, ...over });
const synthesis = () => chat({ origin: 'orchestration', orchestration: { id: 'o1', name: 'Release', taskId: null, taskName: null } });

const filters = (over: Partial<ChatFilters> = {}): ChatFilters => ({ origins: new Set(ALL_ORIGINS), state: null, workers: false, internal: false, search: '', ...over });

test('a share of the window exists only when the window is known', () => {
  assert.equal(contextShare(chat()), null);
  assert.equal(contextShare(chat({ context: { used: 50_000, window: null } })), null);
  assert.equal(contextShare(chat({ context: { used: 50_000, window: 200_000 } })), 0.25);
});

test('the meter warns before the chat compacts', () => {
  assert.equal(contextLevel(0.5), 'ok');
  assert.equal(contextLevel(0.8), 'warn');
  assert.equal(contextLevel(0.95), 'full');
});

test('a cost nobody reported reads as not available, never as zero', () => {
  assert.equal(formatUsd(null), 'not available');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(1.234), '$1.23');
  assert.equal(formatUsd(0.004), '$0.0040');
});

test('tokens are abbreviated', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(12_400), '12.4k');
  assert.equal(formatTokens(328_000), '328k');
  assert.equal(formatTokens(1_250_000), '1.3M');
});

test('orchestration workers are out by default, and the synthesis is not one', () => {
  assert.equal(isWorker(worker()), true);
  assert.equal(isWorker(synthesis()), false);
  assert.equal(matchesFilters(worker(), filters()), false);
  assert.equal(matchesFilters(synthesis(), filters()), true);
  assert.equal(matchesFilters(worker(), filters({ workers: true })), true);
});

test('internal chats need their own switch', () => {
  assert.equal(matchesFilters(chat({ origin: 'internal' }), filters()), false);
  assert.equal(matchesFilters(chat({ origin: 'internal' }), filters({ internal: true })), true);
  assert.deepEqual(originsToFetch({ internal: false }), ['agentry', 'external', 'orchestration']);
  assert.deepEqual(originsToFetch({ internal: true }), ['agentry', 'external', 'orchestration', 'internal']);
});

test('origin and state narrow the list', () => {
  const terminal = chat({ origin: 'external', state: 'working' });
  assert.equal(matchesFilters(terminal, filters({ origins: new Set(['agentry']) })), false);
  assert.equal(matchesFilters(terminal, filters({ origins: new Set(['external']) })), true);
  assert.equal(matchesFilters(terminal, filters({ state: 'idle' })), false);
  assert.equal(matchesFilters(terminal, filters({ state: 'working' })), true);
});

test('search reads the title, the project and the orchestration', () => {
  const c = worker({ project: { id: 'p1', name: 'Agentry' } });
  assert.equal(matchesFilters(c, filters({ workers: true, search: 'login' })), true);
  assert.equal(matchesFilters(c, filters({ workers: true, search: 'agentry' })), true);
  assert.equal(matchesFilters(c, filters({ workers: true, search: 'write docs' })), true);
  assert.equal(matchesFilters(c, filters({ workers: true, search: 'nothing like it' })), false);
});

test('a search never matches across two fields, and reads a chat that changed afresh', () => {
  const c = chat({ title: 'Fix login', cwd: '/work/app' });
  // The title's end and the directory's start are not one phrase
  assert.equal(matchesFilters(c, filters({ search: 'login /work' })), false);
  assert.equal(matchesFilters(c, filters({ search: 'LOGIN' })), true);
  // A new version of the row is a new object, and its text is read again
  assert.equal(matchesFilters({ ...c, title: 'Dark mode' }, filters({ search: 'login' })), false);
});

test('the list asks the server to leave workers out unless they are wanted', () => {
  assert.deepEqual(listRequest({ internal: false, workers: false }), { origin: ['agentry', 'external', 'orchestration'], workers: false });
  assert.deepEqual(listRequest({ internal: true, workers: true }), { origin: ['agentry', 'external', 'orchestration', 'internal'] });
});

test('sorting by context puts the chats closest to compacting first, and those without a share last', () => {
  const near = chat({ id: 'near', context: { used: 190_000, window: 200_000 } });
  const far = chat({ id: 'far', context: { used: 20_000, window: 200_000 } });
  const unknown = chat({ id: 'unknown', context: { used: 20_000, window: null } });
  assert.deepEqual([unknown, far, near].sort(SORTERS.context).map((c) => c.id), ['near', 'far', 'unknown']);
});

test('the last execution that ended is what tells a crashed chat from a finished one', () => {
  const live = execution({ id: 'live', endedAt: null, outcome: null });
  assert.equal(lastEnded(chat({ executions: [] })), null);
  assert.equal(lastEnded(chat({ executions: [execution({ id: 'a' }), live] }))?.id, 'a');
});

test('the project and model facets narrow the list, and an empty facet lets everything through', () => {
  const alpha = chat({ id: 'a', project: { id: 'p1', name: 'Alpha' }, model: 'claude-opus-5' });
  const loose = chat({ id: 'l', model: null });
  assert.equal(matchesFilters(alpha, filters({ projects: new Set() })), true);
  assert.equal(matchesFilters(alpha, filters({ projects: new Set(['p1']) })), true);
  assert.equal(matchesFilters(loose, filters({ projects: new Set(['p1']) })), false);
  assert.equal(matchesFilters(loose, filters({ projects: new Set(['loose']) })), true);
  assert.equal(matchesFilters(alpha, filters({ models: new Set(['claude-opus-5']) })), true);
  // A chat that never said its model cannot be said to match one
  assert.equal(matchesFilters(loose, filters({ models: new Set(['claude-opus-5']) })), false);
  assert.equal(matchesFilters(loose, filters({ models: new Set() })), true);
});

test('the state tabs count what each would show with the other filters kept', () => {
  const chats = [chat({ id: 'w', state: 'working' }), chat({ id: 'q', state: 'waiting' }), chat({ id: 'i' }), chat({ id: 'x', origin: 'external' })];
  const counts = stateCounts(chats, filters({ state: 'working', origins: new Set(['agentry']) }));
  assert.deepEqual(counts, { all: 3, working: 1, waiting: 1, idle: 1 });
});

test('facets offer only values the chats have, the most used first', () => {
  const chats = [
    chat({ id: '1', model: 'sonnet', project: { id: 'p2', name: 'Beta' } }),
    chat({ id: '2', model: 'opus', project: { id: 'p2', name: 'Beta' } }),
    chat({ id: '3', model: 'opus' }),
    chat({ id: '4', model: null }),
    chat({ id: '5', model: '<synthetic>' }),
  ];
  assert.deepEqual(
    facetOptions(chats, 'model').map((o) => [o.value, o.count]),
    [
      ['opus', 2],
      ['sonnet', 1],
    ],
  );
  assert.deepEqual(
    facetOptions(chats, 'project', 'no project').map((o) => [o.value, o.label, o.count]),
    [
      ['loose', 'no project', 3],
      ['p2', 'Beta', 2],
    ],
  );
});

test('day groups follow the calendar, not 24-hour windows', () => {
  const now = new Date(2026, 8, 21, 0, 10);
  assert.equal(dayGroup(new Date(2026, 8, 21, 0, 5).toISOString(), now), 'today');
  assert.equal(dayGroup(new Date(2026, 8, 20, 23, 50).toISOString(), now), 'yesterday');
  assert.equal(dayGroup(new Date(2026, 8, 15, 12).toISOString(), now), 'week');
  assert.equal(dayGroup(new Date(2026, 8, 14, 23).toISOString(), now), 'earlier');
  assert.equal(dayGroup(null, now), 'earlier');
  // A clock a little ahead of this one is still today
  assert.equal(dayGroup(new Date(2026, 8, 21, 0, 20).toISOString(), now), 'today');
});

test('grouping keeps the order it is given and cuts it where the day changes', () => {
  const now = new Date(2026, 8, 21, 12);
  const at = (d: number) => new Date(2026, 8, d, 9).toISOString();
  const groups = groupByDay([chat({ id: 'a', updatedAt: at(21) }), chat({ id: 'b', updatedAt: at(21) }), chat({ id: 'c', updatedAt: at(20) }), chat({ id: 'd', updatedAt: at(1) })], now);
  assert.deepEqual(
    groups.map((g) => [g.group, g.chats.map((c) => c.id)]),
    [
      ['today', ['a', 'b']],
      ['yesterday', ['c']],
      ['earlier', ['d']],
    ],
  );
});

test('a row shows two tags at most, and never the resumable mode nearly every chat has', () => {
  assert.deepEqual(rowTags(chat()), []);
  assert.deepEqual(rowTags(chat({ derivedFrom: { chatId: 'x', at: '2026-01-01T00:00:00Z' } })), ['fork']);
  const busy = chat({
    control: { mode: 'readOnly', reason: 'held', action: 'fork' },
    derivedFrom: { chatId: 'x', at: '2026-01-01T00:00:00Z' },
    worktree: { path: '/w', name: 'w', branch: 'b' },
  });
  assert.deepEqual(rowTags(busy), ['readOnly', 'fork']);
  assert.deepEqual(rowTags(chat({ control: { mode: 'interactive' }, worktree: { path: '/w', name: 'w', branch: null } })), ['interactive', 'worktree']);
});

test('bulk delete skips a chat something runs on or something else holds, and says which', () => {
  assert.equal(deleteBlocker(chat()), null);
  assert.equal(deleteBlocker(chat({ execution: execution({ endedAt: null, outcome: null }) })), 'live');
  // A terminal working on it: no execution of ours, but the server would refuse it all the same
  assert.equal(deleteBlocker(chat({ state: 'working' })), 'live');
  assert.equal(deleteBlocker(chat({ control: { mode: 'readOnly', reason: 'held', action: 'fork' } })), 'held');
});

test('the keyboard cursor starts at an end and stops at either end', () => {
  assert.equal(stepCursor(0, null, 1), null);
  assert.equal(stepCursor(3, null, 1), 0);
  assert.equal(stepCursor(3, null, -1), 2);
  assert.equal(stepCursor(3, 2, 1), 2);
  assert.equal(stepCursor(3, 0, -1), 0);
  assert.equal(stepCursor(3, 1, 1), 2);
  // A cursor left past the end by a shorter list comes back in
  assert.equal(stepCursor(2, 5, 1), 0);
});

test('a chat reads as its first prompt, not as the name Agentry gave the CLI', () => {
  const id = 'e2b36e71-d31d-460b-a378-201035a99b74';
  assert.equal(displayTitle(chat({ id, title: 'workspace-e2b36e', firstPrompt: 'Fix the login bug\nand test it' })), 'Fix the login bug');
  assert.equal(displayTitle(chat({ id, title: id, firstPrompt: 'Fix the login bug' })), 'Fix the login bug');
  assert.equal(displayTitle(chat({ id, title: 'workspace-e2b36e', firstPrompt: null })), 'workspace-e2b36e');
  assert.equal(displayTitle(chat({ id, title: 'Login work', firstPrompt: 'Fix the login bug' })), 'Login work');
});
