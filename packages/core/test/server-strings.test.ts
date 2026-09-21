import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HealthSignal, Localized } from '@agentry/shared';
import { chatHealth, HUNG_COMMAND_MS, type HealthFacts } from '../src/chat-model.ts';
import { usualDuration } from '../src/commands.ts';
import { CONNECTOR_GUIDE, CONNECTOR_LIMITS } from '../src/connectors.ts';
import { budget, loop, noProgress, NO_PROGRESS_MS, repeatStall, weakenedTests, type ToolCall, type Trace } from '../src/health.ts';
import { HEALTH_HINTS, HEALTH_REASONS, hintText, reasonText } from '../src/health-strings.ts';

// The strings the server writes carry a code a client translates by. A code is part of the API: the
// lists below are written out by hand so that renaming or dropping one fails here, on purpose, and
// the web's keys are changed with it. Adding a code means adding it here too.

const REASON_CODES = [
  'health.hungCommand.usual',
  'health.hungCommand.fixed',
  'health.silence',
  'health.lastExecution.interrupted',
  'health.lastExecution.failed',
  'health.lastExecution.failedWithError',
  'health.waiting',
  'health.context',
  'health.branches',
  'health.repeatStall',
  'health.loop.command',
  'health.loop.call',
  'health.loop.error',
  'health.weakenedTest.assertionsRemoved',
  'health.weakenedTest.skipped',
  'health.weakenedTest.tautology',
  'health.weakenedTest.weakMatchers',
  'health.noProgress',
  'health.budget.timeNear',
  'health.budget.timePast',
  'health.budget.cost',
  'health.ok',
];

const HINT_CODES = [
  'health.hint.hungCommand',
  'health.hint.repeatStall',
  'health.hint.noProgress',
  'health.hint.loop',
  'health.hint.weakenedTest',
  'health.hint.silence',
  'health.hint.budget.time',
  'health.hint.budget.cost',
];

const CONNECTOR_CODES = [
  'connectors.authorise.cli',
  'connectors.authorise.claudeAi',
  'connectors.authorise.refresh',
  'connectors.link.settings',
  'connectors.link.mcpDocs',
  'connectors.unavailable.webArtifacts',
  'connectors.unavailable.claudeAiMemory',
];

test('the health codes are the ones clients translate by', () => {
  assert.deepEqual(Object.keys(HEALTH_REASONS).sort(), [...REASON_CODES].sort());
  assert.deepEqual(Object.keys(HEALTH_HINTS).sort(), [...HINT_CODES].sort());
});

test('the connector strings each carry a stable code beside their English', () => {
  const strings: Localized[] = [...CONNECTOR_GUIDE.steps, ...CONNECTOR_GUIDE.links.map((l) => l.label), ...CONNECTOR_LIMITS.map((l) => l.reason)];
  assert.deepEqual(strings.map((s) => s.code), CONNECTOR_CODES);
  for (const s of strings) assert.ok(s.text.trim().length > 0, s.code);
});

// ---------- every signal the rules can raise ----------

const T0 = Date.parse('2026-01-01T10:00:00.000Z');
const at = (msAfter: number) => new Date(T0 + msAfter).toISOString();
let n = 0;
const call = (name: string, input: Record<string, unknown>, over: Partial<ToolCall> = {}): ToolCall => ({
  id: `toolu_${String(++n)}`,
  name,
  input,
  at: at(0),
  endedAt: at(1000),
  isError: false,
  result: 'ok',
  ...over,
});
const bash = (command: string, startMs: number, endMs: number | null, over: Partial<ToolCall> = {}) =>
  call('Bash', { command }, { at: at(startMs), endedAt: endMs === null ? null : at(endMs), ...over });
const trace = (calls: ToolCall[]): Trace => ({ executionStartedAt: at(0), lastEventAt: at(0), calls, heartbeats: new Map() });
const facts = (over: Partial<HealthFacts> = {}): HealthFacts => ({ state: 'idle', live: null, lastEnded: null, context: null, failedBranches: 0, ...over });
const SPEC = 'test/a.test.ts';
const edit = (before: string, after: string) => call('Edit', { file_path: SPEC, old_string: before, new_string: after });
const noHistory = { fallbackMs: HUNG_COMMAND_MS, usualOf: () => null };

function everySignal(): HealthSignal[] {
  const usual = usualDuration([78_000, 80_000, 82_000, 79_000, 95_000, 81_000]);
  const running = (command: { command: string; startedAt: string; usual?: typeof usual }) =>
    chatHealth(facts({ state: 'working', live: { lastEventAt: at(0), commands: [command] } }), T0 + 5 * 60_000).signals;
  const sameCall = (name: string, input: Record<string, unknown>) => Array.from({ length: 4 }, (_, i) => call(name, input, { at: at(i * 1000), result: 'same' }));
  const found = [
    ...running({ command: 'pnpm e2e', startedAt: at(0), usual }),
    ...running({ command: 'pnpm e2e', startedAt: at(0) }),
    ...chatHealth(facts({ state: 'working', live: { lastEventAt: at(0), commands: [] } }), T0 + 4 * 60_000).signals,
    ...chatHealth(facts({ lastEnded: { outcome: 'interrupted', error: null } })).signals,
    ...chatHealth(facts({ lastEnded: { outcome: 'failed', error: null } })).signals,
    ...chatHealth(facts({ lastEnded: { outcome: 'failed', error: 'rate limited' } })).signals,
    ...chatHealth(facts({ state: 'waiting' })).signals,
    ...chatHealth(facts({ context: { used: 170_000, window: 200_000 } })).signals,
    ...chatHealth(facts({ failedBranches: 1 })).signals,
    repeatStall(trace([bash('pnpm e2e', 0, 420_000), bash('pnpm e2e', 430_000, 730_000)]), noHistory, T0 + 740_000),
    loop(trace(sameCall('Bash', { command: 'pnpm build' }))),
    loop(trace(sameCall('Grep', { pattern: 'x' }))),
    loop(trace(['a', 'b', 'c', 'd'].map((f, i) => call('Read', { file_path: f }, { at: at(i * 1000), isError: true, result: 'EACCES: permission denied' })))),
    ...weakenedTests(trace([edit("it('a', () => {\n  expect(x).toBe(1);\n});", "it('a', () => {\n});")])),
    ...weakenedTests(trace([edit("it('a', () => { expect(a).toBe(1); });", "it.skip('a', () => { expect(a).toBe(1); });")])),
    ...weakenedTests(trace([edit("it('a', () => { expect(a).toBe(1); });", "it('a', () => { expect(a).toBe(1); expect(true).toBe(true); });")])),
    ...weakenedTests(trace([edit("expect(a).toBe(3);\nexpect(b).toBe('x');", 'expect(a).toBeTruthy();\nexpect(b).toBeDefined();')])),
    noProgress(at(0), T0 + NO_PROGRESS_MS + 1000),
    budget({ maxMinutes: 20 }, { elapsedMs: 17 * 60_000, costUsd: 0 }),
    budget({ maxMinutes: 20 }, { elapsedMs: 21 * 60_000, costUsd: 0 }),
    budget({ maxCostUsd: 5 }, { elapsedMs: 0, costUsd: 4.2 }),
  ];
  return found.filter((s): s is HealthSignal => s !== null);
}

test('every health text has a code, and the code with its params says the same thing', () => {
  const reasons = new Set<string>();
  const hints = new Set<string>();
  for (const signal of everySignal()) {
    const code = signal.reasonCode;
    assert.ok(code, `no code for "${signal.reason}"`);
    reasons.add(code);
    assert.equal(reasonText(code, signal.params), signal.reason, code);
    // A client fills in the figures from the params: none may be missing or empty
    assert.doesNotMatch(signal.reason, /undefined|NaN/, code);
    if (signal.hint !== undefined) {
      assert.ok(signal.hintCode, `no code for the hint of ${code}`);
      hints.add(signal.hintCode);
      assert.equal(hintText(signal.hintCode, signal.params), signal.hint, signal.hintCode);
      assert.doesNotMatch(signal.hint, /undefined|NaN/, signal.hintCode);
    }
    for (const value of Object.values(signal.params ?? {})) assert.ok(typeof value === 'number' ? Number.isFinite(value) : value.length > 0, code);
  }
  // Every sentence of the catalogue is one a rule really says: a code no rule uses is a dead key
  assert.deepEqual([...reasons].sort(), REASON_CODES.filter((c) => c !== 'health.ok').sort());
  assert.deepEqual([...hints].sort(), [...HINT_CODES].sort());
});

test('a chat with no signal says so under its own code', () => {
  assert.equal(chatHealth(facts()).reason, reasonText('health.ok'));
  assert.equal(reasonText('health.nothing-like-this'), null);
  // A code is looked up as a key of the catalogue, never as whatever an object happens to inherit
  assert.equal(reasonText('toString'), null);
});

test('the figures are the ones that made a signal fire', () => {
  const [hung] = chatHealth(facts({ state: 'working', live: { lastEventAt: at(0), commands: [{ command: 'pnpm e2e', startedAt: at(0) }] } }), T0 + 5 * 60_000).signals;
  assert.deepEqual(hung?.params, { command: 'pnpm e2e', minutes: 5, limitMinutes: 3 });
  assert.deepEqual(budget({ maxCostUsd: 5 }, { elapsedMs: 0, costUsd: 4.2 })?.params, { spentUsd: 4.2, limitUsd: 5 });
  assert.deepEqual(chatHealth(facts({ failedBranches: 2 })).signals[0]?.params, { count: 2 });
  // A signal whose sentence has no figures carries no params at all
  assert.equal(chatHealth(facts({ state: 'waiting' })).signals[0]?.params, undefined);
});
