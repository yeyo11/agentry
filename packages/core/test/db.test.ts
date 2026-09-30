import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { DecisionRecord, Execution } from '@agentry/shared';
import type { LegacyRun, StoredChat } from '../src/chat-records.ts';
import { CHAT_PROVIDER_SCHEMA_VERSION, Db, DECISION_SIGNALS_SCHEMA_VERSION as MIGRATIONS_WITH_SIGNALS, migrate, WORK_ITEMS_SCHEMA_VERSION } from '../src/db.ts';
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

test('the labels table keeps no index nothing queries, on a new database or an upgraded one', () => {
  const indexes = (db: DatabaseSync) =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'work_item_labels' AND sql IS NOT NULL").all() as Array<{ name: string }>).map((i) => i.name);
  const fresh = new Db(tempConfig());
  assert.deepEqual(indexes(fresh.connection), []);
  fresh.close();

  const old = new DatabaseSync(':memory:');
  migrate(old, WORK_ITEMS_SCHEMA_VERSION);
  assert.deepEqual(indexes(old), ['work_item_labels_label']);
  migrate(old);
  assert.deepEqual(indexes(old), []);
  old.close();
});

test('chats stored before the provider column read as claude-code after the migration', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw, CHAT_PROVIDER_SCHEMA_VERSION - 1);
  const old = chat('old', '2026-09-18T10:00:00Z');
  raw.prepare('INSERT INTO chats (id, created_at, json) VALUES (?, ?, ?)').run('old', old.record.createdAt, JSON.stringify(old.record));
  migrate(raw);
  const row = raw.prepare('SELECT provider FROM chats WHERE id = ?').get('old') as { provider: string };
  assert.equal(row.provider, 'claude-code');
  // A process still on the old schema writes no column, and SQLite fills the default
  raw.prepare('INSERT INTO chats (id, created_at, json) VALUES (?, ?, ?)').run('older-writer', old.record.createdAt, JSON.stringify(old.record));
  assert.equal((raw.prepare('SELECT provider FROM chats WHERE id = ?').get('older-writer') as { provider: string }).provider, 'claude-code');
  raw.close();
});

test('the provider column is the truth for a chat, and a record without one is claude-code', () => {
  const db = new Db(tempConfig());
  const other = chat('other', '2026-09-18T11:00:00Z');
  other.record.provider = 'codex';
  db.saveChats([chat('plain', '2026-09-18T10:00:00Z'), other], null);
  const byId = new Map(db.loadChats().map((c) => [c.record.id, c.record.provider]));
  assert.equal(byId.get('plain'), 'claude-code');
  assert.equal(byId.get('other'), 'codex');
  // Changed in the column alone, the JSON copy follows it
  db.connection.prepare("UPDATE chats SET provider = 'claude-code' WHERE id = 'other'").run();
  assert.equal(db.loadChats().find((c) => c.record.id === 'other')?.record.provider, 'claude-code');
  db.close();
});

test('two processes upgrading an old database at once never run a migration twice', async () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  // A database as the release before the work items left it, so several migrations are pending
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec('PRAGMA journal_mode = WAL');
  migrate(raw, WORK_ITEMS_SCHEMA_VERSION - 1);
  // This process takes the write lock first, and keeps it until the other one is waiting on it
  raw.exec('BEGIN IMMEDIATE');
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'db-opener.ts');
  const child = spawn(process.execPath, [...process.execArgv, fixture, dirname(config.dataDir)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  await new Promise<void>((resolve) => child.stdout.on('data', () => resolve()));
  await new Promise((r) => setTimeout(r, 400));
  raw.exec('COMMIT');
  migrate(raw);

  assert.equal(await exited, 0, stderr);
  const version = raw.prepare('PRAGMA user_version').get() as { user_version: number };
  const fresh = new Db({ ...config });
  assert.equal(fresh.connection.prepare('PRAGMA user_version').get()?.user_version, version.user_version);
  fresh.close();
  raw.close();
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

test('a save of only what changed keeps the executions it leaves out, and trims nothing unless asked', () => {
  const db = new Db(tempConfig());
  db.saveChats([chat('a', '2026-09-18T10:00:00Z', [execution('a-1', '2026-09-18T10:00:00Z')]), chat('b', '2026-09-18T11:00:00Z')], 200);
  db.saveChats([chat('a', '2026-09-18T10:00:00Z', [execution('a-2', '2026-09-18T10:30:00Z')])], null);
  assert.deepEqual(db.loadChats().find((c) => c.record.id === 'a')?.executions.map((e) => e.id), ['a-1', 'a-2']);
  db.saveChats([chat('c', '2026-09-18T12:00:00Z')], null);
  assert.equal(db.loadChats().length, 3);
  db.saveChats([chat('d', '2026-09-18T13:00:00Z')], 3);
  assert.deepEqual([...db.storedChats(['a', 'b', 'c', 'd'])].sort(), ['b', 'c', 'd']);
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

function decisionRow(id: string, over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id,
    point: 'run.continuation',
    kind: 'act',
    projectId: 'p1',
    subjectKind: 'flow_run',
    subjectId: 'r1',
    provider: 'jev',
    model: 'jev-1.13.0',
    mode: 'active',
    status: 'answered',
    unavailable: null,
    state: { open: 2 },
    questions: [],
    answers: null,
    confidence: 0.9,
    threshold: 0.85,
    acted: true,
    visible: false,
    savedRun: true,
    latencyMs: 120,
    inputTokens: 40,
    costUsd: 0.01,
    outcome: null,
    agreed: null,
    resolvedAt: null,
    feedback: null,
    feedbackAt: null,
    openedAt: null,
    paletteAction: null,
    at: at(1),
    ...over,
  };
}

test('decisions round-trip, resolve once, and let feedback outrank the inference', () => {
  const db = new Db(tempConfig());
  db.insertDecision(decisionRow('d1'));
  assert.deepEqual(db.decision('d1'), decisionRow('d1'));

  assert.equal(db.resolveDecision('d1', { summary: 'ran', agreed: true }, at(2)), true);
  assert.equal(db.resolveDecision('d1', { summary: 'again', agreed: false }, at(3)), false);
  assert.equal(db.decision('d1')?.agreed, true);
  assert.equal(db.decision('d1')?.outcome?.summary, 'ran');

  assert.equal(db.setDecisionFeedback('d1', 'not_useful', at(4)), true);
  assert.equal(db.decision('d1')?.agreed, false);
  assert.equal(db.setDecisionFeedback('nope', 'useful', at(4)), false);

  db.insertDecision(decisionRow('d2'));
  db.setDecisionFeedback('d2', 'useful', at(5));
  db.resolveDecision('d2', { summary: 'x', agreed: false }, at(6));
  assert.equal(db.decision('d2')?.agreed, true);
  // The person's word is a resolution too, so the stats count the row as resolved
  assert.equal(db.decision('d2')?.resolvedAt, at(5));
  assert.equal(db.decision('d1')?.resolvedAt, at(2));
  db.close();
});

test('an older database migrates with the decisions signals empty, and a new row keeps them', () => {
  const version = MIGRATIONS_WITH_SIGNALS;
  const old = new DatabaseSync(':memory:');
  migrate(old, version - 1);
  old.exec(
    `INSERT INTO decisions (id, point, kind, subject_kind, provider, model, mode, status, state, questions, acted, visible, saved_run, latency_ms, at)
     VALUES ('old', 'palette.intent', 'suggest', 'palette', 'jev', 'm', 'shadow', 'answered', '{}', '[]', 0, 0, 0, 1, '2026-01-01T00:00:00.000Z')`,
  );
  migrate(old);
  const columns = (old.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(columns.includes('opened_at') && columns.includes('palette_action'));
  const row = old.prepare('SELECT opened_at, palette_action FROM decisions WHERE id = ?').get('old');
  assert.deepEqual({ ...row }, { opened_at: null, palette_action: null });
  old.close();
});

test('the palette action classifies against the answer and the first report stands', () => {
  const db = new Db(tempConfig());
  const answered = (id: string) => decisionRow(id, { point: 'palette.intent', subjectKind: 'palette', subjectId: null, answers: { command: { kind: 'choice', value: 'go.home', probabilities: null, confidence: 1 } } });
  for (const id of ['a', 'b', 'c']) db.insertDecision(answered(id));
  assert.equal(db.setDecisionPaletteAction('a', 'go.home', at(2))?.paletteAction?.action, 'proposed');
  assert.equal(db.setDecisionPaletteAction('b', 'chat.new', at(2))?.paletteAction?.action, 'other');
  assert.deepEqual(db.setDecisionPaletteAction('c', null, at(2))?.paletteAction, { action: 'dismissed', commandId: null, at: at(2) });
  assert.equal(db.setDecisionPaletteAction('a', null, at(3))?.paletteAction?.action, 'proposed');
  assert.equal(db.setDecisionPaletteAction('nope', null, at(3)), null);
  db.close();
});

test('a notification open marks the newest row for its key once', () => {
  const db = new Db(tempConfig());
  const push = (id: string, when: number) => decisionRow(id, { point: 'notification.urgency', subjectKind: 'notification', subjectId: 'k1', at: at(when) });
  db.insertDecision(push('n1', 1));
  db.insertDecision(push('n2', 2));
  assert.equal(db.markNotificationOpened('k1', at(5)), 'n2');
  assert.equal(db.markNotificationOpened('k1', at(9)), 'n2');
  assert.equal(db.decision('n2')?.openedAt, at(5));
  assert.equal(db.decision('n1')?.openedAt, null);
  assert.equal(db.markNotificationOpened('other', at(9)), null);
  db.close();
});

test('decisions page newest first, filter, and report stats', () => {
  const db = new Db(tempConfig());
  db.insertDecision(decisionRow('a', { at: at(1) }));
  db.insertDecision(decisionRow('b', { at: at(2), provider: 'cli', model: 'haiku', confidence: null, acted: false, costUsd: 0.02, projectId: null }));
  db.insertDecision(decisionRow('c', { at: at(3), projectId: null, point: 'palette.intent', status: 'unavailable', unavailable: 'timeout', confidence: null, acted: false, savedRun: false, costUsd: null }));

  const first = db.listDecisions({ limit: 2 });
  assert.deepEqual(first.items.map((d) => d.id), ['c', 'b']);
  assert.ok(first.nextCursor);
  const second = db.listDecisions({ limit: 2, ...(first.nextCursor ? { cursor: first.nextCursor } : {}) });
  assert.deepEqual(second.items.map((d) => d.id), ['a']);
  assert.equal(second.nextCursor, null);

  assert.deepEqual(db.listDecisions({ provider: 'cli' }).items.map((d) => d.id), ['b']);
  assert.deepEqual(db.listDecisions({ point: 'palette.intent', status: 'unavailable' }).items.map((d) => d.id), ['c']);
  assert.deepEqual(db.listDecisions({ since: at(2), until: at(2) }).items.map((d) => d.id), ['b']);
  assert.deepEqual(db.listDecisions({ projectId: 'p1' }).items.map((d) => d.id), ['a']);
  db.insertDecision(decisionRow('s', { at: at(4), subjectKind: 'work_item', subjectId: 'w1', visible: true }));
  assert.deepEqual(db.listDecisions({ subjectKind: 'work_item', subjectId: 'w1', visible: true }).items.map((d) => d.id), ['s']);
  assert.deepEqual(db.listDecisions({ subjectId: 'w1', visible: true }).items.length, 1);
  db.deleteDecision('s');

  const stats = db.decisionStats(at(0));
  const run = stats.points.find((p) => p.point === 'run.continuation');
  assert.equal(run?.count, 2);
  assert.equal(run?.acted, 1);
  assert.equal(run?.runsSaved, 1);
  assert.equal(run?.meanConfidence, 0.9);
  assert.equal(stats.points.find((p) => p.point === 'palette.intent')?.unavailable, 1);
  assert.equal(stats.claudeRunsSaved, 1);
  assert.equal(stats.jevCostUsd, 0.01);
  assert.equal(db.decisionStats(at(3)).points.length, 1);
  db.close();
});

test('decisions delete one, clear a filtered set, and prune by age', () => {
  const db = new Db(tempConfig());
  db.insertDecision(decisionRow('a', { at: at(1) }));
  db.insertDecision(decisionRow('b', { at: at(2), provider: 'cli' }));
  db.insertDecision(decisionRow('c', { at: at(3) }));
  assert.equal(db.deleteDecision('a'), true);
  assert.equal(db.deleteDecision('a'), false);
  assert.equal(db.clearDecisions({ provider: 'cli' }), 1);
  assert.equal(db.pruneDecisions(at(3)), 0);
  assert.equal(db.pruneDecisions(at(4)), 1);
  db.insertDecision(decisionRow('d'));
  assert.equal(db.clearDecisions(), 1);
  assert.equal(db.listDecisions().items.length, 0);
  db.close();
});
