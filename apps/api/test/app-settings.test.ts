import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AgentryEvent, AppSettings } from '@agentry/shared';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

// Each test gets its own wrapper: the guard's failure counts and the runtime hosts are per wrapper,
// and a test must not inherit another's.
const json = (body: unknown, headers: Record<string, string> = {}) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

interface Wrapper {
  app: FastifyInstance;
  core: Core;
}

async function wrapper(env: NodeJS.ProcessEnv = {}): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'agentry-app-settings-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
      ...env,
    }),
  );
  return { app: await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') }), core };
}

async function withToken(app: FastifyInstance): Promise<string> {
  const { token } = (await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) })).json() as { token: string };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  return token;
}

const status = async (app: FastifyInstance, host: string, headers: Record<string, string> = {}) =>
  (await app.inject({ url: '/api/overview', headers: { host, ...headers } })).statusCode;

test('an install that sets nothing answers exactly as before the settings had layers', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    core.shutdown();
  });

  const settings = await app.inject('/api/settings/app');
  assert.equal(settings.statusCode, 200);
  assert.deepEqual(settings.json<AppSettings>(), {
    allowedHosts: [],
    maxConcurrentRuns: 8,
    setupSeen: false,
    defaultPermissionMode: 'acceptEdits',
    sources: { allowedHosts: 'default', maxConcurrentRuns: 'default', defaultPermissionMode: 'default', setupSeen: 'default' },
    allowedHostLayers: { env: [], file: [], runtime: [] },
  });
  assert.equal((await app.inject('/api/system')).json().defaultPermissionMode, 'acceptEdits');
  // Open, loopback only, and nothing written to disk for it
  assert.equal(await status(app, 'localhost:8787'), 200);
  assert.equal(await status(app, '127.0.0.1'), 200);
  assert.equal(await status(app, 'rebind.evil.test'), 421);
  assert.equal(await status(app, 'abc.lhr.life'), 421);
  assert.equal(existsSync(join(core.config.dataDir, 'app-settings.json')), false);

  // The backoff is still keyed by the address: a forwarding header on loopback changes nothing
  const token = await withToken(app);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(await status(app, 'localhost', { authorization: 'Bearer wrong', 'x-forwarded-for': `203.0.113.${i}` }), 401);
  }
  assert.equal(await status(app, 'localhost', { authorization: `Bearer ${token}`, 'x-forwarded-for': '198.51.100.1' }), 429);
});

test('a host added in the settings is answered at once, and refused again once it is removed', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    core.shutdown();
  });

  assert.equal(await status(app, 'agentry.example.com'), 421);
  const put = await app.inject({ method: 'PUT', url: '/api/settings/app', ...json({ allowedHosts: ['agentry.example.com', '*.preview.example.com'] }) });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json<AppSettings>().sources.allowedHosts, 'file');
  assert.equal(await status(app, 'agentry.example.com'), 200);
  assert.equal(await status(app, 'pr-1.preview.example.com'), 200);
  assert.equal(await status(app, 'preview.example.com'), 421);

  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/app', ...json({ allowedHosts: [] }) })).statusCode, 200);
  assert.equal(await status(app, 'agentry.example.com'), 421);
});

test('a change to the settings goes out on the event feed with the whole document', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    core.shutdown();
  });
  const seen: AgentryEvent[] = [];
  core.events.subscribe((event) => seen.push(event));

  const put = await app.inject({ method: 'PUT', url: '/api/settings/app', ...json({ maxConcurrentRuns: 3, defaultPermissionMode: 'plan' }) });
  assert.equal(put.statusCode, 200);
  const event = seen.find((e) => e.type === 'settings.changed');
  assert.deepEqual(event?.type === 'settings.changed' && event.settings, put.json());
  assert.equal((await app.inject('/api/system')).json().defaultPermissionMode, 'plan');
});

test('a setting the environment holds is shown, and a PUT for it is refused', async (t) => {
  const { app, core } = await wrapper({ AGENTRY_DEFAULT_PERMISSION_MODE: 'bypassPermissions' });
  t.after(async () => {
    await app.close();
    core.shutdown();
  });

  const settings = (await app.inject('/api/settings/app')).json<AppSettings>();
  assert.deepEqual(settings.sources, { allowedHosts: 'default', maxConcurrentRuns: 'default', defaultPermissionMode: 'env', setupSeen: 'default' });
  assert.equal(settings.defaultPermissionMode, 'bypassPermissions');

  const refused = await app.inject({ method: 'PUT', url: '/api/settings/app', ...json({ defaultPermissionMode: 'plan' }) });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /set by the environment \(AGENTRY_DEFAULT_PERMISSION_MODE\)/);

  const bad = await app.inject({ method: 'PUT', url: '/api/settings/app', ...json({ maxConcurrentRuns: 0 }) });
  assert.equal(bad.statusCode, 400);
});

test("a host added in the UI is answered beside the environment's, which cannot be removed", async (t) => {
  const { app, core } = await wrapper({ AGENTRY_ALLOWED_HOSTS: '*.devtunnels.ms,192.168.1.184' });
  t.after(async () => {
    await app.close();
    core.shutdown();
  });
  assert.equal(await status(app, 'agentry.example.com'), 421);

  const put = await app.inject({ method: 'PUT', url: '/api/settings/app', ...json({ allowedHosts: ['agentry.example.com'] }) });
  assert.equal(put.statusCode, 200);
  const saved = put.json<AppSettings>();
  assert.deepEqual(saved.allowedHosts, ['*.devtunnels.ms', '192.168.1.184', 'agentry.example.com']);
  assert.deepEqual(saved.allowedHostLayers, { env: ['*.devtunnels.ms', '192.168.1.184'], file: ['agentry.example.com'], runtime: [] });
  assert.equal(saved.sources.allowedHosts, 'env');
  // Applied to the next request, without a restart, and the environment's hosts keep answering
  assert.equal(await status(app, 'agentry.example.com'), 200);
  assert.equal(await status(app, 'abc.devtunnels.ms'), 200);

  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/app', ...json({ allowedHosts: [] }) })).statusCode, 200);
  assert.equal(await status(app, 'agentry.example.com'), 421);
  assert.equal(await status(app, '192.168.1.184'), 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/app', ...json({ allowedHosts: ['*.com'] }) })).statusCode, 400);
});

test('the settings are guarded like every other settings route', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    core.shutdown();
  });
  const token = await withToken(app);

  assert.equal((await app.inject('/api/settings/app')).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/app', ...json({ maxConcurrentRuns: 2 }) })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/settings/app', headers: { authorization: `Bearer ${token}` } })).statusCode, 200);

  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ readOnly: true }, auth) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/app', ...json({ maxConcurrentRuns: 2 }, auth) })).statusCode, 405);
});

test('a runtime host is answered while it is registered, and forgotten when it is removed', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    core.shutdown();
  });

  assert.equal(await status(app, 'abc123.lhr.life'), 421);
  core.appSettings.runtimeHosts.add('abc123.lhr.life');
  assert.equal(await status(app, 'abc123.lhr.life'), 200);
  assert.equal(await status(app, 'ABC123.lhr.life:443'), 200);
  // Exact: another tunnel on the same provider is somebody else's
  assert.equal(await status(app, 'other.lhr.life'), 421);
  // Not listed as configuration, since nobody may edit what the tunnel owns, but shown apart
  const settings = (await app.inject('/api/settings/app')).json<AppSettings>();
  assert.deepEqual([settings.allowedHosts, settings.allowedHostLayers.runtime], [[], ['abc123.lhr.life']]);

  core.appSettings.runtimeHosts.remove('abc123.lhr.life');
  assert.equal(await status(app, 'abc123.lhr.life'), 421);
});

test('ten failures through a runtime host do not make a loopback client wait', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    core.shutdown();
  });
  const token = await withToken(app);
  core.appSettings.runtimeHosts.add('abc123.lhr.life');

  // No header registered: the tunnel's traffic shares one bucket, apart from loopback
  for (let i = 0; i < 10; i += 1) assert.equal(await status(app, 'abc123.lhr.life', { authorization: 'Bearer wrong' }), 401);
  assert.equal(await status(app, 'abc123.lhr.life', { authorization: `Bearer ${token}` }), 429);
  assert.equal(await status(app, 'localhost', { authorization: `Bearer ${token}` }), 200);
});

test('with a client header registered, each client through the tunnel waits on its own', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    core.shutdown();
  });
  const token = await withToken(app);
  core.appSettings.runtimeHosts.add('abc123.lhr.life', { clientIpHeader: 'X-Forwarded-For' });

  const stranger = { 'x-forwarded-for': '203.0.113.7' };
  for (let i = 0; i < 10; i += 1) assert.equal(await status(app, 'abc123.lhr.life', { authorization: 'Bearer wrong', ...stranger }), 401);
  assert.equal(await status(app, 'abc123.lhr.life', { authorization: `Bearer ${token}`, ...stranger }), 429);
  // Only the last hop, the one the provider adds, is counted: what the client wrote before it is
  // not, so the stranger's address at the front of someone else's request does not make them wait
  assert.equal(await status(app, 'abc123.lhr.life', { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.7, 198.51.100.2' }), 200);
  assert.equal(await status(app, 'abc123.lhr.life', { authorization: `Bearer ${token}`, 'x-forwarded-for': '198.51.100.2' }), 200);
  // With no value the tunnel's own bucket is used, and neither shares one with loopback
  assert.equal(await status(app, 'abc123.lhr.life', { authorization: `Bearer ${token}` }), 200);
  assert.equal(await status(app, 'localhost', { authorization: `Bearer ${token}` }), 200);
});
