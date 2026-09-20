import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Orchestration, OrchestrationTaskState } from '@agentry/shared';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { effectiveLimits, elapsedMs, normalizeLimits, remainingUsd, spentUsd, startClock } from '../src/task-limits.ts';
import { tempConfig } from './helpers.ts';

// What a task may spend. The cost ceiling is the CLI's own flag and the time ceiling is Agentry's;
// what is tested here is that each reaches the place that enforces it, and that a retry neither
// escapes the ceiling by getting it all again nor trips a limit the person just gave a new go.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

const stateOf = (over: Partial<OrchestrationTaskState> = {}): OrchestrationTaskState => ({
  id: 't', name: 't', prompt: 'p', status: 'running', attempts: 1, runId: 'c', sessionId: 'c', result: null, error: null, startedAt: null, endedAt: null, costUsd: 0, ...over,
});

test('limits that could never mean anything are refused where they are given', () => {
  assert.deepEqual(normalizeLimits({ maxMinutes: 20, maxCostUsd: 5 }, 'limits'), { maxMinutes: 20, maxCostUsd: 5 });
  assert.equal(normalizeLimits(undefined, 'limits'), undefined);
  assert.equal(normalizeLimits({}, 'limits'), undefined);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '20' as unknown as number]) {
    assert.throws(() => normalizeLimits({ maxMinutes: bad }, 'limits'), /maxMinutes must be a number greater than zero/, String(bad));
  }
  assert.throws(() => normalizeLimits({ maxCostUsd: 0 }, "task 'a' limits"), /task 'a' limits: maxCostUsd/);
});

test("a task's own limits win, field by field, over the graph's default", () => {
  assert.deepEqual(effectiveLimits({ maxMinutes: 30, maxCostUsd: 5 }, { maxMinutes: 10 }), { maxMinutes: 10, maxCostUsd: 5 });
  assert.deepEqual(effectiveLimits(null, { maxCostUsd: 2 }), { maxCostUsd: 2 });
  assert.equal(effectiveLimits(undefined, undefined), null);
});

test('time and money count from when the allowance began, which a person can start again', () => {
  const task = stateOf({ startedAt: '2026-01-01T10:00:00.000Z', costUsd: 3 });
  // Until a clock is started, the time since the task began is what counts
  assert.equal(elapsedMs(task, Date.parse('2026-01-01T10:20:00.000Z')), 20 * 60_000);
  startClock(task, '2026-01-01T11:00:00.000Z');
  task.costUsd = 4.5;
  assert.equal(elapsedMs(task, Date.parse('2026-01-01T11:05:00.000Z')), 5 * 60_000);
  assert.equal(spentUsd(task), 1.5);
  assert.equal(remainingUsd({ maxCostUsd: 5 }, task), 3.5);
  assert.equal(remainingUsd({ maxMinutes: 5 }, task), null);
});

// ---------- in a graph ----------

function graph() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const repo = mkdtempSync(join(tmpdir(), 'agentry-limits-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  const runs = new ChatManager(config, db);
  const orchestrator = new Orchestrator(config, runs, db);
  const taskOf = (id: string, task: string) => orchestrator.get(id)?.tasks.find((t) => t.id === task);
  const spec = (tasks: Array<{ id: string; prompt: string; limits?: { maxMinutes?: number; maxCostUsd?: number } }>, extra = {}) => ({
    name: 'limits', cwd: repo, worktree: true, synthesize: false, tasks: tasks.map((t) => ({ name: t.id, ...t })), ...extra,
  });
  // Whatever a failed assertion left running would keep the test process alive
  const close = () => {
    for (const o of orchestrator.list()) orchestrator.stop(o.id);
    runs.stopAll();
    orchestrator.close();
    db.close();
  };
  return { db, runs, orchestrator, taskOf, spec, close };
}

async function until<T>(read: () => T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('limits are validated on create and kept on the graph and the task', () => {
  const { orchestrator, spec, close } = graph();
  assert.throws(() => orchestrator.create(spec([{ id: 'a', prompt: 'FAKE-HANG', limits: { maxMinutes: 0 } }])), /task 'a' limits: maxMinutes/);
  assert.throws(() => orchestrator.create(spec([{ id: 'a', prompt: 'FAKE-HANG' }], { limits: { maxCostUsd: -2 } })), /limits: maxCostUsd/);
  // A workflow has no worker of its own to hold to a limit, and a limit not kept in silence is worse than none
  assert.throws(() => orchestrator.create(spec([{ id: 'a', prompt: 'x' }], { engine: 'workflow', worktree: false, limits: { maxMinutes: 5 } })), /limits apply to the graph engine/);
  const orch = orchestrator.create(spec([{ id: 'a', prompt: 'FAKE-HANG', limits: { maxMinutes: 5 } }, { id: 'b', prompt: 'FAKE-HANG' }], { limits: { maxMinutes: 30, maxCostUsd: 4 } }));
  assert.deepEqual(orch.limits, { maxMinutes: 30, maxCostUsd: 4 });
  assert.deepEqual(orch.tasks[0]?.limits, { maxMinutes: 5 });
  assert.equal(orch.tasks[1]?.limits, undefined);
  orchestrator.stop(orch.id);
  close();
});

test('the cost limit of a task is handed to the CLI as its own ceiling, and a retry gets only what is left', async () => {
  const { orchestrator, spec, taskOf, close } = graph();
  const log = join(mkdtempSync(join(tmpdir(), 'agentry-spawns-')), 'spawns');
  process.env.FAKE_CLAUDE_SPAWNS = log;
  try {
    // Fails once, at a cost of $0.01, and is retried in the same chat
    const started = orchestrator.create(spec([{ id: 'flaky', prompt: 'FAKE-FAIL-ONCE boom' }, { id: 'plain', prompt: 'FAKE-WRITE a.txt x' }], { limits: { maxCostUsd: 1 } }));
    await until(() => orchestrator.get(started.id), (o) => o?.status === 'completed', 'the graph');
    assert.equal(taskOf(started.id, 'flaky')?.attempts, 2);

    const budgets = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => /--max-budget-usd (\S+)/.exec(line)?.[1]);
    assert.equal(budgets.length, 3, 'two workers, one of them started twice');
    assert.equal(budgets.filter((b) => b === '1').length, 2, 'each worker starts with the whole limit');
    assert.equal(budgets.filter((b) => b === '0.99').length, 1, 'the retry has spent $0.01 of it already');
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    close();
  }
});

test('a task with no cost limit is started without a ceiling', async () => {
  const { orchestrator, spec, close } = graph();
  const log = join(mkdtempSync(join(tmpdir(), 'agentry-spawns-')), 'spawns');
  process.env.FAKE_CLAUDE_SPAWNS = log;
  try {
    const started = orchestrator.create(spec([{ id: 'plain', prompt: 'FAKE-WRITE a.txt x' }], { limits: { maxMinutes: 30 } }));
    await until(() => orchestrator.get(started.id), (o) => o?.status === 'completed', 'the graph');
    assert.doesNotMatch(readFileSync(log, 'utf8'), /--max-budget-usd/);
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    close();
  }
});

test('a task past its time limit is stopped and fails with the reason, and what waits behind it is held', async () => {
  const { orchestrator, runs, spec, taskOf, close } = graph();
  const started = orchestrator.create(spec([{ id: 'slow', prompt: 'FAKE-HANG', limits: { maxMinutes: 10 } }, { id: 'after', prompt: 'FAKE-WRITE b.txt y' }].map((t, i) => (i ? { ...t, dependsOn: ['slow'] } : t)) as never));
  const chat = (await until(() => taskOf(started.id, 'slow')?.runId, Boolean, 'the worker')) as string;
  await until(() => runs.get(chat)?.pid, Boolean, 'the worker to spawn');

  orchestrator.enforceLimits(Date.now() + 5 * 60_000);
  assert.equal(taskOf(started.id, 'slow')?.status, 'running', 'half its time is no reason to stop it');

  orchestrator.enforceLimits(Date.now() + 10 * 60_000 + 5000);
  const slow = taskOf(started.id, 'slow');
  assert.equal(slow?.status, 'failed');
  assert.equal(slow?.error, 'stopped at its time limit of 10 min');
  assert.ok(slow?.endedAt);
  await runs.exited(chat);
  // A person decides what happens to the branch: the graph waits, and the task behind it is blocked
  const orch = await until(() => orchestrator.get(started.id) as Orchestration, (o) => o.status === 'waiting', 'the graph to wait');
  assert.equal(orch.tasks.find((t) => t.id === 'after')?.status, 'blocked');
  assert.match(runs.events(chat).map((e) => e.text ?? '').join('|'), /Agentry stopped this task at its time limit of 10 min/);
  close();
});

test('the worker is warned once before the stop, and told to wrap up', async () => {
  const { orchestrator, runs, spec, taskOf, close } = graph();
  const started = orchestrator.create(spec([{ id: 'slow', prompt: 'FAKE-HANG', limits: { maxMinutes: 10 } }]));
  const chat = (await until(() => taskOf(started.id, 'slow')?.runId, Boolean, 'the worker')) as string;
  await until(() => runs.get(chat)?.pid, Boolean, 'the worker to spawn');

  const notesOf = () =>
    runs
      .events(chat)
      .flatMap((e) => e.entry?.blocks ?? [])
      .flatMap((b) => (b.type === 'text' && b.text.startsWith('A note from Agentry') ? [b.text] : []));
  orchestrator.enforceLimits(Date.now() + 7 * 60_000);
  assert.equal(notesOf().length, 0, 'seven of ten minutes is not yet close');
  orchestrator.enforceLimits(Date.now() + 8 * 60_000);
  orchestrator.enforceLimits(Date.now() + 9 * 60_000);
  const notes = runs
    .events(chat)
    .flatMap((e) => e.entry?.blocks ?? [])
    .flatMap((b) => (b.type === 'text' && b.text.startsWith('A note from Agentry') ? [b.text] : []));
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? '', /used 8 of the 10 minutes/);
  assert.match(notes[0] ?? '', /Wrap up now: commit what works/);
  assert.equal(taskOf(started.id, 'slow')?.status, 'running');
  orchestrator.stop(started.id);
  close();
});

test("a person's retry is a new allowance: the clock starts again and the old one does not trip it", async () => {
  const { orchestrator, runs, spec, taskOf, close } = graph();
  const started = orchestrator.create(spec([{ id: 'slow', prompt: 'FAKE-HANG', limits: { maxMinutes: 10 } }]));
  const chat = (await until(() => taskOf(started.id, 'slow')?.runId, Boolean, 'the worker')) as string;
  await until(() => runs.get(chat)?.pid, Boolean, 'the worker to spawn');
  const firstClock = taskOf(started.id, 'slow')?.clockStartedAt;
  assert.ok(firstClock);

  orchestrator.enforceLimits(Date.now() + 11 * 60_000);
  await runs.exited(chat);
  await until(() => orchestrator.get(started.id)?.status, (s) => s === 'waiting', 'the graph to wait');

  await new Promise((r) => setTimeout(r, 30));
  orchestrator.retryTask(started.id, 'slow');
  await until(() => taskOf(started.id, 'slow')?.status, (s) => s === 'running', 'the retry to start');
  const secondClock = taskOf(started.id, 'slow')?.clockStartedAt;
  assert.ok(secondClock && secondClock > firstClock, 'a new clock');
  // Two minutes into the new allowance is well inside it, though it is far past ten since the first start
  orchestrator.enforceLimits(Date.now() + 2 * 60_000);
  assert.equal(taskOf(started.id, 'slow')?.status, 'running');
  orchestrator.stop(started.id);
  close();
});

test('a running task carries its health when the graph is read, and what is stored is untouched', async () => {
  const { orchestrator, runs, spec, taskOf, close } = graph();
  const started = orchestrator.create(spec([{ id: 'slow', prompt: 'FAKE-HANG' }, { id: 'quick', prompt: 'FAKE-WRITE q.txt 1' }]));
  const chat = (await until(() => taskOf(started.id, 'slow')?.runId, Boolean, 'the worker')) as string;
  await until(() => runs.get(chat)?.pid, Boolean, 'the worker to spawn');

  const stored = orchestrator.get(started.id) as Orchestration;
  assert.equal(orchestrator.view(stored), stored, 'no health source, nothing to add');

  orchestrator.health = (task) => ({ level: 'warn', reason: `about ${task.id}`, signals: [] });
  const viewed = orchestrator.view(stored);
  assert.equal(viewed.tasks.find((t) => t.id === 'slow')?.health?.reason, 'about slow');
  await until(() => taskOf(started.id, 'quick')?.status, (s) => s === 'completed', 'the quick worker');
  assert.equal(orchestrator.view(stored).tasks.find((t) => t.id === 'quick')?.health, undefined, 'a task that ended has none');
  assert.equal(stored.tasks.find((t) => t.id === 'slow')?.health, undefined, 'what is persisted never grows a snapshot');
  orchestrator.stop(started.id);
  close();
});
