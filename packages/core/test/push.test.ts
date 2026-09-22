import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import webpush from 'web-push';
import type { AgentryEvent, PushPayload } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { EventBus, type AgentryEventInput } from '../src/events.ts';
import { PushService, idOfEndpoint, truncateEndpoint, type PushTransport } from '../src/push.ts';
import { tempConfig } from './helpers.ts';

const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABsubscription-one';
const OTHER = 'https://fcm.googleapis.com/fcm/send/cDEFghijkl:APA91bHsubscription-two';

const keys = { p256dh: 'BExampleP256dhKeyForTests', auth: 'exampleAuthSecret' };

interface Sent {
  endpoint: string;
  payload: PushPayload;
}

/** A push service that records what it was handed, and fails the endpoints the test names. */
function fakeTransport(fail: Map<string, Error> = new Map()): { transport: PushTransport; sent: Sent[] } {
  const sent: Sent[] = [];
  const transport: PushTransport = async (subscription, payload) => {
    const error = fail.get(subscription.endpoint);
    if (error) throw error;
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as PushPayload });
    return undefined;
  };
  return { transport, sent };
}

function harness(transport?: PushTransport) {
  const config = tempConfig();
  const db = new Db(config);
  const events = new EventBus();
  const push = new PushService({ config, db, events, ...(transport ? { transport } : {}) });
  const logged: string[] = [];
  push.log = (line) => logged.push(line);
  return { config, db, events, push, logged };
}

const waitingEvent: AgentryEventInput = {
  type: 'run.waiting',
  title: 'chat-1 needs your approval to use Bash',
  runId: 'chat-1',
  runName: 'chat-1',
  sessionId: 'chat-1',
  orchestrationId: null,
  internal: false,
  reason: 'permission',
  permissionId: 'req-1',
  toolName: 'Bash',
};

const endedEvent: AgentryEventInput = {
  type: 'run.ended',
  title: 'chat-2 finished',
  runId: 'chat-2',
  runName: 'chat-2',
  sessionId: 'chat-2',
  orchestrationId: null,
  internal: false,
  status: 'completed',
  error: null,
  turns: 3,
  costUsd: 0.1,
};

/** The sender is deliberately not awaited by the bus, so a test has to let its microtasks run. */
const settle = () => delay(50);

test('the VAPID keypair is made on first use and only its public half is ever handed out', async () => {
  const { config, push } = harness();
  const first = await push.keyInfo();
  assert.equal(first.configured, true);
  assert.equal(typeof first.publicKey, 'string');
  assert.ok(first.publicKey && first.publicKey.length > 20);
  assert.deepEqual(Object.keys(first).sort(), ['configured', 'publicKey']);

  const file = join(config.dataDir, 'push.json');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the private key is a secret in a shared data dir');
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { publicKey: string; privateKey: string; subject: string };
  assert.equal(doc.publicKey, first.publicKey);
  assert.ok(doc.privateKey);
  assert.equal(doc.subject, 'mailto:agentry@localhost');

  // Every subscription is taken out against one public key: a second call must not replace it
  assert.deepEqual(await push.keyInfo(), first);
  const reopened = harness();
  assert.equal((await reopened.push.keyInfo()).publicKey !== first.publicKey, true, 'a different data dir gets its own keypair');
});

test('an endpoint is registered once, and the list never hands the whole of it back', () => {
  const { push } = harness();
  const registered = push.register({ endpoint: ENDPOINT, keys, label: 'Pixel 8 · Chrome' });
  assert.equal(registered.id, idOfEndpoint(ENDPOINT));
  assert.equal(registered.label, 'Pixel 8 · Chrome');
  assert.deepEqual(registered.kinds, ['waiting', 'run', 'orchestration', 'conflict', 'limit', 'activity', 'health']);
  assert.equal(registered.endpoint.includes('gAAAAAB'), false, 'a full endpoint is a capability to notify that install');
  assert.equal(registered.endpoint, truncateEndpoint(ENDPOINT));

  const again = push.register({ endpoint: ENDPOINT, keys, kinds: ['waiting'], label: 'Pixel 8 · Chrome' });
  assert.deepEqual(push.list().length, 1, 'the same endpoint is one install, however often it re-subscribes');
  assert.equal(again.createdAt, registered.createdAt, 'a browser rotating its keys is the same device');
  assert.deepEqual(again.kinds, ['waiting']);
});

test('a registration that could never deliver is refused instead of stored', () => {
  const { push } = harness();
  assert.throws(() => push.register(null), /JSON object/);
  assert.throws(() => push.register({ keys }), /endpoint is required/);
  assert.throws(() => push.register({ endpoint: 'not a url', keys }), /absolute URL/);
  assert.throws(() => push.register({ endpoint: 'http://push.example/x', keys }), /https/);
  assert.throws(() => push.register({ endpoint: ENDPOINT }), /p256dh and auth/);
  assert.throws(() => push.register({ endpoint: ENDPOINT, keys: { p256dh: 'k' } }), /keys.auth is required/);
  assert.throws(() => push.register({ endpoint: ENDPOINT, keys, kinds: 'waiting' }), /kinds must be an array/);
  assert.throws(() => push.register({ endpoint: ENDPOINT, keys, kinds: ['nope'] }), /unknown notification kind/);
  assert.deepEqual(push.list(), []);
});

test('an event reaches only the installs that asked for its kind, with the key it is collapsed by', async () => {
  const { transport, sent } = fakeTransport();
  const { push, events } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, kinds: ['waiting'], label: 'phone' });
  push.register({ endpoint: OTHER, keys, kinds: ['run'], label: 'laptop' });

  events.emit(waitingEvent);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.endpoint, ENDPOINT, 'only the install that asked for `waiting`');
  const payload = sent[0]?.payload;
  assert.equal(payload?.kind, 'waiting');
  assert.equal(payload?.key, 'wait:chat-1:req-1', 'the dedupe key the browser already uses, so a chat replaces its own notification');
  assert.equal(payload?.href, '/chats/chat-1?prompt=req-1');
  assert.equal(payload?.priority, 'high');
  assert.equal('permissionId' in (payload ?? {}), false, 'a payload travels through a relay: only what a lock screen shows');

  events.emit(endedEvent);
  await settle();
  assert.deepEqual(
    sent.map((s) => s.endpoint),
    [ENDPOINT, OTHER],
  );
});

test('the same news inside its dedupe window is pushed once', async () => {
  const { transport, sent } = fakeTransport();
  const { push, events } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, label: 'phone' });

  // `run.waiting` keys on the permission id and never repeats; `run.ended` keys on the turn count
  events.emit(waitingEvent);
  events.emit(waitingEvent);
  events.emit(endedEvent);
  events.emit(endedEvent);
  await settle();
  assert.deepEqual(
    sent.map((s) => s.payload.key),
    ['wait:chat-1:req-1', 'run-done:chat-2:3'],
  );
});

test('nothing is sent, and no key is spent, while no install is registered', async () => {
  const { transport, sent } = fakeTransport();
  const { push, events } = harness(transport);
  events.emit(waitingEvent);
  await settle();
  assert.deepEqual(sent, []);

  push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  events.emit(waitingEvent);
  await settle();
  assert.equal(sent.length, 1, 'the first event a subscriber could have heard is still news');
});

test('an endpoint the push service says is gone is deleted on the spot', async () => {
  const gone = new Map([[OTHER, new webpush.WebPushError('gone', 410, {}, '', OTHER)]]);
  const { transport, sent } = fakeTransport(gone);
  const { push, events, logged } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  push.register({ endpoint: OTHER, keys, label: 'old phone' });

  events.emit(waitingEvent);
  await settle();
  assert.deepEqual(
    push.list().map((s) => s.label),
    ['phone'],
    'anything else and the sender slowly becomes a pile of dead endpoints',
  );
  assert.equal(sent.length, 1);
  assert.match(logged.join('\n'), /is gone \(410\); removed/);
});

test('a failing endpoint is a log line, never an exception in the event path', async () => {
  const failing = new Map([[OTHER, new Error('socket hang up')]]);
  const { transport, sent } = fakeTransport(failing);
  const { push, events, logged } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  push.register({ endpoint: OTHER, keys, label: 'flaky' });

  const heard: AgentryEvent[] = [];
  events.subscribe((event) => heard.push(event));
  assert.doesNotThrow(() => events.emit(waitingEvent));
  await settle();

  assert.equal(heard.length, 1, 'the feed carried on');
  assert.equal(sent.length, 1, 'the other install was still notified');
  assert.equal(push.list().length, 2, 'a transport failure is not proof the endpoint is gone');
  assert.match(logged.join('\n'), /failed: socket hang up/);
});

test('the test notification names its target, counts what happened and prunes what is gone', async () => {
  const gone = new Map([[OTHER, new webpush.WebPushError('gone', 404, {}, '', OTHER)]]);
  const { transport, sent } = fakeTransport(gone);
  const { push } = harness(transport);
  await assert.rejects(push.test({}), /no push subscription is registered/);

  push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  push.register({ endpoint: OTHER, keys, label: 'old phone' });

  assert.deepEqual(await push.test({ endpoint: ENDPOINT }), { sent: 1, removed: 0, failed: 0 });
  assert.equal(sent.at(-1)?.payload.title, 'Agentry push works');

  assert.deepEqual(await push.test(undefined), { sent: 1, removed: 1, failed: 0 });
  assert.deepEqual(
    push.list().map((s) => s.label),
    ['phone'],
  );
});

test('unsubscribing by endpoint or by id removes the row, and says so only when there was one', () => {
  const { push } = harness();
  const registered = push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  push.register({ endpoint: OTHER, keys, label: 'laptop' });

  assert.deepEqual(push.remove({ endpoint: ENDPOINT }), { removed: true });
  assert.deepEqual(push.remove({ endpoint: ENDPOINT }), { removed: false }, 'a second unsubscribe is not an error');
  assert.deepEqual(push.remove({ id: idOfEndpoint(OTHER) }), { removed: true });
  assert.equal(registered.id, idOfEndpoint(ENDPOINT));
  assert.deepEqual(push.list(), []);
  assert.throws(() => push.remove({}), /endpoint or the id/);
});

test('a closed service stops hearing the bus', async () => {
  const { transport, sent } = fakeTransport();
  const { push, events } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  push.close();
  events.emit(waitingEvent);
  await settle();
  assert.deepEqual(sent, []);
});
