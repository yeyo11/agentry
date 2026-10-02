import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import type { DecisionPointId } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { decisionPoint } from '../src/decisions/points.ts';
import { ProviderPoints, modelMapSubjectId, type OnLimitSubject, type PickSubject } from '../src/decisions/provider-points.ts';
import { stanceOf } from '../src/decisions/stance.ts';
import { choiceOf, decisionRig } from './decision-rig.ts';
import { tempConfig } from './helpers.ts';

// The call sites of provider.on-limit, provider.pick and provider.model-map. Each owes the four tests
// of every point (off asks nothing, shadow records and the setting decides, active acts above its
// threshold, an unavailable provider is the setting at once), and the options never leave what the
// person allowed.

async function rig(point: DecisionPointId, mode: 'off' | 'shadow' | 'active', threshold = 0.85) {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const r = decisionRig(db, config);
  await r.configure(point, mode, threshold);
  let now = Date.parse('2026-10-02T10:00:00.000Z');
  const points = new ProviderPoints({ decisions: r.engine, sql: db.connection, now: () => now });
  const stance = (): 'off' | 'watch' | 'wait' => stanceOf(r.engine, point, null);
  return { ...r, db, points, stance, advance: (ms: number) => (now += ms) };
}

const cand = (id: 'codex' | 'copilot', utilization = 20) => ({ id, label: id === 'codex' ? 'Codex' : 'Copilot', model: `${id}-model`, utilization, resetsInMin: null });

const limit = (over: Partial<OnLimitSubject> = {}): OnLimitSubject => ({
  kind: 'flow_run',
  id: 'run-1',
  projectId: 'p1',
  chatId: 'chat-1',
  work: { kind: 'flow-run', name: 'work' },
  progress: { checklistDone: 3, checklistTotal: 4, filesChanged: 5, turns: 12, minutes: 20 },
  from: { provider: 'claude-code', model: 'sonnet', resetsInMin: 90 },
  candidates: [cand('codex')],
  allowed: ['handoff', 'restart', 'wait'],
  ...over,
});

const pickSubject = (over: Partial<PickSubject> = {}): PickSubject => ({
  kind: 'task',
  id: 'o1:t1',
  projectId: 'p1',
  work: { kind: 'task', name: 't1' },
  title: 'Write the parser',
  model: 'sonnet',
  candidates: [cand('codex'), cand('copilot', 55)],
  ...over,
});

// ---------- provider.on-limit ----------

test('provider.on-limit: off asks nothing and the setting decides', async () => {
  const r = await rig('provider.on-limit', 'off');
  assert.equal(r.stance(), 'off');
  assert.equal(await r.points.onLimit(r.stance(), limit()), null);
  assert.equal(r.provider.calls.length, 0);
  assert.equal(r.rows('provider.on-limit').length, 0);
});

test('provider.on-limit: shadow records a row in the background and the setting decides', async () => {
  const r = await rig('provider.on-limit', 'shadow');
  r.provider.script = () => ({ action: choiceOf('restart') });
  assert.equal(r.stance(), 'watch');
  assert.equal(await r.points.onLimit(r.stance(), limit()), null, 'a shadow answer never reaches the caller');
  await r.points.idle();
  const [row] = await r.rowsAfter('provider.on-limit', 1);
  assert.equal(row?.mode, 'shadow');
  assert.equal(row?.subjectKind, 'flow_run');
  assert.equal(row?.subjectId, 'run-1');
  assert.equal(row?.acted, false);
});

test('provider.on-limit: active acts above the threshold only', async () => {
  const r = await rig('provider.on-limit', 'active');
  r.provider.script = () => ({ action: choiceOf('restart', 0.95) });
  const done = await r.points.onLimit(r.stance(), limit());
  assert.equal(done?.action, 'restart');
  assert.equal(done?.decisionId, r.rows('provider.on-limit')[0]?.id);

  const low = await rig('provider.on-limit', 'active');
  low.provider.script = () => ({ action: choiceOf('restart', 0.4) });
  assert.equal(await low.points.onLimit(low.stance(), limit()), null, 'below the threshold the setting stays');
});

test('provider.on-limit: an unavailable provider leaves the setting at once', async () => {
  const r = await rig('provider.on-limit', 'active');
  r.provider.script = () => ({ status: 'unavailable', reason: 'no-quota', latencyMs: 1 });
  assert.equal(await r.points.onLimit(r.stance(), limit()), null);
  assert.equal(r.rows('provider.on-limit')[0]?.status, 'unavailable');
});

test('provider.on-limit: the options are the feasible allowed actions, in order, and one option is not a question', async () => {
  const r = await rig('provider.on-limit', 'active');
  r.provider.script = () => ({ action: choiceOf('wait') });
  await r.points.onLimit(r.stance(), limit({ chatId: 'a', allowed: ['wait', 'handoff'] }));
  const question = r.provider.calls[0]?.questions[0];
  assert.equal(question?.kind, 'choice');
  assert.deepEqual(question?.kind === 'choice' ? question.options.map((o) => o.id) : [], ['handoff', 'wait']);
  const state = r.provider.calls[0]?.state as { allowed: string[] };
  assert.deepEqual(state.allowed, ['handoff', 'wait']);

  const before = r.provider.calls.length;
  assert.equal(await r.points.onLimit(r.stance(), limit({ chatId: 'b', allowed: ['wait'] })), null);
  assert.equal(r.provider.calls.length, before, 'a single feasible action is the floor, not a question');
});

test('provider.on-limit: one limit hit is one answer', async () => {
  const r = await rig('provider.on-limit', 'active');
  r.provider.script = () => ({ action: choiceOf('handoff') });
  assert.equal((await r.points.onLimit(r.stance(), limit()))?.action, 'handoff');
  assert.equal(await r.points.onLimit(r.stance(), limit()), null);
  assert.equal(r.provider.calls.length, 1);
});

test('provider.on-limit: the state sends at most three candidates', async () => {
  const r = await rig('provider.on-limit', 'shadow');
  r.provider.script = () => ({ action: choiceOf('wait') });
  const many = [cand('codex'), cand('copilot'), cand('codex', 30), cand('copilot', 40)];
  await r.points.onLimit(r.stance(), limit({ candidates: many }));
  await r.points.idle();
  const state = r.provider.calls[0]?.state as { candidates: unknown[] };
  assert.equal(state.candidates.length, 3);
});

// ---------- provider.pick ----------

test('provider.pick: off asks nothing and the first candidate stands', async () => {
  const r = await rig('provider.pick', 'off');
  assert.equal(await r.points.pick(r.stance(), pickSubject()), null);
  assert.equal(r.provider.calls.length, 0);
});

test('provider.pick: shadow records a row and the order decides', async () => {
  const r = await rig('provider.pick', 'shadow');
  r.provider.script = () => ({ provider: choiceOf('copilot') });
  assert.equal(await r.points.pick(r.stance(), pickSubject()), null);
  await r.points.idle();
  const [row] = await r.rowsAfter('provider.pick', 1);
  assert.equal(row?.mode, 'shadow');
  assert.equal(row?.subjectId, 'o1:t1');
});

test('provider.pick: active picks the candidate asked for above the threshold only', async () => {
  const r = await rig('provider.pick', 'active');
  r.provider.script = () => ({ provider: choiceOf('copilot', 0.95) });
  assert.equal((await r.points.pick(r.stance(), pickSubject()))?.provider, 'copilot');

  const low = await rig('provider.pick', 'active');
  low.provider.script = () => ({ provider: choiceOf('copilot', 0.3) });
  assert.equal(await low.points.pick(low.stance(), pickSubject()), null);
});

test('provider.pick: an unavailable provider leaves the order at once', async () => {
  const r = await rig('provider.pick', 'active');
  r.provider.script = () => ({ status: 'unavailable', reason: 'timeout', latencyMs: 1 });
  assert.equal(await r.points.pick(r.stance(), pickSubject()), null);
});

test('provider.pick: the options are the candidates, and a single candidate is not asked', async () => {
  const r = await rig('provider.pick', 'active');
  r.provider.script = () => ({ provider: choiceOf('codex') });
  await r.points.pick(r.stance(), pickSubject());
  const question = r.provider.calls[0]?.questions[0];
  assert.deepEqual(question?.kind === 'choice' ? question.options.map((o) => o.id) : [], ['codex', 'copilot']);
  assert.match(question?.kind === 'choice' ? (question.options[1]?.label ?? '') : '', /Copilot: copilot-model, 55 % of its limit used/);

  const before = r.provider.calls.length;
  assert.equal(await r.points.pick(r.stance(), pickSubject({ candidates: [cand('codex')] })), null);
  assert.equal(r.provider.calls.length, before);
});

test('provider.pick: the history of each candidate reaches the state', async () => {
  const r = await rig('provider.pick', 'shadow');
  r.provider.script = () => ({ provider: choiceOf('codex') });
  await r.points.pick(r.stance(), pickSubject({ candidates: [{ ...cand('codex'), history: { passed: 4, failed: 1 } }, cand('copilot')] }));
  await r.points.idle();
  const state = r.provider.calls[0]?.state as { candidates: Array<{ id: string; history?: unknown }> };
  assert.deepEqual(state.candidates[0]?.history, { passed: 4, failed: 1 });
});

// ---------- provider.model-map ----------

const PAIR = {
  from: { provider: 'claude-code' as const, model: 'sonnet', name: 'Sonnet' },
  target: 'codex' as const,
  targets: [
    { id: 'gpt-5', name: 'GPT-5' },
    { id: 'gpt-5-mini', name: 'GPT-5 mini' },
  ],
};

test('provider.model-map: off asks nothing', async () => {
  const r = await rig('provider.model-map', 'off');
  assert.equal(await r.points.suggestMapping(r.stance(), PAIR), null);
  assert.equal(r.provider.calls.length, 0);
});

test('provider.model-map: shadow records a row and suggests nothing', async () => {
  const r = await rig('provider.model-map', 'shadow');
  r.provider.script = () => ({ counterpart: choiceOf('gpt-5') });
  assert.equal(await r.points.suggestMapping(r.stance(), PAIR), null);
  await r.points.idle();
  const [row] = await r.rowsAfter('provider.model-map', 1);
  assert.equal(row?.mode, 'shadow');
  assert.equal(row?.subjectKind, 'model');
  assert.equal(row?.subjectId, modelMapSubjectId('claude-code', 'sonnet', 'codex'));
});

test('provider.model-map: active suggests a target model, never none, never one outside the catalog', async () => {
  const r = await rig('provider.model-map', 'active');
  r.provider.script = () => ({ counterpart: choiceOf('gpt-5') });
  assert.equal(await r.points.suggestMapping(r.stance(), PAIR), 'gpt-5');
  assert.equal(r.rows('provider.model-map')[0]?.acted, true);

  const none = await rig('provider.model-map', 'active');
  none.provider.script = () => ({ counterpart: choiceOf('none') });
  assert.equal(await none.points.suggestMapping(none.stance(), PAIR), null);
});

test('provider.model-map: an unavailable provider suggests nothing, at once', async () => {
  const r = await rig('provider.model-map', 'active');
  r.provider.script = () => ({ status: 'unavailable', reason: 'no-quota', latencyMs: 1 });
  assert.equal(await r.points.suggestMapping(r.stance(), PAIR), null);
});

test('provider.model-map: at most once per pair a day, unless a person presses Suggest', async () => {
  const r = await rig('provider.model-map', 'active');
  r.provider.script = () => ({ counterpart: choiceOf('gpt-5') });
  assert.equal(await r.points.suggestMapping(r.stance(), PAIR), 'gpt-5');
  assert.equal(await r.points.suggestMapping(r.stance(), PAIR), null, 'asked a minute ago');
  r.advance(60_000);
  assert.equal(await r.points.suggestMapping(r.stance(), PAIR, { force: true }), 'gpt-5', 'Suggest asks again');
  assert.equal(r.provider.calls.length, 2);

  // Another process, or this one after a restart, finds the day's row in the history
  const again = new ProviderPoints({ decisions: r.engine, sql: r.db.connection, now: () => Date.now() + 60_000 });
  assert.equal(await again.suggestMapping(r.stance(), PAIR), null);
  assert.equal(r.provider.calls.length, 2);

  const tomorrow = new ProviderPoints({ decisions: r.engine, sql: r.db.connection, now: () => Date.now() + 25 * 60 * 60 * 1000 });
  assert.equal(await tomorrow.suggestMapping(r.stance(), PAIR), 'gpt-5');
  assert.equal(r.provider.calls.length, 3);
});

test('provider.model-map: the target list is cut at 40 and the pair is another subject', async () => {
  const r = await rig('provider.model-map', 'shadow');
  r.provider.script = () => ({ counterpart: choiceOf('none') });
  const targets = Array.from({ length: 55 }, (_, i) => ({ id: `m${String(i)}`, name: `Model ${String(i)}` }));
  await r.points.suggestMapping(r.stance(), { ...PAIR, targets });
  await r.points.idle();
  const state = r.provider.calls[0]?.state as { targets: unknown[] };
  assert.equal(state.targets.length, 40);
  const question = r.provider.calls[0]?.questions[0];
  assert.equal(question?.kind === 'choice' ? question.options.length : 0, 41, 'forty models and none');
  // Not the same pair: asked at once
  await r.points.suggestMapping(r.stance(), { ...PAIR, target: 'copilot' });
  await r.points.idle();
  assert.equal(r.provider.calls.length, 2);
  assert.equal(decisionPoint('provider.model-map')?.scope, 'global');
});
