import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionAnswer, DecisionPointId, DecisionProviderId, ProjectDecisionSettings } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { DecisionEngine, lowestConfidence, type DecisionProvider, type DecisionRequest, type ProviderResult } from '../src/decisions/engine.ts';
import { DECISION_POINTS, decisionPoint, type DecisionSubject } from '../src/decisions/points.ts';
import { cutToBytes, maskSecrets, redactState, stateBytes } from '../src/decisions/redact.ts';
import { DecisionCredentialStore, DecisionSettingsStore, DEFAULT_DECISION_SETTINGS, parseProjectDecisions } from '../src/decisions/settings.ts';
import { tempConfig } from './helpers.ts';

type Behaviour = (request: DecisionRequest, signal: AbortSignal) => Promise<ProviderResult>;

class FakeProvider implements DecisionProvider {
  calls: DecisionRequest[] = [];
  up = true;
  readonly id: DecisionProviderId;
  private readonly behaviour: Behaviour;
  constructor(id: DecisionProviderId, behaviour: Behaviour) {
    this.id = id;
    this.behaviour = behaviour;
  }
  available(): boolean {
    return this.up;
  }
  ask(request: DecisionRequest, opts: { signal: AbortSignal }): Promise<ProviderResult> {
    this.calls.push(request);
    return this.behaviour(request, opts.signal);
  }
}

/** Answers the first option of every question with the given confidence */
const answering =
  (confidence: number | null, model = 'fake'): Behaviour =>
  (request) => {
    const answers: Record<string, DecisionAnswer> = {};
    for (const q of request.questions) {
      if (q.kind === 'choice') answers[q.id] = { kind: 'choice', value: q.options[0]?.id ?? '', probabilities: null, confidence };
      else if (q.kind === 'score') answers[q.id] = { kind: 'score', value: q.levels[0]?.id ?? '', probabilities: null, confidence };
      else answers[q.id] = { kind: 'noul', value: true, probability: null, confidence };
    }
    return Promise.resolve({ status: 'answered', answers, latencyMs: 12, inputTokens: 100, costUsd: 0.001, model });
  };

const unavailable =
  (reason: 'no-quota' | 'rate-limited' | 'max-tokens'): Behaviour =>
  () =>
    Promise.resolve({ status: 'unavailable', reason, latencyMs: 3 });

const subject: DecisionSubject = {
  kind: 'flow_run',
  id: 'run-1',
  data: { rejection: 'The button is still missing.', criteria: [{ id: 'c1', text: 'a button', met: false }], bounces: 'second', extra: 'never sent' },
};

function setup(project: ProjectDecisionSettings | null = null) {
  const config = tempConfig();
  const db = new Db(config);
  const credentials = new DecisionCredentialStore(config);
  const settings = new DecisionSettingsStore(config, credentials);
  const engine = new DecisionEngine({ settings, db, projectDecisions: () => project });
  return { db, settings, engine };
}

async function configure(
  s: ReturnType<typeof setup>,
  point: DecisionPointId,
  mode: 'off' | 'shadow' | 'active',
  opts: { provider?: DecisionProviderId; consent?: boolean; threshold?: number } = {},
) {
  const provider = opts.provider ?? 'jev';
  await s.settings.set({ ...structuredClone(DEFAULT_DECISION_SETTINGS), provider, points: { [point]: { mode, threshold: opts.threshold ?? 0.85, consent: null } } });
  if (opts.consent !== false) await s.settings.setConsent(point, { granted: true, stateVersion: decisionPoint(point)?.stateVersion ?? 1, providers: [provider] });
}

test('every point has a definition and a scope the project parser agrees with', () => {
  assert.equal(DECISION_POINTS.length, 25);
  for (const def of DECISION_POINTS) {
    assert.ok(def.maxStateBytes > 0 && def.defaultThreshold >= 0.5 && def.defaultThreshold <= 0.99, def.id);
    const override = { points: { [def.id]: { mode: 'shadow' } } };
    if (def.scope === 'global') assert.throws(() => parseProjectDecisions(override), /globally/, def.id);
    else assert.doesNotThrow(() => parseProjectDecisions(override), def.id);
  }
  assert.equal(decisionPoint('health.test-weakening')?.kind, 'suggest');
  assert.equal(decisionPoint('palette.intent')?.needsLowLatency, true);
});

test('a state carries only the fields its point lists', async () => {
  const state = await decisionPoint('flow.bounce')?.buildState(subject);
  assert.deepEqual(Object.keys(state ?? {}).sort(), ['bounces', 'criteria', 'rejection']);
});

test('off asks nothing and writes nothing, whatever the provider', async () => {
  const s = setup();
  const provider = new FakeProvider('jev', answering(0.99));
  s.engine.register(provider);
  const out = await s.engine.ask('flow.bounce', subject, { projectId: 'p' });
  assert.deepEqual(out, { decisionId: null, mode: 'off', act: false, answers: null });
  assert.equal(provider.calls.length, 0);
  assert.equal(s.db.listDecisions().items.length, 0);
});

test('no consent means no call, even in active; consent for another provider or an older state does not count', async () => {
  const s = setup();
  const provider = new FakeProvider('jev', answering(0.99));
  s.engine.register(provider);
  await configure(s, 'flow.bounce', 'active', { consent: false });
  assert.equal((await s.engine.ask('flow.bounce', subject, { projectId: 'p' })).decisionId, null);
  await s.settings.setConsent('flow.bounce', { granted: true, stateVersion: 1, providers: ['cli'] });
  assert.equal((await s.engine.ask('flow.bounce', subject, { projectId: 'p' })).decisionId, null);
  await s.settings.setConsent('flow.bounce', { granted: true, stateVersion: 7, providers: ['jev'] });
  assert.equal((await s.engine.ask('flow.bounce', subject, { projectId: 'p' })).decisionId, null);
  assert.equal(provider.calls.length, 0);
});

test('shadow records the answer but hands the caller nothing to act on', async () => {
  const s = setup();
  s.engine.register(new FakeProvider('jev', answering(0.99)));
  await configure(s, 'flow.bounce', 'shadow');
  const out = await s.engine.ask('flow.bounce', subject, { projectId: 'p' });
  assert.equal(out.act, false);
  assert.equal(out.answers, null);
  assert.ok(out.decisionId);
  const row = s.db.decision(out.decisionId);
  assert.equal(row?.mode, 'shadow');
  assert.equal(row?.status, 'answered');
  assert.equal(row?.acted, false);
  assert.equal(row?.confidence, 0.99);
  assert.equal(row?.projectId, 'p');
  assert.ok(!('extra' in (row?.state ?? {})));
});

test('active acts only when the confidence clears the threshold, and the lowest of the batch counts', async () => {
  const s = setup();
  s.engine.register(new FakeProvider('jev', answering(0.9)));
  await configure(s, 'flow.bounce', 'active', { threshold: 0.85 });
  const above = await s.engine.ask('flow.bounce', subject, { projectId: 'p' });
  assert.equal(above.act, true);
  assert.ok(above.answers?.bounce);
  const row = s.db.decision(above.decisionId ?? '');
  assert.deepEqual([row?.acted, row?.visible, row?.savedRun, row?.threshold], [true, true, true, 0.85]);

  await configure(s, 'flow.bounce', 'active', { threshold: 0.95 });
  const below = await s.engine.ask('flow.bounce', subject, { projectId: 'p' });
  assert.equal(below.act, false);
  assert.equal(s.db.decision(below.decisionId ?? '')?.acted, false);

  const mixed: Record<string, DecisionAnswer> = {
    a: { kind: 'noul', value: true, probability: 0.9, confidence: 0.9 },
    b: { kind: 'noul', value: false, probability: 0.6, confidence: 0.6 },
  };
  assert.equal(lowestConfidence(mixed), 0.6);
  assert.equal(lowestConfidence({ ...mixed, c: { kind: 'noul', value: true, probability: null, confidence: null } }), null);
});

test('a null confidence never clears a threshold: an act point on the cli answers but does not act', async () => {
  const s = setup();
  s.engine.register(new FakeProvider('cli', answering(null)));
  await configure(s, 'flow.bounce', 'active', { provider: 'cli' });
  const out = await s.engine.ask('flow.bounce', subject, { projectId: 'p' });
  assert.equal(out.act, false);
  const row = s.db.decision(out.decisionId ?? '');
  assert.deepEqual([row?.mode, row?.status, row?.acted, row?.confidence], ['active', 'answered', false, null]);
  assert.equal(s.engine.catalogue(null).find((p) => p.id === 'flow.bounce')?.effective.limited, true);
});

test('a suggest point acts on any answer, with either provider', async () => {
  const s = setup();
  s.engine.register(new FakeProvider('cli', answering(null)));
  await configure(s, 'memory.triage', 'active', { provider: 'cli' });
  const out = await s.engine.ask('memory.triage', { kind: 'memory_proposal', id: 'm1', data: { proposal: 'Use pnpm' } }, { projectId: 'p' });
  assert.equal(out.act, true);
  assert.equal(s.db.decision(out.decisionId ?? '')?.threshold, null);
});

test('an unavailable provider falls back at once and the row says why', async () => {
  const cases: Array<[Behaviour | 'missing' | 'down', string]> = [
    [unavailable('no-quota'), 'no-quota'],
    [unavailable('rate-limited'), 'rate-limited'],
    [unavailable('max-tokens'), 'max-tokens'],
    [() => Promise.reject(new Error('boom')), 'server-error'],
    [() => Promise.resolve({ status: 'answered', answers: {}, latencyMs: 1, inputTokens: null, costUsd: null, model: 'x' }), 'invalid-answer'],
    ['missing', 'no-key'],
    ['down', 'no-key'],
  ];
  for (const [behaviour, reason] of cases) {
    const s = setup();
    if (behaviour === 'down') {
      const p = new FakeProvider('jev', answering(1));
      p.up = false;
      s.engine.register(p);
    } else if (behaviour !== 'missing') s.engine.register(new FakeProvider('jev', behaviour));
    await configure(s, 'flow.bounce', 'active');
    const out = await s.engine.ask('flow.bounce', subject, { projectId: 'p' });
    assert.equal(out.act, false, reason);
    assert.equal(out.answers, null);
    const row = s.db.decision(out.decisionId ?? '');
    assert.deepEqual([row?.status, row?.unavailable], ['unavailable', reason]);
  }
});

test('an answer that is not one of the options is invalid, not acted on', async () => {
  const s = setup();
  s.engine.register(
    new FakeProvider('jev', () =>
      Promise.resolve({ status: 'answered', answers: { bounce: { kind: 'choice', value: 'sideways', probabilities: null, confidence: 1 } }, latencyMs: 1, inputTokens: null, costUsd: null, model: 'x' }),
    ),
  );
  await configure(s, 'flow.bounce', 'active');
  const out = await s.engine.ask('flow.bounce', subject, { projectId: 'p' });
  assert.equal(out.act, false);
  assert.equal(s.db.decision(out.decisionId ?? '')?.unavailable, 'invalid-answer');
});

test('a provider that misses the deadline is a timeout and is aborted', async () => {
  const s = setup();
  let aborted = false;
  s.engine.register(new FakeProvider('jev', (_request, signal) => new Promise(() => signal.addEventListener('abort', () => (aborted = true)))));
  await configure(s, 'flow.bounce', 'active');
  const started = Date.now();
  const out = await s.engine.ask('flow.bounce', subject, { projectId: 'p' });
  assert.ok(Date.now() - started < 3_000);
  assert.equal(out.act, false);
  assert.equal(s.db.decision(out.decisionId ?? '')?.unavailable, 'timeout');
  assert.equal(aborted, true);
});

test('the engine never throws into the caller', async () => {
  const s = setup();
  s.engine.register(new FakeProvider('jev', answering(1)));
  await configure(s, 'flow.bounce', 'active');
  const hostile = {
    kind: 'flow_run',
    id: null,
    get data(): Record<string, unknown> {
      throw new Error('boom');
    },
  } as unknown as DecisionSubject;
  const out = await s.engine.ask('flow.bounce', hostile, { projectId: null });
  assert.deepEqual(out, { decisionId: null, mode: 'off', act: false, answers: null });
});

test('the project overrides the global mode and provider; consent stays global and names its providers', async () => {
  const s = setup({ provider: 'jev', points: { 'flow.bounce': { mode: 'shadow' } } });
  const jev = new FakeProvider('jev', answering(0.99));
  s.engine.register(jev);
  s.engine.register(new FakeProvider('cli', answering(null)));
  await s.settings.set({ ...structuredClone(DEFAULT_DECISION_SETTINGS), points: { 'flow.bounce': { mode: 'off', threshold: 0.85, consent: null } } });
  await s.settings.setConsent('flow.bounce', { granted: true, stateVersion: 1, providers: ['cli'] });
  assert.equal((await s.engine.ask('flow.bounce', subject, { projectId: 'p' })).decisionId, null, 'consent for cli does not cover the project on jev');
  await s.settings.setConsent('flow.bounce', { granted: true, stateVersion: 1, providers: ['cli', 'jev'] });
  const out = await s.engine.ask('flow.bounce', subject, { projectId: 'p' });
  assert.equal(out.mode, 'shadow');
  assert.equal(jev.calls.length, 1);
  assert.equal((await s.engine.ask('flow.bounce', subject, { projectId: null })).mode, 'off', 'no project, the global mode');
});

test('a global-scope point ignores any project override', async () => {
  const s = setup({ points: { 'supervisor.intervene': { mode: 'active' } } });
  s.engine.register(new FakeProvider('cli', answering(null)));
  await s.settings.set({ ...structuredClone(DEFAULT_DECISION_SETTINGS), points: {} });
  assert.equal((await s.engine.ask('supervisor.intervene', { kind: 'chat', id: 'c', data: {} }, { projectId: 'p' })).mode, 'off');
});

test('the palette point is not asked on the cli', async () => {
  const s = setup();
  const cli = new FakeProvider('cli', answering(null));
  s.engine.register(cli);
  await configure(s, 'palette.intent', 'active', { provider: 'cli' });
  const palette = { kind: 'palette' as const, id: null, data: { query: 'go', commands: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] } };
  const out = await s.engine.ask('palette.intent', palette, { projectId: null });
  assert.equal(out.decisionId, null);
  assert.equal(cli.calls.length, 0);
});

test('a batch is one call, secrets are masked in what is sent, and resolve writes the outcome', async () => {
  const s = setup();
  const provider = new FakeProvider('jev', answering(0.9));
  s.engine.register(provider);
  await configure(s, 'flow.bounce', 'shadow');
  const leaky = { ...subject, data: { ...subject.data, rejection: 'Set API_KEY=abcdef123456 and sk-ant-abcdefghijklmnopqrstuv' } };
  const out = await s.engine.ask('flow.bounce', leaky, { projectId: 'p' });
  assert.equal(provider.calls.length, 1);
  const sent = JSON.stringify(provider.calls[0]?.state);
  assert.ok(!sent.includes('abcdef123456') && !sent.includes('sk-ant'));
  s.engine.resolve(out.decisionId ?? '', { summary: 'next QA passed', agreed: true });
  const row = s.db.decision(out.decisionId ?? '');
  assert.equal(row?.agreed, true);
  assert.equal(row?.outcome?.summary, 'next QA passed');
});

test('pruning keeps historyDays of rows', async () => {
  const s = setup();
  s.engine.register(new FakeProvider('jev', answering(0.9)));
  await configure(s, 'flow.bounce', 'shadow');
  const out = await s.engine.ask('flow.bounce', subject, { projectId: 'p' });
  assert.equal(s.engine.prune(), 0);
  const later = new DecisionEngine({ settings: s.settings, db: s.db, projectDecisions: () => null, now: () => new Date(Date.now() + 31 * 86_400_000) });
  assert.equal(later.prune(), 1);
  assert.equal(s.db.decision(out.decisionId ?? ''), null);
});

test('the catalogue and the last state come from the settings and the history', async () => {
  const s = setup();
  s.engine.register(new FakeProvider('jev', answering(0.9)));
  await configure(s, 'flow.bounce', 'shadow');
  assert.equal(s.engine.catalogue(null).length, 25);
  assert.equal(s.engine.catalogue(null).find((p) => p.id === 'flow.bounce')?.effective.mode, 'shadow');
  assert.equal(s.engine.lastState('flow.bounce'), null);
  await s.engine.ask('flow.bounce', subject, { projectId: 'p' });
  const last = s.engine.lastState('flow.bounce');
  assert.equal(last?.provider, 'jev');
  assert.deepEqual(Object.keys(last?.state ?? {}).sort(), ['bounces', 'criteria', 'rejection']);
  const built = await s.engine.previewState('flow.bounce', subject);
  assert.deepEqual(built?.state, last?.state);
});

test('redaction masks secrets in text and secret-named fields, and never splits a character', () => {
  assert.equal(maskSecrets('token ghp_abcdefghijklmnop1234 here'), 'token [redacted] here');
  assert.equal(maskSecrets('Authorization: Bearer abcdefghijklmnopqrstuv').includes('abcdefghij'), false);
  assert.match(maskSecrets('curl -H "Bearer abcdefghijklmnopqrstuv"'), /Bearer \[redacted\]/);
  assert.match(maskSecrets('DB_PASSWORD=hunter2hunter'), /^DB_PASSWORD=\[redacted\]$/);
  assert.match(maskSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'), /^\[redacted\]$/);
  assert.equal(maskSecrets('a plain sentence about tokens'), 'a plain sentence about tokens');
  const cut = redactState({ apiKey: 'shh-shh', nested: { authorization: 'x', ok: 'fine' } }, 1000);
  assert.deepEqual(cut, { apiKey: '[redacted]', nested: { authorization: '[redacted]', ok: 'fine' } });
  const emoji = cutToBytes('😀😀😀😀😀', 10);
  assert.ok(new TextEncoder().encode(emoji).length <= 10);
  assert.ok(!emoji.includes('�'));
});

test('redaction cuts the document to the point byte limit: long strings first, then trailing items', () => {
  const long = redactState({ title: 't', body: 'x'.repeat(5000) }, 400);
  assert.ok(stateBytes(long) <= 400);
  assert.equal(long.title, 't');
  const many = redactState({ items: Array.from({ length: 200 }, (_, i) => ({ n: `item-${String(i)}` })) }, 300);
  assert.ok(stateBytes(many) <= 300);
  assert.ok(Array.isArray(many.items) && many.items.length >= 1);
});
