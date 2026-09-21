import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { ChatSummary, SupervisorConfig, SupervisorProposal } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// The supervisor over HTTP: its settings, and a person sending or dismissing what it proposed. The
// proposals are written as the supervisor would write them, so no model is asked anything here.
const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude-control.mjs', import.meta.url));

let app: FastifyInstance;
let core: Core;

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-supervisor-'));
  const workspace = join(root, 'workspace');
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

const proposal = (over: Partial<SupervisorProposal>): SupervisorProposal => ({
  id: `p-${Math.random().toString(36).slice(2)}`,
  chatId: 'nobody',
  signal: 'hung-command',
  hint: 'Is a connection left open?',
  costUsd: 0.001,
  at: new Date().toISOString(),
  status: 'proposed',
  ...over,
});

test('the settings read as off by default and are replaced whole', async () => {
  const read = await app.inject({ method: 'GET', url: '/api/settings/supervisor' });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), { enabled: false, model: 'haiku', autoSend: false, maxCostUsd: 0.05 });

  const next: SupervisorConfig = { enabled: true, model: 'haiku', autoSend: false, maxCostUsd: 0.02 };
  const put = await app.inject({ method: 'PUT', url: '/api/settings/supervisor', payload: next });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), next);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/settings/supervisor' })).json(), next);

  const bad = await app.inject({ method: 'PUT', url: '/api/settings/supervisor', payload: { ...next, maxCostUsd: -1 } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json<{ error: string }>().error, /maxCostUsd/);
  await app.inject({ method: 'PUT', url: '/api/settings/supervisor', payload: { ...next, enabled: false } });
});

test('a proposal is sent to its chat once, dismissed once, and found only under its own chat or task', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/chats', payload: { prompt: 'SLEEP 60' } });
  assert.equal(created.statusCode, 201);
  const id = created.json<ChatSummary>().id;
  await until(() => core.runtime.pulse(id)?.commands[0], 'the command to start');

  const toSend = proposal({ chatId: id });
  const toDismiss = proposal({ chatId: id, signal: 'loop' });
  assert.ok(core.db.saveProposal(toSend));
  assert.ok(core.db.saveProposal(toDismiss));

  const elsewhere = await app.inject({ method: 'POST', url: `/api/chats/another/supervisor/${toSend.id}/send` });
  assert.equal(elsewhere.statusCode, 404);

  const sent = await app.inject({ method: 'POST', url: `/api/chats/${id}/supervisor/${toSend.id}/send` });
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.json<SupervisorProposal>().status, 'sent');
  const said = core.runtime.events(id).flatMap((e) => e.entry?.blocks ?? []).flatMap((b) => (b.type === 'text' ? [b.text] : []));
  assert.ok(said.some((t) => t.startsWith('A hint from the person following this chat') && t.includes('Is a connection left open?')));

  const again = await app.inject({ method: 'POST', url: `/api/chats/${id}/supervisor/${toSend.id}/send` });
  assert.equal(again.statusCode, 409);

  const dismissed = await app.inject({ method: 'POST', url: `/api/chats/${id}/supervisor/${toDismiss.id}/dismiss` });
  assert.equal(dismissed.statusCode, 200);
  assert.equal(dismissed.json<SupervisorProposal>().status, 'dismissed');
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${id}/supervisor/${toDismiss.id}/dismiss` })).statusCode, 409);
});

test('a task proposal is acted on from the board, and a task that is not running refuses the hint', async () => {
  const forTask = proposal({ chatId: 'worker', orchestrationId: 'orch-x', taskId: 'build' });
  const other = proposal({ chatId: 'worker', signal: 'loop', orchestrationId: 'orch-x', taskId: 'build' });
  core.db.saveProposal(forTask);
  core.db.saveProposal(other);

  assert.equal((await app.inject({ method: 'POST', url: `/api/orchestrations/orch-x/tasks/other/supervisor/${forTask.id}/dismiss` })).statusCode, 404);
  // The graph does not exist, so the task hint route has no worker to reach; the proposal stays proposed
  const send = await app.inject({ method: 'POST', url: `/api/orchestrations/orch-x/tasks/build/supervisor/${forTask.id}/send` });
  assert.equal(send.statusCode, 404);
  assert.equal(core.db.proposal(forTask.id)?.status, 'proposed');

  const dismissed = await app.inject({ method: 'POST', url: `/api/orchestrations/orch-x/tasks/build/supervisor/${other.id}/dismiss` });
  assert.equal(dismissed.statusCode, 200);
  assert.equal(dismissed.json<SupervisorProposal>().status, 'dismissed');
});
