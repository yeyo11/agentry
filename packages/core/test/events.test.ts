import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentryEvent, Orchestration, RunSummary } from '@agentry/shared';
import { Core } from '../src/index.ts';
import { Db } from '../src/db.ts';
import { OrchestrationEventTracker, RunEventPublisher, SessionsWatcher } from '../src/event-sources.ts';
import { EventBus, type AgentryEventInput } from '../src/events.ts';
import { RunManager } from '../src/runner.ts';
import { tempConfig } from './helpers.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const ping = (title: string): AgentryEventInput => ({ type: 'sessions.changed', title });

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 4000): Promise<T> {
  for (let i = 0; i < ms / 20; i++) {
    const value = read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const types = (events: Array<{ type: string }>) => events.map((e) => e.type);

// ---------- the bus ----------

test('events get increasing ids and a timestamp, and reach every subscriber until it leaves', () => {
  const bus = new EventBus();
  const a: AgentryEvent[] = [];
  const b: AgentryEvent[] = [];
  const stopA = bus.subscribe((e) => a.push(e));
  bus.subscribe((e) => b.push(e));

  bus.emit(ping('one'));
  stopA();
  bus.emit(ping('two'));

  assert.deepEqual(a.map((e) => e.id), [1]);
  assert.deepEqual(b.map((e) => e.id), [1, 2]);
  assert.match(b[0]?.at ?? '', /^\d{4}-\d\d-\d\dT/);
  assert.equal(bus.lastEventId, 2);
  assert.equal(bus.subscribers, 1);
});

test('a subscriber that throws does not stop the others from hearing the event', () => {
  const bus = new EventBus();
  const heard: number[] = [];
  bus.subscribe(() => {
    throw new Error('broken consumer');
  });
  bus.subscribe((e) => heard.push(e.id));
  bus.emit(ping('x'));
  assert.deepEqual(heard, [1]);
});

test('a client that reconnects gets what it missed, and nothing when it is up to date', () => {
  const bus = new EventBus();
  for (const t of ['a', 'b', 'c', 'd']) bus.emit(ping(t));

  const missed = bus.since(2);
  assert.ok('events' in missed);
  assert.deepEqual(missed.events.map((e) => e.id), [3, 4]);
  assert.deepEqual(bus.since(4), { events: [] });
});

test('the replay buffer is bounded, and an id that fell out of it asks for a full resync', () => {
  const bus = new EventBus(3);
  for (let i = 0; i < 10; i++) bus.emit(ping(String(i)));

  // Holds 8..10: a client that saw 7 can continue, one that saw 6 lost event 7
  const edge = bus.since(7);
  assert.ok('events' in edge);
  assert.deepEqual(edge.events.map((e) => e.id), [8, 9, 10]);
  assert.deepEqual(bus.since(6), { resync: 'buffer-overflow' });
  assert.deepEqual(bus.since(0), { resync: 'buffer-overflow' });
});

test('an id newer than anything emitted can only come from a previous server process', () => {
  const bus = new EventBus();
  bus.emit(ping('a'));
  assert.deepEqual(bus.since(500), { resync: 'server-restarted' });
  assert.notEqual(new EventBus().bootId, bus.bootId);
});

test('the bus says when the first listener arrives and the last one leaves', () => {
  const bus = new EventBus();
  const calls: boolean[] = [];
  bus.onDemand = (wanted) => calls.push(wanted);
  const stop1 = bus.subscribe(() => {});
  const stop2 = bus.subscribe(() => {});
  stop1();
  stop1(); // leaving twice must not count twice
  stop2();
  assert.deepEqual(calls, [true, false]);
});

// ---------- runs ----------

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1',
    name: 'demo',
    sessionId: 'sess-1',
    cwd: '/tmp',
    model: null,
    permissionMode: 'manual',
    status: 'busy',
    pid: 1,
    createdAt: '',
    updatedAt: '',
    endedAt: null,
    turns: 0,
    costUsd: 0,
    prompt: 'p',
    lastText: null,
    error: null,
    orchestrationId: null,
    orchestrationTaskId: null,
    internal: false,
    account: null,
    backgroundTasks: [],
    subagents: [],
    workflows: [],
    ...over,
  };
}

test('a chatty run costs its clients one update per window, but a status change is not delayed', async () => {
  const seen: AgentryEventInput[] = [];
  const publisher = new RunEventPublisher((e) => seen.push(e), 40);
  publisher.baseline(summary());

  for (let i = 1; i <= 20; i++) publisher.observe(summary({ turns: i, lastText: `message ${i}` }));
  assert.equal(seen.length, 0, 'nothing goes out inside the window');
  await until(() => seen.length > 0, 'the coalesced update');
  assert.equal(seen.length, 1);
  const update = seen[0];
  assert.deepEqual([update?.type, update?.type === 'run.updated' && update.turns], ['run.updated', 20]);

  publisher.observe(summary({ turns: 20, lastText: 'message 20', status: 'idle' }));
  const change = seen[1];
  assert.ok(change?.type === 'run.updated');
  assert.deepEqual([change.status, change.previousStatus], ['idle', 'busy']);
  publisher.dispose();
});

test('a run ending is announced once, with why', () => {
  const seen: AgentryEventInput[] = [];
  const publisher = new RunEventPublisher((e) => seen.push(e));
  publisher.baseline(summary());
  publisher.observe(summary({ status: 'failed', error: 'exit code 1', pid: null }));
  publisher.observe(summary({ status: 'failed', error: 'exit code 1', pid: null }));
  assert.equal(seen.length, 1);
  assert.deepEqual(
    { ...seen[0] },
    {
      type: 'run.ended',
      title: 'demo failed',
      runId: 'run-1',
      runName: 'demo',
      sessionId: 'sess-1',
      orchestrationId: null,
      internal: false,
      status: 'failed',
      error: 'exit code 1',
      turns: 0,
      costUsd: 0,
    },
  );
});

test('delegated work is announced when it starts and when it ends, however it got there', () => {
  const seen: AgentryEventInput[] = [];
  const publisher = new RunEventPublisher((e) => seen.push(e), 5);
  publisher.baseline(summary());
  const task = { id: 't1', runId: 'run-1', runName: 'demo', type: 'local_bash', description: 'tail -f log', status: 'running', toolUseId: null, startedAt: '', endedAt: null, summary: null };
  const sub = { toolUseId: 'toolu_1', runId: 'run-1', runName: 'demo', subagentType: 'Explore', description: 'Look around', status: 'running' as const, startedAt: '', endedAt: null };

  publisher.observe(summary({ backgroundTasks: [task], subagents: [sub] }));
  publisher.observe(summary({ backgroundTasks: [{ ...task, status: 'completed', summary: 'done' }], subagents: [{ ...sub, agentId: 'agent-1' }] }));
  publisher.observe(summary({ backgroundTasks: [{ ...task, status: 'completed' }], subagents: [{ ...sub, agentId: 'agent-1', status: 'completed' }] }));

  assert.deepEqual(types(seen), ['task.started', 'subagent.started', 'task.ended', 'subagent.updated', 'subagent.ended']);
  const ended = seen.find((e) => e.type === 'task.ended');
  assert.ok(ended?.type === 'task.ended');
  assert.deepEqual([ended.status, ended.summary], ['completed', 'done']);
  const subEnded = seen.at(-1);
  assert.ok(subEnded?.type === 'subagent.ended');
  assert.equal(subEnded.agentId, 'agent-1');
  publisher.dispose();
});

test('a run announces itself, its work and its end through the manager', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const runs = new RunManager(config, db);
  const bus = new EventBus();
  runs.bus = bus;
  const seen: AgentryEvent[] = [];
  bus.subscribe((e) => seen.push(e));

  const line = (o: unknown) => JSON.stringify(o);
  const sys = (subtype: string, f: Record<string, unknown>) => line({ type: 'system', subtype, ...f });
  const file = join(config.dataDir, 'turn.jsonl');
  writeFileSync(
    file,
    [
      sys('task_started', { task_id: 'bg-1', task_type: 'local_bash', is_backgrounded: true, description: 'tail -f log' }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'Look', prompt: 'x', subagent_type: 'Explore' } }] } }),
      sys('task_started', { task_id: 'agent-1', tool_use_id: 'toolu_a', task_type: 'local_agent', is_backgrounded: true, subagent_type: 'Explore' }),
      sys('task_notification', { task_id: 'agent-1', tool_use_id: 'toolu_a', status: 'completed' }),
      sys('task_notification', { task_id: 'bg-1', status: 'completed', summary: 'finished' }),
    ].join('\n'),
  );

  const run = runs.start({ prompt: `REPLAY ${file}` });
  await until(() => runs.get(run.id)?.status === 'idle', 'the turn');
  await until(() => seen.some((e) => e.type === 'run.updated' && e.status === 'idle'), 'the idle update');
  runs.stopAll();
  await until(() => seen.some((e) => e.type === 'run.ended'), 'the end');

  const kinds = types(seen);
  assert.equal(kinds[0], 'run.created');
  for (const expected of ['task.started', 'task.ended', 'subagent.started', 'subagent.ended', 'run.ended']) {
    assert.ok(kinds.includes(expected), `${expected} in ${kinds.join(', ')}`);
  }
  const started = seen.find((e) => e.type === 'task.started');
  assert.ok(started?.type === 'task.started');
  assert.deepEqual([started.taskId, started.runId], ['bg-1', run.id]);
  const ended = seen.find((e) => e.type === 'run.ended');
  assert.equal(ended?.type === 'run.ended' && ended.status, 'stopped');
  assert.deepEqual(seen.map((e) => e.id), seen.map((_, i) => i + 1), 'ids are contiguous');

  const before = seen.length;
  runs.remove(run.id);
  assert.equal(seen.at(before)?.type, 'run.removed');
  db.close();
});

// ---------- prompts and accounts, wired by Core ----------

test('a question, a plan and a tool call each say what the run is waiting for, and how it was settled', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  const seen: AgentryEvent[] = [];
  core.events.subscribe((e) => seen.push(e));

  for (const [tool, reason] of [['AskUserQuestion', 'question'], ['ExitPlanMode', 'plan'], ['Bash', 'permission']] as const) {
    const run = core.runs.start({ prompt: `ASK ${tool}`, permissionPrompts: 'host' });
    const asked = await until(() => core.permissions.list(run.id)[0], `the ${tool} prompt`);
    const waiting = seen.find((e) => e.type === 'run.waiting' && e.runId === run.id);
    assert.ok(waiting?.type === 'run.waiting');
    assert.deepEqual([waiting.reason, waiting.permissionId, waiting.toolName], [reason, asked.id, tool]);
    assert.ok(seen.some((e) => e.type === 'permission.requested' && e.permissionId === asked.id && e.reason === reason));

    core.permissions.answer(asked.id, { behavior: 'deny', message: 'no' });
    const resolved = seen.find((e) => e.type === 'permission.resolved' && e.permissionId === asked.id);
    assert.equal(resolved?.type === 'permission.resolved' && resolved.outcome, 'deny');
  }
  core.shutdown();
});

// ---------- orchestrations ----------

function orchestration(over: Partial<Orchestration> = {}): Orchestration {
  const task = { id: 'a', name: 'Task A', prompt: 'p', dependsOn: [], status: 'pending' as const, runId: null, sessionId: null, result: null, error: null, startedAt: null, endedAt: null, costUsd: 0 };
  return {
    id: 'o1', name: 'graph', objective: null, status: 'running', cwd: '/tmp', model: null, permissionMode: 'manual', concurrency: 1,
    synthesize: false, worktree: true, allowedTools: [], permissionPrompts: 'none', createdAt: '', endedAt: null, tasks: [task], finalResult: null, costUsd: 0,
    ...over,
  };
}

test('an orchestration announces its status, each task, and a merge conflict once', () => {
  const tracker = new OrchestrationEventTracker();
  const base = orchestration();
  const kinds = (o: Orchestration) => types(tracker.observe([o]));

  assert.deepEqual(kinds(base), ['orchestration.updated'], 'a new graph is announced; its pending tasks are not news');
  assert.deepEqual(kinds(base), [], 'nothing changed, nothing said');

  const running = orchestration({ tasks: base.tasks.map((t) => ({ ...t, status: 'running' as const, runId: 'r1' })) });
  assert.deepEqual(kinds(running), ['orchestration.task']);

  const conflicted = orchestration({
    status: 'completed',
    tasks: base.tasks.map((t) => ({ ...t, status: 'completed' as const })),
    integration: { branch: 'agentry/graph', worktree: null, status: 'conflicted', merged: [], conflicts: [{ taskId: 'a', paths: ['x.ts'] }], commit: null, error: null, integratorRunId: null },
  });
  const events = tracker.observe([conflicted]);
  assert.deepEqual(types(events), ['orchestration.updated', 'orchestration.task', 'orchestration.conflict']);
  const conflict = events.at(-1);
  assert.ok(conflict?.type === 'orchestration.conflict');
  assert.deepEqual(conflict.paths, ['x.ts']);
  assert.deepEqual(kinds(conflicted), [], 'the same conflict is not announced twice');

  assert.deepEqual(types(tracker.observe([])), ['orchestration.removed']);
});

// ---------- sessions on disk ----------

test('a write under the projects directory becomes one sessions.changed, and only while someone listens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-watch-'));
  mkdirSync(join(dir, '-proj'));
  const bus = new EventBus();
  const watcher = new SessionsWatcher(dir, bus, 40);
  const seen: AgentryEvent[] = [];

  writeFileSync(join(dir, '-proj', 'before.jsonl'), '{}\n');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(bus.lastEventId, 0, 'nobody was listening, nothing was watched');

  const stop = bus.subscribe((e) => seen.push(e));
  await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, '-proj', 'a.jsonl'), `{"n":${i}}\n`);
  await until(() => seen.length > 0, 'sessions.changed');
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(types(seen), ['sessions.changed']);

  stop();
  watcher.close();
});
