import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Orchestration } from '@agentry/shared';
import { chatsFromRuns, type LegacyRun } from '../src/chat-records.ts';
import { ChatConflictError } from '../src/chat-service.ts';
import { Db } from '../src/db.ts';
import { Core } from '../src/index.ts';
import { CHAT_TOKEN_MAX_AGE_MS, CHAT_TOKEN_PREFIX, ChatTokenStore } from '../src/security/chat-tokens.ts';
import { drivesSession } from '../src/processes.ts';
import { ModelAliasIds, modelOptions } from '../src/models.ts';
import { encodeProjectId } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

// Chats are one per session id: however many times one is resumed, however it is read, it is one row.
// Executions are what a process did on it, and whether something else holds the session is decided on
// the server when a client asks to continue it.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

async function until<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function setup() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  return { config, core };
}

/** A transcript the CLI wrote for a chat Agentry never drove, e.g. one started in a terminal. */
function terminalChat(config: ReturnType<typeof tempConfig>, sessionId: string): string {
  // A real directory, since resuming the chat starts a process in it
  const cwd = join(config.workspaceDir, 'terminal-project');
  mkdirSync(cwd, { recursive: true });
  const dir = join(config.projectsDir, encodeProjectId(cwd));
  mkdirSync(dir, { recursive: true });
  const at = '2026-01-01T10:00:00Z';
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    [
      { type: 'user', uuid: 'u1', timestamp: at, cwd, sessionId, message: { role: 'user', content: 'refactor the parser' } },
      { type: 'assistant', uuid: 'a1', timestamp: at, cwd, sessionId, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }] } },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n'),
  );
  return cwd;
}

/** What `claude agents --json` reports for sessions open somewhere else. */
function reportOpen(config: ReturnType<typeof tempConfig>, ...sessionIds: string[]): void {
  const file = join(config.dataDir, 'agents.json');
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(sessionIds.map((sessionId) => ({ pid: 4_000_000, cwd: '/work/terminal', kind: 'interactive', startedAt: 1, sessionId, name: 'terminal', status: 'busy' }))));
  process.env.FAKE_CLAUDE_AGENTS = file;
}

/** Its process is up and waiting for the next message. */
const idle = (core: Core, id: string) => until(() => core.runtime.get(id)?.status === 'idle' && core.runtime.get(id), `${id} to be idle`);

const finished = (core: Core, id: string, executions: number) =>
  until(() => {
    const runtime = core.runtime.get(id);
    return runtime && runtime.executions.length === executions && runtime.executions.every((e) => e.endedAt !== null) && runtime;
  }, `${String(executions)} finished execution(s) of ${id}`);

// ---------- the models the aliases stand for ----------

test("a chat started on an alias records the model its system/init reports, which names the alias in the picker", async () => {
  process.env.FAKE_CLAUDE_MODEL_IDS = JSON.stringify({ sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5[1m]' });
  const { config, core } = setup();
  try {
    const named = (value: string) => modelOptions(config.globalConfigFile, core.runtime.modelIds.get()).find((m) => m.value === value)?.label;
    // Before any chat ran on it, the alias stands alone
    assert.equal(named('sonnet'), undefined);
    const chat = core.runtime.start({ prompt: 'hello', model: 'sonnet', keepAlive: false });
    await finished(core, chat.id, 1);
    assert.deepEqual(core.runtime.modelIds.get(), { sonnet: 'claude-sonnet-5' });
    assert.equal(named('sonnet'), 'Sonnet 5');
    assert.equal(named('opus'), undefined);
    // A chat started on a full id, or on none, says nothing about an alias
    const full = core.runtime.start({ prompt: 'hello', model: 'claude-opus-5-5[1m]', keepAlive: false });
    const plain = core.runtime.start({ prompt: 'hello', keepAlive: false });
    await finished(core, full.id, 1);
    await finished(core, plain.id, 1);
    assert.deepEqual(core.runtime.modelIds.get(), { sonnet: 'claude-sonnet-5' });
    // And it is still known after a restart
    await core.runtime.modelIds.settled();
    assert.deepEqual(new ModelAliasIds(config.dataDir).get(), { sonnet: 'claude-sonnet-5' });
  } finally {
    delete process.env.FAKE_CLAUDE_MODEL_IDS;
    core.shutdown();
  }
});

// ---------- why an execution failed ----------

test("a process that dies with an error says why: the last lines of its stderr are the execution's error", async () => {
  const core = new Core({ ...tempConfig(), claudeBin: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url)) });
  try {
    // The fake exits 1 at once with this line on stderr, as the CLI does with an option it refuses
    const chat = core.runtime.start({ prompt: 'hello', model: 'fake-refused', keepAlive: false });
    const done = await finished(core, chat.id, 1);
    const execution = done.executions[0];
    assert.equal(execution?.outcome, 'failed');
    // The chat is finalized once the streams have been read to the end, not when the process exits
    assert.match(execution?.error ?? '', /model 'fake-refused' not found/);
  } finally {
    core.shutdown();
  }
});

// ---------- one chat per session ----------

test('resuming a chat adds an execution to it and never a second chat', async () => {
  const { core } = setup();
  try {
    const first = core.runtime.start({ prompt: 'hello', keepAlive: false });
    await finished(core, first.id, 1);

    // The same conversation, continued: same id, one more execution
    const resumed = await core.chats.resume(first.id, { prompt: 'and again' });
    assert.equal(resumed.id, first.id);
    await finished(core, first.id, 2);

    const listed = (await core.chats.list()).filter((c) => c.id === first.id);
    assert.equal(listed.length, 1, 'one row for one conversation');
    assert.deepEqual(listed[0]?.executions.map((e) => e.outcome), ['completed', 'completed']);
    assert.equal(core.runtime.list().length, 1);
  } finally {
    core.shutdown();
  }
});

test('a chat is its session id from the first instant, and the fork of one is a new chat that says where it came from', async () => {
  const { core } = setup();
  try {
    const original = core.runtime.start({ prompt: 'hello', keepAlive: false });
    await finished(core, original.id, 1);

    const fork = await core.chats.fork(original.id, { prompt: 'try it differently' });
    // Known before the CLI has answered anything: nothing waits on its first event to name the copy
    assert.notEqual(fork.id, original.id);
    assert.equal(fork.derivedFrom?.chatId, original.id);
    assert.ok(fork.derivedFrom?.at);
    assert.equal((await core.chats.list()).filter((c) => c.id === fork.id).length, 1, 'never two rows while the copy is being made');

    await idle(core, fork.id);
    const listed = await core.chats.list();
    assert.equal(listed.filter((c) => c.id === fork.id).length, 1);
    assert.equal(listed.filter((c) => c.id === original.id).length, 1);
    // The original was left as it was
    assert.equal(listed.find((c) => c.id === original.id)?.executions.length, 1);
    assert.equal(listed.find((c) => c.id === original.id)?.derivedFrom, null);
  } finally {
    core.shutdown();
  }
});

// ---------- execution history ----------

test('an execution records how it ended and what it cost, and the chat adds them up', async () => {
  const { core } = setup();
  try {
    const started = core.runtime.start({ prompt: 'work', keepAlive: false });
    const done = await finished(core, started.id, 1);
    assert.equal(done.executions[0]?.outcome, 'completed');
    assert.equal(done.executions[0]?.costUsd, 0.01);
    assert.equal(done.executions[0]?.turns, 1);
    assert.ok(done.executions[0]?.endedAt);

    await core.chats.resume(started.id, { prompt: 'more' });
    await finished(core, started.id, 2);
    const chat = await core.chats.get(started.id);
    assert.equal(chat?.executions.length, 2);
    assert.equal(chat?.cost.usd, 0.02, 'the cost of a chat is what its executions cost');
    assert.equal(chat?.execution, null, 'nothing is live once both have ended');
  } finally {
    core.shutdown();
  }
});

test('a chat is told which wrapper runs it, and never inherits the address of another', async () => {
  const config = tempConfig();
  const log = join(config.dataDir, 'env.log');
  const claude = join(config.dataDir, 'claude');
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(claude, `#!/bin/sh\necho "$AGENTRY_CHAT_ID|$AGENTRY_API_URL" >> "${log}"\n`);
  chmodSync(claude, 0o755);
  const inherited = process.env.AGENTRY_API_URL;
  // The wrapper itself was started from a chat of another one
  process.env.AGENTRY_API_URL = 'http://127.0.0.1:1/api';
  const core = new Core({ ...config, claudeBin: claude });
  try {
    const before = core.runtime.start({ prompt: 'hi', keepAlive: false });
    const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
    assert.equal(await until(() => lines()[0], 'the first launch'), `${before.id}|`, 'no address until the API listens');

    core.runtime.apiUrl = 'http://127.0.0.1:34331/api';
    const after = core.runtime.start({ prompt: 'hi', keepAlive: false });
    assert.equal(await until(() => lines()[1], 'the second launch'), `${after.id}|http://127.0.0.1:34331/api`);
  } finally {
    if (inherited === undefined) delete process.env.AGENTRY_API_URL;
    else process.env.AGENTRY_API_URL = inherited;
    core.shutdown();
  }
});

// ---------- the chat's own API token ----------

/**
 * A CLI that writes `<chat id>|<AGENTRY_API_TOKEN>` and then either exits, or stays up while the
 * file named by $HOLD_FILE exists, so a test can look at a token while its process lives.
 */
function tokenCli() {
  const config = tempConfig();
  const log = join(config.dataDir, 'env.log');
  const hold = join(config.dataDir, 'hold');
  const claude = join(config.dataDir, 'claude');
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(claude, `#!/bin/sh\necho "$AGENTRY_CHAT_ID|$AGENTRY_API_TOKEN" >> "${log}"\nif [ -f "${hold}" ]; then exec sleep 30; fi\n`);
  chmodSync(claude, 0o755);
  const core = new Core({ ...config, claudeBin: claude });
  core.runtime.apiUrl = 'http://127.0.0.1:34331/api';
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const tokenOf = async (n: number) => (await until(() => lines()[n], `launch ${String(n + 1)}`)).split('|')[1] ?? '';
  return { core, hold, tokenOf };
}

type ProcOf = { chats: Map<string, { proc: import('node:child_process').ChildProcess | null }> };

/** Whether the chat's process has exited, as its status tells after the exit was handled. */
const exited = (core: Core, id: string) => ['completed', 'failed', 'stopped'].includes(core.runtime.get(id)?.status ?? '');

test("a chat's process gets its own API token, never the one the wrapper inherited", async () => {
  const inherited = process.env.AGENTRY_API_TOKEN;
  // The wrapper itself was started from a chat of another one
  process.env.AGENTRY_API_TOKEN = 'agc_the-other-wrappers-token';
  const { core, tokenOf } = tokenCli();
  try {
    core.runtime.start({ prompt: 'hi', keepAlive: false });
    const token = await tokenOf(0);
    assert.ok(token.startsWith(CHAT_TOKEN_PREFIX), 'a recognisable prefix');
    assert.notEqual(token, 'agc_the-other-wrappers-token');
    // 32 random bytes in base64url
    assert.equal(Buffer.from(token.slice(CHAT_TOKEN_PREFIX.length), 'base64url').length, 32);
  } finally {
    if (inherited === undefined) delete process.env.AGENTRY_API_TOKEN;
    else process.env.AGENTRY_API_TOKEN = inherited;
    core.shutdown();
  }
});

test('a chat is handed no token while the wrapper has no API address', async () => {
  const { core, tokenOf } = tokenCli();
  core.runtime.apiUrl = null;
  try {
    core.runtime.start({ prompt: 'hi', keepAlive: false });
    assert.equal(await tokenOf(0), '');
    assert.equal(core.security.chatTokens.size, 0);
  } finally {
    core.shutdown();
  }
});

test("a chat token works while its process lives and is revoked when it exits", async () => {
  const { core, hold, tokenOf } = tokenCli();
  try {
    writeFileSync(hold, '');
    const chat = core.runtime.start({ prompt: 'hi', keepAlive: false });
    const token = await tokenOf(0);
    // The guard reads the same store the process was minted from
    assert.equal(core.security.chatTokens.verify(token), chat.id);
    core.runtime.stop(chat.id);
    await until(() => core.security.chatTokens.verify(token) === null, 'the token to be revoked');
  } finally {
    core.shutdown();
  }
});

test('each turn of a chat gets a different token, and the earlier one is refused', async () => {
  const { core, tokenOf } = tokenCli();
  try {
    const chat = core.runtime.start({ prompt: 'hi', keepAlive: false });
    const first = await tokenOf(0);
    await until(() => exited(core, chat.id), 'the first turn to end');
    core.runtime.send(chat.id, 'again');
    const second = await tokenOf(1);
    assert.notEqual(second, first);
    assert.equal(core.security.chatTokens.verify(first), null);
  } finally {
    core.shutdown();
  }
});

test("a late exit from a chat's earlier process leaves the current process's token valid", async () => {
  const { core, hold, tokenOf } = tokenCli();
  try {
    const chat = core.runtime.start({ prompt: 'hi', keepAlive: false });
    await tokenOf(0);
    await until(() => exited(core, chat.id), 'the first turn to end');
    const earlier = (core.runtime as unknown as ProcOf).chats.get(chat.id)?.proc;
    assert.ok(earlier);
    writeFileSync(hold, '');
    core.runtime.send(chat.id, 'again');
    const current = await tokenOf(1);
    // What an exit event arriving after the next process started looks like
    earlier.emit('exit', 1, null);
    assert.equal(core.security.chatTokens.verify(current), chat.id);
  } finally {
    core.shutdown();
  }
});

test('stopping every chat revokes every chat token', async () => {
  const { core, hold, tokenOf } = tokenCli();
  try {
    writeFileSync(hold, '');
    core.runtime.start({ prompt: 'one', keepAlive: false });
    core.runtime.start({ prompt: 'two', keepAlive: false });
    const tokens = [await tokenOf(0), await tokenOf(1)];
    assert.ok(tokens.every((token) => core.security.chatTokens.verify(token) !== null));
    core.runtime.stopAll();
    // At once, not when the processes get round to exiting
    assert.ok(tokens.every((token) => core.security.chatTokens.verify(token) === null));
  } finally {
    core.shutdown();
  }
});

test('a chat token older than its maximum age is refused even while its process lives', async () => {
  const { core, hold, tokenOf } = tokenCli();
  let clock = Date.now();
  core.runtime.chatTokens = new ChatTokenStore(() => clock);
  try {
    writeFileSync(hold, '');
    const chat = core.runtime.start({ prompt: 'hi', keepAlive: false });
    const token = await tokenOf(0);
    clock += CHAT_TOKEN_MAX_AGE_MS - 1;
    assert.equal(core.runtime.chatTokens.verify(token), chat.id);
    clock += 1;
    assert.equal(core.runtime.chatTokens.verify(token), null);
    assert.ok(!exited(core, chat.id), 'the process is still up');
  } finally {
    core.shutdown();
  }
});

test('a stopped execution says it was stopped, and the chat is idle rather than failed', async () => {
  const { core } = setup();
  try {
    const started = core.runtime.start({ prompt: 'ASK Bash', permissionPrompts: 'host' });
    await until(() => core.permissions.list(started.id)[0], 'the prompt');
    // Stopped for a person: a chat waiting on a permission is `waiting`, not `working`
    assert.equal((await core.chats.get(started.id))?.state, 'waiting');
    assert.equal((await core.chats.get(started.id))?.control.mode, 'interactive');

    await core.chats.stop(started.id);
    const ended = await finished(core, started.id, 1);
    assert.equal(ended.executions[0]?.outcome, 'stopped');
    const chat = await core.chats.get(started.id);
    assert.equal(chat?.state, 'idle');
    assert.equal(chat?.control.mode, 'resumable');
  } finally {
    core.shutdown();
  }
});

test('a chat that reported no cost reads as not available, not as free', async () => {
  const { config, core } = setup();
  try {
    terminalChat(config, 'no-cost');
    const chat = await core.chats.get('no-cost');
    assert.equal(chat?.cost.usd, null);
    assert.deepEqual(chat?.executions, []);
  } finally {
    core.shutdown();
  }
});

// ---------- the guard on continuing a chat ----------

test('a chat born in a terminal that nothing holds is adopted in place when resumed', async () => {
  const { config, core } = setup();
  try {
    terminalChat(config, 'from-terminal');
    const before = await core.chats.get('from-terminal');
    assert.equal(before?.origin, 'external');
    assert.equal(before?.control.mode, 'resumable');

    const resumed = await core.chats.resume('from-terminal', { prompt: 'carry on' });
    assert.equal(resumed.id, 'from-terminal', 'the same chat: no second one appears');
    await idle(core, 'from-terminal');

    const listed = (await core.chats.list()).filter((c) => c.id === 'from-terminal' || c.derivedFrom !== null);
    assert.equal(listed.length, 1);
    // Where it was born and what can be done with it now are different questions
    assert.equal(listed[0]?.origin, 'external');
    assert.equal(listed[0]?.control.mode, 'interactive');
    assert.equal(listed[0]?.executions.length, 1);
    assert.equal(listed[0]?.state, 'idle');
  } finally {
    core.shutdown();
  }
});

test('a chat a terminal holds is read-only and refuses to be resumed, and the fork is the way forward', async () => {
  const { config, core } = setup();
  try {
    terminalChat(config, 'held');
    reportOpen(config, 'held');

    const chat = await core.chats.get('held');
    assert.equal(chat?.control.mode, 'readOnly');
    assert.equal(chat?.control.mode === 'readOnly' && chat.control.action, 'fork');

    await assert.rejects(core.chats.resume('held', { prompt: 'me too' }), (err: unknown) => {
      assert.ok(err instanceof ChatConflictError);
      assert.equal(err.statusCode, 409);
      assert.equal(err.action, 'fork');
      assert.match(err.message, /terminal/);
      return true;
    });
    assert.equal(core.runtime.get('held'), null, 'no process, and no record, was made for a refused resume');

    const fork = await core.chats.fork('held', { prompt: 'in a copy' });
    assert.equal(fork.derivedFrom?.chatId, 'held');
    assert.notEqual(fork.id, 'held');
  } finally {
    delete process.env.FAKE_CLAUDE_AGENTS;
    core.shutdown();
  }
});

test('whether a chat is held is read at resume time, not from what an earlier read left cached', async () => {
  const { config, core } = setup();
  try {
    terminalChat(config, 'opened-just-now');
    // A client looks at the chat: nothing holds it, and that is what the short cache now says
    assert.equal((await core.chats.get('opened-just-now'))?.control.mode, 'resumable');

    // A terminal opens it a moment later, well inside the cache's lifetime
    reportOpen(config, 'opened-just-now');
    await assert.rejects(core.chats.resume('opened-just-now', { prompt: 'go' }), ChatConflictError);
    assert.equal(core.runtime.get('opened-just-now'), null);
  } finally {
    delete process.env.FAKE_CLAUDE_AGENTS;
    core.shutdown();
  }
});

test('a process on the session that the CLI does not list still holds it', async () => {
  const { config, core } = setup();
  const sessionId = randomUUID();
  // An SDK host or another wrapper: stream-json on stdin and the session on --resume, never in `agents`
  const other = spawn(FAKE_CLAUDE, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--resume', sessionId], { stdio: 'pipe' });
  try {
    terminalChat(config, sessionId);
    await until(() => other.pid !== undefined, 'the other process to start');
    await new Promise((r) => setTimeout(r, 150));

    await assert.rejects(core.chats.resume(sessionId, { prompt: 'me too' }), ChatConflictError);
    assert.equal(core.runtime.get(sessionId), null);

    other.kill('SIGKILL');
    await until(() => other.exitCode !== null || other.signalCode !== null, 'the other process to exit');
    // Nothing holds it now, so the same request goes through
    await core.chats.resume(sessionId, { prompt: 'now it is mine' });
    assert.equal(core.runtime.get(sessionId)?.origin, 'external');
  } finally {
    other.kill('SIGKILL');
    core.shutdown();
  }
});

test('a chat that belongs to an orchestration is read-only whoever holds it, and fork is the way forward', async () => {
  const { core } = setup();
  try {
    const worker = core.runtime.start({ prompt: 'task', keepAlive: false, name: 'graph:a' }, { orchestrationId: 'orch-1', orchestrationTaskId: 'a' });
    await finished(core, worker.id, 1);

    const chat = await core.chats.get(worker.id);
    assert.equal(chat?.origin, 'orchestration');
    assert.equal(chat?.control.mode, 'readOnly');
    await assert.rejects(core.chats.resume(worker.id, { prompt: 'sneak a turn in' }), (err: unknown) => err instanceof ChatConflictError && err.action === 'fork');
    await assert.rejects(core.chats.send(worker.id, { text: 'or this' }), ChatConflictError);
    assert.equal(core.runtime.get(worker.id)?.executions.length, 1, 'nothing was added to a chat the graph already used');

    // Workers stay out of the list unless asked for
    assert.equal((await core.chats.list()).some((c) => c.id === worker.id), false);
    assert.equal((await core.chats.list({ origins: ['orchestration'] })).some((c) => c.id === worker.id), true);
    // A list that hides workers can leave them out while still asking for the syntheses
    assert.equal((await core.chats.list({ origins: ['orchestration'], workers: false })).some((c) => c.id === worker.id), false);
  } finally {
    core.shutdown();
  }
});

test('a message goes only to a chat with a live execution; any other is told to resume', async () => {
  const { core } = setup();
  try {
    const started = core.runtime.start({ prompt: 'hi', keepAlive: false });
    await finished(core, started.id, 1);
    await assert.rejects(core.chats.send(started.id, { text: 'hello?' }), /resume/);
  } finally {
    core.shutdown();
  }
});

test('the processes that drive a session are recognised by the id they were given, a fork by the copy it writes', () => {
  const base = ['-p', '--input-format', 'stream-json'];
  assert.equal(drivesSession([...base, '--resume', 'a'], 'a'), true);
  assert.equal(drivesSession([...base, '--session-id', 'a'], 'a'), true);
  assert.equal(drivesSession([...base, '--resume', 'a'], 'b'), false);
  // A fork reads the session it resumes but only writes its copy: the original is not held by it
  const fork = [...base, '--resume', 'a', '--fork-session', '--session-id', 'copy'];
  assert.equal(drivesSession(fork, 'a'), false);
  assert.equal(drivesSession(fork, 'copy'), true);
  assert.equal(drivesSession(['-p', '--resume', 'a'], 'a'), false, 'a terminal has no stream-json on stdin');
});

// ---------- the migration of what an older wrapper stored ----------

const run = (id: string, sessionId: string | null, createdAt: string, extra: Partial<LegacyRun> = {}): LegacyRun => ({
  id,
  name: id,
  sessionId,
  cwd: '/work/app',
  model: 'claude-opus-5',
  permissionMode: 'acceptEdits',
  status: 'completed',
  createdAt,
  updatedAt: createdAt,
  endedAt: createdAt,
  turns: 2,
  costUsd: 0.4,
  prompt: `prompt of ${id}`,
  lastText: null,
  error: null,
  orchestrationId: null,
  orchestrationTaskId: null,
  internal: false,
  account: null,
  ...extra,
});

test('the runs of one session fold into one chat with an execution each, and what could not start leaves nothing', () => {
  const { chats, chatOf } = chatsFromRuns([
    run('r2', 'S', '2026-01-02T10:00:00Z', { status: 'busy', endedAt: null, turns: 0, costUsd: 0 }),
    run('r1', 'S', '2026-01-01T10:00:00Z', { costUsd: 0.4 }),
    run('r3', 'T', '2026-01-03T10:00:00Z', { internal: true }),
    run('r4', null, '2026-01-04T10:00:00Z', { status: 'failed', error: 'spawn ENOENT' }),
  ]);
  assert.deepEqual(chats.map((c) => c.record.id).sort(), ['S', 'T']);
  const s = chats.find((c) => c.record.id === 'S');
  // Oldest first, whatever order they were stored in
  assert.deepEqual(s?.executions.map((e) => e.id), ['r1', 'r2']);
  // Alive when the wrapper went away and nobody stopped it: interrupted, not stopped
  assert.deepEqual(s?.executions.map((e) => e.outcome), ['completed', 'interrupted']);
  assert.ok(s?.executions.every((e) => e.endedAt !== null));
  // A run that answered nothing has no cost figure; one that did keeps the CLI's
  assert.deepEqual(s?.executions.map((e) => e.costUsd), [0.4, null]);
  assert.equal(s?.record.prompt, 'prompt of r1');
  assert.equal(chats.find((c) => c.record.id === 'T')?.record.origin, 'internal');
  assert.equal(chatOf.get('r2'), 'S');
  assert.equal(chatOf.has('r4'), false);
});

test('opening a store written before chats rewrites it once, and the documents that pointed at a run point at its chat', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  // The store as the last release left it: version 4, a `runs` table, documents pointing at run ids
  const old = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  old.exec(`
    CREATE TABLE rotation_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, event TEXT NOT NULL, from_acct TEXT, to_acct TEXT, reason TEXT, detail TEXT, raw TEXT);
    CREATE TABLE runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE orchestrations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE plan_drafts (run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, objective TEXT, json TEXT NOT NULL);
    CREATE TABLE environments (cwd TEXT PRIMARY KEY, observed_at TEXT NOT NULL, json TEXT NOT NULL);
    PRAGMA user_version = 4;
  `);
  const save = old.prepare('INSERT INTO runs (id, created_at, json) VALUES (?, ?, ?)');
  for (const r of [run('run-a', 'session-1', '2026-01-01T10:00:00Z'), run('run-b', 'session-1', '2026-01-02T10:00:00Z'), run('run-lost', null, '2026-01-03T10:00:00Z')]) {
    save.run(r.id, r.createdAt, JSON.stringify(r));
  }
  const orchestration = {
    id: 'orch-1',
    name: 'graph',
    tasks: [
      { id: 'a', runId: 'run-a', sessionId: 'session-1' },
      { id: 'b', runId: 'run-lost', sessionId: null },
    ],
    synthesisRunId: 'run-b',
    workflow: { runId: 'run-a' },
  };
  old.prepare('INSERT INTO orchestrations (id, created_at, json) VALUES (?, ?, ?)').run('orch-1', '2026-01-01T00:00:00Z', JSON.stringify(orchestration));
  old.prepare('INSERT INTO plan_drafts (run_id, created_at, objective, json) VALUES (?, ?, ?, ?)').run('run-a', '2026-01-01T00:00:00Z', 'goal', JSON.stringify({ name: 'p', tasks: [] }));
  old.prepare('INSERT INTO plan_drafts (run_id, created_at, objective, json) VALUES (?, ?, ?, ?)').run('run-lost', '2026-01-01T00:00:00Z', 'gone', JSON.stringify({ name: 'q', tasks: [] }));
  old.prepare('INSERT INTO environments (cwd, observed_at, json) VALUES (?, ?, ?)').run('/work/app', '2026-01-01T00:00:00Z', JSON.stringify({ cwd: '/work/app', runId: 'run-b', tools: [] }));
  old.close();

  const db = new Db(config);
  const chats = db.loadChats();
  assert.deepEqual(chats.map((c) => c.record.id), ['session-1']);
  assert.deepEqual(chats[0]?.executions.map((e) => e.id), ['run-a', 'run-b']);

  const [migrated] = db.loadOrchestrations() as unknown as Array<Orchestration & { workflow: { runId: string | null } }>;
  assert.deepEqual(migrated?.tasks.map((t) => t.runId), ['session-1', null]);
  assert.equal(migrated?.synthesisRunId, 'session-1');
  assert.equal(migrated?.workflow.runId, 'session-1');
  assert.deepEqual(db.planDrafts().map((d) => d.runId), ['session-1']);
  assert.equal(db.loadEnvironments()[0]?.chatId, 'session-1');
  db.close();

  // Nothing reads the old shape any more: the table is gone, and a second open leaves the rest alone
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'runs'").get(), undefined);
  raw.close();
  const again = new Db(config);
  assert.equal(again.loadChats().length, 1);
  assert.equal(again.loadChats()[0]?.executions.length, 2);
  again.close();
});

test('the synthesis of an orchestration is answered in place, while its workers stay closed', async () => {
  const { core, config } = setup();
  try {
    const started = core.orchestrator.create({ name: 'report', cwd: config.workspaceDir, synthesize: true, tasks: [{ id: 'a', name: 'a', prompt: 'work' }] });
    const orch = await until(() => {
      const current = core.orchestrator.get(started.id);
      return current?.status === 'completed' ? current : null;
    }, 'the graph to finish');
    const synthesis = orch.synthesisRunId;
    assert.ok(synthesis);
    await core.runtime.exited(synthesis);

    // Nothing follows its run and it is the deliverable, so a person can go on with it
    assert.equal((await core.chats.get(synthesis))?.control.mode, 'resumable');
    await core.chats.resume(synthesis, { prompt: 'expand on the second point' });
    assert.equal(core.runtime.get(synthesis)?.executions.length, 2, 'the same chat, one more execution');

    const worker = orch.tasks[0]?.sessionId;
    assert.ok(worker);
    assert.equal((await core.chats.get(worker))?.control.mode, 'readOnly');
  } finally {
    core.shutdown();
  }
});

test('what a chat is running shows the shell commands it started and has not had an answer to', async () => {
  const { core } = setup();
  try {
    const started = core.runtime.start({ prompt: 'BASH pnpm e2e --slow' });
    const pulse = await until(() => core.runtime.pulse(started.id)?.commands[0] && core.runtime.pulse(started.id), 'the command to start');
    assert.equal(pulse.commands.length, 1);
    assert.equal(pulse.commands[0]?.command, 'pnpm e2e --slow');
    assert.ok(Date.parse(pulse.lastEventAt) >= Date.parse(pulse.commands[0]?.startedAt ?? ''));
    // Seconds old is no reason to worry: the limits are in minutes, which chat-model.test covers with a clock of its own
    const chat = await core.chats.get(started.id);
    assert.equal(chat?.health.level, 'ok');
    assert.equal(chat?.health.reason, 'Nothing unusual.');

    await core.chats.stop(started.id);
    await finished(core, started.id, 1);
    assert.equal(core.runtime.pulse(started.id), null);
  } finally {
    core.shutdown();
  }
});

test("the CLI's list of sessions is read once for everyone asking at the same time, and again once invalidated", async (t) => {
  // A read is stamped when it starts, so one that takes longer than the fresh window (a loaded
  // machine boots the fake CLI slowly) is served stale and read again in the background, and that
  // read lands in the log mid-test. Frozen time keeps every read fresh, which is what the counts
  // below are about; only `Date` is frozen, so the exec's own timers still run.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { config, core } = setup();
  const log = join(config.dataDir, 'spawns.log');
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(log, '');
  process.env.FAKE_CLAUDE_SPAWNS = log;
  const reads = () => readFileSync(log, 'utf8').split('\n').filter((l) => / agents --json$/.test(l)).length;
  try {
    core.chats.forgetHolders();
    await Promise.all([core.chats.cliSessions(), core.chats.cliSessions(), core.chats.list(), core.chats.allActivity()]);
    assert.equal(reads(), 1, 'one exec shared by every caller');
    await core.chats.list();
    assert.equal(reads(), 1, 'served from what was read while it is fresh');
    core.chats.forgetHolders();
    await core.chats.cliSessions();
    assert.equal(reads(), 2, 'read again once invalidated');
    await Promise.all([core.chats.cliSessions(), core.chats.cliSessions(true)]);
    assert.equal(reads(), 3, 'a fresh caller reads again even when what was read is fresh');
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    core.shutdown();
  }
});
