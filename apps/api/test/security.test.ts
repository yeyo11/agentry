import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import { REDACTED } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// Each test gets its own wrapper: the auth mode is process-wide state, and a test that closes the
// port must not be able to close it for the next one.
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

interface Wrapper {
  app: FastifyInstance;
  core: Core;
}

async function wrapper(env: NodeJS.ProcessEnv = {}): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'agentry-security-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
      ...env,
    }),
  );
  return { app: await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') }), core };
}

/** Puts the wrapper in token mode and answers with the token, which exists only here. */
async function withToken(app: FastifyInstance): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  assert.equal(created.statusCode, 200);
  const { token } = created.json() as { token: string };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  return token;
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
/** A body and a credential at once: both live in `headers`, so they cannot be spread separately. */
const authed = (token: string, body: unknown) => ({
  payload: JSON.stringify(body),
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
});

test('an install nobody configured is open, exactly as it was', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());

  assert.deepEqual((await app.inject('/api/security/auth')).json(), { mode: 'none', tokenSet: false, readOnly: false });
  assert.equal((await app.inject('/api/overview')).statusCode, 200);
  assert.equal((await app.inject('/api/system')).statusCode, 200);
});

test('with a token every route needs it, and health does not', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  // A probe has to work without a credential, and says nothing about the install
  assert.equal((await app.inject('/api/health')).statusCode, 200);

  const refused = await app.inject('/api/overview');
  assert.equal(refused.statusCode, 401);
  assert.match(refused.headers['www-authenticate'] as string, /^Bearer/);
  // The mode travels with the refusal: it is how the UI knows what to ask for
  assert.equal(refused.json().mode, 'token');

  assert.equal((await app.inject({ url: '/api/overview', ...bearer(token) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/overview', headers: { authorization: token } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'x' }) })).statusCode, 401);

  // The reference and the document it renders are part of the API, not of the public shell
  assert.equal((await app.inject('/openapi.json')).statusCode, 401);
  assert.equal((await app.inject('/docs')).statusCode, 401);
  assert.equal((await app.inject({ url: '/openapi.json', ...bearer(token) })).statusCode, 200);

  // The token is never readable back, in any shape
  const config = await app.inject({ url: '/api/security/auth', ...bearer(token) });
  assert.equal(config.payload.includes(token), false);
  assert.deepEqual(config.json(), { mode: 'token', tokenSet: true, readOnly: false });
});

test('the event stream takes the token in the query string, which EventSource cannot avoid', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  const open = (url: string) =>
    new Promise<{ status: number; first: string }>((resolve, reject) => {
      const req = get(url, (res) => {
        res.setEncoding('utf8');
        res.once('data', (chunk: string) => {
          req.destroy();
          resolve({ status: res.statusCode ?? 0, first: chunk });
        });
        res.once('end', () => resolve({ status: res.statusCode ?? 0, first: '' }));
      });
      req.on('error', reject);
    });

  const guarded = await open(`${base}/api/events`);
  assert.equal(guarded.status, 401);

  const allowed = await open(`${base}/api/events?token=${encodeURIComponent(token)}`);
  assert.equal(allowed.status, 200);
  assert.match(allowed.first, /retry: 3000/);

  const wrong = await open(`${base}/api/events?token=nope`);
  assert.equal(wrong.status, 401);

  // A transcript export is a download link, which carries no header either. An unknown chat is a
  // 404: what matters is that the guard let it reach the route.
  assert.equal((await app.inject('/api/chats/nope/export')).statusCode, 401);
  assert.equal((await app.inject(`/api/chats/nope/export?format=json&token=${encodeURIComponent(token)}`)).statusCode, 404);
  assert.equal((await app.inject('/api/projects/nope/export')).statusCode, 401);
  assert.equal((await app.inject(`/api/projects/nope/export?token=${encodeURIComponent(token)}`)).statusCode, 404);

  // Only the routes a browser cannot put a header on: anything callable with `fetch` may not
  assert.equal((await app.inject(`/api/overview?token=${encodeURIComponent(token)}`)).statusCode, 401);
});

test('an OIDC wrapper refuses a token it cannot check, without reaching for the issuer', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  // 127.0.0.1:1 is a closed port: a JWT that is not even a JWT must fail before any fetch
  const configured = await app.inject({
    method: 'PUT',
    url: '/api/security/auth',
    ...json({ oidc: { issuer: 'http://127.0.0.1:1', audience: 'agentry', clientId: 'ui' }, mode: 'oidc' }),
  });
  assert.equal(configured.statusCode, 200);
  assert.deepEqual(configured.json().oidc, { issuer: 'http://127.0.0.1:1', audience: 'agentry', clientId: 'ui' });

  const refused = await app.inject({ url: '/api/overview', ...bearer('not.a.jwt') });
  assert.equal(refused.statusCode, 401);
  assert.equal(refused.json().mode, 'oidc');
  assert.equal((await app.inject('/api/health')).statusCode, 200);
});

test('read-only refuses every change but answering a prompt and turning itself back off', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const created = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'demo' }) });
  assert.equal(created.statusCode, 201);

  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ readOnly: true }) })).statusCode, 200);

  const rejected = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'another' }) });
  assert.equal(rejected.statusCode, 405);
  assert.match(rejected.json().error, /read-only/);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${created.json().id}` })).statusCode, 405);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/config/settings', ...json({ settings: { model: 'sonnet' } }) })).statusCode, 405);
  // Reading is exactly what read-only is for
  assert.equal((await app.inject('/api/projects')).statusCode, 200);

  // A prompt still gets an answer: 400 because this one does not exist, and not 405
  const answered = await app.inject({ method: 'POST', url: '/api/chats/c1/permissions/p1', ...json({ behavior: 'allow' }) });
  assert.notEqual(answered.statusCode, 405);

  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ readOnly: false }) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'another' }) })).statusCode, 201);
});

test('settings hand out the names of their secrets and take the placeholder back unchanged', async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());

  const written = await app.inject({
    method: 'PUT',
    url: '/api/config/settings',
    ...json({ settings: { model: 'sonnet', env: { ANTHROPIC_AUTH_TOKEN: 'sk-real-secret', REGION: 'eu' } } }),
  });
  assert.equal(written.statusCode, 200);
  // Even the answer to the write is redacted: the value never travels back
  assert.deepEqual(written.json().settings.env, { ANTHROPIC_AUTH_TOKEN: REDACTED, REGION: REDACTED });

  const read = await app.inject('/api/config/settings');
  assert.equal(read.json().settings.model, 'sonnet');
  assert.equal(read.payload.includes('sk-real-secret'), false);

  // The panel sends back what it was given, with one field edited
  const edited = read.json().settings as Record<string, unknown>;
  const roundTripped = await app.inject({
    method: 'PUT',
    url: '/api/config/settings',
    ...json({ settings: { ...edited, model: 'opus', env: { ANTHROPIC_AUTH_TOKEN: REDACTED, REGION: 'us' } } }),
  });
  assert.equal(roundTripped.statusCode, 200);

  const onDisk = JSON.parse(readFileSync(join(core.config.configDir, 'settings.json'), 'utf8')) as { model: string; env: Record<string, string> };
  assert.equal(onDisk.model, 'opus');
  assert.equal(onDisk.env.ANTHROPIC_AUTH_TOKEN, 'sk-real-secret', 'the placeholder must not overwrite the stored secret');
  assert.equal(onDisk.env.REGION, 'us');

  // A placeholder standing for nothing is refused rather than written down as itself
  const invented = await app.inject({ method: 'PUT', url: '/api/config/settings', ...json({ settings: { env: { NEW_ONE: REDACTED } } }) });
  assert.equal(invented.statusCode, 400);
  assert.match(invented.json().error, /no stored value behind the placeholder/);
});

test('every write leaves an audit row, with who and what but never the body', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());

  const created = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'audited' }) });
  assert.equal(created.statusCode, 201);
  await app.inject({ method: 'PUT', url: '/api/config/settings', ...json({ settings: { model: 'sonnet' } }) });
  await app.inject({ method: 'DELETE', url: `/api/projects/${created.json().id}` });
  assert.equal((await app.inject('/api/projects')).statusCode, 200); // a read leaves nothing

  const page = (await app.inject('/api/audit')).json();
  assert.equal(page.total, 3);
  assert.equal(page.from, 0);
  const [newest] = page.entries;
  assert.equal(newest.method, 'DELETE');
  assert.match(newest.path, /^\/api\/projects\//);
  assert.equal(newest.actor, 'local');
  assert.equal(newest.status, 200);
  // The summary comes from the route's own documentation, not from anything the caller sent
  assert.equal(newest.summary, 'Remove a project from Agentry');
  assert.equal(page.entries.some((entry: { summary: string }) => entry.summary === 'Create a project in the workspace'), true);
  assert.equal((await app.inject('/api/audit')).payload.includes('audited'), false, 'no body, and no name from one, is ever recorded');

  const filtered = (await app.inject('/api/audit?path=/api/config')).json();
  assert.equal(filtered.total, 1);
  assert.equal(filtered.entries[0].summary, 'Replace settings.json');

  const paged = (await app.inject('/api/audit?limit=1&from=1')).json();
  assert.equal(paged.entries.length, 1);
  assert.equal(paged.from, 1);
  assert.equal(paged.total, 3);
});

test('a write refused for want of a credential is recorded as nobody', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'x' }) })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...authed(token, { name: 'named' }) })).statusCode, 201);

  const page = (await app.inject({ url: '/api/audit', ...bearer(token) })).json();
  const refused = page.entries.find((entry: { status: number }) => entry.status === 401);
  assert.ok(refused, 'the attempt is in the log');
  assert.equal(refused.actor, 'anonymous');
  // And what the credential did carries its id, which is how a rotation shows up in the history
  const allowed = page.entries.find((entry: { status: number }) => entry.status === 201);
  assert.match(allowed.actor, /^token:/);
});

test('the environment can hand a fresh install a closed door', async (t) => {
  const { app } = await wrapper({ AGENTRY_AUTH_TOKEN: 'a-token-from-a-secret', AGENTRY_READ_ONLY: '1' });
  t.after(() => app.close());

  assert.equal((await app.inject('/api/overview')).statusCode, 401);
  assert.deepEqual((await app.inject({ url: '/api/security/auth', ...bearer('a-token-from-a-secret') })).json(), {
    mode: 'token',
    tokenSet: true,
    readOnly: true,
  });
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...authed('a-token-from-a-secret', { name: 'x' }) })).statusCode, 405);
});
