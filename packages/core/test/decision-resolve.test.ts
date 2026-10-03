import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import type { DecisionAnswer, DecisionPointId, DecisionRecord, ModelMapEntry } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { DecisionEngine } from '../src/decisions/engine.ts';
import { DecisionResolvers } from '../src/decisions/resolve.ts';
import { choiceOf, noulOf, scoreOf } from './decision-rig.ts';
import { tempConfig } from './helpers.ts';

// Shadow accuracy: each point's row gets its inferred outcome from the signal the app already writes,
// and the person's useful / not useful outranks it. The rows and the signals are written straight
// into the store; the resolvers only read.

const T0 = '2026-09-01T10:00:00.000Z';
const T1 = '2026-09-01T11:00:00.000Z';

function setup() {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const engine = new DecisionEngine({ settings: { get: () => ({ historyDays: 30 }) } as never, db, projectDecisions: () => null });
  let map: ModelMapEntry[] = [];
  const resolvers = new DecisionResolvers({ sql: db.connection, db, engine, historyDays: () => 30, modelMap: () => map, now: () => new Date('2026-09-02T00:00:00.000Z') });
  let n = 0;
  const row = (point: DecisionPointId, over: Partial<DecisionRecord> & { answers: Record<string, DecisionAnswer> | null }): DecisionRecord => {
    const record: DecisionRecord = {
      id: `d${String(++n)}`,
      point,
      kind: 'act',
      projectId: 'p1',
      subjectKind: 'flow_run',
      subjectId: null,
      provider: 'jev',
      model: 'jev-1',
      mode: 'shadow',
      status: 'answered',
      unavailable: null,
      state: {},
      questions: [],
      confidence: 0.9,
      threshold: 0.85,
      acted: false,
      visible: false,
      savedRun: false,
      latencyMs: 10,
      inputTokens: 1,
      costUsd: 0,
      outcome: null,
      agreed: null,
      resolvedAt: null,
      feedback: null,
      feedbackAt: null,
      openedAt: null,
      paletteAction: null,
      at: T0,
      ...over,
    };
    db.insertDecision(record);
    return record;
  };
  const run = (id: string, over: { item?: string; stage?: string; outcome?: string | null; endedAt?: string | null; chat?: string | null } = {}): void => {
    db.connection
      .prepare(
        `INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, chat_id, outcome, queued_at, ended_at)
         VALUES (?, 'p1', ?, 'qa', 'qa', 'm', ?, 'in_review', 'ended', ?, ?, ?, ?)`,
      )
      .run(id, over.item ?? 'i1', over.stage ?? 'verify', over.chat ?? null, over.outcome ?? 'passed', T0, over.endedAt === undefined ? T1 : over.endedAt);
  };
  const get = (id: string) => db.decision(id);
  const setMap = (entries: ModelMapEntry[]): void => {
    map = entries;
  };
  return { db, row, run, get, resolvers, setMap };
}

test('flow.bounce: fixable is right when the next QA run passes, wrong when it rejects again', () => {
  const s = setup();
  s.run('r1', { outcome: 'rejected', endedAt: T0 });
  const fixable = s.row('flow.bounce', { subjectId: 'r1', answers: { bounce: choiceOf('fixable') } });
  assert.equal(s.resolvers.sweep(), 0, 'no later QA run yet: nothing is known');
  assert.equal(s.get(fixable.id)?.agreed, null);
  s.run('r2', { outcome: 'rejected', endedAt: T1 });
  s.resolvers.sweep();
  assert.equal(s.get(fixable.id)?.agreed, false);
  assert.equal(s.get(fixable.id)?.outcome?.summary, 'The next QA run rejected it again');
  assert.ok(s.get(fixable.id)?.resolvedAt);
});

test('flow.bounce: needs-person is right when the card waited for a person', () => {
  const s = setup();
  s.run('r1', { outcome: 'rejected', endedAt: T0 });
  s.db.connection
    .prepare("INSERT INTO work_items (id, project_id, number, type, title, description, status, priority, rank, created_at, updated_at, waiting) VALUES ('i1', 'p1', 1, 'task', 't', '', 'in_progress', 'medium', 'a', ?, ?, 'bounces')")
    .run(T0, T0);
  const needs = s.row('flow.bounce', { subjectId: 'r1', answers: { bounce: choiceOf('needs-person') } });
  s.resolvers.sweep();
  assert.equal(s.get(needs.id)?.agreed, true);
});

test('flow.criteria-precheck: a clearly-unmet criterion is right when QA then rejects', () => {
  const s = setup();
  const unmet = s.row('flow.criteria-precheck', { subjectKind: 'work_item', subjectId: 'i1', answers: { c1: choiceOf('clearly-unmet'), c2: choiceOf('met-or-unknown') } });
  const clean = s.row('flow.criteria-precheck', { subjectKind: 'work_item', subjectId: 'i1', answers: { c1: choiceOf('met-or-unknown') } });
  s.run('r1', { outcome: 'rejected', endedAt: T1 });
  s.resolvers.sweep();
  assert.equal(s.get(unmet.id)?.agreed, true);
  assert.equal(s.get(clean.id)?.agreed, false, 'nothing unmet, yet QA rejected');
});

test('flow.restart: do-not-requeue is right when the requeued run failed again', () => {
  const s = setup();
  s.run('r1', { stage: 'work', outcome: 'failed', endedAt: T1 });
  const stop = s.row('flow.restart', { subjectId: 'r1', answers: { requeue: noulOf(false) } });
  s.resolvers.sweep();
  assert.equal(s.get(stop.id)?.agreed, true);
});

test('memory.triage: a high score is right when the proposal was approved, a duplicate when it was rejected', () => {
  const s = setup();
  const insert = (id: string, status: string): void => {
    s.db.connection
      .prepare("INSERT INTO memory_proposals (id, project_id, target_kind, text, reason, status, proposed_by_kind, created_at) VALUES (?, 'p1', 'journal', 'x', 'y', ?, 'agent', ?)")
      .run(id, status, T0);
  };
  insert('m1', 'approved');
  insert('m2', 'rejected');
  insert('m3', 'pending');
  const high = s.row('memory.triage', { kind: 'suggest', subjectKind: 'memory_proposal', subjectId: 'm1', answers: { usefulness: scoreOf('high') } });
  const dup = s.row('memory.triage', { kind: 'suggest', subjectKind: 'memory_proposal', subjectId: 'm2', answers: { usefulness: scoreOf('duplicate') } });
  const wrong = s.row('memory.triage', { kind: 'suggest', subjectKind: 'memory_proposal', subjectId: 'm2', answers: { usefulness: scoreOf('high') } });
  const open = s.row('memory.triage', { kind: 'suggest', subjectKind: 'memory_proposal', subjectId: 'm3', answers: { usefulness: scoreOf('low') } });
  assert.equal(s.resolvers.sweep(), 3);
  assert.equal(s.get(high.id)?.agreed, true);
  assert.equal(s.get(dup.id)?.agreed, true);
  assert.equal(s.get(wrong.id)?.agreed, false);
  assert.equal(s.get(open.id)?.resolvedAt, null, 'a pending proposal is not an outcome');
});

test('supervisor.intervene: needs-a-hint is right when the hint was sent, wrong when it was dismissed', () => {
  const s = setup();
  const proposal = (chat: string, status: string): void => {
    s.db.connection.prepare("INSERT INTO supervisor_proposals (id, chat_id, signal, hint, cost_usd, at, status) VALUES (?, ?, 'loop', 'h', 0, ?, ?)").run(`sp-${chat}`, chat, T0, status);
  };
  proposal('c1', 'sent');
  proposal('c2', 'dismissed');
  const sent = s.row('supervisor.intervene', { subjectKind: 'chat', subjectId: 'c1', state: { signal: 'loop' }, answers: { intervene: noulOf(true) } });
  const dismissed = s.row('supervisor.intervene', { subjectKind: 'chat', subjectId: 'c2', state: { signal: 'loop' }, answers: { intervene: noulOf(true) } });
  s.resolvers.sweep();
  assert.equal(s.get(sent.id)?.agreed, true);
  assert.equal(s.get(dismissed.id)?.agreed, false);
});

test('orchestration.retry: permanent is right when every retry failed', () => {
  const s = setup();
  const orch = { id: 'o1', status: 'failed', tasks: [{ id: 't1', status: 'failed', attempts: 2 }] };
  s.db.connection.prepare("INSERT INTO orchestrations (id, created_at, json) VALUES ('o1', ?, ?)").run(T0, JSON.stringify(orch));
  const permanent = s.row('orchestration.retry', { subjectKind: 'task', subjectId: 'o1:t1', state: { attempt: 'first attempt' }, answers: { retry: choiceOf('permanent') } });
  const transient = s.row('orchestration.retry', { subjectKind: 'task', subjectId: 'o1:t1', state: { attempt: 'first attempt' }, answers: { retry: choiceOf('transient') } });
  s.resolvers.sweep();
  assert.equal(s.get(permanent.id)?.agreed, true);
  assert.equal(s.get(transient.id)?.agreed, false);
});

test('assistant.rerank: agreement follows what the person accepted and discarded', () => {
  const s = setup();
  const insert = (id: string, status: string): void => {
    s.db.connection
      .prepare("INSERT INTO assistant_proposals (id, run_id, project_id, kind, status, position, reason, payload, created_at) VALUES (?, 'ar1', 'p1', 'resource', ?, 0, '', '{}', ?)")
      .run(id, status, T0);
  };
  insert('a1', 'accepted');
  insert('a2', 'discarded');
  const ranked = s.row('assistant.rerank', { kind: 'suggest', subjectKind: 'assistant_run', subjectId: 'ar1', answers: { a1: scoreOf('key'), a2: scoreOf('covered') } });
  s.resolvers.sweep();
  assert.equal(s.get(ranked.id)?.agreed, true);
  assert.deepEqual(s.get(ranked.id)?.outcome?.detail, { judged: 2, right: 2 });
});

test('flow.scope-drift: only a flagged commit is judged, by the QA verdict that follows', () => {
  const s = setup();
  const flag = s.row('flow.scope-drift', { kind: 'suggest', subjectKind: 'work_item', subjectId: 'i1', answers: { abc: noulOf(true) } });
  const quiet = s.row('flow.scope-drift', { kind: 'suggest', subjectKind: 'work_item', subjectId: 'i1', answers: { abc: noulOf(false) } });
  s.run('r1', { outcome: 'rejected', endedAt: T1 });
  s.resolvers.sweep();
  assert.equal(s.get(flag.id)?.agreed, true);
  assert.equal(s.get(quiet.id)?.resolvedAt, null);
});

test("the person's word outranks the inference, and the metric keeps both", () => {
  const s = setup();
  s.run('r1', { outcome: 'rejected', endedAt: T0 });
  const fixable = s.row('flow.bounce', { subjectId: 'r1', answers: { bounce: choiceOf('fixable') } });
  s.db.setDecisionFeedback(fixable.id, 'useful', T1);
  s.run('r2', { outcome: 'rejected', endedAt: T1 });
  s.resolvers.sweep();
  const done = s.get(fixable.id);
  assert.equal(done?.agreed, true, 'the feedback stays');
  assert.equal(done?.outcome?.agreed, false, 'the inference is still recorded');
});

test('rows that are unavailable, off the window, or resolved already are left alone', () => {
  const s = setup();
  s.run('r1', { outcome: 'rejected', endedAt: T0 });
  s.run('r2', { outcome: 'passed', endedAt: T1 });
  const unavailable = s.row('flow.bounce', { subjectId: 'r1', status: 'unavailable', unavailable: 'timeout', answers: null });
  const old = s.row('flow.bounce', { subjectId: 'r1', at: '2026-05-01T00:00:00.000Z', answers: { bounce: choiceOf('fixable') } });
  const first = s.row('flow.bounce', { subjectId: 'r1', answers: { bounce: choiceOf('fixable') } });
  assert.equal(s.resolvers.sweep(), 1);
  assert.equal(s.get(unavailable.id)?.resolvedAt, null);
  assert.equal(s.get(old.id)?.resolvedAt, null);
  assert.equal(s.get(first.id)?.agreed, true);
  assert.equal(s.resolvers.sweep(), 0, 'a resolved row is not resolved twice');
});

const action = (kind: 'proposed' | 'other' | 'dismissed', commandId: string | null) => ({ action: kind, commandId, at: T1 });
const commands = [{ id: 'go.home', title: 'Home' }, { id: 'chat.new', title: 'New chat' }];

test('palette.intent: a proposed command is right only when it ran, and waits for the person', () => {
  const s = setup();
  const answers = { command: choiceOf('go.home') };
  const waiting = s.row('palette.intent', { kind: 'suggest', subjectKind: 'palette', answers, state: { commands } });
  const ran = s.row('palette.intent', { kind: 'suggest', subjectKind: 'palette', answers, state: { commands }, paletteAction: action('proposed', 'go.home') });
  const other = s.row('palette.intent', { kind: 'suggest', subjectKind: 'palette', answers, state: { commands }, paletteAction: action('other', 'chat.new') });
  const dismissed = s.row('palette.intent', { kind: 'suggest', subjectKind: 'palette', answers, state: { commands }, paletteAction: action('dismissed', null) });
  assert.equal(s.resolvers.sweep(), 3);
  assert.equal(s.get(waiting.id)?.resolvedAt, null);
  assert.equal(s.get(ran.id)?.agreed, true);
  assert.equal(s.get(other.id)?.agreed, false);
  assert.equal(s.get(dismissed.id)?.agreed, false);
  assert.deepEqual(s.get(other.id)?.outcome?.detail, { action: 'other', commandId: 'chat.new' });
});

test('palette.intent: "none" is right when the palette was dismissed or ran a command it did not list', () => {
  const s = setup();
  const base = { kind: 'suggest' as const, subjectKind: 'palette' as const, answers: { command: choiceOf('none') }, state: { commands } };
  const dismissed = s.row('palette.intent', { ...base, paletteAction: action('dismissed', null) });
  const unlisted = s.row('palette.intent', { ...base, paletteAction: action('other', 'act:api-docs') });
  const listed = s.row('palette.intent', { ...base, paletteAction: action('other', 'chat.new') });
  s.resolvers.sweep();
  assert.equal(s.get(dismissed.id)?.agreed, true);
  assert.equal(s.get(unlisted.id)?.agreed, true);
  assert.equal(s.get(listed.id)?.agreed, false, 'a listed command ran where none was proposed');
});

test("palette.intent: the person's word outranks the inference", () => {
  const s = setup();
  const r = s.row('palette.intent', { kind: 'suggest', subjectKind: 'palette', answers: { command: choiceOf('go.home') }, state: { commands }, paletteAction: action('proposed', 'go.home') });
  s.db.setDecisionFeedback(r.id, 'not_useful', T1);
  s.resolvers.sweep();
  assert.equal(s.get(r.id)?.agreed, false);
  assert.equal(s.get(r.id)?.outcome?.agreed, true);
});

test('notification.urgency: only an open within the hour is a signal; a push nobody tapped says nothing', () => {
  const s = setup();
  const answers = (value: string) => ({ urgency: choiceOf(value) });
  const base = { kind: 'act' as const, subjectKind: 'notification' as const, subjectId: 'k' };
  const highOpened = s.row('notification.urgency', { ...base, answers: answers('high'), openedAt: '2026-09-01T10:20:00.000Z' });
  const normalOpened = s.row('notification.urgency', { ...base, answers: answers('normal'), openedAt: '2026-09-01T10:20:00.000Z' });
  const highIgnored = s.row('notification.urgency', { ...base, answers: answers('high') });
  const normalIgnored = s.row('notification.urgency', { ...base, answers: answers('normal') });
  const openedLate = s.row('notification.urgency', { ...base, answers: answers('high'), openedAt: '2026-09-01T12:30:00.000Z' });
  s.resolvers.sweep();
  assert.equal(s.get(highOpened.id)?.agreed, true);
  assert.equal(s.get(normalOpened.id)?.agreed, false);
  assert.equal(s.get(highIgnored.id)?.resolvedAt, null, 'ignored is no evidence, so it is not scored');
  assert.equal(s.get(normalIgnored.id)?.resolvedAt, null, 'ignored is no evidence, so it is not scored');
  assert.equal(s.get(openedLate.id)?.resolvedAt, null, 'an open after the window is not opened soon');
  assert.equal(s.get(highOpened.id)?.outcome?.detail?.withinMs, 20 * 60_000);
});

test('notification.urgency: before the hour ends with no open there is no outcome yet', () => {
  const s = setup();
  // The clock of this rig is 2026-09-02T00:00Z
  const recent = s.row('notification.urgency', { kind: 'act', subjectKind: 'notification', subjectId: 'k', answers: { urgency: choiceOf('normal') }, at: '2026-09-01T23:30:00.000Z' });
  assert.equal(s.resolvers.sweep(), 0);
  assert.equal(s.get(recent.id)?.resolvedAt, null);
  s.db.markNotificationOpened('k', '2026-09-01T23:40:00.000Z');
  s.resolvers.sweep();
  assert.equal(s.get(recent.id)?.agreed, false, 'a normal push opened in time was raised in effect');
});

function orchestration(s: ReturnType<typeof setup>, id: string, plannerRunId: string | null, tasks: Array<{ id: string; status: string; model?: string }>, model: string | null = 'sonnet', createdAt = T1): void {
  s.db.connection.prepare('INSERT INTO orchestrations (id, created_at, json) VALUES (?, ?, ?)').run(id, createdAt, JSON.stringify({ id, model, plannerRunId, tasks }));
}
const suggest = (s: ReturnType<typeof setup>, answers: Record<string, string>) =>
  s.row('orchestration.model', { kind: 'suggest', subjectKind: 'task', subjectId: 'plan1', answers: Object.fromEntries(Object.entries(answers).map(([task, model]) => [task, choiceOf(model)])) });

test('orchestration.model: waits for a launch from that planner run and for every task to settle', () => {
  const s = setup();
  const r = suggest(s, { a: 'sonnet' });
  assert.equal(s.resolvers.sweep(), 0, 'nothing launched from it yet');
  orchestration(s, 'o0', 'someone-else', [{ id: 'a', status: 'completed' }]);
  orchestration(s, 'o-early', 'plan1', [{ id: 'a', status: 'completed' }], 'sonnet', '2026-08-01T00:00:00.000Z');
  assert.equal(s.resolvers.sweep(), 0, 'another planner run, or one launched before the suggestion');
  orchestration(s, 'o1', 'plan1', [{ id: 'a', status: 'running' }]);
  assert.equal(s.resolvers.sweep(), 0);
  s.db.connection.prepare('UPDATE orchestrations SET json = ? WHERE id = ?').run(JSON.stringify({ id: 'o1', model: 'sonnet', plannerRunId: 'plan1', tasks: [{ id: 'a', status: 'completed' }] }), 'o1');
  s.resolvers.sweep();
  assert.equal(s.get(r.id)?.agreed, true);
});

test('orchestration.model: kept, stronger and weaker suggestions are judged by how the task ended', () => {
  const s = setup();
  const kept = suggest(s, { a: 'sonnet', b: 'sonnet' });
  orchestration(s, 'o1', 'plan1', [{ id: 'a', status: 'completed' }, { id: 'b', status: 'failed' }], 'sonnet');
  s.resolvers.sweep();
  const done = s.get(kept.id);
  assert.equal(done?.agreed, true, 'one right, one wrong is a majority tie');
  assert.deepEqual(done?.outcome?.detail, {
    judged: 2,
    right: 1,
    tasks: [
      { task: 'a', suggested: 'sonnet', launched: 'sonnet', kept: true, status: 'completed' },
      { task: 'b', suggested: 'sonnet', launched: 'sonnet', kept: true, status: 'failed' },
    ],
  });

  const s2 = setup();
  const stronger = suggest(s2, { a: 'claude-opus-4', b: 'claude-opus-4' });
  orchestration(s2, 'o1', 'plan1', [{ id: 'a', status: 'failed', model: 'haiku' }, { id: 'b', status: 'failed', model: 'haiku' }], 'sonnet');
  s2.resolvers.sweep();
  assert.equal(s2.get(stronger.id)?.agreed, true, 'a stronger model was suggested and the changed-down tasks failed');

  const strongerDone = suggest(s2, { c: 'opus' });
  orchestration(s2, 'o2', 'plan1', [{ id: 'c', status: 'completed', model: 'haiku' }], 'sonnet', '2026-09-01T12:00:00.000Z');
  s2.db.connection.prepare("UPDATE orchestrations SET json = json_set(json, '$.plannerRunId', 'plan2') WHERE id = 'o1'").run();
  s2.resolvers.sweep();
  assert.equal(s2.get(strongerDone.id)?.agreed, false, 'the weaker model completed, so the stronger one was not needed');

  const s3 = setup();
  const weaker = suggest(s3, { a: 'haiku', b: 'haiku' });
  orchestration(s3, 'o1', 'plan1', [{ id: 'a', status: 'completed', model: 'opus' }, { id: 'b', status: 'failed', model: 'opus' }], 'sonnet');
  s3.resolvers.sweep();
  const w = s3.get(weaker.id);
  assert.equal(w?.agreed, false, 'a weaker suggestion that failed is wrong; the one that completed is not judged');
  assert.equal(w?.outcome?.detail?.judged, 1);
});

test('orchestration.model: unranked ids that changed, skipped and stopped tasks judge nothing', () => {
  const s = setup();
  const r = suggest(s, { a: 'custom-x', b: 'sonnet', c: 'sonnet' });
  orchestration(s, 'o1', 'plan1', [{ id: 'a', status: 'completed', model: 'custom-y' }, { id: 'b', status: 'skipped' }, { id: 'c', status: 'stopped' }], 'sonnet');
  assert.equal(s.resolvers.sweep(), 0);
  assert.equal(s.get(r.id)?.resolvedAt, null);
});

// ---------- provider.on-limit, provider.pick, provider.model-map ----------

type Setup = ReturnType<typeof setup>;

const move = (s: Setup, over: { id: string; subjectKind: 'flow_run' | 'task' | 'assistant_run'; subjectId: string; decisionId: string | null; fromChat: string; toChat: string | null; to: 'codex' | null; action?: 'handoff' | 'restart' | 'wait'; state?: 'moved' | 'waiting' | 'resumed' }): void => {
  s.db.insertProviderMove({
    id: over.id, at: T0, subjectKind: over.subjectKind, subjectId: over.subjectId, projectId: 'p1', fromChat: over.fromChat, toChat: over.toChat,
    fromProvider: 'claude-code', toProvider: over.to, fromModel: 'sonnet', toModel: over.to ? 'gpt-5' : null, action: over.action ?? 'handoff',
    state: over.state ?? 'moved', decidedBy: 'decision', decisionId: over.decisionId, resetsAt: null, reason: null, updatedAt: T0,
  });
};
const chatCost = (s: Setup, chat: string, costs: number[]): void => {
  s.db.connection.prepare("INSERT INTO chats (id, created_at, json) VALUES (?, ?, '{}')").run(chat, T0);
  costs.forEach((costUsd, i) => s.db.connection.prepare('INSERT INTO executions (id, chat_id, started_at, json) VALUES (?, ?, ?, ?)').run(`${chat}-e${String(i)}`, chat, T0, JSON.stringify({ costUsd })));
};
const flowProvider = (s: Setup, id: string, provider: string | null): void => {
  s.db.connection.prepare('UPDATE flow_runs SET provider = ? WHERE id = ?').run(provider, id);
};

test('provider.on-limit: waits for the move row and for the work to end', () => {
  const s = setup();
  s.run('r1', { stage: 'work', outcome: 'passed' });
  const r = s.row('provider.on-limit', { subjectId: 'r1', answers: { action: choiceOf('handoff') } });
  assert.equal(s.resolvers.sweep(), 0, 'no move row carries this decision yet');
  move(s, { id: 'm1', subjectKind: 'flow_run', subjectId: 'r1', decisionId: r.id, fromChat: 'c1', toChat: 'c2', to: 'codex' });
  s.db.connection.prepare("UPDATE flow_runs SET state = 'running', outcome = NULL WHERE id = 'r1'").run();
  assert.equal(s.resolvers.sweep(), 0, 'the run is still going');
  assert.equal(s.get(r.id)?.agreed, null);
});

test('provider.on-limit: agreed when the run ended passed, with the cost on each provider of the chain', () => {
  const s = setup();
  s.run('r1', { stage: 'work', outcome: 'passed' });
  flowProvider(s, 'r1', 'codex');
  const r = s.row('provider.on-limit', { subjectId: 'r1', answers: { action: choiceOf('handoff') } });
  move(s, { id: 'm1', subjectKind: 'flow_run', subjectId: 'r1', decisionId: r.id, fromChat: 'c1', toChat: 'c2', to: 'codex' });
  chatCost(s, 'c1', [0.5, 0.25]);
  chatCost(s, 'c2', [1.5]);
  s.resolvers.sweep();
  const done = s.get(r.id);
  assert.equal(done?.agreed, true);
  assert.deepEqual(done?.outcome?.detail, {
    action: 'handoff',
    state: 'moved',
    chain: [
      { chat: 'c1', provider: 'claude-code', costUsd: 0.75 },
      { chat: 'c2', provider: 'codex', costUsd: 1.5 },
    ],
  });
});

test('provider.on-limit: not agreed when the run failed or QA rejected it; not judged when a person cancelled it', () => {
  const s = setup();
  s.run('failed', { stage: 'work', outcome: 'failed' });
  s.run('rejected', { stage: 'verify', outcome: 'rejected' });
  s.run('cancelled', { stage: 'work', outcome: 'cancelled' });
  const ids = ['failed', 'rejected', 'cancelled'].map((run, i) => {
    const r = s.row('provider.on-limit', { subjectId: run, answers: { action: choiceOf('restart') } });
    move(s, { id: `m${String(i)}`, subjectKind: 'flow_run', subjectId: run, decisionId: r.id, fromChat: `c${String(i)}`, toChat: null, to: null, action: 'restart' });
    return r.id;
  });
  s.resolvers.sweep();
  assert.equal(s.get(ids[0] ?? '')?.agreed, false);
  assert.equal(s.get(ids[1] ?? '')?.agreed, false);
  assert.equal(s.get(ids[2] ?? '')?.agreed, null);
  assert.equal(s.get(ids[2] ?? '')?.resolvedAt, null);
});

test('provider.on-limit: a wait that ended well agrees, and a task is judged by its status', () => {
  const s = setup();
  s.run('r1', { stage: 'work', outcome: 'passed' });
  const waited = s.row('provider.on-limit', { subjectId: 'r1', answers: { action: choiceOf('wait') } });
  move(s, { id: 'mw', subjectKind: 'flow_run', subjectId: 'r1', decisionId: waited.id, fromChat: 'c1', toChat: null, to: null, action: 'wait', state: 'resumed' });
  orchestration(s, 'o1', null, [{ id: 'a', status: 'completed' }, { id: 'b', status: 'failed' }, { id: 'c', status: 'stopped' }]);
  const tasks = ['a', 'b', 'c'].map((t) => {
    const r = s.row('provider.on-limit', { subjectKind: 'task', subjectId: `o1:${t}`, answers: { action: choiceOf('handoff') } });
    move(s, { id: `mt${t}`, subjectKind: 'task', subjectId: `o1:${t}`, decisionId: r.id, fromChat: `tc${t}`, toChat: `tn${t}`, to: 'codex' });
    return r.id;
  });
  s.resolvers.sweep();
  assert.equal(s.get(waited.id)?.agreed, true);
  assert.equal(s.get(waited.id)?.outcome?.detail?.action, 'wait');
  assert.equal(s.get(tasks[0] ?? '')?.agreed, true);
  assert.equal(s.get(tasks[1] ?? '')?.agreed, false);
  assert.equal(s.get(tasks[2] ?? '')?.agreed, null);
});

test('provider.on-limit: an assistant run is judged by its status', () => {
  const s = setup();
  s.db.connection
    .prepare("INSERT INTO assistant_runs (id, project_id, kind, status, model, proposes, base_sources, reads, started_at) VALUES ('ar1', 'p1', 'agents', 'completed', 'sonnet', '[]', '[]', '[]', ?)")
    .run(T0);
  const r = s.row('provider.on-limit', { subjectKind: 'assistant_run', subjectId: 'ar1', answers: { action: choiceOf('restart') } });
  move(s, { id: 'ma', subjectKind: 'assistant_run', subjectId: 'ar1', decisionId: r.id, fromChat: 'c1', toChat: 'c2', to: 'codex', action: 'restart' });
  s.resolvers.sweep();
  assert.equal(s.get(r.id)?.agreed, true);
});

test('provider.pick: agreed when the work ended on the provider chosen, wrong when it failed there', () => {
  const s = setup();
  s.run('ok', { stage: 'work', outcome: 'passed' });
  s.run('bad', { stage: 'work', outcome: 'failed' });
  flowProvider(s, 'ok', 'codex');
  flowProvider(s, 'bad', 'codex');
  const good = s.row('provider.pick', { subjectId: 'ok', answers: { provider: choiceOf('codex') } });
  const failed = s.row('provider.pick', { subjectId: 'bad', answers: { provider: choiceOf('codex') } });
  s.resolvers.sweep();
  assert.equal(s.get(good.id)?.agreed, true);
  assert.equal(s.get(failed.id)?.agreed, false);
});

test('provider.pick: a shadow pick that is not what ran is not judged, and one equal to the first is', () => {
  const s = setup();
  // A row with no provider ran on Claude Code
  s.run('r1', { stage: 'work', outcome: 'passed' });
  s.run('r2', { stage: 'work', outcome: 'passed' });
  const different = s.row('provider.pick', { subjectId: 'r1', answers: { provider: choiceOf('codex') } });
  const first = s.row('provider.pick', { subjectId: 'r2', answers: { provider: choiceOf('claude-code') } });
  s.resolvers.sweep();
  assert.equal(s.get(different.id)?.agreed, null, 'no counterfactual');
  assert.equal(s.get(first.id)?.agreed, true);
});

test('provider.pick: a task is judged on its own provider, and a run still going waits', () => {
  const s = setup();
  s.db.connection.prepare('INSERT INTO orchestrations (id, created_at, json) VALUES (?, ?, ?)').run('o1', T1, JSON.stringify({ id: 'o1', tasks: [{ id: 'a', status: 'completed', provider: 'codex' }, { id: 'b', status: 'running', provider: 'codex' }] }));
  const done = s.row('provider.pick', { subjectKind: 'task', subjectId: 'o1:a', answers: { provider: choiceOf('codex') } });
  const going = s.row('provider.pick', { subjectKind: 'task', subjectId: 'o1:b', answers: { provider: choiceOf('codex') } });
  s.resolvers.sweep();
  assert.equal(s.get(done.id)?.agreed, true);
  assert.equal(s.get(going.id)?.agreed, null);
});

const entry = (provider: 'codex' | 'copilot', model: string, from = 'sonnet'): ModelMapEntry => ({ from: { provider: 'claude-code', model: from }, to: { provider, model }, origin: 'decision', at: T1 });

test('provider.model-map: waits until the pair is mapped, then agrees with the accepted model and not with another', () => {
  const s = setup();
  const a = s.row('provider.model-map', { kind: 'suggest', subjectKind: 'model', subjectId: 'claude-code:sonnet→codex', answers: { counterpart: choiceOf('gpt-5') } });
  const b = s.row('provider.model-map', { kind: 'suggest', subjectKind: 'model', subjectId: 'claude-code:sonnet→copilot', answers: { counterpart: choiceOf('x') } });
  assert.equal(s.resolvers.sweep(), 0, 'the mapping is empty: nothing has been accepted or dismissed');
  s.setMap([entry('codex', 'gpt-5'), entry('copilot', 'y')]);
  s.resolvers.sweep();
  assert.equal(s.get(a.id)?.agreed, true);
  assert.equal(s.get(a.id)?.outcome?.summary, 'The person accepted the suggested model');
  assert.equal(s.get(b.id)?.agreed, false);
  assert.deepEqual(s.get(b.id)?.outcome?.detail, { suggested: 'x', mapped: 'y' });
});

test('provider.model-map: a model id with a colon belongs to the model', () => {
  const s = setup();
  const r = s.row('provider.model-map', { kind: 'suggest', subjectKind: 'model', subjectId: 'claude-code:sonnet:1m→codex', answers: { counterpart: choiceOf('gpt-5') } });
  s.setMap([entry('codex', 'gpt-5', 'sonnet:1m')]);
  s.resolvers.sweep();
  assert.equal(s.get(r.id)?.agreed, true);
});
