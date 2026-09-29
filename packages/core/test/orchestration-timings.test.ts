import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Execution, ExecutionOutcome, Orchestration, OrchestrationTaskState } from '@agentry/shared';
import { orchestrationTimings, type TimingsChat } from '../src/orchestration-timings.ts';
import { emptyTokenUsage } from '../src/usage.ts';

/** Minutes after 10:00 on one day, so the figures below read as clock times. */
const t = (min: number): string => new Date(Date.UTC(2026, 0, 1, 10, 0, 0) + min * 60_000).toISOString();
const MIN = 60_000;

const task = (id: string, over: Partial<OrchestrationTaskState> = {}): OrchestrationTaskState => ({
  id,
  name: id.toUpperCase(),
  prompt: '',
  status: 'completed',
  attempts: 1,
  runId: `chat-${id}`,
  sessionId: `chat-${id}`,
  result: null,
  error: null,
  startedAt: null,
  endedAt: null,
  costUsd: 0,
  ...over,
});

const graph = (tasks: OrchestrationTaskState[], over: Partial<Orchestration> = {}): Orchestration => ({
  id: 'g1',
  name: 'graph',
  objective: null,
  status: 'completed',
  cwd: '/repo',
  model: null,
  permissionMode: 'acceptEdits',
  concurrency: 2,
  synthesize: false,
  worktree: true,
  maxAttempts: 2,
  allowedTools: [],
  permissionPrompts: 'none',
  createdAt: t(0),
  endedAt: t(60),
  tasks,
  finalResult: null,
  costUsd: 0,
  ...over,
});

const exec = (start: number, end: number | null, outcome: ExecutionOutcome | null = 'completed', error: string | null = null): Execution => ({
  id: `e${String(start)}`,
  startedAt: t(start),
  endedAt: end === null ? null : t(end),
  outcome: end === null ? null : outcome,
  error,
  permissionMode: 'acceptEdits',
  model: null,
  account: null,
  maxBudgetUsd: null,
  costUsd: null,
  tokens: emptyTokenUsage(),
  turns: 1,
});

const chat = (taskId: string, executions: Execution[], id = `chat-${taskId}`): TimingsChat => ({ id, orchestrationId: 'g1', orchestrationTaskId: taskId, executions });

test('a task that was ready but found no free slot waited for one, and the tasks phase runs from the first start to the last end', () => {
  // a and b start at once; c depends on nothing but the concurrency of 2 holds it until a ends
  const orch = graph([task('a', { endedAt: t(20) }), task('b', { endedAt: t(30) }), task('c', { endedAt: t(40) })]);
  const timings = orchestrationTimings(orch, [chat('a', [exec(1, 20)]), chat('b', [exec(1, 30)]), chat('c', [exec(20, 40)])], new Date(t(90)));

  assert.deepEqual(timings.phases, [{ phase: 'tasks', startedAt: t(1), endedAt: t(40), durationMs: 39 * MIN }]);
  assert.equal(timings.afterTasksMs, 20 * MIN);
  assert.equal(timings.wallMs, 60 * MIN);
  assert.equal(timings.endedAt, t(60));
  assert.equal(timings.parallelism, Math.round(((19 + 29 + 20) / 39) * 100) / 100);
  const slot = timings.waits.items.filter((w) => w.kind === 'slot');
  // a and b started 1 min after the graph was created: a gap over a second is a slot wait too
  assert.deepEqual(slot.map((w) => [w.taskId, w.durationMs]), [['a', MIN], ['b', MIN], ['c', 20 * MIN]]);
  assert.equal(timings.waits.slotMs, 22 * MIN);
  assert.deepEqual(timings.missing, []);
});

test('a limit wait runs from the execution that hit the limit to the one that resumed the task, and work leaves it out', () => {
  const orch = graph([task('a', { endedAt: t(50), attempts: 2 })]);
  const timings = orchestrationTimings(orch, [chat('a', [exec(0, 10, 'failed', "You've hit your session limit · resets 11am"), exec(40, 50)])], new Date(t(90)));

  assert.deepEqual(
    timings.waits.items.map((w) => [w.kind, w.startedAt, w.endedAt, w.durationMs]),
    [['limit', t(10), t(40), 30 * MIN]],
  );
  assert.equal(timings.waits.limitMs, 30 * MIN);
  assert.equal(timings.waits.retryMs, 0);
  assert.match(timings.waits.items[0]?.reason ?? '', /session limit/);
  assert.equal(timings.criticalPath.links[0]?.workMs, 20 * MIN);
});

test('a retry wait follows any other failed or interrupted execution, and a task left failed waits until the graph ends', () => {
  const orch = graph([
    task('a', { endedAt: t(30), attempts: 2 }),
    task('b', { status: 'failed', endedAt: t(15), error: 'the tests fail' }),
  ]);
  const timings = orchestrationTimings(
    orch,
    [chat('a', [exec(0, 5, 'interrupted', 'interrupted by a restart'), exec(12, 30)]), chat('b', [exec(0, 15, 'failed', 'the tests fail')])],
    new Date(t(90)),
  );
  const retries = timings.waits.items.filter((w) => w.kind === 'retry').map((w) => [w.taskId, w.startedAt, w.endedAt, w.durationMs]);
  assert.deepEqual(retries, [
    ['a', t(5), t(12), 7 * MIN],
    ['b', t(15), t(60), 45 * MIN],
  ]);
  assert.equal(timings.waits.retryMs, 52 * MIN);
  assert.equal(timings.waits.limitMs, 0);
});

test('the critical path walks back from the task that ended last through the dependency that ended last', () => {
  //  types(0–10) ─┬─ core(10–30) ─┬─ docs(45–50)
  //               └─ web(12–45) ──┘
  const orch = graph([
    task('types', { endedAt: t(10) }),
    task('core', { endedAt: t(30), dependsOn: ['types'] }),
    task('web', { endedAt: t(45), dependsOn: ['types'] }),
    task('docs', { endedAt: t(50), dependsOn: ['core', 'web'] }),
  ]);
  const timings = orchestrationTimings(
    orch,
    [chat('types', [exec(0, 10)]), chat('core', [exec(10, 30)]), chat('web', [exec(12, 45)]), chat('docs', [exec(45, 50)])],
    new Date(t(90)),
  );
  const path = timings.criticalPath;
  assert.deepEqual(path.links.map((l) => l.taskId), ['types', 'web', 'docs']);
  assert.deepEqual(path.links.map((l) => [l.workMs / MIN, l.waitBeforeMs / MIN]), [[10, 0], [33, 2], [5, 0]]);
  assert.equal(path.durationMs, 50 * MIN);
  // web's two minutes behind types were a wait for a slot, and they are the link's
  assert.deepEqual(path.links[1]?.waits.map((w) => [w.kind, w.durationMs / MIN]), [['slot', 2]]);
  assert.equal(path.links[1]?.taskName, 'WEB');
});

test('the phases after the tasks come from the recorded times, and the verification from every run and fix', () => {
  const orch = graph([task('a', { endedAt: t(20) })], {
    endedAt: t(80),
    synthesize: true,
    integration: { branch: 'agentry/x', worktree: null, status: 'merged', merged: ['a'], conflicts: [], commit: 'c', error: null, integratorRunId: null, startedAt: t(20), endedAt: t(21) },
    verification: {
      status: 'fixed',
      startedAt: t(21),
      endedAt: t(70),
      attempts: 1,
      commits: [],
      report: '',
      costUsd: 1.5,
      commands: [
        { command: 'pnpm e2e', status: 'fixed', output: '', durationMs: 14 * MIN, runs: [
          { pass: 1, startedAt: t(21), durationMs: 15 * MIN, status: 'failed' },
          { pass: 2, startedAt: t(56), durationMs: 14 * MIN, status: 'passed' },
        ] },
      ],
      fixes: [{ runId: 'fixer-1', command: 'pnpm e2e', attempt: 1, startedAt: t(36), endedAt: t(56), costUsd: 1.5 }],
    },
    synthesisRunId: 'synth',
    synthesisStartedAt: t(70),
    synthesisEndedAt: t(80),
  });
  const timings = orchestrationTimings(orch, [chat('a', [exec(0, 20)])], new Date(t(90)));
  assert.deepEqual(timings.phases.map((p) => [p.phase, p.durationMs / MIN]), [['tasks', 20], ['integration', 1], ['verification', 49], ['synthesis', 10]]);
  assert.equal(timings.afterTasksMs, 60 * MIN);
  assert.equal(timings.verification?.checksMs, 29 * MIN);
  assert.equal(timings.verification?.fixerMs, 20 * MIN);
  assert.equal(timings.verification?.passes, 2);
  assert.equal(timings.verification?.commands[0]?.totalMs, 29 * MIN);
  assert.equal(timings.verification?.fixes[0]?.runId, 'fixer-1');
  assert.deepEqual(timings.missing, []);
});

test('a graph stored before the times were recorded falls back to its role chats, and names what it cannot give', () => {
  const orch = graph([task('a', { startedAt: t(0), endedAt: t(20) })], {
    synthesize: true,
    integration: { branch: 'agentry/x', worktree: null, status: 'merged', merged: ['a'], conflicts: [], commit: 'c', error: null, integratorRunId: null },
    verification: { status: 'passed', attempts: 0, commits: [], report: '', costUsd: 0, commands: [{ command: 'pnpm test', status: 'passed', output: '', durationMs: 3 * MIN }] },
    synthesisRunId: 'synth',
  });
  // No chat for the task (its record is gone) and none for the integration; the synthesis chat is still there
  const timings = orchestrationTimings(orch, [chat('__synthesis__', [exec(50, 58)], 'synth')], new Date(t(90)));
  assert.deepEqual(timings.phases.map((p) => [p.phase, p.startedAt, p.endedAt]), [
    ['tasks', t(0), t(20)],
    ['synthesis', t(50), t(58)],
  ]);
  assert.deepEqual(timings.missing, ['integration.startedAt', 'verification.startedAt', 'verification.runs', 'verification.fixes']);
  // What an older check did record still counts
  assert.equal(timings.verification?.checksMs, 3 * MIN);
  assert.deepEqual(timings.verification?.commands[0]?.runs, []);

  // With the fixer's chat still there, its executions stand in for the attempts it did not record
  const withFixer = orchestrationTimings(orch, [chat('__synthesis__', [exec(50, 58)], 'synth'), chat('__verification__', [exec(30, 42)], 'fixer')], new Date(t(90)));
  assert.deepEqual(withFixer.verification?.fixes.map((f) => [f.runId, f.attempt, f.startedAt, f.endedAt]), [['fixer', 1, t(30), t(42)]]);
  assert.equal(withFixer.verification?.fixerMs, 12 * MIN);
  // The fixer's chat also dates the verification phase, from its first execution
  assert.ok(!withFixer.missing.includes('verification.fixes'));
});

test('a running graph counts what is still going up to now, and has no end yet', () => {
  const orch = graph(
    [
      task('a', { endedAt: t(10) }),
      task('b', { status: 'running', endedAt: null, dependsOn: ['a'] }),
      task('c', { status: 'pending', endedAt: null, runId: null, sessionId: null, dependsOn: ['a'] }),
    ],
    { status: 'running', endedAt: null, concurrency: 1 },
  );
  const timings = orchestrationTimings(orch, [chat('a', [exec(0, 10)]), chat('b', [exec(10, null)])], new Date(t(25)));
  assert.equal(timings.endedAt, null);
  assert.equal(timings.at, t(25));
  assert.equal(timings.wallMs, 25 * MIN);
  assert.deepEqual(timings.phases, [{ phase: 'tasks', startedAt: t(0), endedAt: null, durationMs: 25 * MIN }]);
  assert.equal(timings.afterTasksMs, 0);
  assert.deepEqual(timings.criticalPath.links.map((l) => [l.taskId, l.endedAt, l.workMs / MIN]), [['a', t(10), 10], ['b', null, 15]]);
  // c has been ready since a ended and is still waiting for the one slot
  assert.deepEqual(timings.waits.items.map((w) => [w.taskId, w.kind, w.endedAt, w.durationMs / MIN]), [['c', 'slot', null, 15]]);
  assert.equal(timings.verification, null);
});
