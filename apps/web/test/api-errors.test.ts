import assert from 'node:assert/strict';
import test from 'node:test';
import { api, ApiRequestError } from '../src/api';
import { errorMessage } from '../src/lib/format';
import i18n from '../src/i18n';

// An answer Agentry did not write — a dropped connection, a proxy's or a tunnel's own page — used to
// reach the screen as the browser's "Failed to fetch" or a bare "HTTP 503", in English and with
// nothing to act on. It is said in the reader's language, and the technical line stays as detail.

const realFetch = globalThis.fetch;

async function failure(stub: typeof fetch): Promise<ApiRequestError> {
  globalThis.fetch = stub;
  try {
    await api.stopTunnel();
  } catch (err) {
    assert.ok(err instanceof ApiRequestError);
    return err;
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.fail('the request did not fail');
}

test.before(async () => {
  await i18n.changeLanguage('es');
});
test.after(async () => {
  await i18n.changeLanguage('en');
});

test('a connection that drops is said in the reader language, keeping the browser wording as detail', async () => {
  const err = await failure(async () => {
    throw new TypeError('Failed to fetch');
  });
  assert.equal(err.status, 0);
  assert.equal(err.message, i18n.t('common:networkError'));
  assert.match(err.message, /No se ha podido conectar con Agentry/);
  assert.equal(err.detail, 'Failed to fetch');
});

test("a page from a tunnel or a proxy names who answered, with Agentry's own errors left as they are", async () => {
  const tunnel = await failure(async () => new Response('<h1>no tunnel here :(</h1>', { status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'text/html' } }));
  assert.equal(tunnel.status, 503);
  assert.match(tunnel.message, /\(error 503\)/);
  assert.match(errorMessage(tunnel), /— HTTP 503 Service Unavailable$/);

  const own = await failure(async () => new Response(JSON.stringify({ error: 'the tunnel needs authentication' }), { status: 409 }));
  assert.equal(own.message, 'the tunnel needs authentication');
});
