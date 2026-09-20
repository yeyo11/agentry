import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatControl, chatState, executionOutcome, sessionHolder, stateFromCliAgent, stateFromRun } from '../src/chat-model.ts';

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
