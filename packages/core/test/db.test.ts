import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { RunSummary } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { RunManager } from '../src/runner.ts';
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

const run = (id: string, createdAt: string): RunSummary =>
  ({
    id,
    name: id,
    sessionId: null,
    cwd: '/tmp',
    model: null,
    permissionMode: 'plan',
    status: 'completed',
    pid: null,
    createdAt,
    updatedAt: createdAt,
    endedAt: createdAt,
    turns: 1,
    costUsd: 0,
    prompt: 'hi',
    lastText: 'ok',
    error: null,
    orchestrationId: null,
    orchestrationTaskId: null,
    internal: false,
    account: null,
    backgroundTasks: [],
    subagents: [],
  }) as unknown as RunSummary;

test('runs round-trip, newest first, and the cap drops the oldest', () => {
  const db = new Db(tempConfig());
  db.saveRuns([run('a', '2026-09-18T10:00:00Z'), run('b', '2026-09-18T11:00:00Z')], 200);
  assert.deepEqual(
    db.loadRuns().map((r) => r.id),
    ['b', 'a'],
  );

  db.saveRuns([run('c', '2026-09-18T12:00:00Z')], 2);
  assert.deepEqual(
    db.loadRuns().map((r) => r.id),
    ['c', 'b'],
  );

  db.deleteRun('c');
  assert.deepEqual(
    db.loadRuns().map((r) => r.id),
    ['b'],
  );
  db.close();
});

test('a save never drops the runs another process owns', () => {
  const config = tempConfig();
  const a = new Db(config);
  const b = new Db(config);
  a.saveRuns([run('from-a', '2026-09-18T10:00:00Z')], 200);
  // b knows nothing about a's run — the old whole-file write erased it here
  b.saveRuns([run('from-b', '2026-09-18T11:00:00Z')], 200);
  assert.deepEqual(
    a.loadRuns().map((r) => r.id),
    ['from-b', 'from-a'],
  );
  a.close();
  b.close();
});

test('a pre-SQLite runs.json is carried into the store once', async () => {
  const config = tempConfig();
  const legacy = join(config.dataDir, 'runs.json');
  writeFileSync(legacy, JSON.stringify([run('old', '2026-09-18T09:00:00Z')]));

  const db = new Db(config);
  const manager = new RunManager(config, db);
  await manager.restore(new SessionStore(config));

  assert.deepEqual(
    manager.list().map((r) => r.id),
    ['old'],
  );
  assert.deepEqual(
    db.loadRuns().map((r) => r.id),
    ['old'],
  );
  // Renamed away, so a second boot cannot resurrect runs the user deleted since
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
