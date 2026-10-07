import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import { REDACTED } from '@agentry/shared';
import { buildApp } from '../src/app.ts';
import { FailureBackoff } from '../src/security.ts';

// Each test gets its own wrapper: the auth mode is process-wide state, and a test that closes the
// port must not be able to close it for the next one.
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

interface Wrapper {
  app: FastifyInstance;
  core: Core;
}

async function wrapper(env: NodeJS.ProcessEnv = {}, root = mkdtempSync(join(tmpdir(), 'agentry-security-'))): Promise<Wrapper> {
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

  // The other two a browser opens without a header: a chat's own stream and an attachment shown
  // inline. Unknown ids again, so only the guard's answer is under test.
  for (const path of ['/api/chats/nope/stream', '/api/uploads/nope/content']) {
    assert.equal((await app.inject(path)).statusCode, 401, path);
    assert.notEqual((await app.inject(`${path}?token=${encodeURIComponent(token)}`)).statusCode, 401, path);
  }

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

  const deletes = (await app.inject('/api/audit?method=delete')).json();
  assert.equal(deletes.total, 1);
  assert.equal(deletes.entries[0].method, 'DELETE');
  assert.equal((await app.inject('/api/audit?status=2xx')).json().total, 3);
  assert.equal((await app.inject('/api/audit?status=201')).json().total, 1);
  assert.equal((await app.inject('/api/audit?status=4xx&method=POST')).json().total, 0);
  const refused = await app.inject('/api/audit?status=teapot');
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /a code such as 404 or a class such as 4xx/);
});

test('the audit page says itself what a page number must be, instead of letting SQLite say it', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());

  for (const query of ['limit=soon', 'limit=1.5', 'limit=-1', 'from=yesterday', 'from=-1']) {
    const refused = await app.inject(`/api/audit?${query}`);
    assert.equal(refused.statusCode, 400, query);
    // NaN used to reach node:sqlite as a binding and come back as `datatype mismatch`
    assert.match(refused.json().error, /must be a non-negative integer/, query);
  }
  // An absent or empty parameter is not a mistake: it means the default page
  assert.equal((await app.inject('/api/audit')).json().from, 0);
  assert.equal((await app.inject('/api/audit?limit=&from=')).json().from, 0);
  assert.equal((await app.inject('/api/audit?limit=1&from=0')).statusCode, 200);
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

test('AGENTRY_AUTH_TOKEN_RESET lets someone who lost the token back in, once, and says so in the log', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-security-'));
  const first = await wrapper({}, root);
  const lost = await withToken(first.app);
  await first.app.close();

  const reset = { AGENTRY_AUTH_TOKEN: 'a-recovered-token-from-env', AGENTRY_AUTH_TOKEN_RESET: '1' };
  const second = await wrapper(reset, root);
  assert.equal((await second.app.inject({ url: '/api/overview', ...bearer(lost) })).statusCode, 401, 'the lost token no longer opens it');
  assert.equal((await second.app.inject({ url: '/api/overview', ...bearer(reset.AGENTRY_AUTH_TOKEN) })).statusCode, 200);
  const rows = (await second.app.inject({ url: '/api/audit?path=/api/security/token', ...bearer(reset.AGENTRY_AUTH_TOKEN) })).json();
  const byEnv = rows.entries.filter((entry: { actor: string }) => entry.actor === 'env');
  assert.equal(byEnv.length, 1);
  assert.match(byEnv[0].summary, /AGENTRY_AUTH_TOKEN_RESET/);
  // Someone rotates it from the UI; a restart with the variable still set must not undo that
  const rotated = (await second.app.inject({ method: 'POST', url: '/api/security/token', ...authed(reset.AGENTRY_AUTH_TOKEN, {}) })).json() as { token: string };
  await second.app.close();

  const third = await wrapper(reset, root);
  t.after(() => third.app.close());
  assert.equal((await third.app.inject({ url: '/api/overview', ...bearer(rotated.token) })).statusCode, 200);
  assert.equal((await third.app.inject({ url: '/api/overview', ...bearer(reset.AGENTRY_AUTH_TOKEN) })).statusCode, 401);
  const after = (await third.app.inject({ url: '/api/audit?path=/api/security/token', ...bearer(rotated.token) })).json();
  assert.equal(after.entries.filter((entry: { actor: string }) => entry.actor === 'env').length, 1, 'no second reset row');
});

test('a host nobody configured is refused, which is what stops DNS rebinding', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());

  // Loopback is the install itself, under every spelling a browser or a dual-stack socket produces
  for (const host of ['localhost', 'localhost:8787', '127.0.0.1:8787', '127.1.2.3', '[::1]:8787', '::ffff:127.0.0.1']) {
    assert.equal((await app.inject({ url: '/api/overview', headers: { host } })).statusCode, 200, host);
  }

  // The attack itself: a page on a name whose second lookup answers 127.0.0.1
  const rebound = await app.inject({ url: '/api/overview', headers: { host: 'rebind.evil.test' } });
  assert.equal(rebound.statusCode, 421);
  assert.match(rebound.json().error, /AGENTRY_ALLOWED_HOSTS/);

  // Every guarded path, not just the API: /docs and the reference serve the same install
  assert.equal((await app.inject({ url: '/openapi.json', headers: { host: 'rebind.evil.test' } })).statusCode, 421);
  const written = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: JSON.stringify({ name: 'x' }),
    headers: { host: 'rebind.evil.test', 'content-type': 'application/json' },
  });
  assert.equal(written.statusCode, 421);
  // A probe stays open whatever it dialled: it says nothing about the install
  assert.equal((await app.inject({ url: '/api/health', headers: { host: 'rebind.evil.test' } })).statusCode, 200);
});

test('AGENTRY_ALLOWED_HOSTS names the hosts a deployment answers to, port and case aside', async (t) => {
  const { app } = await wrapper({ AGENTRY_ALLOWED_HOSTS: 'agentry.example.com, agentry.internal' });
  t.after(() => app.close());

  assert.equal((await app.inject({ url: '/api/overview', headers: { host: 'agentry.example.com' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/overview', headers: { host: 'AGENTRY.Example.COM:8787' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/overview', headers: { host: 'agentry.internal:443' } })).statusCode, 200);
  // A name that merely contains one of them is a different name
  assert.equal((await app.inject({ url: '/api/overview', headers: { host: 'agentry.example.com.evil.test' } })).statusCode, 421);
  assert.equal((await app.inject({ url: '/api/overview', headers: { host: 'other.example.com' } })).statusCode, 421);
});

test('a pattern answers to the subdomains of a domain, and to nothing that merely looks like one', async (t) => {
  // What a tunnel needs: its host changes on every start, and only the domain under it is fixed
  const { app } = await wrapper({ AGENTRY_ALLOWED_HOSTS: '*.tunnel.example, agentry.internal' });
  t.after(() => app.close());

  for (const host of ['a.tunnel.example', 'a-1234.region.tunnel.example', 'A.Tunnel.Example:8787']) {
    assert.equal((await app.inject({ url: '/api/overview', headers: { host } })).statusCode, 200, host);
  }
  // A name alongside the pattern still answers, and the apex is a host of its own
  assert.equal((await app.inject({ url: '/api/overview', headers: { host: 'agentry.internal' } })).statusCode, 200);
  for (const host of ['tunnel.example', 'eviltunnel.example', 'tunnel.example.evil.test']) {
    assert.equal((await app.inject({ url: '/api/overview', headers: { host } })).statusCode, 421, host);
  }
});

test('the host is checked before the credential, so an open install is guarded too', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  // Even holding the credential that opens everything: the authority is refused first
  const refused = await app.inject({ url: '/api/overview', headers: { host: 'rebind.evil.test', authorization: `Bearer ${token}` } });
  assert.equal(refused.statusCode, 421);
  assert.equal(refused.headers['www-authenticate'], undefined);
});

test('a client that keeps guessing the token is asked to wait, and the wait grows', () => {
  let now = 0;
  const backoff = new FailureBackoff(() => now);

  // The first failures are free: a mistyped token must not lock someone out of their own wrapper
  for (let i = 0; i < 9; i += 1) {
    backoff.fail('10.0.0.1');
    assert.equal(backoff.retryAfter('10.0.0.1'), 0, `failure ${i + 1}`);
  }

  backoff.fail('10.0.0.1');
  assert.equal(backoff.retryAfter('10.0.0.1'), 1);
  // Waiting it out and failing again costs twice as long
  now += 1_000;
  assert.equal(backoff.retryAfter('10.0.0.1'), 0);
  backoff.fail('10.0.0.1');
  assert.equal(backoff.retryAfter('10.0.0.1'), 2);
  now += 2_000;
  backoff.fail('10.0.0.1');
  assert.equal(backoff.retryAfter('10.0.0.1'), 4);

  // Capped: a wait that doubled for ever would be a permanent ban on an address
  for (let i = 0; i < 20; i += 1) {
    now += 60_000;
    backoff.fail('10.0.0.1');
  }
  assert.equal(backoff.retryAfter('10.0.0.1'), 60);

  // Another address is another client: one attacker does not close the wrapper for everybody
  assert.equal(backoff.retryAfter('10.0.0.2'), 0);
  // And a credential that works clears what came before it
  backoff.succeed('10.0.0.1');
  assert.equal(backoff.retryAfter('10.0.0.1'), 0);
});

test('a quiet client is forgotten, and the addresses remembered cannot grow without end', () => {
  let now = 0;
  const backoff = new FailureBackoff(() => now);

  for (let i = 0; i < 12; i += 1) backoff.fail('10.0.0.1');
  assert.ok(backoff.retryAfter('10.0.0.1') > 0);

  // Quiet for the forgetting period: the count starts over instead of resuming where it stopped
  now += 15 * 60_000;
  assert.equal(backoff.retryAfter('10.0.0.1'), 0);
  backoff.fail('10.0.0.1');
  assert.equal(backoff.retryAfter('10.0.0.1'), 0, 'the old count did not come back');

  // A botnet with a fresh address per attempt feeds the map; it stays bounded
  for (let i = 0; i < 5_000; i += 1) {
    now += 1;
    backoff.fail(`10.1.${Math.floor(i / 256)}.${i % 256}`);
  }
  assert.ok(backoff.size > 0 && backoff.size <= 1024, `bounded, got ${backoff.size}`);
  // And the flood does not buy the attacker a clean slate: an address still failing is still counted
  for (let i = 0; i < 10; i += 1) backoff.fail('10.9.9.9');
  assert.ok(backoff.retryAfter('10.9.9.9') > 0);
});

test('the guard answers 429 once an address has failed too often, with a Retry-After', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  for (let i = 0; i < 10; i += 1) {
    assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 401, `attempt ${i + 1}`);
  }

  const throttled = await app.inject({ url: '/api/overview', ...bearer('not-the-token') });
  assert.equal(throttled.statusCode, 429);
  assert.equal(throttled.headers['retry-after'], '1');
  assert.equal(throttled.json().mode, 'token');
  // The real token waits with the rest: the wait is on the address, which is all the guard knows
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(token) })).statusCode, 429);
  // Nothing open is affected, so a container healthcheck survives an attack on its own port
  assert.equal((await app.inject('/api/health')).statusCode, 200);
});

test('a credential that works clears the failures behind it', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  for (let i = 0; i < 9; i += 1) {
    assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 401);
  }
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(token) })).statusCode, 200);

  // Nine more would have passed the threshold had the successful one not wiped the slate
  for (let i = 0; i < 9; i += 1) {
    assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 401, `after the success, attempt ${i + 1}`);
  }
});

test('a request that carries no credential is refused but never counted, however often it comes', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  await withToken(app);

  // A tray or a stale tab polling without a credential is not guessing the token
  for (let i = 0; i < 40; i += 1) {
    const refused = await app.inject('/api/overview');
    assert.equal(refused.statusCode, 401, `anonymous attempt ${i + 1}`);
    assert.equal(refused.headers['retry-after'], undefined);
  }
  // Nor is an empty bearer, or a `?token=` on a route that never reads one
  assert.equal((await app.inject({ url: '/api/overview', headers: { authorization: 'Bearer ' } })).statusCode, 401);
  assert.equal((await app.inject('/api/overview?token=whatever')).statusCode, 401);
  // A wrong token still has its whole allowance: nothing above spent any of it
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 401, `wrong token ${i + 1}`);
  }
  assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 429);
});

test('a wrong token in the query string is a guess like any other', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  await withToken(app);

  for (let i = 0; i < 10; i += 1) {
    assert.equal((await app.inject('/api/chats/x/export?token=not-the-token')).statusCode, 401, `attempt ${i + 1}`);
  }
  assert.equal((await app.inject('/api/chats/x/export?token=not-the-token')).statusCode, 429);
});

test('an address blocked for wrong tokens stays blocked, and anonymous requests are only refused', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  for (let i = 0; i < 10; i += 1) await app.inject({ url: '/api/overview', ...bearer('not-the-token') });
  assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 429);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(token) })).statusCode, 429);
  // Nothing to check, so nothing to wait for: the answer is the plain refusal
  assert.equal((await app.inject('/api/overview')).statusCode, 401);
  // And going without a credential is not a way to serve the wait sooner
  assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 429);
});

test('the owner is served while something on the same machine polls without a credential', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  // What happened on the desktop: the tray polled every few seconds, all from 127.0.0.1
  for (let round = 0; round < 5; round += 1) {
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await app.inject({ url: i % 2 ? '/api/events' : '/api/overview', remoteAddress: '127.0.0.1' })).statusCode, 401);
    }
    const owner = await app.inject({ url: '/api/overview', remoteAddress: '127.0.0.1', ...bearer(token) });
    assert.equal(owner.statusCode, 200, `round ${round + 1}`);
  }
});

const DESKTOP_SECRET = 'a-per-launch-secret-of-32-random-bytes';

test("the desktop app's own secret lets its tray read from loopback, whatever token the owner chose", async (t) => {
  const { app, core } = await wrapper({ AGENTRY_DESKTOP_TOKEN: DESKTOP_SECRET });
  t.after(() => app.close());
  await withToken(app);

  // How the tray asks: from 127.0.0.1, to 127.0.0.1
  const local = { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:43123', authorization: `Bearer ${DESKTOP_SECRET}` } };
  assert.equal((await app.inject({ url: '/api/overview', ...local })).statusCode, 200);
  // The event feed takes it as a header like any other route
  assert.equal((await app.inject({ url: '/api/chats?state=working&limit=10', ...local })).statusCode, 200);

  // It reads and nothing else, and the refusal is written down under its name
  const write = await app.inject({ method: 'POST', url: '/api/projects', ...local, payload: { name: 'x' } });
  assert.equal(write.statusCode, 403);
  const audit = core.db.auditPage({ path: '/api/projects' }).entries[0];
  assert.equal(audit?.actor, 'desktop');

  // No route hands it back
  for (const url of ['/api/security/auth', '/api/system', '/api/overview']) {
    const res = await app.inject({ url, ...local });
    assert.equal(res.body.includes(DESKTOP_SECRET), false, url);
  }
});

test("the desktop app's secret is refused from anywhere but this machine, and a wrong one is a guess", async (t) => {
  const { app } = await wrapper({ AGENTRY_DESKTOP_TOKEN: DESKTOP_SECRET, AGENTRY_ALLOWED_HOSTS: 'agentry.example' });
  t.after(() => app.close());
  await withToken(app);
  const withSecret = (secret: string) => ({ authorization: `Bearer ${secret}` });

  // From another address
  assert.equal((await app.inject({ url: '/api/overview', remoteAddress: '10.0.0.5', headers: { host: '127.0.0.1:43123', ...withSecret(DESKTOP_SECRET) } })).statusCode, 401);
  // From loopback, but relayed: a proxy or a tunnel carries the name it was reached on
  assert.equal((await app.inject({ url: '/api/overview', remoteAddress: '127.0.0.1', headers: { host: 'agentry.example', ...withSecret(DESKTOP_SECRET) } })).statusCode, 401);
  // A secret that is not the one this launch was given
  assert.equal((await app.inject({ url: '/api/overview', remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:43123', ...withSecret(`${DESKTOP_SECRET}x`) } })).statusCode, 401);
});

test('without a desktop secret configured, nothing is accepted in its place', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  await withToken(app);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(DESKTOP_SECRET) })).statusCode, 401);
});

// ---------- a chat's own token (AGENTRY_API_TOKEN) ----------

/** How a chat on this machine calls the wrapper that started it: loopback peer, loopback name. */
const fromChat = (token: string, extra: Record<string, string> = {}) => ({
  remoteAddress: '127.0.0.1',
  headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}`, ...extra },
});
const fromChatWith = (token: string, body: unknown) => ({
  remoteAddress: '127.0.0.1',
  payload: JSON.stringify(body),
  headers: { host: '127.0.0.1:34331', 'content-type': 'application/json', authorization: `Bearer ${token}` },
});

test("a chat's token opens a guarded read and a write from loopback, and the write is audited as the chat", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const token = core.security.chatTokens.mint('chat-42');

  assert.equal((await app.inject({ url: '/api/overview', ...fromChat(token) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/overview', ...fromChat(token, { host: 'localhost:34331' }) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/overview', remoteAddress: '::1', headers: { host: '[::1]:34331', authorization: `Bearer ${token}` } })).statusCode, 200);
  const created = await app.inject({ method: 'POST', url: '/api/projects', ...fromChatWith(token, { name: 'from-a-chat' }) });
  assert.equal(created.statusCode, 201);

  const [newest] = (await app.inject({ url: '/api/audit', ...bearer(owner) })).json().entries;
  assert.equal(newest.actor, 'chat:chat-42');
  assert.equal(newest.path, '/api/projects');
});

test("a chat's token is refused, like a wrong token, from anywhere that is not a chat on this machine", async (t) => {
  const { app, core } = await wrapper({ AGENTRY_ALLOWED_HOSTS: 'agentry.example' });
  t.after(() => app.close());
  await withToken(app);
  core.appSettings.runtimeHosts.add('abc123.lhr.life', { clientIpHeader: 'X-Client-Ip' });
  const token = core.security.chatTokens.mint('chat-42');
  const wrong = await app.inject({ url: '/api/overview', ...bearer('not-the-token') });

  const cases: Array<[string, InjectOptions]> = [
    ['a peer that is not loopback', { url: '/api/overview', remoteAddress: '10.0.0.5', headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}` } }],
    // The tunnel dials 127.0.0.1 too: only the name it carries tells it apart
    ['the tunnel host', { url: '/api/overview', ...fromChat(token, { host: 'abc123.lhr.life' }) }],
    ['an allowed host', { url: '/api/overview', ...fromChat(token, { host: 'agentry.example' }) }],
    ['X-Forwarded-For', { url: '/api/overview', ...fromChat(token, { 'x-forwarded-for': '203.0.113.9' }) }],
    ['Forwarded', { url: '/api/overview', ...fromChat(token, { forwarded: 'for=203.0.113.9' }) }],
    ["a runtime host's client-IP header", { url: '/api/overview', ...fromChat(token, { 'x-client-ip': '203.0.113.9' }) }],
  ];
  for (const [where, request] of cases) {
    const refused = await app.inject(request);
    assert.equal(refused.statusCode, 401, where);
    assert.equal(refused.payload, wrong.payload, `${where}: the same body as a wrong token`);
    assert.equal(refused.headers['www-authenticate'], wrong.headers['www-authenticate'], `${where}: the same challenge`);
  }
});

test("a chat's token used from the wrong place is a guess, and counts toward the wait", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  await withToken(app);
  const token = core.security.chatTokens.mint('chat-42');
  const outside = { url: '/api/overview', remoteAddress: '10.0.0.5', headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}` } };
  for (let i = 0; i < 10; i += 1) assert.equal((await app.inject(outside)).statusCode, 401, `attempt ${i + 1}`);
  assert.equal((await app.inject(outside)).statusCode, 429);
});

test("a chat's token is refused once revoked, and by a wrapper started afresh", async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-security-'));
  const first = await wrapper({}, root);
  await withToken(first.app);
  const token = first.core.security.chatTokens.mint('chat-42');
  const kept = first.core.security.chatTokens.mint('chat-43');
  assert.equal((await first.app.inject({ url: '/api/overview', ...fromChat(token) })).statusCode, 200);
  first.core.security.chatTokens.revoke(token);
  assert.equal((await first.app.inject({ url: '/api/overview', ...fromChat(token) })).statusCode, 401);
  await first.app.close();
  first.core.shutdown();

  // Same data dir, same owner token on disk: only the chat tokens are gone
  const second = await wrapper({}, root);
  t.after(() => second.app.close());
  assert.equal((await second.app.inject({ url: '/api/overview', ...fromChat(kept) })).statusCode, 401);
});

test("a chat's token cannot administer the guard or open the tunnel, but can close it", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  await withToken(app);
  const token = core.security.chatTokens.mint('chat-42');
  const forbidden: Array<[string, string, unknown]> = [
    ['PUT', '/api/security/auth', { mode: 'none' }],
    ['POST', '/api/security/token', {}],
    ['DELETE', '/api/security/token', undefined],
    ['POST', '/api/tunnel/start', undefined],
    ['PUT', '/api/tunnel/settings', { startWithAgentry: true }],
  ];
  for (const [method, url, body] of forbidden) {
    const request = body === undefined ? { method, url, ...fromChat(token) } : { method, url, ...fromChatWith(token, body) };
    const answer = await app.inject(request as InjectOptions);
    assert.equal(answer.statusCode, 403, `${method} ${url}`);
    assert.match(answer.json().error, /chat's token cannot change the API's authentication/);
  }
  assert.equal(core.security.mode, 'token', 'the guard is still on');
  assert.notEqual((await app.inject({ method: 'POST', url: '/api/tunnel/stop', ...fromChat(token) })).statusCode, 403);
});

test("a chat's token cannot change a project's tracker through the general settings route", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const root = mkdtempSync(join(tmpdir(), 'agentry-security-project-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', ...authed(owner, { path: root, name: 'Tracked', modules: ['board'] }) });
  assert.equal(imported.statusCode, 201, imported.body);
  const { id } = imported.json() as { id: string };
  const url = `/api/projects/${id}/settings`;
  const tracker = { id: 'github-issues', scope: 'acme/widgets', query: 'is:open', statusMap: { done: 'completed' } };
  const settings = (await app.inject({ url, ...bearer(owner) })).json() as Record<string, unknown>;
  assert.equal((await app.inject({ method: 'PUT', url, ...authed(owner, { ...settings, tracker }) })).statusCode, 200);

  // A chat saves the document with another tracker: the rest is saved, the tracker is not
  const chat = core.security.chatTokens.mint('chat-42');
  const hijacked = { ...settings, tracker: { ...tracker, scope: 'evil/repo', query: '', statusMap: { done: 'closed' } } };
  const answer = await app.inject({ method: 'PUT', url, ...fromChatWith(chat, hijacked) });
  assert.equal(answer.statusCode, 200, answer.body);
  assert.deepEqual((answer.json() as { tracker?: unknown }).tracker, tracker);
  assert.deepEqual(((await app.inject({ url, ...bearer(owner) })).json() as { tracker?: unknown }).tracker, tracker);

  // And a chat's document without one cannot clear it
  const { tracker: _gone, ...without } = settings as Record<string, unknown>;
  assert.equal((await app.inject({ method: 'PUT', url, ...fromChatWith(chat, without) })).statusCode, 200);
  assert.deepEqual(((await app.inject({ url, ...bearer(owner) })).json() as { tracker?: unknown }).tracker, tracker);
});

test("read-only and the host allowlist apply to a chat's token as to the owner's", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...authed(owner, { readOnly: true }) })).statusCode, 200);
  const token = core.security.chatTokens.mint('chat-42');
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...fromChatWith(token, { name: 'x' }) })).statusCode, 405);
  // Refused before any credential is looked at
  assert.equal((await app.inject({ url: '/api/overview', ...fromChat(token, { host: 'rebound.example' }) })).statusCode, 421);
});

test("a chat's token is honoured under OIDC too, under the same loopback rules", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const configured = await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ oidc: { issuer: 'http://127.0.0.1:1', audience: 'agentry', clientId: 'ui' }, mode: 'oidc' }) });
  assert.equal(configured.statusCode, 200);
  const token = core.security.chatTokens.mint('chat-42');
  assert.equal((await app.inject({ url: '/api/overview', ...fromChat(token) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...fromChatWith(token, { name: 'oidc-chat' }) })).statusCode, 201);
  assert.equal((await app.inject({ url: '/api/overview', ...fromChat(token, { 'x-forwarded-for': '203.0.113.9' }) })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/overview', remoteAddress: '10.0.0.5', headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}` } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...fromChatWith(token, { mode: 'none' }) })).statusCode, 403);
});

test("an open wrapper stays open and labels a chat's writes as the chat, and a token that is not valid as local", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const token = core.security.chatTokens.mint('chat-42');
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...fromChatWith(token, { name: 'open' }) })).statusCode, 201);
  // Nothing guards it, so the chat's token administers nothing either way
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...fromChatWith(token, { readOnly: false }) })).statusCode, 200);
  // The label is all the token does here: a wrong one is not refused, it is `local`
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...fromChatWith('agentry_chat_wrong', { name: 'wrong' }) })).statusCode, 201);
  const entries = (await app.inject('/api/audit')).json().entries as Array<{ actor: string }>;
  assert.deepEqual(entries.map((entry) => entry.actor), ['local', 'chat:chat-42', 'chat:chat-42']);
});

test("the owner's token is still the owner's when chat tokens exist", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  core.security.chatTokens.mint('chat-42');
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...authed(owner, { name: 'owners' }) })).statusCode, 201);
  const [newest] = (await app.inject({ url: '/api/audit', ...bearer(owner) })).json().entries;
  assert.match(newest.actor, /^token:[0-9a-f]{8}$/);
  // The owner may still administer the guard, from anywhere the guard lets them in
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...authed(owner, { readOnly: false }) })).statusCode, 200);
});
