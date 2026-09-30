import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { DecisionQuestion } from '@agentry/shared';
import { Core } from '../src/index.ts';
import { CliDecisionProvider, decisionPrompt, decisionSchema, parseAnswers } from '../src/decisions/providers/cli.ts';
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
