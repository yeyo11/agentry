import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { AgentryEvent, StoredDashboardLayout } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const layout = (...types: string[]) => ({ version: 1, widgets: types.map((type) => ({ id: type, type, size: 'm' })) });

let app: FastifyInstance;
let core: Core;
let root: string;
let projectId: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-layout-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  projectId = (await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'demo' }) })).json<{ id: string }>().id;
});

after(async () => {
  await app.close();
  core.shutdown();
  rmSync(root, { recursive: true, force: true });
});

const url = (project: string) => `/api/dashboard/layout?project=${encodeURIComponent(project)}`;

test('a Home layout is saved, read, announced and reset per project', async () => {
  const seen: AgentryEvent[] = [];
  const stop = core.events.subscribe((e) => seen.push(e));
  assert.deepEqual((await app.inject(url(projectId))).json(), { project: projectId, layout: null });

  const put = await app.inject({ method: 'PUT', url: url(projectId), ...json(layout('documents', 'flows')) });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json<StoredDashboardLayout>().layout?.widgets.length, 2);
  assert.equal((await app.inject(url(projectId))).json<StoredDashboardLayout>().layout?.widgets[0]?.type, 'documents');
  assert.equal((await app.inject(url('all'))).json<StoredDashboardLayout>().layout, null, 'All projects keeps its own');
  assert.ok(seen.some((e) => e.type === 'dashboard.layout' && e.project === projectId && e.layout !== null));

  const del = await app.inject({ method: 'DELETE', url: url(projectId) });
  assert.deepEqual(del.json(), { project: projectId, layout: null });
  assert.equal((await app.inject(url(projectId))).json<StoredDashboardLayout>().layout, null);
  stop();
});

test('an invalid layout is a 400, an unknown project a 404, a missing project query a 400', async () => {
  assert.equal((await app.inject({ method: 'PUT', url: url(projectId), ...json(layout('projects')) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: url('all'), ...json(layout('documents')) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: url('nope'), ...json(layout('now')) })).statusCode, 404);
  assert.equal((await app.inject('/api/dashboard/layout')).statusCode, 400);
});

test("a chat's token can read a layout and not write it", async () => {
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  assert.equal(created.statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  const { token } = created.json<{ token: string }>();
  try {
    const chat = core.security.chatTokens.mint('chat-42');
    const fromChat = (method: 'GET' | 'PUT' | 'DELETE', body?: unknown) => ({
      method,
      url: url(projectId),
      remoteAddress: '127.0.0.1',
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      headers: { host: '127.0.0.1:34331', authorization: `Bearer ${chat}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    assert.equal((await app.inject(fromChat('GET'))).statusCode, 200);
    assert.equal((await app.inject(fromChat('PUT', layout('documents')))).statusCode, 403);
    assert.equal((await app.inject(fromChat('DELETE'))).statusCode, 403);
  } finally {
    await app.inject({ method: 'PUT', url: '/api/security/auth', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify({ mode: 'none' }) });
  }
});
