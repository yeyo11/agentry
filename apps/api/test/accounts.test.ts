import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;
let core: Core;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-accounts-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  await app.close();
  core.shutdown();
});

test('rotation policies are created, listed, edited and deleted, and the overview carries them', async () => {
  assert.deepEqual((await app.inject('/api/accounts/policies')).json(), []);

  const created = await app.inject({ method: 'POST', url: '/api/accounts/policies', ...json({ threshold: 80, order: [2, 1], projects: ['proj'] }) });
  assert.equal(created.statusCode, 201);
  const policy = created.json();
  assert.equal(policy.threshold, 80);

  // Two policies for one project would leave the choice to whichever was read first
  const clash = await app.inject({ method: 'POST', url: '/api/accounts/policies', ...json({ threshold: 70, projects: ['proj'] }) });
  assert.equal(clash.statusCode, 400);
  assert.match(clash.json().error, /already governed/);

  const edited = await app.inject({ method: 'PUT', url: `/api/accounts/policies/${policy.id}`, ...json({ threshold: 75, projects: ['proj'] }) });
  assert.equal(edited.json().threshold, 75);
  assert.equal(edited.json().order, undefined, 'a policy with no order allows every account');

  assert.deepEqual((await app.inject('/api/accounts')).json().policies.map((p: { id: string }) => p.id), [policy.id]);

  assert.deepEqual((await app.inject({ method: 'DELETE', url: `/api/accounts/policies/${policy.id}` })).json(), { ok: true });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/accounts/policies/${policy.id}` })).statusCode, 404);
});

test('one policy may take the chats without a project, with or without projects of its own', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/accounts/policies', ...json({ threshold: 80, projects: [], looseChats: true }) });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().looseChats, true);

  const clash = await app.inject({ method: 'POST', url: '/api/accounts/policies', ...json({ threshold: 70, projects: ['other'], looseChats: true }) });
  assert.equal(clash.statusCode, 400);
  assert.match(clash.json().error, /already governed/);
  const empty = await app.inject({ method: 'POST', url: '/api/accounts/policies', ...json({ threshold: 70, projects: [] }) });
  assert.equal(empty.statusCode, 400);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/accounts/policies/${created.json().id}` })).statusCode, 200);
});

test('a config directory needs an account claude-swap manages, and a path or null', async () => {
  const missing = await app.inject({ method: 'PUT', url: '/api/accounts/1/config', ...json({ configDir: join(tmpdir(), 'x') }) });
  assert.equal(missing.statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/accounts/1/config', ...json({}) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/accounts/-x/config', ...json({ configDir: null }) })).statusCode, 400);
  assert.deepEqual((await app.inject('/api/accounts')).json().configs, []);
});

test('the usage history is empty without readings and rejects a window it does not know', async () => {
  assert.deepEqual((await app.inject('/api/accounts/usage?account=1&window=5h')).json(), []);
  assert.equal((await app.inject('/api/accounts/usage?window=1h')).statusCode, 400);
  assert.equal((await app.inject('/api/accounts/usage?account=one')).statusCode, 400);
});
