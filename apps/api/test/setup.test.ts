import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { AgentryEvent, AppSettings, LoginSession, SetupState, SignOutResult } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// The setup routes over HTTP, on a real core with scratch dirs. No agent CLI is found (the test
// providers are off and Claude Code points nowhere), so a sign-in that needs a binary ends
// `cli-missing`; the sign-ins themselves are covered in core against fake CLIs.
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
// The state reads Tailscale too: never the machine's own, which would make the answer the host's
const FAKE_TAILSCALE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-tailscale.mjs', import.meta.url));

let app: FastifyInstance;
let core: Core;
let root: string;
const events: AgentryEvent[] = [];

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-setup-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
      TAILSCALE_BIN: FAKE_TAILSCALE,
    }),
  );
  core.events.subscribe((event) => events.push(event));
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  await app.close();
  core.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test('the setup state says what is done: access, agents, hosts, YouTrack, the methods per tool and how secrets are kept', async () => {
  const res = await app.inject('/api/setup');
  assert.equal(res.statusCode, 200);
  const state = res.json<SetupState>();
  assert.equal(state.seen, false);
  assert.deepEqual(state.access, { mode: 'none', tokenSet: false, readOnly: false });
  // Only the enabled agents: the test turns the others off
  assert.deepEqual(state.providers.map((p) => p.id), ['claude-code']);
  assert.deepEqual(state.hosts.map((h) => [h.id, h.cli]), [['github', 'gh'], ['gitlab', 'glab']]);
  assert.equal(state.youtrack.configured, false);
  assert.deepEqual(state.methods.map((m) => m.tool), ['claude-code', 'codex', 'gemini', 'copilot', 'opencode', 'gh', 'glab', 'youtrack', 'tailscale']);
  // A source install's Tailscale is the machine's: its state shows, and it is not Agentry's to sign in
  assert.deepEqual(state.tailscale, { enabled: true, managed: false, state: 'ready', host: 'agentry-test.tail0000.ts.net' });
  // A source install without AGENTRY_SECRET_KEY keeps plain values, as before
  assert.deepEqual(state.secrets, { sealed: false, keyBeside: false });
});

test('finishing or skipping the assistant is recorded once, in the app settings', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/setup/seen' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<SetupState>().seen, true);
  assert.equal((await app.inject('/api/settings/app')).json<AppSettings>().setupSeen, true);
  assert.equal(JSON.parse(readFileSync(join(root, 'data', 'app-settings.json'), 'utf8')).setupSeen, true);
});

test('a key for an agent that reads its environment is kept sealed away and never answered back', async () => {
  const secret = 'AIza-api-test-never-echoed';
  const res = await app.inject({ method: 'POST', url: '/api/setup/logins', ...json({ tool: 'gemini', method: 'key', secret }) });
  assert.equal(res.statusCode, 201, res.body);
  const session = res.json<LoginSession>();
  assert.deepEqual([session.tool, session.method, session.state], ['gemini', 'key', 'succeeded']);
  assert.ok(!res.body.includes(secret));
  assert.deepEqual(core.vault.get('gemini'), { GEMINI_API_KEY: secret });
  assert.equal(process.env.GEMINI_API_KEY === secret, false);
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.equal((await app.inject(`/api/setup/logins/${session.id}`)).json<LoginSession>().state, 'succeeded');

  const out = await app.inject({ method: 'DELETE', url: '/api/setup/credentials/gemini' });
  assert.deepEqual(out.json<SignOutResult>(), { tool: 'gemini', host: null, signedOut: true, reason: null });
  assert.equal(core.vault.has('gemini'), false);
});

test('the Claude credential of /auth/credentials lands in the vault and not in the server\'s environment', async () => {
  const before = process.env.ANTHROPIC_API_KEY;
  assert.equal((await app.inject({ method: 'PUT', url: '/api/auth/credentials', ...json({ apiKey: 'sk-ant-api-test' }) })).statusCode, 200);
  assert.deepEqual(core.vault.get('claude-code'), { ANTHROPIC_API_KEY: 'sk-ant-api-test' });
  assert.equal(process.env.ANTHROPIC_API_KEY, before);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/auth/credentials' })).statusCode, 200);
  assert.equal(core.vault.has('claude-code'), false);
});

test('a device sign-in of a CLI that is not there ends cli-missing, and can be read and cancelled', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/setup/logins', ...json({ tool: 'codex', method: 'device' }) });
  assert.equal(res.statusCode, 201);
  const session = res.json<LoginSession>();
  assert.deepEqual([session.state, session.error, session.url, session.code], ['failed', 'cli-missing', null, null]);
  assert.equal((await app.inject(`/api/setup/logins/${session.id}`)).json<LoginSession>().error, 'cli-missing');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/setup/logins/${session.id}` })).json<LoginSession>().state, 'failed');
  assert.ok(events.some((e) => e.type === 'login.updated' && e.login.id === session.id && e.login.state === 'failed'));
  assert.equal((await app.inject('/api/setup/logins/nope')).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/setup/logins/nope' })).statusCode, 404);
});

test('a bad sign-in request is a 400 whose message never carries the key', async () => {
  for (const body of [
    { tool: 'jira', method: 'key', secret: 'x' },
    { tool: 'gemini', method: 'device' },
    { tool: 'codex', method: 'key', secret: 'has a space' },
    { tool: 'gh', method: 'key', secret: 'ghp_x', host: '-oProxyCommand=x' },
  ]) {
    const res = await app.inject({ method: 'POST', url: '/api/setup/logins', ...json(body) });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.ok(!res.body.includes('has a space'));
  }
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/setup/credentials/jira' })).statusCode, 400);
});

test('a Copilot token is kept for Copilot\'s environment, a classic one is refused, and signing out forgets it', async () => {
  const classic = await app.inject({ method: 'POST', url: '/api/setup/logins', ...json({ tool: 'copilot', method: 'key', secret: 'ghp_classicNeverEchoed' }) });
  assert.equal(classic.statusCode, 400);
  assert.ok(!classic.body.includes('ghp_classicNeverEchoed'));
  assert.equal(core.vault.has('copilot'), false);

  const secret = 'github_pat_11AAAA_api_never_echoed';
  const res = await app.inject({ method: 'POST', url: '/api/setup/logins', ...json({ tool: 'copilot', method: 'key', secret }) });
  assert.equal(res.statusCode, 201, res.body);
  assert.ok(!res.body.includes(secret));
  assert.deepEqual(core.vault.get('copilot'), { COPILOT_GITHUB_TOKEN: secret });
  assert.equal((await app.inject('/api/setup')).json<SetupState>().methods.find((m) => m.tool === 'copilot')?.deviceVia?.tool, 'gh');

  const out = await app.inject({ method: 'DELETE', url: '/api/setup/credentials/copilot' });
  assert.deepEqual(out.json<SignOutResult>(), { tool: 'copilot', host: null, signedOut: true, reason: null });
  assert.equal(core.vault.has('copilot'), false);
});

test('read-only mode refuses every setup write, and the state stays readable', async () => {
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ readOnly: true }) })).statusCode, 200);
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/setup/logins', ...json({ tool: 'gemini', method: 'key', secret: 'k' }) })).statusCode, 405);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/setup/credentials/gemini' })).statusCode, 405);
    assert.equal((await app.inject({ method: 'POST', url: '/api/setup/seen' })).statusCode, 405);
    assert.equal((await app.inject('/api/setup')).statusCode, 200);
  } finally {
    await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ readOnly: false }) });
  }
});

test("a chat's token reads the setup state but cannot start, read or cancel a sign-in, or sign anything out", async () => {
  const { token } = (await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) })).json<{ token: string }>();
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
    assert.equal((await app.inject(fromChat('GET', '/api/setup'))).statusCode, 200);
    for (const [method, url, body] of [
      ['POST', '/api/setup/seen', undefined],
      ['POST', '/api/setup/logins', { tool: 'gemini', method: 'key', secret: 'evil' }],
      ['GET', '/api/setup/logins/some-id', undefined],
      ['DELETE', '/api/setup/logins/some-id', undefined],
      ['DELETE', '/api/setup/credentials/gemini', undefined],
    ] as const) {
      assert.equal((await app.inject(fromChat(method, url, body))).statusCode, 403, `${method} ${url}`);
    }
    assert.equal(core.vault.has('gemini'), false);
  } finally {
    await app.inject({ method: 'PUT', url: '/api/security/auth', remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify({ mode: 'none' }) });
  }
});

test("the machine's own Tailscale is never signed in or out through the setup routes", async () => {
  const start = await app.inject({ method: 'POST', url: '/api/setup/logins', ...json({ tool: 'tailscale', method: 'device' }) });
  assert.equal(start.statusCode, 409, start.body);
  assert.match(start.json<{ error: string }>().error, /Tailscale app or tailscale up/);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/setup/credentials/tailscale' })).statusCode, 409);
});

test('the Tailscale the image runs signs in with an auth key that no answer or event carries, and signs out', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-api-tailscale-'));
  const node = join(dir, 'node.json');
  const key = 'fake-ts-auth-key-api-never-echoed';
  writeFileSync(node, JSON.stringify({ backendState: 'NeedsLogin', authKey: key }));
  // The fake reads its state from the environment every child inherits
  const saved = process.env.FAKE_TAILSCALE_STATE;
  process.env.FAKE_TAILSCALE_STATE = node;
  const managed = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(dir, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(dir, 'workspace'),
      AGENTRY_DATA_DIR: join(dir, 'data'),
      AGENTRY_DISTRIBUTION: 'docker',
      AGENTRY_TAILSCALE_MANAGED: '1',
      TAILSCALE_BIN: FAKE_TAILSCALE,
    }),
  );
  const seen: AgentryEvent[] = [];
  managed.events.subscribe((event) => seen.push(event));
  const api = await buildApp(managed, { logLevel: 'silent', webDist: join(dir, 'no-ui') });
  t.after(async () => {
    await api.close();
    managed.shutdown();
    if (saved === undefined) delete process.env.FAKE_TAILSCALE_STATE;
    else process.env.FAKE_TAILSCALE_STATE = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  const before = (await api.inject('/api/setup')).json<SetupState>().tailscale;
  assert.deepEqual(before, { enabled: true, managed: true, state: 'loggedOut', host: null });
  const tunnel = (await api.inject('/api/tunnel')).json<{ managed: boolean; tailscale: { reason: { code: string } } }>();
  assert.equal(tunnel.managed, true);
  assert.equal(tunnel.tailscale.reason.code, 'tunnel.managedLoggedOut');

  const res = await api.inject({ method: 'POST', url: '/api/setup/logins', ...json({ tool: 'tailscale', method: 'key', secret: key }) });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual([res.json<LoginSession>().state, res.json<LoginSession>().ready], ['succeeded', true]);
  assert.ok(!res.body.includes(key));
  assert.ok(!JSON.stringify(seen).includes(key));
  assert.equal(managed.vault.has('tailscale'), false, 'tailscaled keeps the node key; the auth key is not stored');
  assert.equal((await api.inject('/api/setup')).json<SetupState>().tailscale.state, 'ready');

  const out = await api.inject({ method: 'DELETE', url: '/api/setup/credentials/tailscale' });
  assert.deepEqual(out.json<SignOutResult>(), { tool: 'tailscale', host: null, signedOut: true, reason: null });
  assert.equal((await api.inject('/api/setup')).json<SetupState>().tailscale.state, 'loggedOut');
});
