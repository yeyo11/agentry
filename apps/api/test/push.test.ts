import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { PushKeyInfo, PushSubscriptionSummary } from '@agentry/shared';
import { Core, idOfEndpoint, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

// The routes only, against an isolated data dir and a missing CLI: nothing here posts to a push
// service, which is covered as a unit in @agentry/core.
let app: FastifyInstance;

const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABapi-test-endpoint';
const keys = { p256dh: 'BExampleP256dhKeyForTests', auth: 'exampleAuthSecret' };

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-push-'));
  const core = new Core(
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

after(() => app.close());

test('the key route makes the keypair on first use and returns only its public half', async () => {
  const res = await app.inject('/api/push/key');
  assert.equal(res.statusCode, 200);
  const info = res.json<PushKeyInfo>();
  assert.equal(info.configured, true);
  assert.equal(typeof info.publicKey, 'string');
  assert.equal(res.payload.includes('privateKey'), false, 'the private key never leaves the server');
  assert.deepEqual((await app.inject('/api/push/key')).json<PushKeyInfo>(), info);
});

test('a subscription round-trips, and the list truncates the endpoint it was registered with', async () => {
  assert.deepEqual((await app.inject('/api/push/subscriptions')).json(), []);

  const created = await app.inject({
    method: 'POST',
    url: '/api/push/subscriptions',
    ...json({ endpoint: ENDPOINT, keys, kinds: ['waiting', 'run'], label: 'Pixel · Chrome' }),
  });
  assert.equal(created.statusCode, 201);
  const summary = created.json<PushSubscriptionSummary>();
  assert.equal(summary.id, idOfEndpoint(ENDPOINT), 'the browser recognises itself in the list by this id');
  assert.deepEqual(summary.kinds, ['waiting', 'run']);

  const listed = (await app.inject('/api/push/subscriptions')).json<PushSubscriptionSummary[]>();
  assert.deepEqual(listed, [summary]);
  assert.equal(listed[0]?.endpoint.includes('api-test-endpoint'), false);

  const removed = await app.inject({ method: 'DELETE', url: '/api/push/subscriptions', ...json({ endpoint: ENDPOINT }) });
  assert.deepEqual(removed.json(), { removed: true });
  assert.deepEqual((await app.inject('/api/push/subscriptions')).json(), []);
  assert.deepEqual((await app.inject({ method: 'DELETE', url: '/api/push/subscriptions', ...json({ id: summary.id }) })).json(), { removed: false });
});

test('a registration the sender could never deliver is a 400, not a stored row', async () => {
  for (const body of [{}, { endpoint: ENDPOINT }, { endpoint: 'http://push.example/x', keys }, { endpoint: ENDPOINT, keys, kinds: ['nope'] }]) {
    const res = await app.inject({ method: 'POST', url: '/api/push/subscriptions', ...json(body) });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(typeof res.json<{ error: string }>().error, 'string');
  }
  assert.deepEqual((await app.inject('/api/push/subscriptions')).json(), []);
});

test('a test notification with nothing registered says so instead of silently doing nothing', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/push/test', ...json({}) });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /no push subscription is registered/);
});
