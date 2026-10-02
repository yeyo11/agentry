import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { Project, ProjectWebhooks, WebhookRegistration } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// A project's webhook routes over HTTP. The CLIs on this machine are whatever they are, so the
// project here has no remote: what holds on any machine is the shape of every answer and who may ask.
const json = (body?: unknown) => ({ payload: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } });

let app: FastifyInstance;
let core: Core;
let root: string;
let project: Project;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-project-webhooks-'));
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
  const plain = mkdtempSync(join(root, 'plain-'));
  project = (await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: plain, name: 'Plain' }) })).json<Project>();
});

after(async () => {
  await app.close();
  core.shutdown();
  rmSync(root, { recursive: true, force: true });
});

const register = (id: string, remoteHookId: string | null = null) =>
  core.webhooks.create({ id, projectId: project.id, host: 'github', hostname: 'github.com', repoPath: 'o/r', remoteHookId, url: `https://x.lhr.life/api/webhooks/github/${id}`, events: ['pull_request'] });

test('a project that cannot have a hook says why, with nothing to act on', async () => {
  const res = await app.inject(`/api/projects/${project.id}/webhooks`);
  assert.equal(res.statusCode, 200);
  const body = res.json<ProjectWebhooks>();
  assert.equal(body.available, false);
  assert.equal(body.reason, 'no-remote');
  assert.equal(body.canRedeliver, false);
  assert.deepEqual(body.registrations, []);
});

test('registering without a remote is a 409 that names its reason', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/webhooks`, ...json() });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json<{ code: string }>().code, 'no-remote');
});

test('testing or removing a registration that is not the project\'s is a 404', async () => {
  for (const [method, url] of [
    ['POST', `/api/projects/${project.id}/webhooks/nope/test`],
    ['DELETE', `/api/projects/${project.id}/webhooks/nope`],
  ] as const) {
    const res = await app.inject({ method, url, ...(method === 'POST' ? json() : {}) });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
    assert.equal(res.json<{ code: string }>().code, 'registration-not-found');
  }
});

test('removing a registration answers it as removed, drops its secret and keeps it listed', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  register(id);
  await core.webhookSecrets.set(id, 'a-secret');
  const res = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/webhooks/${id}` });
  assert.equal(res.statusCode, 200);
  const body = res.json<WebhookRegistration>();
  assert.equal(body.state, 'removed');
  assert.ok(!JSON.stringify(body).includes('a-secret'));
  assert.equal(core.webhookSecrets.get(id), null);
  const listed = (await app.inject(`/api/projects/${project.id}/webhooks`)).json<ProjectWebhooks>();
  assert.deepEqual(listed.registrations.map((r) => [r.id, r.state]), [[id, 'removed']]);
});

test("a chat's token reads the webhooks but gets 403 on every write, and the receivers still need no bearer", async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  register(id);
  await core.webhookSecrets.set(id, 'kept-secret');
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json() });
  const { token } = created.json<{ token: string }>();
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  try {
    const chat = core.security.chatTokens.mint('chat-42');
    const as = (bearer: string | null, method: string, url: string, body?: unknown) => ({
      method: method as 'GET',
      url,
      remoteAddress: '127.0.0.1',
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      headers: { host: '127.0.0.1:34331', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    const base = `/api/projects/${project.id}/webhooks`;
    for (const [method, url, body] of [
      ['POST', base, {}],
      ['POST', `${base}/${id}/test`, {}],
      ['DELETE', `${base}/${id}`, undefined],
    ] as const) {
      assert.equal((await app.inject(as(chat, method, url, body))).statusCode, 403, `${method} ${url}`);
      assert.equal((await app.inject(as(null, method, url, body))).statusCode, 401, `${method} ${url} with no credential`);
    }
    assert.equal(core.webhooks.get(id)?.state, 'active', 'nothing changed');
    assert.equal(core.webhookSecrets.get(id), 'kept-secret');
    assert.equal((await app.inject(as(chat, 'GET', base))).statusCode, 200);
    // The receiver is the one door that takes no bearer: only it can answer a signed delivery with
    // 204 while the guard is on, and only it answers a wrong signature with an empty 401 (the
    // guard's 401 carries a body)
    const guarded = await app.inject(as(null, 'POST', base, {}));
    assert.equal(guarded.statusCode, 401);
    assert.notEqual(guarded.body, '', "the guard's refusal says something");
    const payload = JSON.stringify({ zen: 'x' });
    const deliver = (secret: string, delivery: string) =>
      app.inject({
        method: 'POST',
        url: `/api/webhooks/github/${id}`,
        remoteAddress: '127.0.0.1',
        payload,
        headers: {
          host: '127.0.0.1:34331',
          'content-type': 'application/json',
          'x-github-event': 'ping',
          'x-github-delivery': delivery,
          'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`,
        },
      });
    const forged = await deliver('not-the-secret', 'd-forged');
    assert.equal(forged.statusCode, 401);
    assert.equal(forged.body, '', "the receiver's refusal has no detail");
    assert.equal((await deliver('kept-secret', 'd-genuine')).statusCode, 204);
  } finally {
    await app.inject({ method: 'PUT', url: '/api/security/auth', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify({ mode: 'none' }) });
  }
});

test('every webhook route is documented with a summary and the Webhooks tag', async () => {
  const spec = (await app.inject('/openapi.json')).json<{ paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> }>();
  for (const [path, method] of [
    ['/api/projects/{id}/webhooks', 'get'],
    ['/api/projects/{id}/webhooks', 'post'],
    ['/api/projects/{id}/webhooks/{registrationId}/test', 'post'],
    ['/api/projects/{id}/webhooks/{registrationId}', 'delete'],
  ] as const) {
    const op = spec.paths[path]?.[method];
    assert.ok(op?.summary && op.tags?.includes('Webhooks'), `${method} ${path}`);
  }
});
