// Web Push as the server serves it: the key a browser subscribes with, and the subscription
// round-trip behind the Settings list. The delivery itself is not reachable from here — it would
// mean posting to a real push service — so this spec never lets a send happen: the endpoint it
// registers is on the reserved `.invalid` domain, it asks only for a kind the sandbox never emits,
// and it unregisters before it ends. What the sender does with an event is covered as a unit in
// packages/core/test/push.test.ts.

const ENDPOINT = 'https://push.invalid/e2e/subscription-one';
const KEYS = { p256dh: 'BE2ePushEndpointPublicKeyForTheSuite', auth: 'e2ePushAuthSecret' };

export default async ({ api, check }) => {
  // Nothing to send to yet: the route says so rather than reporting a silent success
  const empty = await api.post('/push/test', {});
  check(empty.status === 400 && /no push subscription/i.test(empty.body?.error ?? ''), `a test push with nothing registered explains itself (${empty.status})`);

  const key = await api.get('/push/key');
  check(key.status === 200, `GET /api/push/key answers (${key.status})`);
  check(key.body?.configured === true, 'the server made itself a VAPID keypair on first use');
  check(typeof key.body?.publicKey === 'string' && key.body.publicKey.length > 20, 'the public key is there to subscribe with');
  check(!JSON.stringify(key.body).includes('privateKey'), 'the private key never leaves the server');

  const created = await api.post('/push/subscriptions', { endpoint: ENDPOINT, keys: KEYS, kinds: ['conflict'], label: 'e2e device' });
  check(created.status === 201, `a subscription is registered (${created.status})`);
  check(typeof created.body?.id === 'string' && created.body.id.length > 0, 'the registration returns the id the browser knows itself by');
  check(!created.body.endpoint.includes('subscription-one'), 'the endpoint comes back truncated: the whole of it is a capability');

  const listed = await api.get('/push/subscriptions');
  check(listed.status === 200 && Array.isArray(listed.body), `GET /api/push/subscriptions is a list (${listed.status})`);
  const mine = listed.body.find((s) => s.id === created.body.id);
  check(!!mine, 'the registered install is in the list');
  check(mine.label === 'e2e device' && mine.kinds.join() === 'conflict', `the list carries the label and the kinds: ${JSON.stringify(mine)}`);

  // The same endpoint is one install however often the browser re-subscribes
  const again = await api.post('/push/subscriptions', { endpoint: ENDPOINT, keys: KEYS, kinds: ['conflict', 'limit'], label: 'e2e device' });
  check(again.status === 201 && again.body.id === created.body.id, 're-subscribing refreshes the same row');
  const afterRefresh = (await api.get('/push/subscriptions')).body.filter((s) => s.id === created.body.id);
  check(afterRefresh.length === 1, `one row per endpoint, got ${afterRefresh.length}`);

  const bad = await api.post('/push/subscriptions', { endpoint: 'http://push.invalid/plain', keys: KEYS });
  check(bad.status === 400, `a subscription that could never be delivered to is refused (${bad.status})`);

  const removed = await api.request('DELETE', '/push/subscriptions', { endpoint: ENDPOINT });
  check(removed.status === 200 && removed.body?.removed === true, `the subscription is unregistered (${removed.status})`);
  const gone = await api.request('DELETE', '/push/subscriptions', { endpoint: ENDPOINT });
  check(gone.status === 200 && gone.body?.removed === false, 'a second unsubscribe is not an error');
  check(!(await api.get('/push/subscriptions')).body.some((s) => s.id === created.body.id), 'nothing of this spec is left registered');
};
