import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

// What goes over the wire besides the JSON itself: compression for whoever asks for it, a tag so an
// unchanged answer comes back empty, and event streams left alone so each event arrives as written.

let app: FastifyInstance;

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-wire-'));
  const core = new Core(
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

after(() => app.close());

test('an answer is compressed for a client that accepts it, and plain for one that does not', async () => {
  const plain = await app.inject('/openapi.json');
  assert.equal(plain.headers['content-encoding'], undefined);
  const gzipped = await app.inject({ url: '/openapi.json', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gzipped.headers['content-encoding'], 'gzip');
  assert.ok(gzipped.rawPayload.length < plain.rawPayload.length / 4, 'JSON shrinks to a fraction');
  assert.deepEqual(JSON.parse(gunzipSync(gzipped.rawPayload).toString('utf8')), plain.json());
});

test('an unchanged answer comes back empty when the client sends its tag, and is never kept as fresh', async () => {
  const first = await app.inject('/api/orchestrations');
  const tag = first.headers.etag;
  assert.equal(typeof tag, 'string');
  assert.match(String(tag), /^W\//, 'weak: the bytes sent depend on the encoding');
  assert.equal(first.headers['cache-control'], 'private, no-cache');

  const again = await app.inject({ url: '/api/orchestrations', headers: { 'if-none-match': String(tag) } });
  assert.equal(again.statusCode, 304);
  assert.equal(again.payload, '');

  const compressed = await app.inject({ url: '/api/orchestrations', headers: { 'if-none-match': String(tag), 'accept-encoding': 'br, gzip' } });
  assert.equal(compressed.statusCode, 304, 'the tag names the answer, not how it travelled');
});

test('the event stream is neither compressed nor tagged, so each event is flushed as it is written', async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const headers = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path: '/api/events', headers: { 'accept-encoding': 'gzip, br' } }, (res) => {
      resolve(res.headers);
      res.destroy();
    });
    req.on('error', reject);
  });
  assert.match(String(headers['content-type']), /text\/event-stream/);
  assert.equal(headers['content-encoding'], undefined);
  assert.equal(headers.etag, undefined);
});
