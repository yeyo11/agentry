import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';
import { WEBHOOK_BODY_LIMIT } from '../src/routes/webhooks.ts';

// The receivers over HTTP. The recorded deliveries are core's fixtures; each is signed again here
// with a secret of this test's own, because the recorded signatures were redacted.
const DELIVERIES = join(import.meta.dirname, '../../../packages/core/test/fixtures/recordings/gh/deliveries');
const SECRET = 'api-test-secret-0123456789abcdef0123456789';
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

interface Wrapper {
  app: FastifyInstance;
  core: Core;
  /** What `Core.nudgeChangeRequests` was asked, so a test can see a delivery reach the pacer */
  nudged: string[][];
}

async function wrapper(t: { after: (fn: () => Promise<void> | void) => void }): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'agentry-webhooks-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  const nudged: string[][] = [];
  core.nudgeChangeRequests = (ids) => void nudged.push([...ids]);
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  t.after(async () => {
    await app.close();
    core.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  return { app, core, nudged };
}

async function register(core: Core, id: string, host: 'github' | 'gitlab' = 'github', secret = SECRET): Promise<void> {
  core.webhooks.create({ id, projectId: 'p1', host, hostname: `${host}.com`, repoPath: 'yeyo11/agentry-probe', remoteHookId: '1', url: `https://x.lhr.life/api/webhooks/${host}/${id}`, events: ['pull_request'] });
  await core.webhookSecrets.set(id, secret);
}

function delivery(name: string, secret = SECRET) {
  const recorded = JSON.parse(readFileSync(join(DELIVERIES, `${name}.json`), 'utf8')) as { request: { headers: Record<string, string>; payload: unknown } };
  const raw = JSON.stringify(recorded.request.payload);
  const headers = Object.fromEntries(Object.entries(recorded.request.headers).map(([k, v]) => [k.toLowerCase(), v]));
  // The recorded headers say what GitHub sends; the body and the signature are ours
  return { raw, headers: { ...headers, 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` } };
}

test('a signed GitHub delivery is answered 204 with no body, and reaches the pacer', async (t) => {
  const { app, core, nudged } = await wrapper(t);
  await register(core, 'r1');
  const d = delivery('pull_request.synchronize');
  const res = await app.inject({ method: 'POST', url: '/api/webhooks/github/r1', payload: d.raw, headers: d.headers });
  assert.equal(res.statusCode, 204);
  assert.equal(res.payload, '');
  // The registration remembers it; the delivery id is recorded for the replay check
  assert.ok(core.webhooks.get('r1')?.lastDeliveryAt);
  assert.equal(core.webhooks.deliveries('r1').length, 1);
  // No change request exists in this install, so the call names none: it is still made
  assert.deepEqual(nudged, [[]]);
});

test('a replay is answered the same and not worked twice', async (t) => {
  const { app, core, nudged } = await wrapper(t);
  await register(core, 'r1');
  const d = delivery('pull_request.opened');
  for (let i = 0; i < 2; i++) assert.equal((await app.inject({ method: 'POST', url: '/api/webhooks/github/r1', payload: d.raw, headers: d.headers })).statusCode, 204);
  assert.equal(nudged.length, 1);
});

test('a wrong signature, an unknown registration and a hook of the other host are all 401 with nothing said', async (t) => {
  const { app, core, nudged } = await wrapper(t);
  await register(core, 'r1');
  const bad = delivery('ping.None', 'not the secret');
  const good = delivery('ping.None');
  const answers = [
    await app.inject({ method: 'POST', url: '/api/webhooks/github/r1', payload: bad.raw, headers: bad.headers }),
    await app.inject({ method: 'POST', url: '/api/webhooks/github/missing', payload: good.raw, headers: good.headers }),
    await app.inject({ method: 'POST', url: '/api/webhooks/gitlab/r1', payload: good.raw, headers: { ...good.headers, 'x-gitlab-token': SECRET } }),
    await app.inject({ method: 'POST', url: '/api/webhooks/github/r1', payload: '', headers: {} }),
  ];
  for (const res of answers) {
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload, '');
  }
  assert.deepEqual(nudged, []);
  assert.equal(core.webhooks.deliveries('r1').length, 0);
});

test('the signature is over the bytes sent: a body that parses the same but is spaced differently still verifies, and one byte more does not', async (t) => {
  const { app, core } = await wrapper(t);
  await register(core, 'r1');
  const spaced = `{ "zen": "Keep it logically awesome.",   "hook_id": 1 }\n`;
  const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  const headers = (raw: string) => ({ 'content-type': 'application/json', 'x-github-event': 'ping', 'x-github-delivery': `d-${raw.length}`, 'x-hub-signature-256': sign(raw) });
  assert.equal((await app.inject({ method: 'POST', url: '/api/webhooks/github/r1', payload: spaced, headers: headers(spaced) })).statusCode, 204);
  assert.equal((await app.inject({ method: 'POST', url: '/api/webhooks/github/r1', payload: `${spaced} `, headers: headers(spaced) })).statusCode, 401);
});

test('a GitLab delivery is believed by its token header', async (t) => {
  const { app, core } = await wrapper(t);
  await register(core, 'g1', 'gitlab');
  const body = { object_kind: 'merge_request', project: { path_with_namespace: 'g/app' }, object_attributes: { iid: 3 } };
  const url = '/api/webhooks/gitlab/g1';
  assert.equal((await app.inject({ method: 'POST', url, ...json(body), headers: { 'content-type': 'application/json', 'x-gitlab-token': 'nope' } })).statusCode, 401);
  const ok = await app.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-gitlab-token': SECRET, 'x-gitlab-event': 'Merge Request Hook', 'idempotency-key': 'k1' } });
  assert.equal(ok.statusCode, 204);
});

test('beyond 60 verified deliveries a minute is 429, and a body over 5 MiB is 413', async (t) => {
  const { app, core } = await wrapper(t);
  await register(core, 'r1');
  const send = (n: number) => {
    const raw = JSON.stringify({ n });
    return app.inject({ method: 'POST', url: '/api/webhooks/github/r1', payload: raw, headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': `d${n}`, 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` } });
  };
  for (let n = 0; n < 60; n++) assert.equal((await send(n)).statusCode, 204);
  const limited = await send(61);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'], '60');

  const big = await app.inject({ method: 'POST', url: '/api/webhooks/github/r1', payload: Buffer.alloc(WEBHOOK_BODY_LIMIT + 1, 0x20), headers: { 'content-type': 'application/json' } });
  assert.equal(big.statusCode, 413);
});

test('they answer without a bearer token, in token mode and in read-only mode, and leave no audit row', async (t) => {
  const { app, core } = await wrapper(t);
  await register(core, 'r1');
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  assert.equal(created.statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  const { token } = created.json() as { token: string };
  assert.equal((await app.inject('/api/overview')).statusCode, 401, 'the guard is on');
  const send = (name: string) => {
    const d = delivery(name);
    return app.inject({ method: 'POST', url: '/api/webhooks/github/r1', payload: d.raw, headers: d.headers });
  };
  assert.equal((await send('pull_request.opened')).statusCode, 204);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', payload: JSON.stringify({ readOnly: true }), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } })).statusCode, 200);
  assert.equal((await send('pull_request.closed')).statusCode, 204);
  // A GET on the receiver's address is no delivery: it is guarded like any other route
  assert.equal((await app.inject('/api/webhooks/github/r1')).statusCode, 401);
  const audit = (await app.inject({ url: '/api/audit?path=/api/webhooks', headers: { authorization: `Bearer ${token}` } })).json() as { entries?: unknown[] } | unknown[];
  assert.equal(Array.isArray(audit) ? audit.length : (audit.entries ?? []).length, 0);
});

test('an unknown, removed or other-host registration is refused before the body is read', async (t) => {
  const { app, core } = await wrapper(t);
  await register(core, 'r1');
  await register(core, 'gone');
  core.webhooks.update('gone', { state: 'removed' });
  // Over the limit: were the body parser reached, each of these would be a 413 and not the receiver's 401
  const big = Buffer.alloc(WEBHOOK_BODY_LIMIT + 1, 0x20);
  for (const url of ['/api/webhooks/github/nobody', '/api/webhooks/github/gone', '/api/webhooks/gitlab/r1']) {
    const res = await app.inject({ method: 'POST', url, payload: big, headers: { 'content-type': 'application/json' } });
    assert.equal(res.statusCode, 401, url);
    assert.equal(res.payload, '', url);
  }
  // A registration that exists still reaches the parser, which is what the 413 shows
  const known = await app.inject({ method: 'POST', url: '/api/webhooks/github/r1', payload: big, headers: { 'content-type': 'application/json' } });
  assert.equal(known.statusCode, 413);
});

test('the receivers are documented, in the tag the plan names', async (t) => {
  const { app } = await wrapper(t);
  const doc = (await app.inject('/openapi.json')).json() as { paths: Record<string, { post?: { tags?: string[]; summary?: string } }> };
  for (const path of ['/api/webhooks/github/{registrationId}', '/api/webhooks/gitlab/{registrationId}']) {
    assert.deepEqual(doc.paths[path]?.post?.tags, ['Webhooks']);
    assert.ok(doc.paths[path]?.post?.summary);
  }
});
