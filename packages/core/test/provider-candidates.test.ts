import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelMapEntry, ProviderLimit, ProviderStatus, ToolPolicy } from '@agentry/shared';
import { candidatesFor, type CandidateContext, type CandidateProvider, type RunNeeds } from '../src/providers/candidates.ts';
import { mapModel } from '../src/providers/model-map.ts';
import { defaultProvidersSettings } from '../src/providers/settings.ts';
import { PROVIDER_MANIFESTS, translationFor } from '../src/providers/registry.ts';
import { translateCodexPolicy } from '../src/providers/codex/policy.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const POLICY: ToolPolicy = {
  read: { allow: true },
  edit: { allow: 'any' },
  commands: { allow: 'any' },
  network: 'omit',
  gitPush: 'deny',
};

function status(id: string, over: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    id,
    label: id,
    state: 'ready',
    reason: null,
    version: '1',
    compatibleRange: '*',
    binaryPath: null,
    configHome: null,
    account: null,
    capabilities: [],
    checkedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

function limit(over: Partial<ProviderLimit>): ProviderLimit {
  return {
    provider: 'x',
    state: 'ok',
    window: null,
    utilization: null,
    resetsAt: null,
    windows: {},
    observedAt: new Date(NOW).toISOString(),
    source: 'stream',
    ...over,
  };
}

function provider(id: string, over: Partial<CandidateProvider> = {}, st: Partial<ProviderStatus> = {}): CandidateProvider {
  return {
    status: status(id, st),
    hasDriver: true,
    capabilities: ['structuredOutput', 'budgetLimit', 'interactivePermissions'],
    translate: id === 'codex' ? translateCodexPolicy : translationFor(id),
    models: [],
    ...over,
  };
}

function context(over: Partial<CandidateContext> = {}, providers?: Record<string, CandidateProvider>): CandidateContext {
  const ids = ['claude-code', 'codex', 'gemini', 'copilot', 'opencode'];
  return {
    settings: defaultProvidersSettings(ids),
    project: null,
    providers: providers ?? { 'claude-code': provider('claude-code'), codex: provider('codex') },
    now: NOW,
    ...over,
  };
}

function run(over: Partial<RunNeeds> = {}): RunNeeds {
  return {
    kind: 'task',
    from: { provider: 'claude-code', model: null },
    model: null,
    needs: [],
    policy: POLICY,
    nativeRules: false,
    automated: true,
    exclude: [],
    ...over,
  };
}

const why = (r: ReturnType<typeof candidatesFor>, id: string) => r.excluded.find((e) => e.provider === id)?.excluded;

test('the shipped manifests are all known to the order the tests use', () => {
  assert.equal(PROVIDER_MANIFESTS.length, 5);
});

test('the provider the run is on is left, and the next one in order is the candidate', () => {
  const r = candidatesFor(run(), context());
  assert.deepEqual(r.candidates.map((c) => c.provider), ['codex']);
  assert.equal(why(r, 'claude-code'), 'left-already');
});

test('starting work (from null) can pick the first provider in order', () => {
  const r = candidatesFor(run({ from: null }), context());
  assert.deepEqual(r.candidates.map((c) => c.provider), ['claude-code', 'codex']);
});

test('providers with no entry are disabled, outside the order are not-in-order', () => {
  const ctx = context();
  ctx.settings.providers['codex'] = { enabled: false, binaryPath: null };
  ctx.settings.order = ['claude-code', 'codex'];
  const r = candidatesFor(run(), ctx);
  assert.equal(why(r, 'codex'), 'disabled');
  const other = candidatesFor(run(), context({}, { 'claude-code': provider('claude-code'), gemini: provider('gemini') }));
  assert.equal(why(other, 'gemini') ?? 'in-order', 'policy');
  const out = context({ project: { order: ['claude-code'] } });
  assert.equal(why(candidatesFor(run(), out), 'codex'), 'not-in-order');
});

test('a project order overrides the global one', () => {
  const ctx = context({ project: { order: ['codex', 'claude-code'] } });
  assert.deepEqual(candidatesFor(run({ from: null }), ctx).candidates.map((c) => c.provider), ['codex', 'claude-code']);
});

test('readiness: not ready is excluded, degraded passes unless limit-reached', () => {
  const base = { 'claude-code': provider('claude-code') };
  const signedOut = candidatesFor(run(), context({}, { ...base, codex: provider('codex', {}, { state: 'signed-out' }) }));
  assert.equal(why(signedOut, 'codex'), 'not-ready');
  const degraded = candidatesFor(run(), context({}, { ...base, codex: provider('codex', {}, { state: 'degraded', reason: 'limit-near' }) }));
  assert.equal(degraded.candidates[0]?.provider, 'codex');
  const reached = candidatesFor(run(), context({}, { ...base, codex: provider('codex', {}, { state: 'degraded', reason: 'limit-reached' }) }));
  assert.equal(why(reached, 'codex'), 'not-ready');
});

test('no-probe (Copilot) is a candidate for a person only', () => {
  const providers = { 'claude-code': provider('claude-code'), copilot: provider('copilot', {}, { state: 'unknown', reason: 'no-probe' }) };
  const person = candidatesFor(run({ kind: 'chat', automated: false, policy: null }), context({}, providers));
  assert.deepEqual(person.candidates.map((c) => c.provider), ['copilot']);
  const auto = candidatesFor(run({ kind: 'task' }), context({}, providers));
  assert.equal(why(auto, 'copilot'), 'not-ready');
});

test('no driver, and a missing capability', () => {
  const providers = {
    'claude-code': provider('claude-code'),
    codex: provider('codex', { hasDriver: false }),
    gemini: provider('gemini', { capabilities: [] }),
  };
  const r = candidatesFor(run({ needs: ['structuredOutput'], automated: false }), context({}, providers));
  assert.equal(why(r, 'codex'), 'no-driver');
  assert.equal(why(r, 'gemini'), 'capability');
});

test('automated work needs git push denied and enforced; no translator excludes', () => {
  const providers = {
    'claude-code': provider('claude-code'),
    codex: provider('codex'),
    opencode: provider('opencode', { translate: () => ({ rules: { allowedTools: [], disallowedTools: [] }, unsupported: [] }) }),
    gemini: provider('gemini', { translate: null }),
  };
  const r = candidatesFor(run(), context({}, providers));
  assert.equal(why(r, 'opencode'), 'policy');
  assert.equal(why(r, 'gemini'), 'policy');
  assert.equal(r.candidates[0]?.provider, 'codex');
  const loose = candidatesFor(run({ policy: { ...POLICY, gitPush: 'omit' } }), context({}, providers));
  assert.equal(why(loose, 'codex'), 'policy');
});

test('a policy part the target cannot enforce excludes it, and a flow stage stays off Copilot and Gemini', () => {
  const unsupported = candidatesFor(run({ policy: { ...POLICY, delegate: 'deny' } }), context());
  assert.equal(why(unsupported, 'codex'), 'policy');
  const providers = { 'claude-code': provider('claude-code'), gemini: provider('gemini'), copilot: provider('copilot') };
  const flow = candidatesFor(run({ kind: 'flow-run' }), context({}, providers));
  assert.equal(why(flow, 'gemini'), 'policy');
  assert.equal(why(flow, 'copilot'), 'policy');
});

test('custom native rules without a policy cannot be translated', () => {
  const r = candidatesFor(run({ kind: 'chat', automated: false, policy: null, nativeRules: true }), context());
  assert.equal(why(r, 'codex'), 'policy-not-portable');
  const free = candidatesFor(run({ kind: 'chat', automated: false, policy: null }), context());
  assert.equal(free.candidates[0]?.provider, 'codex');
});

test('model: own catalog, a mapping, and none (no-mapping)', () => {
  const entry: ModelMapEntry = { from: { provider: 'claude-code', model: 'opus' }, to: { provider: 'codex', model: 'gpt-x' }, origin: 'person', at: '' };
  const from = { provider: 'claude-code', id: 'opus' };
  const none = candidatesFor(run({ model: from }), context());
  assert.equal(why(none, 'codex'), 'no-mapping');

  const mapped = context();
  mapped.settings.rotation = { onLimit: { action: 'wait', allowed: ['wait'], maxWaitHours: 6, maxMoves: 2 }, modelMap: [entry] };
  assert.equal(candidatesFor(run({ model: from }), mapped).candidates[0]?.model, 'gpt-x');

  const gone = context({}, { 'claude-code': provider('claude-code'), codex: provider('codex', { models: [{ value: 'other' }] }) });
  gone.settings.rotation = mapped.settings.rotation;
  assert.equal(why(candidatesFor(run({ model: from }), gone), 'codex'), 'no-mapping');

  const own = context({}, { 'claude-code': provider('claude-code'), codex: provider('codex', { models: [{ value: 'opus' }] }) });
  assert.equal(candidatesFor(run({ model: from }), own).candidates[0]?.model, 'opus');
});

test('a mapping made on the alias the person picked applies to the id the run reports', () => {
  const entry: ModelMapEntry = { from: { provider: 'claude-code', model: 'sonnet' }, to: { provider: 'codex', model: 'gpt-x' }, origin: 'person', at: '' };
  const mapped = context();
  mapped.settings.rotation = { onLimit: { action: 'wait', allowed: ['wait'], maxWaitHours: 6, maxMoves: 2 }, modelMap: [entry] };
  // The CLI reports the model it resolved, not the alias: without its other names the map misses it
  const bare = { provider: 'claude-code', id: 'claude-sonnet-5-5' };
  assert.equal(why(candidatesFor(run({ model: bare }), mapped), 'codex'), 'no-mapping');
  const named = { ...bare, names: ['claude-sonnet-5-5', 'sonnet'] };
  assert.equal(candidatesFor(run({ model: named }), mapped).candidates[0]?.model, 'gpt-x');
});

test('the Claude driver names a model by its alias and by the id it resolved to', () => {
  const driver = new ClaudeCodeDriver('claude');
  driver.modelSource = { file: '', seen: () => ({ sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }) };
  assert.deepEqual(driver.modelNames('claude-sonnet-5-5').sort(), ['claude-sonnet-5-5', 'sonnet']);
  assert.deepEqual(driver.modelNames('opus').sort(), ['claude-opus-5-5', 'opus']);
  assert.deepEqual(driver.modelNames('claude-haiku-4-5'), ['claude-haiku-4-5']);
});

test('mapModel: a stale entry is missing, the same provider keeps its model', () => {
  assert.equal(mapModel([], { provider: 'a', id: 'm' }, 'a', []), 'm');
  assert.equal(mapModel([], { provider: 'a', id: 'm' }, 'b', []), undefined);
});

test('an exhausted provider is excluded until its reset, then it is a candidate again', () => {
  const future = new Date(NOW + 3600_000).toISOString();
  const past = new Date(NOW - 3600_000).toISOString();
  const mk = (resetsAt: string | null) =>
    context({}, { 'claude-code': provider('claude-code'), codex: provider('codex', { status: status('codex', { limit: limit({ state: 'exhausted', resetsAt }) }) }) });
  assert.equal(why(candidatesFor(run(), mk(future)), 'codex'), 'exhausted');
  assert.equal(why(candidatesFor(run(), mk(null)), 'codex'), 'exhausted');
  assert.equal(candidatesFor(run(), mk(past)).candidates[0]?.provider, 'codex');
});

test('the chain: a provider already left stays out until its reset passed', () => {
  const past = new Date(NOW - 1000).toISOString();
  const providers = { 'claude-code': provider('claude-code'), codex: provider('codex') };
  const r = candidatesFor(run({ from: { provider: 'codex', model: null }, exclude: ['claude-code'] }), context({}, providers));
  assert.equal(why(r, 'claude-code'), 'left-already');
  const back = candidatesFor(
    run({ from: { provider: 'codex', model: null }, exclude: ['claude-code'] }),
    context({}, { ...providers, 'claude-code': provider('claude-code', { status: status('claude-code', { limit: limit({ state: 'unknown', resetsAt: past }) }) }) }),
  );
  assert.equal(back.candidates[0]?.provider, 'claude-code');
});

test('the moves cap leaves no candidate, project cap included', () => {
  const capped = candidatesFor(run({ moves: 2 }), context());
  assert.equal(capped.movesCapped, true);
  assert.deepEqual(capped.candidates, []);
  const project = context({ project: { onLimit: { maxMoves: 3 } } });
  assert.equal(candidatesFor(run({ moves: 2 }), project).candidates.length, 1);
  assert.equal(candidatesFor(run({ moves: 3 }), project).movesCapped, true);
  assert.equal(candidatesFor(run({ from: null, moves: 9 }), context()).movesCapped, false);
});

test('the effort carries over only where the candidate declares it and lists the level', () => {
  const providers = {
    'claude-code': provider('claude-code'),
    codex: provider('codex', { capabilities: ['effort'], efforts: ['low', 'high'] }),
    gemini: provider('gemini', { capabilities: [], efforts: ['high'] }),
  };
  const r = candidatesFor(run({ effort: 'high', policy: null, automated: false }), context({}, providers));
  assert.equal(r.candidates.find((c) => c.provider === 'codex')?.effort, 'high');
  assert.equal(r.candidates.find((c) => c.provider === 'gemini')?.effort, null);
  assert.equal(candidatesFor(run({ effort: 'max', policy: null, automated: false }), context({}, providers)).candidates[0]?.effort, null);
});
