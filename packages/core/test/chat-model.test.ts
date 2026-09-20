import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Execution } from '@agentry/shared';
import {
  chatControl,
  chatHealth,
  chatState,
  executionOutcome,
  HUNG_COMMAND_BAD_MS,
  HUNG_COMMAND_MS,
  lastEndedOf,
  SILENCE_MS,
  sessionHolder,
  stateFromCliAgent,
  stateFromRun,
  type HealthFacts,
} from '../src/chat-model.ts';

test('a run is working while it generates, idle between turns and once ended', () => {
  assert.equal(stateFromRun({ status: 'starting', pendingPrompts: 0 }), 'working');
  assert.equal(stateFromRun({ status: 'busy', pendingPrompts: 0 }), 'working');
  assert.equal(stateFromRun({ status: 'idle', pendingPrompts: 0 }), 'idle');
  for (const status of ['completed', 'failed', 'stopped'] as const) assert.equal(stateFromRun({ status, pendingPrompts: 0 }), 'idle', status);
});

test('a run stopped for a person is waiting, unless it has already ended', () => {
  assert.equal(stateFromRun({ status: 'busy', pendingPrompts: 1 }), 'waiting');
  assert.equal(stateFromRun({ status: 'starting', pendingPrompts: 2 }), 'waiting');
  // Prompts of a process that is gone cannot be answered
  assert.equal(stateFromRun({ status: 'failed', pendingPrompts: 1 }), 'idle');
});

test('the CLI list maps onto the same three states', () => {
  assert.equal(stateFromCliAgent({ status: 'busy' }), 'working');
  assert.equal(stateFromCliAgent({ status: 'idle' }), 'idle');
  assert.equal(stateFromCliAgent({ status: 'busy', state: 'blocked' }), 'waiting');
  assert.equal(stateFromCliAgent({ status: 'idle', state: 'done' }), 'idle');
  // A process on its way out is not still working
  assert.equal(stateFromCliAgent({ status: 'busy', state: 'done' }), 'idle');
  // What the CLI says that we do not know is never read as work
  assert.equal(stateFromCliAgent({ status: 'unknown' }), 'idle');
});

test('a run of ours outranks the CLI list, and no source at all is idle', () => {
  assert.equal(chatState({ run: { status: 'idle', pendingPrompts: 0 }, cli: { status: 'busy' } }), 'idle');
  assert.equal(chatState({ run: null, cli: { status: 'busy' } }), 'working');
  assert.equal(chatState({}), 'idle');
});

test('an execution ends with the outcome of its run, or is interrupted when the wrapper lost it', () => {
  for (const status of ['completed', 'failed', 'stopped'] as const) {
    assert.equal(executionOutcome(status), status);
    assert.equal(executionOutcome(status, true), status);
  }
  for (const status of ['starting', 'busy', 'idle'] as const) {
    assert.equal(executionOutcome(status), null, `${status} is alive`);
    assert.equal(executionOutcome(status, true), 'interrupted', `${status} was alive when the wrapper stopped`);
  }
});

test('one of our processes holds a session before a foreign one', () => {
  assert.equal(sessionHolder({ ownProcess: true, foreignProcess: true }), 'agentry');
  assert.equal(sessionHolder({ ownProcess: false, foreignProcess: true }), 'terminal');
  assert.equal(sessionHolder({ ownProcess: false, foreignProcess: false }), 'nobody');
});

test('control follows who is driving', () => {
  assert.deepEqual(chatControl({ holder: 'agentry', origin: 'agentry' }), { mode: 'interactive' });
  assert.deepEqual(chatControl({ holder: 'nobody', origin: 'agentry' }), { mode: 'resumable' });
  const terminal = chatControl({ holder: 'terminal', origin: 'external' });
  assert.equal(terminal.mode, 'readOnly');
  assert.equal(terminal.mode === 'readOnly' && terminal.action, 'fork');
  assert.ok(terminal.mode === 'readOnly' && terminal.reason.length > 0);
});

test('where a chat was born does not decide what can be done with it', () => {
  // Nothing holds an external chat, so resuming adopts it in place
  assert.deepEqual(chatControl({ holder: 'nobody', origin: 'external' }), { mode: 'resumable' });
  assert.deepEqual(chatControl({ holder: 'agentry', origin: 'external' }), { mode: 'interactive' });
});

test('the synthesis of an orchestration is answered in place, whatever else is closed', () => {
  assert.deepEqual(chatControl({ holder: 'nobody', origin: 'orchestration', deliverable: true }), { mode: 'resumable' });
  assert.deepEqual(chatControl({ holder: 'agentry', origin: 'orchestration', deliverable: true }), { mode: 'interactive' });
  // A terminal that holds it still closes it: the guard is about the session, not about the origin
  assert.equal(chatControl({ holder: 'terminal', origin: 'orchestration', deliverable: true }).mode, 'readOnly');
});

test('an orchestration chat takes a hint while its task runs and a fork afterwards', () => {
  const running = chatControl({ holder: 'agentry', origin: 'orchestration', taskRunning: true });
  assert.equal(running.mode === 'readOnly' && running.action, 'hint');
  // A finished task is closed even though nothing holds it: it would overwrite the result others used
  const finished = chatControl({ holder: 'nobody', origin: 'orchestration' });
  assert.equal(finished.mode, 'readOnly');
  assert.equal(finished.mode === 'readOnly' && finished.action, 'fork');
});

// ---------- health ----------

const T0 = Date.parse('2026-01-01T10:00:00.000Z');
const at = (msAfter: number) => new Date(T0 + msAfter).toISOString();
const facts = (over: Partial<HealthFacts> = {}): HealthFacts => ({ state: 'idle', live: null, lastEnded: null, context: null, failedBranches: 0, ...over });
const working = (live: NonNullable<HealthFacts['live']>, over: Partial<HealthFacts> = {}) => facts({ state: 'working', live, ...over });

test('a chat with nothing to report is ok, and says so in words', () => {
  const health = chatHealth(facts());
  assert.deepEqual(health, { level: 'ok', reason: 'Nothing unusual.', signals: [] });
  // A chat that is working and speaking is ok too, whatever it has been running
  assert.equal(chatHealth(working({ lastEventAt: at(0), commands: [] }), T0 + 30_000).level, 'ok');
});

test('a command running past the limit is a warning, and a problem long after', () => {
  const live = { lastEventAt: at(0), commands: [{ command: 'pnpm e2e', startedAt: at(0) }] };
  assert.equal(chatHealth(working(live), T0 + HUNG_COMMAND_MS - 1).level, 'ok');

  const slow = chatHealth(working(live), T0 + 5 * 60_000);
  assert.equal(slow.level, 'warn');
  assert.deepEqual(slow.signals.map((s) => s.kind), ['hung-command']);
  assert.equal(slow.reason, '`pnpm e2e` has been running for 5 min, past the 3 min a command is expected to need.');

  assert.equal(chatHealth(working(live), T0 + HUNG_COMMAND_BAD_MS).level, 'bad');
  // The oldest of several is the one that matters
  const two = { lastEventAt: at(0), commands: [{ command: 'young', startedAt: at(4 * 60_000) }, { command: 'old', startedAt: at(0) }] };
  assert.match(chatHealth(working(two), T0 + 5 * 60_000).reason, /^`old`/);
});

test('a long command is only hung while the chat is working: a person being asked is not it', () => {
  const live = { lastEventAt: at(0), commands: [{ command: 'rm -rf build', startedAt: at(0) }] };
  assert.deepEqual(chatHealth(facts({ state: 'waiting', live }), T0 + 20 * 60_000).signals.map((s) => s.kind), ['waiting']);
  // No process of ours, nothing to watch
  assert.equal(chatHealth(facts({ state: 'working', live: null }), T0 + 20 * 60_000).level, 'ok');
});

test('a working chat that has said nothing for too long is silent, unless a command is what it waits for', () => {
  const quiet = { lastEventAt: at(0), commands: [] };
  assert.equal(chatHealth(working(quiet), T0 + SILENCE_MS - 1).level, 'ok');
  const silent = chatHealth(working(quiet), T0 + 4 * 60_000);
  assert.deepEqual(silent.signals.map((s) => [s.kind, s.level]), [['silence', 'warn']]);
  assert.equal(silent.reason, 'Nothing has happened for 4 min and no command is running: the model or an API call may be stalled.');
  assert.equal(chatHealth(working(quiet), T0 + 11 * 60_000).level, 'bad');
  // An idle chat is not silent, it is finished with its turn
  assert.equal(chatHealth(facts({ state: 'idle', live: quiet }), T0 + 11 * 60_000).level, 'ok');
  // A command in flight explains the quiet; only its own age counts
  const running = { lastEventAt: at(0), commands: [{ command: 'pnpm build', startedAt: at(0) }] };
  assert.deepEqual(chatHealth(working(running), T0 + 2 * 60_000).signals, []);
});

test('the facts of the chat itself are signals too, worst first', () => {
  assert.equal(chatHealth(facts({ lastEnded: { outcome: 'failed', error: 'rate limited' } })).reason, 'The last execution failed: rate limited');
  assert.equal(chatHealth(facts({ lastEnded: { outcome: 'interrupted', error: null } })).reason, 'The last execution was cut short: its process was lost.');
  // Someone stopping it, or it finishing, is not a problem
  for (const outcome of ['stopped', 'completed'] as const) assert.equal(chatHealth(facts({ lastEnded: { outcome, error: null } })).level, 'ok', outcome);

  assert.equal(chatHealth(facts({ context: { used: 195_000, window: 200_000 } })).level, 'bad');
  assert.equal(chatHealth(facts({ context: { used: 170_000, window: 200_000 } })).level, 'warn');
  // Without a window there is no honest percentage
  assert.equal(chatHealth(facts({ context: { used: 900_000, window: null } })).level, 'ok');
  assert.match(chatHealth(facts({ state: 'waiting' })).reason, /answers a permission/);
  assert.match(chatHealth(facts({ failedBranches: 2 })).reason, /2 branches failed/);
  assert.match(chatHealth(facts({ failedBranches: 1 })).reason, /1 branch failed/);

  const both = chatHealth(facts({ state: 'waiting', failedBranches: 1, lastEnded: { outcome: 'failed', error: null } }));
  assert.deepEqual(both.signals.map((s) => s.kind), ['last-execution', 'waiting', 'branches']);
  assert.equal(both.level, 'bad');
  assert.equal(both.reason, both.signals[0]?.reason);
});

test('a failure that a later live execution has superseded is not the chat\'s news of now', () => {
  const execution = (over: Partial<Execution>): Execution => ({
    id: 'x',
    startedAt: at(0),
    endedAt: at(1000),
    outcome: 'completed',
    error: null,
    permissionMode: 'acceptEdits',
    model: null,
    account: null,
    maxBudgetUsd: null,
    costUsd: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
    turns: 1,
    ...over,
  });
  assert.equal(lastEndedOf([]), null);
  assert.deepEqual(lastEndedOf([execution({ outcome: 'failed', error: 'boom' })]), { outcome: 'failed', error: 'boom' });
  assert.equal(lastEndedOf([execution({ outcome: 'failed' }), execution({ endedAt: null, outcome: null })]), null);
});
