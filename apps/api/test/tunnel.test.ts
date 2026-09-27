import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { AuditPage, TunnelStatus } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// The whole wrapper, listening on loopback, behind the fake ssh the core tests use: what goes
// through "the public URL" goes through the fake's proxy, with the tunnel's own `Host`, as
// localhost.run delivers it. Nothing here touches the network.
const FAKE_SSH = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-ssh.mjs', import.meta.url));

const json = (body: unknown, headers: Record<string, string> = {}) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

interface Wrapper {
  app: FastifyInstance;
  core: Core;
  /** A request through the tunnel's address, as a phone would make it */
  remote: (url: string, path: string, headers?: Record<string, string>) => Promise<number>;
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function wrapper(t: TestContext): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'agentry-tunnel-api-'));
  const routes = join(root, 'routes.json');
  const saved = process.env.FAKE_SSH_ROUTES;
  process.env.FAKE_SSH_ROUTES = routes;
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
      SSH_BIN: FAKE_SSH,
    }),
  );
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    core.shutdown();
    await app.close();
    if (saved === undefined) delete process.env.FAKE_SSH_ROUTES;
    else process.env.FAKE_SSH_ROUTES = saved;
  });

  const remote = (url: string, path: string, headers: Record<string, string> = {}): Promise<number> => {
    const host = new URL(url).hostname;
    const port = existsSync(routes) ? (JSON.parse(readFileSync(routes, 'utf8')) as Record<string, number>)[host] : undefined;
    if (!port) return Promise.resolve(0);
    return new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { ...headers, host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', () => resolve(0));
      req.end();
    });
  };
  core.tunnel.verify = async (url) => (await remote(url, '/api/health')) === 200;
  core.tunnel.attach((app.server.address() as AddressInfo).port);
  return { app, core, remote };
}

async function withToken(app: FastifyInstance): Promise<string> {
  const { token } = (await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) })).json() as { token: string };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  return token;
}

const tunnel = async (app: FastifyInstance, token?: string): Promise<TunnelStatus> =>
  (await app.inject({ url: '/api/tunnel', headers: token ? { authorization: `Bearer ${token}` } : {} })).json() as TunnelStatus;

async function openTunnel(w: Wrapper, token: string): Promise<TunnelStatus> {
  const started = await w.app.inject({ method: 'POST', url: '/api/tunnel/start', headers: { authorization: `Bearer ${token}` } });
  assert.equal(started.statusCode, 200);
  await until(async () => (await tunnel(w.app, token)).state === 'active', 'active');
  return tunnel(w.app, token);
}

test('the tunnel starts stopped, with ssh found and start with Agentry off', async (t) => {
  const { app } = await wrapper(t);
  const status = await tunnel(app);
  assert.deepEqual(status, { state: 'stopped', url: null, since: null, reason: null, enabled: true, sshAvailable: true, settings: { startWithAgentry: false } });
});

test('no tunnel without authentication', async (t) => {
  const { app } = await wrapper(t);
  const refused = await app.inject({ method: 'POST', url: '/api/tunnel/start' });
  assert.equal(refused.statusCode, 409);
  assert.match((refused.json() as { error: string }).error, /needs authentication/);
  assert.equal((await tunnel(app)).state, 'stopped');
});

test('the tunnel host is answered while active, and refused again once it stops', async (t) => {
  const w = await wrapper(t);
  const token = await withToken(w.app);
  const auth = { authorization: `Bearer ${token}` };
  const active = await openTunnel(w, token);
  assert.ok(active.url);
  assert.equal(await w.remote(active.url, '/api/overview', auth), 200);
  // The host is let in, the guard still is not skipped
  assert.equal(await w.remote(active.url, '/api/overview'), 401);

  const stopped = await w.app.inject({ method: 'POST', url: '/api/tunnel/stop', headers: auth });
  assert.equal((stopped.json() as TunnelStatus).state, 'stopped');
  // The fake's proxy is gone with ssh; the host itself is what the guard refuses now
  const host = new URL(active.url).hostname;
  assert.equal((await w.app.inject({ url: '/api/overview', headers: { ...auth, host } })).statusCode, 421);

  const audit = (await w.app.inject({ url: '/api/audit', headers: auth })).json() as AuditPage;
  const summaries = audit.entries.map((row) => row.summary).reverse();
  assert.deepEqual(
    summaries.filter((s) => /tunnel/i.test(s)),
    ['Start the tunnel', `Tunnel host ${host} joined the allowlist`, `Tunnel host ${host} left the allowlist`, 'Stop the tunnel'],
  );
});

test('switching the mode to none closes the tunnel before the switch lands', async (t) => {
  const w = await wrapper(t);
  const token = await withToken(w.app);
  const active = await openTunnel(w, token);
  const host = new URL(active.url ?? '').hostname;
  const pid = w.core.tunnel.pid;
  assert.ok(pid);

  const unguarded = await w.app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'none' }, { authorization: `Bearer ${token}` }) });
  assert.equal(unguarded.statusCode, 200);
  // Already closed when the answer arrives, not some time after
  assert.equal(w.core.tunnel.status().state, 'stopped');
  assert.deepEqual(w.core.appSettings.runtimeHosts.list(), []);
  assert.equal((await w.app.inject({ url: '/api/overview', headers: { host } })).statusCode, 421);
  assert.throws(() => process.kill(pid, 0));
  const audit = w.core.db.auditPage({ limit: 50 }).entries.map((row) => row.summary);
  assert.ok(audit.includes('Stop the tunnel: authentication was turned off'));
});

test('ten wrong guesses through the tunnel do not make the owner on loopback wait', async (t) => {
  const w = await wrapper(t);
  const token = await withToken(w.app);
  const active = await openTunnel(w, token);
  assert.ok(active.url);
  for (let i = 0; i < 10; i++) assert.equal(await w.remote(active.url, '/api/overview', { authorization: 'Bearer wrong' }), 401);
  assert.equal(await w.remote(active.url, '/api/overview', { authorization: 'Bearer wrong' }), 429);
  // A client-address header is not trusted to pick another bucket: localhost.run passes it through
  assert.equal(await w.remote(active.url, '/api/overview', { authorization: 'Bearer wrong', 'x-forwarded-for': '198.51.100.9' }), 429);
  assert.equal((await w.app.inject({ url: '/api/overview', headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
});

test('every move of the tunnel is a tunnel.changed on the feed, with the address only while it works', async (t) => {
  const w = await wrapper(t);
  const token = await withToken(w.app);
  const seen: TunnelStatus[] = [];
  const stop = w.core.events.observe((event) => {
    if (event.type === 'tunnel.changed') seen.push(event.tunnel);
  });
  t.after(stop);
  await openTunnel(w, token);
  const settings = await w.app.inject({ method: 'PUT', url: '/api/tunnel/settings', ...json({ startWithAgentry: true }, { authorization: `Bearer ${token}` }) });
  assert.equal((settings.json() as TunnelStatus).settings.startWithAgentry, true);
  assert.equal((await w.app.inject({ method: 'PUT', url: '/api/tunnel/settings', ...json({ startWithAgentry: 1 }, { authorization: `Bearer ${token}` }) })).statusCode, 400);
  await w.app.inject({ method: 'POST', url: '/api/tunnel/stop', headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(
    seen.map((s) => s.state),
    ['starting', 'verifying', 'active', 'active', 'stopping', 'stopped'],
  );
  assert.ok(seen.every((s) => (s.state === 'active') === (s.url !== null)));
  assert.equal(seen.at(-1)?.settings.startWithAgentry, true);
});
