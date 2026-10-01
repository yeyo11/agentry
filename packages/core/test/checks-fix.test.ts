import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import test, { after } from 'node:test';
import type { ChangeRequestChecks, Check, DecisionAnswer, DecisionRecord, WorkItem } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { ChecksFix } from '../src/decisions/checks-fix.ts';
import { DecisionEngine } from '../src/decisions/engine.ts';
import { DecisionResolvers } from '../src/decisions/resolve.ts';
import type { FlowProject } from '../src/flow.ts';
import { defaultProjectSettings, parseProjectSettings } from '../src/project-settings.ts';
import type { ChecksFailingNotice } from '../src/pull-requests.ts';
import { choiceOf, decisionRig } from './decision-rig.ts';
import { tempConfig } from './helpers.ts';

// `checks.fix` over the real engine and store; the provider is scripted and the fix flow is a stub
// that counts what it was asked. Off asks nothing, shadow asks and starts nothing, active above the
// threshold starts one fix and never a second for the same head, and the limits hold.

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const check = (id: string, name: string): Check => ({
  id,
  name,
  group: 'ci',
  state: 'failed',
  allowedToFail: false,
  required: false,
  startedAt: null,
  finishedAt: null,
  url: null,
  rerunnable: true,
  hasLog: true,
  source: 'actions',
});

const FLOW = { enabled: true, columns: {}, maxBounces: 1 };
const NOTICE: ChecksFailingNotice = { kind: 'work-item', id: 'cr1', ownerId: 'i1', headSha: 'aaa', attempts: 0 };

function setup(flow: Record<string, unknown> = FLOW) {
  const config = tempConfig();
  roots.push(dirname(config.dataDir));
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const rig = decisionRig(db, config);
  const calls: string[] = [];
  const state = { attempts: 0 };
  const list: ChangeRequestChecks = { headSha: 'aaa', rollup: 'failing', checks: [check('1', 'unit'), check('2', 'lint')], truncated: false, checkedAt: '2026-10-01T00:00:00.000Z' };
  const handler = new ChecksFix({
    decisions: rig.engine,
    sql: db.connection,
    checks: { list: () => Promise.resolve(list), log: (_id, checkId) => Promise.resolve({ lines: [`FAIL ${checkId}`, 'x'.repeat(5000)], truncated: false, noOutputYet: false, annotations: [] }) },
    pullRequests: {
      fixChecks: (itemId) => {
        calls.push(itemId);
        state.attempts++;
        return Promise.resolve({} as never);
      },
      fixAttemptsFor: () => state.attempts,
    },
    item: (id) => (id === 'i1' ? ({ id: 'i1', projectId: 'p1', worktree: null } as WorkItem) : null),
    project: () => ({ path: '/p', settings: { flow } }) as unknown as FlowProject,
  });
  const run = async (notice = NOTICE) => {
    handler.onChecksFailing(notice);
    await handler.idle();
  };
  return { db, rig, calls, state, handler, run };
}

const fixable = (confidence: number | null = 0.95, value = 'branch-fixable') => () => ({ fix: choiceOf(value, confidence) });

test('checks.fix off: nobody is asked and nothing starts', async () => {
  const s = setup();
  s.rig.provider.script = fixable();
  await s.run();
  assert.equal(s.rig.provider.calls.length, 0);
  assert.equal(s.calls.length, 0);
});

test('checks.fix shadow: the row is recorded and nothing starts', async () => {
  const s = setup();
  s.rig.provider.script = fixable();
  await s.rig.configure('checks.fix', 'shadow');
  await s.run();
  const rows = await s.rig.rowsAfter('checks.fix', 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.subjectKind, 'work_item');
  assert.equal(s.calls.length, 0);
});

test('checks.fix active: the question carries the failing checks with their tails cut to 2 KiB', async () => {
  const s = setup();
  s.rig.provider.script = fixable();
  await s.rig.configure('checks.fix', 'active');
  await s.run();
  const state = s.rig.provider.calls[0]?.state as { checks: Array<{ name: string; conclusion: string; tail: string }>; attempt: string; headSha: string };
  assert.deepEqual(state.checks.map((c) => c.name), ['unit', 'lint']);
  assert.ok(state.checks.every((c) => c.conclusion === 'failed' && Buffer.byteLength(c.tail) <= 2048));
  assert.equal(state.attempt, 'fix attempt 1 for this head');
  assert.equal(state.headSha, 'aaa');
});

test('checks.fix active above the threshold starts one fix as the decision, and never a second for the same head', async () => {
  const s = setup();
  s.rig.provider.script = fixable();
  await s.rig.configure('checks.fix', 'active');
  await s.run();
  await s.run();
  assert.deepEqual(s.calls, ['i1']);
  assert.equal(s.rig.provider.calls.length, 1);
  // A new head is asked about again, within the attempt limit
  await s.run({ ...NOTICE, headSha: 'bbb', attempts: 0 });
  assert.equal(s.rig.provider.calls.length, 2);
});

test('checks.fix active: below the threshold, or not branch-fixable, starts nothing', async () => {
  const low = setup();
  low.rig.provider.script = fixable(0.5);
  await low.rig.configure('checks.fix', 'active');
  await low.run();
  assert.equal(low.calls.length, 0);
  const flake = setup();
  flake.rig.provider.script = fixable(0.99, 'not-branch');
  await flake.rig.configure('checks.fix', 'active');
  await flake.run();
  assert.equal(flake.calls.length, 0);
  const person = setup();
  person.rig.provider.script = fixable(0.99, 'needs-person');
  await person.rig.configure('checks.fix', 'active');
  await person.run();
  assert.equal(person.calls.length, 0);
});

test('checks.fix with the provider down starts nothing', async () => {
  const s = setup();
  s.rig.provider.up = false;
  await s.rig.configure('checks.fix', 'active');
  await s.run();
  assert.equal(s.calls.length, 0);
});

test("checks.fix limits: the project's attempts, the flow's parallel runs and a spent budget", async () => {
  const attempts = setup({ ...FLOW, checksFixAttempts: 1 });
  attempts.rig.provider.script = fixable();
  await attempts.rig.configure('checks.fix', 'active');
  attempts.state.attempts = 1;
  await attempts.run();
  assert.equal(attempts.rig.provider.calls.length, 0, 'spent attempts ask nothing');

  const busy = setup({ ...FLOW, maxParallel: 1 });
  busy.rig.provider.script = fixable();
  await busy.rig.configure('checks.fix', 'active');
  const insert = (s: ReturnType<typeof setup>, state: string, cause: string | null) =>
    s.db.connection
      .prepare("INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, cause, queued_at) VALUES (?, 'p1', 'i1', 'dev', 'dev', 'm', 'work', 'in_progress', ?, ?, '2026-10-01T00:00:00.000Z')")
      .run(`r-${state}-${String(cause)}`, state, cause);
  insert(busy, 'running', null);
  await busy.run();
  assert.equal(busy.calls.length, 0, 'no place in the parallel runs');

  const spent = setup();
  spent.rig.provider.script = fixable();
  await spent.rig.configure('checks.fix', 'active');
  insert(spent, 'ended', 'budget');
  await spent.run();
  assert.equal(spent.calls.length, 0, 'the last run reached its budget');
});

test('checks.fix ignores an orchestration and a project without the flow', async () => {
  const s = setup();
  s.rig.provider.script = fixable();
  await s.rig.configure('checks.fix', 'active');
  await s.run({ ...NOTICE, kind: 'orchestration', ownerId: 'o1' });
  assert.equal(s.rig.provider.calls.length, 0);
  const off = setup({ ...FLOW, enabled: false });
  off.rig.provider.script = fixable();
  await off.rig.configure('checks.fix', 'active');
  await off.run();
  assert.equal(off.rig.provider.calls.length, 0);
});

test('flow.checksFixAttempts is read from the project settings and kept to 1 through 5', () => {
  const base = defaultProjectSettings('AGN');
  const parse = (n: unknown) => parseProjectSettings({ ...base, flow: { ...FLOW, checksFixAttempts: n } }).flow?.checksFixAttempts;
  assert.equal(parse(3), 3);
  assert.equal(parse(undefined), undefined);
  assert.throws(() => parse(0), /checksFixAttempts/);
  assert.throws(() => parse(6), /checksFixAttempts/);
  assert.throws(() => parse(1.5), /checksFixAttempts/);
});

// ---------- shadow accuracy ----------

test('checks.fix resolves against the head the rollup reads after the failing one', () => {
  const config = tempConfig();
  roots.push(dirname(config.dataDir));
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const engine = new DecisionEngine({ settings: { get: () => ({ historyDays: 30 }) } as never, db, projectDecisions: () => null });
  const resolvers = new DecisionResolvers({ sql: db.connection, db, engine, historyDays: () => 30, now: () => new Date('2026-10-02T00:00:00.000Z') });
  const T = '2026-10-01T10:00:00.000Z';
  db.connection.prepare("INSERT INTO work_items (id, project_id, number, type, title, description, status, priority, rank, created_at, updated_at) VALUES ('i1', 'p1', 1, 'task', 't', '', 'in_review', 'medium', 'a', ?, ?)").run(T, T);
  db.connection
    .prepare("INSERT INTO work_item_pull_requests (id, item_id, project_id, phase, number, branch, base, approved_at, created_at, updated_at) VALUES ('cr1', 'i1', 'p1', 'open', 7, 'task/AGN-1', 'main', ?, ?, ?)")
    .run(T, T, T);
  const snapshot = (head: string, rollup: string) =>
    db.connection.prepare('INSERT OR REPLACE INTO change_request_snapshots (cr_id, kind, head_sha, checks, rollup, fetched_at) VALUES (?, ?, ?, ?, ?, ?)').run('cr1', 'work-item', head, '[]', rollup, T);
  let n = 0;
  const row = (value: string): DecisionRecord => {
    const answers: Record<string, DecisionAnswer> = { fix: choiceOf(value) };
    const record = { id: `d${String(++n)}`, point: 'checks.fix', kind: 'act', projectId: 'p1', subjectKind: 'work_item', subjectId: 'i1', provider: 'jev', model: 'm', mode: 'shadow', status: 'answered', unavailable: null, state: { headSha: 'aaa' }, questions: [], answers, confidence: 0.9, threshold: 0.85, acted: false, visible: false, savedRun: false, latencyMs: 1, inputTokens: 1, costUsd: 0, outcome: null, agreed: null, resolvedAt: null, feedback: null, feedbackAt: null, openedAt: null, paletteAction: null, at: T } as DecisionRecord;
    db.insertDecision(record);
    return record;
  };
  const fixableRow = row('branch-fixable');
  const flakeRow = row('not-branch');
  snapshot('aaa', 'failing');
  assert.equal(resolvers.sweep(), 0, 'still failing: nothing is known');
  snapshot('bbb', 'pending');
  assert.equal(resolvers.sweep(), 0, 'a new head still running: nothing is known');
  snapshot('bbb', 'passing');
  resolvers.sweep();
  assert.equal(db.decision(fixableRow.id)?.agreed, true);
  assert.equal(db.decision(flakeRow.id)?.agreed, false);
});
