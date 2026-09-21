import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { CancelCommandResult, ChatDetail, ChatSummary, Orchestration } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// Stepping in on a worker over HTTP: cancel one command, send a hint, and the health an
// orchestration carries for a task that is running. The CLI is a fake that runs a real process
// tree for `SLEEP`, so a cancel kills a real one.
const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude-control.mjs', import.meta.url));

let app: FastifyInstance;
let core: Core;
let workspace: string;

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-stuck-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: workspace,
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  for (const o of core.orchestrator.list()) core.orchestrator.stop(o.id);
  core.runtime.stopAll();
  await app.close();
  core.shutdown();
});

async function until<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function sleepingChat(): Promise<{ id: string; toolUseId: string }> {
  const created = await app.inject({ method: 'POST', url: '/api/chats', payload: { prompt: 'SLEEP 60' } });
  assert.equal(created.statusCode, 201);
  const id = created.json<ChatSummary>().id;
  const command = await until(() => core.runtime.pulse(id)?.commands[0], 'the command to start');
  return { id, toolUseId: command.toolUseId };
}

test('cancelling one command answers with what was killed, and a second try says it is no longer running', async () => {
  const { id, toolUseId } = await sleepingChat();
  const res = await app.inject({ method: 'POST', url: `/api/chats/${id}/commands/${toolUseId}/cancel`, payload: { reason: 'it hangs' } });
  assert.equal(res.statusCode, 200);
  const body = res.json<CancelCommandResult>();
  assert.equal(body.toolUseId, toolUseId);
  assert.equal(body.command, 'sleep 60');
  assert.ok(body.processes >= 2, 'the shell and what it started');

  // The turn goes on: the chat is working or idle, never failed by it
  await until(() => core.runtime.get(id)?.status === 'idle', 'the turn to end');
  const chat = await app.inject(`/api/chats/${id}`);
  assert.equal(chat.json<ChatDetail>().chat.executions.at(-1)?.outcome, null, 'its execution is still live');

  // Nothing left to cancel: refused with the reason, not a server error
  const again = await app.inject({ method: 'POST', url: `/api/chats/${id}/commands/${toolUseId}/cancel` });
  assert.equal(again.statusCode, 409);
  assert.match(again.json<{ error: string }>().error, /not a command that is running/);

  const unknown = await app.inject({ method: 'POST', url: `/api/chats/nope/commands/${toolUseId}/cancel` });
  assert.equal(unknown.statusCode, 404);
});

test('a chat that is running a command says so on its summary, in the list and on its own page', async () => {
  const { id } = await sleepingChat();
  const listed = (await app.inject('/api/chats')).json<ChatSummary[]>().find((chat) => chat.id === id);
  assert.deepEqual(listed?.activity, { kind: 'tool', tool: 'Bash', target: 'sleep 60', since: listed?.activity?.since ?? '' });
  const page = (await app.inject(`/api/chats/${id}`)).json<ChatDetail>().chat;
  assert.equal(page.activity?.tool, 'Bash');

  await app.inject({ method: 'POST', url: `/api/chats/${id}/stop` });
  await core.runtime.exited(id);
  const ended = (await app.inject(`/api/chats/${id}`)).json<ChatDetail>().chat;
  assert.equal(ended.activity, null, 'a chat with no process of ours is doing nothing');
});

test('the health of a chat that is running a command carries the call to cancel and a text to send', async () => {
  const { id, toolUseId } = await sleepingChat();
  await until(() => core.runtime.pulse(id)?.commands[0]?.heartbeat, 'the heartbeat');
  const quiet = (await app.inject(`/api/chats/${id}`)).json<ChatDetail>().chat.health;
  assert.equal(quiet.level, 'ok', 'ninety seconds is not worth a signal');

  // The same read, four minutes on, as the panel would poll it
  const health = core.health.read(id, { state: 'working', lastEnded: null, context: null, failedBranches: 0 }, Date.now() + 4 * 60_000);
  assert.equal(health.signals[0]?.kind, 'hung-command');
  assert.equal(health.signals[0]?.toolUseId, toolUseId);
  assert.ok(health.signals[0]?.hint);
  await app.inject({ method: 'POST', url: `/api/chats/${id}/stop` });
});

test('a hint is delivered to a working chat, and refused with a reason when there is nothing to nudge', async () => {
  const { id } = await sleepingChat();
  const ok = await app.inject({ method: 'POST', url: `/api/chats/${id}/hint`, payload: { text: 'look at what the suite waits on' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json<ChatSummary>().id, id);
  const said = core.runtime.events(id).flatMap((e) => e.entry?.blocks ?? []).flatMap((b) => (b.type === 'text' ? [b.text] : []));
  assert.ok(said.some((t) => t.includes('look at what the suite waits on')));

  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${id}/hint`, payload: { text: ' ' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/nope/hint`, payload: { text: 'hi' } })).statusCode, 404);

  await app.inject({ method: 'POST', url: `/api/chats/${id}/stop` });
  await core.runtime.exited(id);
  const stopped = await app.inject({ method: 'POST', url: `/api/chats/${id}/hint`, payload: { text: 'hi' } });
  assert.equal(stopped.statusCode, 409);
  assert.match(stopped.json<{ error: string }>().error, /no live process/);
});

test('an orchestration reports the health of the tasks that are running and takes limits on its tasks', async () => {
  const started = await app.inject({
    method: 'POST',
    url: '/api/orchestrations',
    payload: { name: 'limits', cwd: workspace, synthesize: false, limits: { maxMinutes: 30 }, tasks: [{ id: 'slow', name: 'slow', prompt: 'SLEEP 60', limits: { maxCostUsd: 2 } }] },
  });
  assert.equal(started.statusCode, 201);
  const orch = started.json<Orchestration>();
  assert.deepEqual(orch.limits, { maxMinutes: 30 });
  assert.deepEqual(orch.tasks[0]?.limits, { maxCostUsd: 2 });

  const running = await until(async () => {
    const got = (await app.inject(`/api/orchestrations/${orch.id}`)).json<Orchestration>();
    return got.tasks[0]?.status === 'running' && got.tasks[0].health && got.tasks[0].activity ? got : null;
  }, 'a running task with its health and what it is doing');
  assert.equal(running.tasks[0]?.health?.level, 'ok');
  assert.deepEqual(running.tasks[0]?.activity?.kind, 'tool', 'the board says what the worker is doing right now');
  assert.equal(running.tasks[0]?.activity?.target, 'sleep 60');
  const listed = (await app.inject('/api/orchestrations')).json<Orchestration[]>().find((o) => o.id === orch.id);
  assert.ok(listed?.tasks[0]?.health, 'the list carries it too');
  assert.ok(listed?.tasks[0]?.activity, 'and what it is doing');

  const bad = await app.inject({ method: 'POST', url: '/api/orchestrations', payload: { name: 'bad', cwd: workspace, tasks: [{ id: 'a', name: 'a', prompt: 'x', limits: { maxMinutes: -5 } }] } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json<{ error: string }>().error, /maxMinutes must be a number greater than zero/);
  await app.inject({ method: 'POST', url: `/api/orchestrations/${orch.id}/stop` });
});
