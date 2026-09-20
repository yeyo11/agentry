import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { REDACTED, type OidcConfig } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { AuthStore } from '../src/security/auth.ts';
import { OidcVerifier } from '../src/security/oidc.ts';
import { hasRedacted, redactSecrets, restoreSecrets } from '../src/security/redact.ts';
import { tempConfig } from './helpers.ts';

// ---------- redaction ----------

test('an MCP server keeps the names of its secrets and loses their values', () => {
  const server = { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer real-secret' }, env: { API_KEY: 'sk-live' } };
  const safe = redactSecrets(server);
  assert.equal(safe.headers.Authorization, REDACTED);
  assert.equal(safe.env.API_KEY, REDACTED);
  assert.equal(safe.url, 'https://example.test/mcp');
  // The original is untouched: what core holds is still the real configuration
  assert.equal(server.env.API_KEY, 'sk-live');
});

test('an edit that sends the placeholder back keeps the stored secret', () => {
  const stored = { command: 'npx', env: { API_KEY: 'sk-live', REGION: 'eu' } };
  const edited = { command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: REDACTED, REGION: 'us' } };
  const merged = restoreSecrets(edited, stored);
  assert.equal(merged.env.API_KEY, 'sk-live');
  assert.equal(merged.env.REGION, 'us');
  assert.deepEqual(merged.args, ['-y', 'pkg']);
  assert.equal(hasRedacted(merged), false);
});

test('a placeholder with nothing stored behind it is refused instead of written', () => {
  assert.throws(() => restoreSecrets({ env: { NEW_KEY: REDACTED } }, {}), /no stored value behind the placeholder for env.NEW_KEY/);
});

test('a document with no env or headers passes through untouched', () => {
  const doc = { model: 'sonnet', permissions: { allow: ['Bash'] } };
  assert.equal(redactSecrets(doc), doc);
  assert.equal(restoreSecrets(doc, { model: 'opus' }), doc);
});

// ---------- the auth store ----------

test('a fresh install is unguarded, which is what it has always been', async () => {
  const store = new AuthStore(tempConfig(), {});
  assert.deepEqual(store.config, { mode: 'none', tokenSet: false, readOnly: false });
  assert.equal(store.mode, 'none');
  // With no mode, anything (including nothing) is the local caller
  assert.equal(await store.actorFor(undefined), 'local');
});

test('the token is returned once, stored as a hash and accepted afterwards', async () => {
  const config = tempConfig();
  const store = new AuthStore(config, {});
  const { token } = await store.setToken();
  assert.ok(token.length >= 32);
  await store.update({ mode: 'token' });

  assert.deepEqual(store.config, { mode: 'token', tokenSet: true, readOnly: false });
  assert.equal(JSON.stringify(store.config).includes(token), false);
  const onDisk = readFileSync(join(config.dataDir, 'auth.json'), 'utf8');
  assert.equal(onDisk.includes(token), false, 'the token itself must never reach the disk');
  assert.match(onDisk, /"tokenHash": "[0-9a-f]{64}"/);

  assert.match((await store.actorFor(token)) ?? '', /^token:/);
  assert.equal(await store.actorFor('not-the-token'), null);
  assert.equal(await store.actorFor(undefined), null);

  // A restart reads the hash back and the same token still works
  const reopened = new AuthStore(config, {});
  assert.equal(reopened.mode, 'token');
  assert.match((await reopened.actorFor(token)) ?? '', /^token:/);
});

test('rotating the token stops the previous one', async () => {
  const store = new AuthStore(tempConfig(), {});
  const first = (await store.setToken()).token;
  await store.update({ mode: 'token' });
  const second = (await store.setToken({ token: 'a-token-of-my-own-16+' })).token;
  assert.equal(second, 'a-token-of-my-own-16+');
  assert.equal(await store.actorFor(first), null);
  assert.ok(await store.actorFor(second));
});

test('a mode that would lock everyone out is refused', async () => {
  const store = new AuthStore(tempConfig(), {});
  await assert.rejects(store.update({ mode: 'token' }), /set a token before/);
  await assert.rejects(store.update({ mode: 'oidc' }), /configure the issuer/);
  await assert.rejects(store.setToken({ token: 'short' }), /at least 16 characters/);

  await store.setToken();
  await store.update({ mode: 'token' });
  await assert.rejects(store.clearToken(), /switch the mode away/);
  await store.update({ mode: 'none' });
  assert.equal((await store.clearToken()).tokenSet, false);
});

test('read-only is part of the guard and survives a restart', async () => {
  const config = tempConfig();
  const store = new AuthStore(config, {});
  assert.equal(store.readOnly, false);
  await store.update({ readOnly: true });
  assert.equal(new AuthStore(config, {}).readOnly, true);
});

test('the environment can close a fresh install, and never writes the token down', () => {
  const config = tempConfig();
  const store = new AuthStore(config, { AGENTRY_AUTH_TOKEN: 'from-the-environment-42', AGENTRY_READ_ONLY: '1' });
  assert.equal(store.mode, 'token');
  assert.equal(store.readOnly, true);
  assert.equal(readFileSync(join(config.dataDir, 'auth.json'), 'utf8').includes('from-the-environment-42'), false);
  // The document on disk wins from then on: the environment only seeds an install that has none
  const configured = new AuthStore(config, { AGENTRY_AUTH_MODE: 'none' });
  assert.equal(configured.mode, 'token');
});

test('AGENTRY_AUTH_MODE without what it needs fails loudly rather than opening the port', () => {
  assert.throws(() => new AuthStore(tempConfig(), { AGENTRY_AUTH_MODE: 'token' }), /needs AGENTRY_AUTH_TOKEN/);
  assert.throws(() => new AuthStore(tempConfig(), { AGENTRY_AUTH_MODE: 'oidc' }), /AGENTRY_OIDC_ISSUER/);
});

test('an auth document that cannot be read stops the wrapper instead of unguarding it', () => {
  const config = tempConfig();
  new AuthStore(config, { AGENTRY_AUTH_TOKEN: 'from-the-environment-42' });
  writeFileSync(join(config.dataDir, 'auth.json'), '{ not json');
  assert.throws(() => new AuthStore(config, {}), /is not readable as JSON/);
});

// ---------- OIDC ----------

interface Issuer {
  url: string;
  close(): Promise<void>;
  jwt(claims: Record<string, unknown>, opts?: { kid?: string; key?: KeyObject }): string;
}

/** A minimal issuer: a discovery document, a JWKS, and tokens signed with the key in it. */
async function startIssuer(): Promise<Issuer> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let server: Server;
  let url = '';
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/.well-known/openid-configuration') res.end(JSON.stringify({ issuer: url, jwks_uri: `${url}/keys` }));
      else if (req.url === '/keys') res.end(JSON.stringify({ keys: [jwk] }));
      else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      resolve();
    });
  });
  return {
    get url() {
      return url;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    jwt(claims, opts = {}) {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: opts.kid ?? 'test-key' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signature = sign('sha256', Buffer.from(`${header}.${payload}`), opts.key ?? privateKey).toString('base64url');
      return `${header}.${payload}.${signature}`;
    },
  };
}

test('an OIDC token is accepted only when its signature, audience and expiry all hold', async (t) => {
  const issuer = await startIssuer();
  t.after(() => issuer.close());
  const config: OidcConfig = { issuer: issuer.url, audience: 'agentry', clientId: 'agentry-ui' };
  const verifier = new OidcVerifier();
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: issuer.url, aud: 'agentry', sub: 'user@example.test', exp: now + 600 };

  assert.equal(await verifier.verify(issuer.jwt(good), config), 'user@example.test');
  // An audience list is as valid as a single one
  assert.equal(await verifier.verify(issuer.jwt({ ...good, aud: ['other', 'agentry'] }), config), 'user@example.test');

  await assert.rejects(verifier.verify(issuer.jwt({ ...good, aud: 'another-app' }), config), /another audience/);
  await assert.rejects(verifier.verify(issuer.jwt({ ...good, exp: now - 3600 }), config), /expired/);
  await assert.rejects(verifier.verify(issuer.jwt({ ...good, exp: undefined }), config), /no expiry/);
  await assert.rejects(verifier.verify(issuer.jwt({ ...good, iss: 'https://evil.test' }), config), /issued by someone else/);
  await assert.rejects(verifier.verify(issuer.jwt({ ...good, sub: undefined }), config), /no subject/);
  await assert.rejects(verifier.verify('not.a.jwt', config), /not readable|unsupported/);
  await assert.rejects(verifier.verify('nope', config), /not a signed JWT/);

  // Signed with a key the issuer does not publish
  const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(verifier.verify(issuer.jwt(good, { key: stranger.privateKey }), config), /signature does not match/);
  // `none` is not an algorithm anyone accepts
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(good)).toString('base64url')}.`;
  await assert.rejects(verifier.verify(unsigned, config), /not a signed JWT|unsupported algorithm/);
});

test('the issuer is asked for its keys once, not on every request', async (t) => {
  const issuer = await startIssuer();
  t.after(() => issuer.close());
  let calls = 0;
  const counting = new OidcVerifier(async (url, init) => {
    calls++;
    return fetch(url, init);
  });
  const config: OidcConfig = { issuer: issuer.url, audience: 'agentry', clientId: '' };
  const token = issuer.jwt({ iss: issuer.url, aud: 'agentry', sub: 'someone', exp: Math.floor(Date.now() / 1000) + 600 });
  await counting.verify(token, config);
  const first = calls;
  await counting.verify(token, config);
  assert.equal(calls, first, 'the key set is cached');
});

test('an OIDC store answers with the subject of the token', async (t) => {
  const issuer = await startIssuer();
  t.after(() => issuer.close());
  const store = new AuthStore(tempConfig(), {});
  await store.update({ oidc: { issuer: issuer.url, audience: 'agentry', clientId: '' }, mode: 'oidc' });
  const token = issuer.jwt({ iss: issuer.url, aud: 'agentry', sub: 'alice', exp: Math.floor(Date.now() / 1000) + 600 });
  assert.equal(await store.actorFor(token), 'alice');
  assert.equal(await store.actorFor('rubbish'), null);
  await assert.rejects(store.update({ oidc: { issuer: 'not a url', audience: 'a', clientId: '' } }), /absolute URL/);
});

// ---------- the audit log ----------

test('mutating requests are rows, newest first, filterable and never carrying a body', () => {
  const config = tempConfig();
  const db = new Db(config);
  for (let i = 0; i < 5; i++) {
    db.appendAudit({ at: `2026-09-20T10:0${String(i)}:00.000Z`, actor: 'token:abcd', method: 'POST', path: `/api/chats/${String(i)}/stop`, status: 200, summary: 'Stop a chat' });
  }
  db.appendAudit({ at: '2026-09-20T11:00:00.000Z', actor: 'local', method: 'DELETE', path: '/api/projects/x', status: 200, summary: 'Forget a project' });

  const page = db.auditPage({ limit: 2 });
  assert.equal(page.total, 6);
  assert.equal(page.from, 0);
  assert.equal(page.entries.length, 2);
  assert.equal(page.entries[0]?.path, '/api/projects/x');
  assert.equal(page.entries[0]?.actor, 'local');

  const next = db.auditPage({ limit: 2, from: 2 });
  assert.equal(next.from, 2);
  assert.equal(next.entries[0]?.path, '/api/chats/3/stop');

  const filtered = db.auditPage({ path: '/api/chats' });
  assert.equal(filtered.total, 5);
  assert.ok(filtered.entries.every((entry) => entry.path.startsWith('/api/chats')));
  // The shape is the contract: no body, no query string
  assert.deepEqual(Object.keys(filtered.entries[0] ?? {}).sort(), ['actor', 'at', 'id', 'method', 'path', 'status', 'summary']);

  db.close();
  const reopened = new Db(config);
  assert.equal(reopened.auditPage().total, 6);
  assert.equal(reopened.pruneAudit(2), 4);
  assert.equal(reopened.auditPage().total, 2);
  reopened.close();
});
