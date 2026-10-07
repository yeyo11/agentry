import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Core } from '../src/index.ts';
import { effortOption, resolveEffort } from '../src/effort.ts';
import { parseMemberRequest } from '../src/team.ts';
import { parseTeam } from '../src/project-settings.ts';
import { validateSpecSettings } from '../src/orchestrator.ts';
import { normalizeVerification } from '../src/verification.ts';
import { recommendedMemberEffort } from '../src/assistant-answer.ts';
import { tempConfig } from './helpers.ts';

// Effort reaches the CLI as `--effort <level>`, only when the provider declares `effort`, and each
// execution records what it was started with.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function setup() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  const log = join(config.dataDir, 'spawns.log');
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(log, '');
  process.env.FAKE_CLAUDE_SPAWNS = log;
  /** The argv of every process of a chat, oldest first */
  const spawns = (id: string): string[] => readFileSync(log, 'utf8').split('\n').filter((l) => l.includes(id));
  return { core, spawns };
}

const finished = (core: Core, id: string, executions: number) =>
  until(() => {
    const runtime = core.runtime.get(id);
    return runtime && runtime.executions.length === executions && runtime.executions.every((e) => e.endedAt !== null) && runtime;
  }, `${String(executions)} finished execution(s) of ${id}`);

test('a chat started with an effort passes --effort and records it on the execution', async () => {
  const { core, spawns } = setup();
  try {
    const chat = core.runtime.start({ prompt: 'hello', model: 'opus', effort: 'xhigh', keepAlive: false });
    const done = await finished(core, chat.id, 1);
    assert.equal(done.executions[0]?.effort, 'xhigh');
    assert.match(spawns(chat.id)[0] ?? '', /--effort xhigh/);
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    core.shutdown();
  }
});

test('a new chat with none takes the recommendation for its model, and none for a model it does not know', async () => {
  const { core, spawns } = setup();
  try {
    const sonnet = await core.chats.create({ prompt: 'hello', model: 'sonnet', keepAlive: false });
    const haiku = await core.chats.create({ prompt: 'hello', model: 'haiku', keepAlive: false });
    await finished(core, sonnet.id, 1);
    await finished(core, haiku.id, 1);
    assert.match(spawns(sonnet.id)[0] ?? '', /--effort medium/);
    assert.equal(core.runtime.get(sonnet.id)?.executions[0]?.effort, 'medium');
    assert.doesNotMatch(spawns(haiku.id)[0] ?? '', /--effort/);
    assert.equal(core.runtime.get(haiku.id)?.executions[0]?.effort, undefined);
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    core.shutdown();
  }
});

test('an effort that is not a level is refused with a 400, and so is one on a provider that does not declare effort', async () => {
  const { core } = setup();
  try {
    await assert.rejects(core.chats.create({ prompt: 'hello', effort: 'turbo', keepAlive: false }), (err: Error & { statusCode?: number }) => err.statusCode === 400 && /effort must be one of/.test(err.message));
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    core.shutdown();
  }
});

test('a resume goes on with the last execution\'s effort unless it is given another', async () => {
  const { core, spawns } = setup();
  try {
    const chat = await core.chats.create({ prompt: 'hello', model: 'opus', effort: 'high', keepAlive: false });
    await finished(core, chat.id, 1);
    await core.chats.resume(chat.id, { prompt: 'again' });
    await finished(core, chat.id, 2);
    assert.equal(core.runtime.get(chat.id)?.executions[1]?.effort, 'high');
    assert.match(spawns(chat.id)[1] ?? '', /--effort high/);
    await core.chats.resume(chat.id, { prompt: 'harder', effort: 'max' });
    await finished(core, chat.id, 3);
    assert.equal(core.runtime.get(chat.id)?.executions[2]?.effort, 'max');
    assert.match(spawns(chat.id)[2] ?? '', /--effort max/);
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    core.shutdown();
  }
});

test('resolveEffort takes the first level chosen, then the recommendation', () => {
  assert.equal(resolveEffort('worker', 'opus', undefined, 'low'), 'low');
  assert.equal(resolveEffort('worker', 'opus', 'max', 'low'), 'max');
  assert.equal(resolveEffort('worker', 'sonnet', null, undefined), 'medium');
  assert.equal(resolveEffort('fixer', 'sonnet'), 'high');
  assert.equal(resolveEffort('worker', 'haiku'), undefined);
  // an unknown level is not one: the next choice, or the recommendation, stands
  assert.equal(resolveEffort('worker', 'opus', 'turbo', 'high'), 'high');
  assert.deepEqual(effortOption(undefined), {});
  assert.deepEqual(effortOption('low'), { effort: 'low' });
});

test('a team member keeps a valid effort and refuses an unknown one', () => {
  const body = { role: 'developer', model: 'sonnet', responsibility: 'builds it' };
  assert.equal(parseMemberRequest('dev', { ...body, effort: 'high' }).member.effort, 'high');
  assert.equal(parseMemberRequest('dev', { ...body, effort: null }).member.effort, undefined);
  assert.throws(() => parseMemberRequest('dev', { ...body, effort: 'turbo' }), /effort must be one of/);
  const settings = (effort: unknown) => ({ members: [{ agent: 'dev', ...body, effort }] });
  assert.equal(parseTeam(settings('low')).members[0]?.effort, 'low');
  assert.throws(() => parseTeam(settings('turbo')), /effort/);
});

test('a spec, its tasks and its verification refuse an unknown effort and keep a valid one', () => {
  const task = { id: 'a', name: 'a', prompt: 'p' };
  assert.doesNotThrow(() => validateSpecSettings({ effort: 'max', tasks: [{ ...task, effort: 'low' }] }));
  assert.throws(() => validateSpecSettings({ effort: 'turbo' as never, tasks: [task] }), /effort must be one of/);
  assert.throws(() => validateSpecSettings({ tasks: [{ ...task, effort: 'turbo' as never }] }), /task 'a' effort/);
  assert.equal(normalizeVerification({ commands: ['true'], fixer: true, maxAttempts: 1, effort: 'high' })?.effort, 'high');
  assert.throws(() => normalizeVerification({ commands: ['true'], fixer: true, maxAttempts: 1, effort: 'turbo' as never }), /effort must be one of/);
});

test('the assistant recommends an effort and its reason for a member by its model', () => {
  assert.deepEqual(recommendedMemberEffort('opus'), { effort: 'medium', effortReason: 'opus-medium' });
  assert.deepEqual(recommendedMemberEffort('sonnet'), { effort: 'medium', effortReason: 'sonnet-medium' });
  assert.deepEqual(recommendedMemberEffort('haiku'), { effort: null, effortReason: null });
});
