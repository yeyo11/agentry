import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { Execution } from '@agentry/shared';
import type { LegacyRun, StoredChat } from '../src/chat-records.ts';
import { Db } from '../src/db.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { ChatManager } from '../src/chats.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

const at = (minute: number) => `2026-09-18T20:${String(minute).padStart(2, '0')}:00.000Z`;

test('events survive a reopen, which the in-memory buffer never did', () => {
  const config = tempConfig();
  const first = new Db(config);
  first.appendRotationEvent({ ts: at(28), event: 'switch', from: 'a@x.es', to: 'b@x.es', reason: 'at-limit' });
  first.appendRotationEvent({ ts: at(29), event: 'poll', data: { pct: 53 } });
  first.close();

  const second = new Db(config);
  const events = second.rotationEvents();
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.event),
    ['switch', 'poll'],
  );
  assert.equal(events[0]?.from, 'a@x.es');
  assert.equal(events[0]?.to, 'b@x.es');
  assert.deepEqual(events[1]?.data, { pct: 53 });
  // Absent columns stay absent rather than becoming null
  assert.equal('reason' in (events[1] ?? {}), false);
  second.close();
});

test('reads the newest events, oldest last, and filters by timestamp', () => {
  const db = new Db(tempConfig());
  for (let i = 0; i < 10; i++) db.appendRotationEvent({ ts: at(i), event: `e${String(i)}` });

  const latest = db.rotationEvents({ limit: 3 });
  assert.deepEqual(
    latest.map((e) => e.event),
    ['e7', 'e8', 'e9'],
  );

  const since = db.rotationEvents({ since: at(7) });
  assert.deepEqual(
    since.map((e) => e.event),
    ['e8', 'e9'],
  );
  db.close();
});

test('pruning keeps the newest rows and leaves the sequence intact', () => {
  const db = new Db(tempConfig());
  for (let i = 0; i < 10; i++) db.appendRotationEvent({ ts: at(i), event: `e${String(i)}` });

  assert.equal(db.pruneRotationEvents(4), 6);
  const kept = db.rotationEvents();
  assert.deepEqual(
    kept.map((e) => e.event),
    ['e6', 'e7', 'e8', 'e9'],
  );
  // A later append must not reuse a pruned seq: the panel pages on it
  const next = db.appendRotationEvent({ ts: at(10), event: 'e10' });
  assert.equal(next.seq, 11);
  assert.equal(db.pruneRotationEvents(100), 0);
  db.close();
});

test('two connections on one data dir both write, as two wrapper processes would', () => {
  const config = tempConfig();
  const a = new Db(config);
  const b = new Db(config);
  a.appendRotationEvent({ ts: at(30), event: 'from-a' });
  b.appendRotationEvent({ ts: at(31), event: 'from-b' });
  assert.deepEqual(
    a.rotationEvents().map((e) => e.event),
    ['from-a', 'from-b'],
  );
  a.close();
  b.close();
});

const execution = (id: string, startedAt: string, extra: Partial<Execution> = {}): Execution => ({
  id,
  startedAt,
  endedAt: startedAt,
  outcome: 'completed',
  error: null,
  permissionMode: 'plan',
  model: null,
  account: null,
  maxBudgetUsd: null,
  costUsd: 0.5,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  turns: 1,
  ...extra,
});

const chat = (id: string, createdAt: string, executions: Execution[] = [execution(`${id}-1`, createdAt)]): StoredChat => ({
  record: {
    id,
    name: id,
    cwd: '/tmp',
    workingDir: null,
    origin: 'agentry',
    orchestrationId: null,
    orchestrationTaskId: null,
    derivedFrom: null,
    prompt: 'hi',
    lastText: 'ok',
    model: null,
    permissionMode: 'plan',
    account: null,
    permissionPrompts: 'none',
    createdAt,
    updatedAt: createdAt,
  },
  executions,
});

/** A run as the wrapper stored it before a run became an execution of a chat. */
const legacyRun = (id: string, sessionId: string | null, createdAt: string, extra: Partial<LegacyRun> = {}): LegacyRun => ({
  id,
  name: id,
  sessionId,
  cwd: '/tmp',
  model: null,
  permissionMode: 'plan',
  status: 'completed',
  createdAt,
  updatedAt: createdAt,
  endedAt: createdAt,
  turns: 1,
  costUsd: 0.25,
  prompt: 'hi',
  lastText: 'ok',
  error: null,
  orchestrationId: null,
  orchestrationTaskId: null,
  internal: false,
  account: null,
  ...extra,
});

test('chats round-trip with their executions, newest first, and the cap drops the oldest with theirs', () => {
  const db = new Db(tempConfig());
  db.saveChats([chat('a', '2026-09-18T10:00:00Z'), chat('b', '2026-09-18T11:00:00Z', [execution('b-1', '2026-09-18T11:00:00Z'), execution('b-2', '2026-09-18T11:30:00Z', { turns: 4 })])], 200);
  assert.deepEqual(
    db.loadChats().map((c) => c.record.id),
    ['b', 'a'],
  );
  // The history of one chat is what it says, oldest first, however often it was saved
  assert.deepEqual(db.loadChats()[0]?.executions.map((e) => [e.id, e.turns]), [['b-1', 1], ['b-2', 4]]);

  db.saveChats([chat('c', '2026-09-18T12:00:00Z')], 2);
  assert.deepEqual(
    db.loadChats().map((c) => c.record.id),
    ['c', 'b'],
  );

  db.deleteChat('c');
  assert.deepEqual(
    db.loadChats().map((c) => c.record.id),
    ['b'],
  );
  db.close();
});

test('saving a chat again updates its executions in place instead of adding a second history', () => {
  const db = new Db(tempConfig());
  const live = execution('e1', '2026-09-18T10:00:00Z', { endedAt: null, outcome: null, costUsd: null });
  db.saveChats([chat('a', '2026-09-18T10:00:00Z', [live])], 200);
  db.saveChats([chat('a', '2026-09-18T10:00:00Z', [{ ...live, endedAt: '2026-09-18T10:05:00Z', outcome: 'completed', costUsd: 0.3 }])], 200);

  const [stored] = db.loadChats();
  assert.equal(stored?.executions.length, 1);
  assert.deepEqual([stored?.executions[0]?.outcome, stored?.executions[0]?.costUsd], ['completed', 0.3]);
  db.close();
});

test('a save never drops the chats another process owns', () => {
  const config = tempConfig();
  const a = new Db(config);
  const b = new Db(config);
  a.saveChats([chat('from-a', '2026-09-18T10:00:00Z')], 200);
  // b knows nothing about a's chat — the old whole-file write erased it here
  b.saveChats([chat('from-b', '2026-09-18T11:00:00Z')], 200);
  assert.deepEqual(
    a.loadChats().map((c) => c.record.id),
    ['from-b', 'from-a'],
  );
  a.close();
  b.close();
});

test('a pre-SQLite runs.json is carried into the store once, as chats', async () => {
  const config = tempConfig();
  const legacy = join(config.dataDir, 'runs.json');
  writeFileSync(legacy, JSON.stringify([legacyRun('old', 'session-old', '2026-09-18T09:00:00Z')]));

  const db = new Db(config);
  const manager = new ChatManager(config, db);
  await manager.restore(new SessionStore(config));

  assert.deepEqual(
    manager.list().map((r) => r.id),
    ['session-old'],
  );
  assert.deepEqual(
    db.loadChats().map((c) => c.record.id),
    ['session-old'],
  );
  // Renamed away, so a second boot cannot resurrect chats the user deleted since
  assert.equal(existsSync(legacy), false);
  assert.equal(existsSync(`${legacy}.migrated`), true);
  db.close();
});

test('a planner draft outlives the response that was supposed to carry it', () => {
  const config = tempConfig();
  const first = new Db(config);
  first.savePlanDraft('run-1', {
    name: 'refactor-auth',
    objective: 'Split the auth module',
    tasks: [
      { id: 'a', name: 'A', prompt: 'do a', dependsOn: [] },
      { id: 'b', name: 'B', prompt: 'do b', dependsOn: ['a'] },
    ],
  });
  first.close();

  // A new process: the run itself is gone (planner runs are internal), the plan is not
  const second = new Db(config);
  const stored = second.planDraft('run-1');
  assert.equal(stored?.name, 'refactor-auth');
  assert.equal(stored?.tasks.length, 2);
  assert.equal(second.planDraft('missing'), null);

  const listed = second.planDrafts();
  assert.deepEqual(
    listed.map((d) => [d.runId, d.taskCount, d.objective]),
    [['run-1', 2, 'Split the auth module']],
  );

  // Re-reading the same run replaces the row rather than duplicating it
  second.savePlanDraft('run-1', { name: 'refactor-auth', tasks: [{ id: 'a', name: 'A', prompt: 'do a', dependsOn: [] }] });
  assert.equal(second.planDrafts().length, 1);
  assert.equal(second.planDrafts()[0]?.taskCount, 1);
  second.close();
});

test('an internal chat survives a restart, because the planner is one', async () => {
  const config = tempConfig();
  const db = new Db(config);
  // What the orchestration planner looks like in the store: internal, but real paid work
  const planner = chat('planner', '2026-09-18T20:57:00Z');
  db.saveChats([{ ...planner, record: { ...planner.record, name: 'orchestration-planner', origin: 'internal' } }], 200);

  const manager = new ChatManager(config, db);
  await manager.restore(new SessionStore(config));
  const restored = manager.list();
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.name, 'orchestration-planner');
  assert.equal(restored[0]?.origin, 'internal');
  db.close();
});

test('an orchestration stored before a field existed still schedules', () => {
  const config = tempConfig();
  const db = new Db(config);
  // Exactly what was on disk: written before `worktree` and `allowedTools` were added
  db.saveOrchestrations([
    {
      id: 'old-1',
      name: 'legacy',
      objective: null,
      status: 'stopped',
      cwd: '/tmp',
      model: null,
      permissionMode: 'acceptEdits',
      concurrency: 3,
      synthesize: false,
      createdAt: '2026-09-18T21:21:39.941Z',
      endedAt: '2026-09-18T21:34:05.149Z',
      finalResult: null,
      costUsd: 1.71,
      tasks: [],
    } as unknown as Parameters<Db['saveOrchestrations']>[0][number],
  ]);

  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);
  const loaded = orchestrator.get('old-1');
  // Reading `.length` off an absent array threw inside launch(), where a bare catch swallowed it
  // and retried every three seconds for ever: the graph reported itself running with nothing running.
  assert.deepEqual(loaded?.allowedTools, []);
  assert.equal(loaded?.worktree, false);
  db.close();
});

test('what Claude loaded in a directory survives a restart', () => {
  const config = tempConfig();
  const first = new Db(config);
  first.saveEnvironment({
    cwd: '/work/app',
    observedAt: '2026-01-01T10:00:00Z',
    chatId: 'r1',
    cliVersion: '2.1.277',
    model: 'claude-opus-5',
    permissionMode: 'acceptEdits',
    outputStyle: null,
    tools: ['Bash', 'Edit'],
    mcpServers: [{ name: 'docs', status: 'connected' }],
    agents: [],
    skills: [],
    plugins: [],
    slashCommands: [],
    memoryPaths: {},
  } as unknown as Parameters<Db['saveEnvironment']>[0]);
  first.close();

  // The init event that carried this is gone after a restart, and the transcript never had it
  const loaded = new Db(config).loadEnvironments();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.cwd, '/work/app');
  assert.deepEqual(loaded[0]?.tools, ['Bash', 'Edit']);
});
