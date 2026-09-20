import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatSummary, Execution } from '@agentry/shared';
import {
  ALL_ORIGINS,
  contextLevel,
  contextShare,
  formatTokens,
  formatUsd,
  isWorker,
  lastEnded,
  matchesFilters,
  originsToFetch,
  SORTERS,
  type ChatFilters,
} from '../src/lib/chat-model.ts';

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
