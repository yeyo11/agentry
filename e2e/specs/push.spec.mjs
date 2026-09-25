// Web Push end to end, as far as a harness can follow it: the key a browser subscribes with, the
// subscription round-trip behind the Settings list, and what that list then shows.
//
// The delivery itself is not reachable from here — it would mean posting to a real push service and
// receiving it in this browser — so this spec never lets a send happen: the endpoint it
// registers is on the reserved `.invalid` domain, it asks only for a kind the sandbox never emits,
// and it unregisters before it ends. What the sender does with an event is covered as a unit in
// packages/core/test/push.test.ts.

const ENDPOINT = 'https://push.invalid/e2e/subscription-one';
const KEYS = { p256dh: 'BE2ePushEndpointPublicKeyForTheSuite', auth: 'e2ePushAuthSecret' };

export default async ({ api, page, check }) => {
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
  check(mine.level === 'important', `an install that names no level gets the default one: ${mine.level}`);

  // The same endpoint is one install however often the browser re-subscribes
  const again = await api.post('/push/subscriptions', { endpoint: ENDPOINT, keys: KEYS, kinds: ['conflict', 'limit'], level: 'urgent', label: 'e2e device' });
  check(again.status === 201 && again.body.id === created.body.id, 're-subscribing refreshes the same row');
  const afterRefresh = (await api.get('/push/subscriptions')).body.filter((s) => s.id === created.body.id);
  check(afterRefresh.length === 1, `one row per endpoint, got ${afterRefresh.length}`);
  check(afterRefresh[0]?.level === 'urgent', `re-subscribing updates the level: ${afterRefresh[0]?.level}`);
  const badLevel = await api.post('/push/subscriptions', { endpoint: ENDPOINT, keys: KEYS, level: 'loud' });
  check(badLevel.status === 400, `an unknown level is refused (${badLevel.status})`);

  const bad = await api.post('/push/subscriptions', { endpoint: 'http://push.invalid/plain', keys: KEYS });
  check(bad.status === 400, `a subscription that could never be delivered to is refused (${bad.status})`);

  // ---- What Settings shows about all this ----
  //
  // The delivery path itself stops here: it would take a real push service, a real endpoint and a
  // browser with a real subscription. What the page does with a delivered push — show it, or stay
  // quiet because a window is visible, and where a tap goes — is driven event by event as a unit in
  // apps/web/test/pwa.test.ts, against the very file that ships.
  await page.goto('/settings?tab=notifications', 1500);
  await page.waitFor(`return !!document.querySelector('[data-testid=push-devices]')`, { label: 'the list of registered devices' });
  const list = await page.text('[data-testid=push-devices]');
  check(list.includes('e2e device'), `the registered install is in the list: "${list}"`);
  check(!list.includes('subscription-one'), 'and its endpoint is truncated there: the whole of it is a capability to notify that install');
  check(list.includes('push.invalid'), `which push service it is still shows: "${list}"`);

  // The accessible name of each action names the device it acts on, and begins with what the button
  // says, which is what WCAG 2.5.3 asks of a label that is longer than its own text
  const labels = await page.eval(
    `return [...document.querySelectorAll('[data-testid=push-devices] button')].map((button) => [button.innerText.trim(), button.getAttribute('aria-label')]);`,
  );
  check(
    labels.every(([text, label]) => label?.includes('e2e device') && label.startsWith(text)),
    `every action names the device it acts on: ${JSON.stringify(labels)}`,
  );

  // 127.0.0.1 is a secure origin, so this browser is offered the switch rather than the sentence
  // that replaces it — the sentence is what an insecure origin or an iOS tab gets, and those two
  // decisions are pure functions covered in apps/web/test/push.test.ts.
  const preference = await page.eval(`return document.querySelector('[data-testid=push-switch]')?.innerText ?? null`);
  check(preference !== null, 'the push preference is on the page');
  check(
    await page.eval(`return !!document.querySelector('[data-testid=push-switch] [role=switch]')`),
    `a secure origin gets a switch and not an explanation: "${preference}"`,
  );
  const switches = await page.eval(`return document.querySelectorAll('[role=switch]').length`);
  check(switches >= 9, `the seven kinds, the browser notifications and push are all switches: ${switches}`);
  check(
    await page.eval(`return !!document.querySelector('.select-trigger[aria-label=Interruptions]')`),
    'how much notifications may interrupt is chosen with the themed select',
  );

  const removed = await api.request('DELETE', '/push/subscriptions', { endpoint: ENDPOINT });
  check(removed.status === 200 && removed.body?.removed === true, `the subscription is unregistered (${removed.status})`);
  const gone = await api.request('DELETE', '/push/subscriptions', { endpoint: ENDPOINT });
  check(gone.status === 200 && gone.body?.removed === false, 'a second unsubscribe is not an error');
  check(!(await api.get('/push/subscriptions')).body.some((s) => s.id === created.body.id), 'nothing of this spec is left registered');
};
