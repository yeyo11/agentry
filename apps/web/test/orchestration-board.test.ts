import assert from 'node:assert/strict';
import test from 'node:test';
import type { Orchestration, OrchestrationTaskState } from '@agentry/shared';

// The wording follows navigator.languages; pin it so the result does not depend on the machine.
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'] }, configurable: true });
const { attemptLabel, blockedBy, costSplit, decisionsOn, waitingSummary } = await import('../src/lib/orchestration-board.ts');

const task = (id: string, extra: Partial<OrchestrationTaskState> = {}): OrchestrationTaskState => ({
  id,
  name: id,
  prompt: 'do it',
  status: 'pending',
  attempts: 0,
  runId: null,
  sessionId: null,
  result: null,
  error: null,
  startedAt: null,
  endedAt: null,
  costUsd: 0,
  ...extra,
});

const orch = (tasks: OrchestrationTaskState[], extra: Partial<Orchestration> = {}): Orchestration => ({
  id: 'o1',
  name: 'graph',
  objective: null,
  status: 'running',
  cwd: '/repo',
  model: null,
  permissionMode: 'acceptEdits',
  concurrency: 2,
  synthesize: true,
  worktree: true,
  maxAttempts: 2,
  allowedTools: [],
  permissionPrompts: 'host',
  createdAt: '2026-01-01T00:00:00Z',
  endedAt: null,
  tasks,
  finalResult: null,
  costUsd: 0,
  engine: 'graph',
  ...extra,
});

test('a failed task offers both retries and giving the branch up, a blocked one only the latter', () => {
  const o = orch([task('a', { status: 'failed' }), task('b', { status: 'blocked', dependsOn: ['a'] })], { status: 'waiting' });
  assert.deepEqual(decisionsOn(o, o.tasks[0]!), { retry: true, retryClean: true, skip: true, hint: false });
  assert.deepEqual(decisionsOn(o, o.tasks[1]!), { retry: false, retryClean: false, skip: true, hint: false });
});

test('only a running task takes a hint', () => {
  const o = orch([task('a', { status: 'running' }), task('b', { status: 'completed' })]);
  assert.equal(decisionsOn(o, o.tasks[0]!).hint, true);
  assert.equal(decisionsOn(o, o.tasks[1]!).hint, false);
});

test('nothing is decided on a workflow or once the orchestration is over', () => {
  const failed = task('a', { status: 'failed' });
  assert.equal(decisionsOn(orch([failed], { engine: 'workflow' }), failed).skip, false);
  assert.equal(decisionsOn(orch([failed], { status: 'stopped' }), failed).skip, false);
  assert.equal(decisionsOn(orch([failed], { status: 'completed' }), failed).retry, false);
});

test('a blocked task names the failed tasks behind it, through the blocked ones between', () => {
  const o = orch(
    [
      task('a', { status: 'failed' }),
      task('b', { status: 'blocked', dependsOn: ['a'] }),
      task('c', { status: 'blocked', dependsOn: ['b'] }),
      task('d', { status: 'completed' }),
    ],
    { status: 'waiting' },
  );
  assert.deepEqual(blockedBy(o, o.tasks[2]!).map((t) => t.id), ['a']);
  assert.deepEqual(blockedBy(o, o.tasks[0]!), []);
});

test('the attempt label says which attempt a task is on and how a failure ended', () => {
  const o = orch([]);
  assert.equal(attemptLabel(o, task('a', { status: 'running', attempts: 1 })), null);
  assert.equal(attemptLabel(o, task('a', { status: 'running', attempts: 2 })), 'Attempt 2 of 2');
  assert.equal(attemptLabel(o, task('a', { status: 'running', attempts: 3 })), 'Attempt 3, retried by hand');
  assert.equal(attemptLabel(o, task('a', { status: 'failed', attempts: 2 })), 'Failed after 2 attempts');
  assert.equal(attemptLabel(o, task('a', { status: 'failed', attempts: 1 })), 'Failed after 1 attempt, not retried');
  assert.equal(attemptLabel(o, task('a', { status: 'completed', attempts: 2 })), 'Completed on attempt 2');
  assert.equal(attemptLabel(o, task('a', { status: 'completed', attempts: 1 })), null);
});

test('the waiting summary exists only while the orchestration waits', () => {
  const tasks = [task('a', { status: 'failed' }), task('b', { status: 'blocked' }), task('c', { status: 'blocked' })];
  assert.equal(waitingSummary(orch(tasks)), null);
  const summary = waitingSummary(orch(tasks, { status: 'waiting' }));
  assert.deepEqual([summary?.failed.length, summary?.blocked.length], [1, 2]);
});

test('cost outside the tasks is what a clean retry left behind, and rounding noise is not', () => {
  assert.deepEqual(costSplit(orch([task('a', { costUsd: 0.1 }), task('b', { costUsd: 0.2 })], { costUsd: 0.1 + 0.2 })), {
    tasks: 0.1 + 0.2,
    other: 0,
  });
  const split = costSplit(orch([task('a', { costUsd: 0.5 })], { costUsd: 0.8 }));
  assert.equal(split.tasks, 0.5);
  assert.ok(Math.abs(split.other - 0.3) < 1e-9);
});
