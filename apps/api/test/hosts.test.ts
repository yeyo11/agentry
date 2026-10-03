import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { CodeHostStatus, CodeHostsSettings, Project, ProjectCodeHost } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// The code host routes over HTTP. The CLIs on this machine are whatever they are, so only what
// holds on any machine is asserted.
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

let app: FastifyInstance;
let core: Core;
let root: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-hosts-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
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

test('every code host is listed with a status, and one by id', async () => {
  const all = (await app.inject('/api/hosts')).json<CodeHostStatus[]>();
  assert.deepEqual(all.map((s) => s.id), ['github', 'gitlab']);
  const one = await app.inject('/api/hosts/gitlab');
  assert.equal(one.statusCode, 200);
  assert.equal(one.json<CodeHostStatus>().cli, 'glab');
  assert.equal((await app.inject('/api/hosts/nope')).statusCode, 404);
});

test('settings read as the defaults until the first save, then persist in hosts.json', async () => {
  const defaults = (await app.inject('/api/hosts/settings')).json<CodeHostsSettings>();
  assert.ok(Object.values(defaults.hosts).every((h) => h.enabled && h.binaryPath === null));
  assert.equal(existsSync(join(root, 'data', 'hosts.json')), false);

  const saved = await app.inject({ method: 'PUT', url: '/api/hosts/settings', ...json({ hosts: { gitlab: { enabled: false, binaryPath: '/opt/glab' } } }) });
  assert.equal(saved.statusCode, 200);
  const body = saved.json<CodeHostsSettings>();
  assert.deepEqual(body.hosts.gitlab, { enabled: false, binaryPath: '/opt/glab' });
  assert.equal(body.hosts.github.enabled, true, 'a host left out keeps the defaults');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'data', 'hosts.json'), 'utf8')), body);
  assert.deepEqual((await app.inject('/api/hosts/settings')).json(), body);

  const refreshed = (await app.inject({ method: 'POST', url: '/api/hosts/refresh' })).json<CodeHostStatus[]>();
  assert.deepEqual(refreshed.map((s) => s.id), ['github', 'gitlab']);
});

test('settings that name an unknown host, or a relative binary, are refused and change nothing', async () => {
  const before = (await app.inject('/api/hosts/settings')).json();
  for (const bad of [{ hosts: { nope: { enabled: true } } }, { hosts: { github: { binaryPath: 'gh' } } }, { hosts: { github: { enabled: 'yes' } } }, []]) {
    assert.equal((await app.inject({ method: 'PUT', url: '/api/hosts/settings', ...json(bad) })).statusCode, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await app.inject('/api/hosts/settings')).json(), before);
});

test("a chat's token can read the hosts but not change the settings or force a detection", async () => {
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  const { token } = created.json<{ token: string }>();
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  try {
    const chat = core.security.chatTokens.mint('chat-42');
    const fromChat = (method: string, url: string, body?: unknown) => ({
      method: method as 'GET',
      url,
      remoteAddress: '127.0.0.1',
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      headers: { host: '127.0.0.1:34331', authorization: `Bearer ${chat}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    const stored = readFileSync(join(root, 'data', 'hosts.json'), 'utf8');
    for (const [method, url, body] of [
      ['PUT', '/api/hosts/settings', { hosts: { github: { binaryPath: '/tmp/evil' } } }],
      ['POST', '/api/hosts/refresh', undefined],
    ] as const) {
      assert.equal((await app.inject(fromChat(method, url, body))).statusCode, 403, `${method} ${url}`);
    }
    assert.equal(readFileSync(join(root, 'data', 'hosts.json'), 'utf8'), stored);
    assert.equal((await app.inject(fromChat('GET', '/api/hosts'))).statusCode, 200);
    assert.equal((await app.inject(fromChat('GET', '/api/hosts/settings'))).statusCode, 200);
  } finally {
    await app.inject({ method: 'PUT', url: '/api/security/auth', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify({ mode: 'none' }) });
  }
});

test("a project's code host is its readiness and parsed remote, and 404 for an unknown project", async () => {
  const plain = mkdtempSync(join(root, 'plain-'));
  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: plain, name: 'Plain' }) });
  const project = imported.json<Project>();
  const res = await app.inject(`/api/projects/${project.id}/code-host`);
  assert.equal(res.statusCode, 200);
  const body = res.json<ProjectCodeHost>();
  assert.equal(body.readiness.status, 'not-git');
  assert.equal(body.remote, null);
  assert.equal((await app.inject('/api/projects/nope/code-host')).statusCode, 404);
});

test('every code host route is documented with a summary and the Integrations tag', async () => {
  const spec = (await app.inject('/openapi.json')).json<{ paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> }>();
  const routes = Object.entries(spec.paths).filter(([path]) => path === '/api/hosts' || path.startsWith('/api/hosts/') || path === '/api/projects/{id}/code-host');
  assert.equal(routes.reduce((n, [, methods]) => n + Object.keys(methods).length, 0), 6);
  for (const [path, methods] of routes) {
    for (const [method, op] of Object.entries(methods)) {
      assert.ok(op.summary, `${method} ${path} has no summary`);
      assert.deepEqual(op.tags, ['Integrations'], `${method} ${path}`);
    }
  }
});
