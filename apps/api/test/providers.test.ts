import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { ModelOption, ProviderStatus, ProvidersSettings } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// The providers over HTTP. Nothing real is needed: the routes are exercised against whatever this
// host has, and only what holds on any host is asserted.
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

let app: FastifyInstance;
let core: Core;
let root: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-providers-'));
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

test('every provider is listed with a status, and one by id', async () => {
  const all = (await app.inject('/api/providers')).json<ProviderStatus[]>();
  assert.deepEqual(all.map((s) => s.id), ['claude-code', 'codex', 'gemini', 'copilot', 'opencode']);
  const one = await app.inject('/api/providers/codex');
  assert.equal(one.statusCode, 200);
  assert.equal(one.json<ProviderStatus>().id, 'codex');
  assert.equal((await app.inject('/api/providers/nope')).statusCode, 404);
});

test('settings read as the defaults until the first save, then persist in providers.json', async () => {
  const defaults = (await app.inject('/api/providers/settings')).json<ProvidersSettings>();
  assert.equal(defaults.defaultProvider, null);
  assert.deepEqual(defaults.order, ['claude-code', 'codex', 'gemini', 'copilot', 'opencode']);
  assert.ok(Object.values(defaults.providers).every((p) => p.enabled && p.binaryPath === null));
  assert.equal(existsSync(join(root, 'data', 'providers.json')), false);

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/providers/settings',
    ...json({ providers: { gemini: { enabled: false, binaryPath: '/opt/gemini' } }, order: ['gemini', 'codex'], defaultProvider: 'codex' }),
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json<ProvidersSettings>();
  assert.deepEqual(body.providers.gemini, { enabled: false, binaryPath: '/opt/gemini' });
  assert.deepEqual(body.order, ['gemini', 'codex', 'claude-code', 'copilot', 'opencode'], 'a provider left out is appended');
  assert.equal(JSON.parse(readFileSync(join(root, 'data', 'providers.json'), 'utf8')).defaultProvider, 'codex');
  assert.deepEqual((await app.inject('/api/providers/settings')).json(), body);

  // The list follows the order, and a disabled provider is not probed
  const refreshed = (await app.inject({ method: 'POST', url: '/api/providers/refresh' })).json<ProviderStatus[]>();
  assert.deepEqual(refreshed.map((s) => s.id).slice(0, 2), ['gemini', 'codex']);
  assert.equal(refreshed.find((s) => s.id === 'gemini')?.reason, 'disabled');
});

test('settings that name an unknown provider, or a relative binary, are refused and change nothing', async () => {
  const before = (await app.inject('/api/providers/settings')).json();
  for (const bad of [
    { providers: { nope: { enabled: true } } },
    { providers: { codex: { binaryPath: 'codex' } } },
    { providers: { codex: { enabled: 'yes' } } },
    { order: ['codex', 'codex'] },
    { order: ['nope'] },
    { defaultProvider: 'nope' },
    [],
  ]) {
    assert.equal((await app.inject({ method: 'PUT', url: '/api/providers/settings', ...json(bad) })).statusCode, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await app.inject('/api/providers/settings')).json(), before);
});

test("a chat's token can read the providers but not change the settings or force a detection", async () => {
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
    const stored = readFileSync(join(root, 'data', 'providers.json'), 'utf8');
    for (const [method, url, body] of [
      ['PUT', '/api/providers/settings', { defaultProvider: 'claude-code' }],
      ['POST', '/api/providers/refresh', undefined],
    ] as const) {
      assert.equal((await app.inject(fromChat(method, url, body))).statusCode, 403, `${method} ${url}`);
    }
    assert.equal(readFileSync(join(root, 'data', 'providers.json'), 'utf8'), stored);
    assert.equal((await app.inject(fromChat('GET', '/api/providers'))).statusCode, 200);
    assert.equal((await app.inject(fromChat('GET', '/api/providers/settings'))).statusCode, 200);
  } finally {
    await app.inject({ method: 'PUT', url: '/api/security/auth', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify({ mode: 'none' }) });
  }
});

test('every provider route is documented with a summary and the Providers tag', async () => {
  const spec = (await app.inject('/openapi.json')).json<{ paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> }>();
  const routes = Object.entries(spec.paths).filter(([path]) => path === '/api/providers' || path.startsWith('/api/providers/'));
  assert.equal(routes.reduce((n, [, methods]) => n + Object.keys(methods).length, 0), 6);
  for (const [path, methods] of routes) {
    for (const [method, op] of Object.entries(methods)) {
      assert.ok(op.summary, `${method} ${path} has no summary`);
      assert.deepEqual(op.tags, ['Providers'], `${method} ${path}`);
    }
  }
});

test('a provider\'s catalog is served with its tiers, and one with no driver is 404', async () => {
  const models = (await app.inject('/api/providers/claude-code/models')).json<ModelOption[]>();
  assert.deepEqual(models.map((m) => m.value).slice(0, 4), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.equal(models.find((m) => m.value === 'haiku')?.tier, 'fast');
  assert.equal((await app.inject('/api/providers/codex/models')).statusCode, 404);
  assert.equal((await app.inject('/api/providers/nope/models')).statusCode, 404);
});
