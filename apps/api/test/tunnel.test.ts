import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// The whole wrapper, listening on loopback, behind the fake `tailscale` the core tests use. What
// tailscaled would deliver from a phone on the tailnet arrives from 127.0.0.1 carrying the node's
// name and the Serve port in `Host`, so a request made that way stands for it. Nothing here touches
// a real tailnet.
const FAKE_TAILSCALE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-tailscale.mjs', import.meta.url));
const NODE = 'agentry-test.tail0000.ts.net';

const json = (body: unknown, headers: Record<string, string> = {}) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

interface Wrapper {
  app: FastifyInstance;
  core: Core;
  /** The node's Serve config, as the fake CLI keeps it */
  serve: () => unknown;
  /** A request as tailscaled relays it: from loopback, with the tailnet name as its host */
  remote: (path: string, headers?: Record<string, string>, method?: string) => Promise<number>;
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
  const node = join(root, 'node.json');
  writeFileSync(node, JSON.stringify({ serve: {} }));
  const saved = process.env.FAKE_TAILSCALE_STATE;
  process.env.FAKE_TAILSCALE_STATE = node;
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
      TAILSCALE_BIN: FAKE_TAILSCALE,
    }),
  );
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    core.shutdown();
    await app.close();
    if (saved === undefined) delete process.env.FAKE_TAILSCALE_STATE;
    else process.env.FAKE_TAILSCALE_STATE = saved;
  });
  const { port } = app.server.address() as AddressInfo;
  const remote = (path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<number> =>
    new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: { ...headers, host: `${NODE}:8443` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', () => resolve(0));
      req.end();
    });
  core.tunnel.attach(port);
  const serve = () => (JSON.parse(readFileSync(node, 'utf8')) as { serve: unknown }).serve;
  return { app, core, serve, remote };
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

test('the tunnel starts stopped, with a ready Tailscale read from its CLI and start with Agentry off', async (t) => {
  const { app } = await wrapper(t);
  const status = await tunnel(app);
  assert.deepEqual(status, {
    state: 'stopped',
    url: null,
    since: null,
    reason: null,
    enabled: true,
    tailscale: { state: 'ready', version: '1.102.4', host: NODE, reason: null },
    port: 8443,
    settings: { startWithAgentry: false },
  });
});

test('no tunnel without authentication', async (t) => {
  const { app, serve } = await wrapper(t);
  const refused = await app.inject({ method: 'POST', url: '/api/tunnel/start' });
  assert.equal(refused.statusCode, 409);
  assert.match((refused.json() as { error: string }).error, /needs authentication/);
  assert.equal((await tunnel(app)).state, 'stopped');
  assert.deepEqual(serve(), {});
});

test('the tailnet name is answered while active, and refused again once it stops', async (t) => {
  const w = await wrapper(t);
  const token = await withToken(w.app);
  const auth = { authorization: `Bearer ${token}` };
  // Before the tunnel, the node's name is not one this wrapper answers to
  assert.equal(await w.remote('/api/overview', auth), 421);
  const active = await openTunnel(w, token);
  assert.equal(active.url, `https://${NODE}:8443`);
  assert.equal(await w.remote('/api/overview', auth), 200);
  // The host is let in, the guard still is not skipped
  assert.equal(await w.remote('/api/overview'), 401);

  const stopped = await w.app.inject({ method: 'POST', url: '/api/tunnel/stop', headers: auth });
  assert.equal((stopped.json() as TunnelStatus).state, 'stopped');
  assert.equal(await w.remote('/api/overview', auth), 421);
  assert.deepEqual(w.serve(), {});

  const audit = (await w.app.inject({ url: '/api/audit', headers: auth })).json() as AuditPage;
  const summaries = audit.entries.map((row) => row.summary).reverse();
  assert.deepEqual(
    summaries.filter((s) => /tunnel/i.test(s)),
    ['Start the tunnel', `Tunnel host ${NODE} joined the allowlist`, `Tunnel host ${NODE} left the allowlist`, 'Stop the tunnel'],
  );
});

test('closing the tunnel from a page that came through it answers before the rule goes', async (t) => {
  const w = await wrapper(t);
  const token = await withToken(w.app);
  await openTunnel(w, token);
  assert.equal(await w.remote('/api/tunnel/stop', { authorization: `Bearer ${token}` }, 'POST'), 200);
  assert.notDeepEqual(w.serve(), {}, 'the rule this reply travels back through is still there when it leaves');
  await until(async () => (await tunnel(w.app, token)).state === 'stopped', 'stopped');
  assert.deepEqual(w.serve(), {});
});

test('switching the mode to none closes the tunnel before the switch lands', async (t) => {
  const w = await wrapper(t);
  const token = await withToken(w.app);
  await openTunnel(w, token);

  const unguarded = await w.app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'none' }, { authorization: `Bearer ${token}` }) });
  assert.equal(unguarded.statusCode, 200);
  // Already closed when the answer arrives, not some time after
  assert.equal(w.core.tunnel.status().state, 'stopped');
  assert.deepEqual(w.core.appSettings.runtimeHosts.list(), []);
  assert.deepEqual(w.serve(), {});
  assert.equal(await w.remote('/api/overview'), 421);
  const audit = w.core.db.auditPage({ limit: 50 }).entries.map((row) => row.summary);
  assert.ok(audit.includes('Stop the tunnel: authentication was turned off'));
});

test('ten wrong guesses through the tunnel do not make the owner on loopback wait', async (t) => {
  const w = await wrapper(t);
  const token = await withToken(w.app);
  await openTunnel(w, token);
  for (let i = 0; i < 10; i++) assert.equal(await w.remote('/api/overview', { authorization: 'Bearer wrong' }), 401);
  assert.equal(await w.remote('/api/overview', { authorization: 'Bearer wrong' }), 429);
  // A client-address header is not trusted to pick another bucket: what Serve sets was not measured
  assert.equal(await w.remote('/api/overview', { authorization: 'Bearer wrong', 'x-forwarded-for': '100.64.0.9' }), 429);
  assert.equal((await w.app.inject({ url: '/api/overview', headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
});

test('every move of the tunnel is a tunnel.changed on the feed, with the address only while it works', async (t) => {
  const w = await wrapper(t);
  const token = await withToken(w.app);
  await tunnel(w.app, token);
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

test('a Tailscale that is not signed in is said before anything is offered, and start fails with it', async (t) => {
  const w = await wrapper(t);
  writeFileSync(process.env.FAKE_TAILSCALE_STATE ?? '', JSON.stringify({ serve: {}, backendState: 'NeedsLogin' }));
  const token = await withToken(w.app);
  const status = await tunnel(w.app, token);
  assert.equal(status.tailscale.state, 'loggedOut');
  assert.equal(status.tailscale.reason?.code, 'tunnel.tailscaleLoggedOut');
  const started = await w.app.inject({ method: 'POST', url: '/api/tunnel/start', headers: { authorization: `Bearer ${token}` } });
  assert.equal(started.statusCode, 200);
  assert.equal((started.json() as TunnelStatus).state, 'failed');
  assert.deepEqual(w.serve(), {});
});
