import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { DecisionQuestion, ModelMapEntry, ProviderStatus } from '@agentry/shared';
import type { NewChat } from '../src/live-chat.ts';
import type { CandidateContext, CandidateProvider } from '../src/providers/candidates.ts';
import { defaultProvidersSettings } from '../src/providers/settings.ts';
import { Core } from '../src/index.ts';
import { translateClaudePolicy } from '../src/providers/claude-code/policy.ts';
import { translateCodexPolicy } from '../src/providers/codex/policy.ts';
import { chooseCliRoute, CliDecisionProvider, DECISION_POLICY, decisionPrompt, decisionSchema, parseAnswers } from '../src/decisions/providers/cli.ts';
import type { DecisionRequest, ProviderResult } from '../src/decisions/engine.ts';
import { PASTED_NOTE, THINK_THROUGH } from '../src/prompt-rules.ts';
import { tempConfig } from './helpers.ts';

// The cli provider over the real chat runtime and the fake CLI (test/fixtures/fake-claude.mjs): the
// chat is a real process given the real flags. A marker line in a question scripts what the fake does.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

const questions = (script: string): DecisionQuestion[] => [
  {
    kind: 'choice',
    id: 'next',
    question: `What comes next?\n${script}`,
    options: [
      { id: 'retry', label: 'Run it again' },
      { id: 'stop', label: 'Leave it' },
    ],
  },
  { kind: 'score', id: 'risk', question: 'How risky is it?', levels: [{ id: 'low', description: 'Nothing breaks' }, { id: 'high', description: 'Much breaks' }] },
  { kind: 'noul', id: 'clear', question: 'Is the goal clear?' },
];

const request = (script: string): DecisionRequest => ({ point: 'flow.bounce', state: { rejection: 'the button is missing' }, questions: questions(script) });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-decision-cli-'));
  const core = new Core({ ...tempConfig(), claudeBin: FAKE_CLAUDE });
  core.runtime.apiUrl = 'http://127.0.0.1:34331/api';
  const provider = new CliDecisionProvider({ runtime: core.runtime, settings: core.decisionSettings });
  const ask = (script: string, deadlineMs = 15_000): Promise<ProviderResult> =>
    provider.ask(request(script), { deadlineMs, signal: new AbortController().signal });
  const log = (name: string) => join(dir, name);
  return { core, provider, ask, log };
}

const lines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []);

test('the schema asks for the typed answers only', () => {
  const schema = decisionSchema(questions('')) as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
  assert.deepEqual(schema.properties, {
    next: { type: 'string', enum: ['retry', 'stop'] },
    risk: { type: 'string', enum: ['low', 'high'] },
    clear: { type: 'boolean' },
  });
  assert.deepEqual(schema.required, ['next', 'risk', 'clear']);
  assert.equal(schema.additionalProperties, false);
  assert.doesNotMatch(JSON.stringify(schema), /reason|explanation/i);
});

test('the prompt pastes the state, carries the note, and thinks through only on Sonnet', () => {
  const haiku = decisionPrompt(request(''), 'haiku');
  assert.match(haiku, /<pasted_content id="([0-9a-f]{8})">\n[\s\S]*the button is missing[\s\S]*\n<\/pasted_content id="\1">/);
  assert.ok(haiku.includes(PASTED_NOTE));
  assert.ok(!haiku.includes(THINK_THROUGH));
  assert.ok(decisionPrompt(request(''), 'claude-sonnet-5-5').includes(THINK_THROUGH));
  assert.doesNotMatch(haiku, /This run is unattended|reasoning/);
});

test('answers are read against the questions, with no confidence', () => {
  const qs = questions('');
  assert.deepEqual(parseAnswers({ next: 'stop', risk: 'high', clear: false }, qs), {
    next: { kind: 'choice', value: 'stop', probabilities: null, confidence: null },
    risk: { kind: 'score', value: 'high', probabilities: null, confidence: null },
    clear: { kind: 'noul', value: false, probability: null, confidence: null },
  });
  assert.equal(parseAnswers({ next: 'later', risk: 'high', clear: false }, qs), null);
  assert.equal(parseAnswers({ next: 'stop', risk: 'high' }, qs), null);
  assert.equal(parseAnswers('stop', qs), null);
});

test('one confined chat answers, holds no API credential, and leaves nothing behind', async () => {
  const { core, ask, log } = setup();
  process.env.FAKE_CLAUDE_SPAWNS = log('spawns');
  process.env.FAKE_CLAUDE_ENVS = log('envs');
  process.env.FAKE_CLAUDE_PROMPTS = log('prompts');
  try {
    const result = await ask('FAKE-RESULT-DECISION {"next":"stop","risk":"low","clear":true}');
    assert.equal(result.status, 'answered');
    if (result.status !== 'answered') return;
    assert.equal(result.model, 'haiku');
    assert.equal(result.answers.next?.confidence, null);
    assert.deepEqual(result.answers.next, { kind: 'choice', value: 'stop', probabilities: null, confidence: null });
    assert.equal(result.answers.clear?.kind, 'noul');

    const argv = (lines(log('spawns'))[0] ?? '').split(' ');
    for (const flag of ['--restricted', '--tools=', '--setting-sources=', '--no-session-persistence', '--json-schema', '--max-budget-usd', '0.02']) {
      assert.ok(argv.includes(flag), `${flag} is passed`);
    }
    assert.ok(argv.join(' ').includes('--effort low'));
    assert.ok(argv.join(' ').includes('--model haiku'));
    assert.ok(!argv.includes('--add-dir'), 'no uploads directory');

    assert.deepEqual(JSON.parse(lines(log('envs'))[0] ?? '{}'), { url: null, token: null }, 'no API url and no minted token');
    assert.match(JSON.parse(lines(log('prompts'))[0] ?? '{}').prompt, /pasted_content/);
    assert.equal(core.runtime.list().length, 0, 'the chat was removed');
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    delete process.env.FAKE_CLAUDE_ENVS;
    delete process.env.FAKE_CLAUDE_PROMPTS;
    core.shutdown();
  }
});

test('an ordinary chat still gets the API url and token', async () => {
  const { core, log } = setup();
  process.env.FAKE_CLAUDE_ENVS = log('envs');
  try {
    core.runtime.start({ prompt: 'hi', keepAlive: false });
    for (let i = 0; i < 200 && !lines(log('envs'))[0]; i++) await new Promise((r) => setTimeout(r, 20));
    const env = JSON.parse(lines(log('envs'))[0] ?? '{}') as { url: string | null; token: string | null };
    assert.equal(env.url, 'http://127.0.0.1:34331/api');
    assert.ok(env.token);
  } finally {
    delete process.env.FAKE_CLAUDE_ENVS;
    core.shutdown();
  }
});

test('unavailable answers: max tokens, rate limit, unreadable answer, failure and timeout', async () => {
  const { core, ask } = setup();
  try {
    const answer = 'FAKE-RESULT-DECISION {"next":"stop","risk":"low","clear":true}';
    const cut = await ask(`FAKE-MAX-TOKENS\n${answer}`);
    assert.deepEqual(cut.status === 'unavailable' && cut.reason, 'max-tokens');

    const limited = await ask('FAKE-LIMIT-ONCE');
    assert.deepEqual(limited.status === 'unavailable' && limited.reason, 'rate-limited');

    const off = await ask('FAKE-RESULT-DECISION {"next":"later","risk":"low","clear":true}');
    assert.deepEqual(off.status === 'unavailable' && off.reason, 'invalid-answer');

    const none = await ask('nothing scripted');
    assert.deepEqual(none.status === 'unavailable' && none.reason, 'invalid-answer');

    const failed = await ask('FAKE-FAIL it broke');
    assert.deepEqual(failed.status === 'unavailable' && failed.reason, 'server-error');

    const slow = await ask('FAKE-HANG', 300);
    assert.deepEqual(slow.status === 'unavailable' && slow.reason, 'timeout');
    assert.equal(core.runtime.list().length, 0, 'even a chat that hung is removed');
  } finally {
    core.shutdown();
  }
});

test('an aborted request is unavailable and removes its chat', async () => {
  const { core, provider } = setup();
  try {
    const controller = new AbortController();
    const pending = provider.ask(request('FAKE-HANG'), { deadlineMs: 15_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.deepEqual(result.status === 'unavailable' && result.reason, 'timeout');
    assert.equal(core.runtime.list().length, 0);
  } finally {
    core.shutdown();
  }
});

// ---------- the provider the chat runs on (decision 9) ----------

const NOW = Date.parse('2026-10-02T12:00:00Z');
const CLI = { model: 'haiku', effort: 'low', maxCostUsd: 0.02 };

function candidate(id: string, over: Partial<CandidateProvider> = {}, st: Partial<ProviderStatus> = {}): CandidateProvider {
  return {
    status: { id, label: id, state: 'ready', reason: null, version: '1', compatibleRange: '*', binaryPath: null, configHome: null, account: null, capabilities: [], checkedAt: new Date(NOW).toISOString(), ...st },
    hasDriver: true,
    capabilities: ['structuredOutput', 'effort'],
    // The real translations: the decision chat's policy decides which provider may take it
    translate: id === 'codex' ? translateCodexPolicy : id === 'claude-code' ? translateClaudePolicy : null,
    models: [],
    efforts: ['low', 'medium'],
    ...over,
  };
}

const exhausted: Partial<ProviderStatus> = {
  limit: { provider: 'claude-code', state: 'exhausted', window: '5h', utilization: 1, resetsAt: new Date(NOW + 3_600_000).toISOString(), windows: {}, observedAt: new Date(NOW).toISOString(), source: 'stream' },
};

function context(providers: Record<string, CandidateProvider>, modelMap: ModelMapEntry[] = []): CandidateContext {
  const settings = defaultProvidersSettings(['claude-code', 'codex']);
  return { settings: { ...settings, rotation: { ...(settings.rotation as NonNullable<typeof settings.rotation>), modelMap } }, project: null, providers, now: NOW };
}

const HAIKU_TO_CODEX: ModelMapEntry = { from: { provider: 'claude-code', model: 'haiku' }, to: { provider: 'codex', model: 'gpt-5-mini' }, origin: 'person', at: '2026-10-01T00:00:00.000Z' };

test('the route is the first ready provider with structured output: Claude Code while it can answer', () => {
  const route = chooseCliRoute(CLI, context({ 'claude-code': candidate('claude-code'), codex: candidate('codex') }, [HAIKU_TO_CODEX]));
  assert.deepEqual(route, { provider: 'claude-code', model: 'haiku', effort: 'low' });
});

test('at its limit the chat goes to the next provider that has a model for the configured one', () => {
  const route = chooseCliRoute(CLI, context({ 'claude-code': candidate('claude-code', {}, exhausted), codex: candidate('codex') }, [HAIKU_TO_CODEX]));
  assert.deepEqual(route, { provider: 'codex', model: 'gpt-5-mini', effort: 'low' });
});

test('with an empty model mapping nothing else can answer, and the reason is the limit (decision P4-3)', () => {
  const route = chooseCliRoute(CLI, context({ 'claude-code': candidate('claude-code', {}, exhausted), codex: candidate('codex') }));
  assert.deepEqual(route, { unavailable: 'rate-limited' });
});

test('a Claude-only setup keeps the decision chat on Claude Code, and at its limit the answer is rate-limited', () => {
  assert.deepEqual(chooseCliRoute(CLI, context({ 'claude-code': candidate('claude-code') }, [HAIKU_TO_CODEX])), { provider: 'claude-code', model: 'haiku', effort: 'low' });
  assert.deepEqual(chooseCliRoute(CLI, context({ 'claude-code': candidate('claude-code', {}, exhausted) }, [HAIKU_TO_CODEX])), { unavailable: 'rate-limited' });
});

test('a provider that cannot enforce the no-tools policy does not take the chat', () => {
  const blind = chooseCliRoute(CLI, context({ 'claude-code': candidate('claude-code', {}, exhausted), codex: candidate('codex', { translate: null }) }, [HAIKU_TO_CODEX]));
  assert.deepEqual(blind, { unavailable: 'rate-limited' });
});

test('the decision policy allows no tool at all', () => {
  assert.deepEqual(DECISION_POLICY, { read: { allow: false }, edit: { allow: 'none' }, commands: { allow: 'none' }, network: 'deny', gitPush: 'deny' });
});

test('a provider without structured output is passed over, and no provider at all is a server error', () => {
  const noSchema = chooseCliRoute(CLI, context({ 'claude-code': candidate('claude-code', { capabilities: [] }, exhausted), codex: candidate('codex', { capabilities: [] }) }, [HAIKU_TO_CODEX]));
  assert.deepEqual(noSchema, { unavailable: 'server-error' });
  const nothing = chooseCliRoute(CLI, context({ 'claude-code': candidate('claude-code', {}, { state: 'not-installed', reason: null }) }));
  assert.deepEqual(nothing, { unavailable: 'server-error' });
});

test('the chat starts on the provider and the model the route names, and an unavailable route starts none', async () => {
  const { core } = setup();
  try {
    const started: NewChat[] = [];
    const runtime = {
      start: (opts: NewChat): never => {
        started.push(opts);
        throw new Error('stop here');
      },
      waitForResult: () => Promise.reject(new Error('unused')),
      stop: () => undefined,
      exited: () => Promise.resolve(),
      remove: () => false,
    };
    const routed = new CliDecisionProvider({ runtime, settings: core.decisionSettings, route: () => ({ provider: 'codex', model: 'gpt-5-mini', effort: null }) });
    const result = await routed.ask(request(''), { deadlineMs: 1_000, signal: new AbortController().signal });
    assert.equal(result.status === 'unavailable' && result.reason, 'server-error');
    assert.equal(started[0]?.provider, 'codex');
    assert.equal(started[0]?.model, 'gpt-5-mini');
    assert.equal(started[0]?.effort, undefined, 'the target keeps its own default effort');
    assert.deepEqual(started[0]?.confine, { tools: [], settingSources: [] });
    assert.deepEqual(started[0]?.toolConfig?.policy, DECISION_POLICY, 'the launch states the policy the route was chosen against');

    started.length = 0;
    const blocked = new CliDecisionProvider({ runtime, settings: core.decisionSettings, route: () => ({ unavailable: 'rate-limited' }) });
    const refused = await blocked.ask(request(''), { deadlineMs: 1_000, signal: new AbortController().signal });
    assert.deepEqual(refused.status === 'unavailable' && refused.reason, 'rate-limited');
    assert.equal(started.length, 0, 'no chat is started for a decision that cannot run');
  } finally {
    core.shutdown();
  }
});
