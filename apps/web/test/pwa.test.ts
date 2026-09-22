// The installable app: the manifest a phone reads, and the service worker that sits between the
// page and the network. The worker is a plain file rather than a module, so it is loaded into a
// sandbox with the handful of globals a worker has and then driven event by event — which is the
// only way to prove the thing that matters most: that it never answers a request to /api, where
// the event streams live.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { buildServiceWorker, shellId } from '../scripts/sw-shell.ts';
import { PUSH_STATE_CACHE, PUSH_STATE_KEY } from '../src/lib/push-model.ts';

const WEB = path.join(import.meta.dirname, '..');
const ORIGIN = 'https://agentry.test';
const SOURCE = readFileSync(path.join(WEB, 'public', 'sw.js'), 'utf8');

const SHELL = [
  '/index.html',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/assets/index-Aa11Bb22.js',
  '/assets/index-Cc33Dd44.css',
  '/assets/inter-latin-wght-normal-Ee55Ff66.woff2',
];

interface SwRequest {
  method: string;
  url: string;
  mode: string;
  headers: { has(name: string): boolean };
}

const request = (url: string, { method = 'GET', mode = 'no-cors', range = false } = {}): SwRequest => ({
  method,
  url: url.startsWith('http') ? url : `${ORIGIN}${url}`,
  mode,
  headers: { has: (name) => name === 'range' && range },
});

const navigation = (url: string): SwRequest => request(url, { mode: 'navigate' });

/** What the page leaves in a cache for the worker: a body it reads back as JSON. */
interface StoredJson {
  json(): Promise<unknown>;
}

class FakeCache {
  readonly entries = new Map<string, string | StoredJson>();
  constructor(private readonly broken: boolean) {}
  addAll(urls: readonly string[]): Promise<void> {
    if (this.broken) return Promise.reject(new Error('404 while precaching'));
    for (const url of urls) this.entries.set(url, `cached ${url}`);
    return Promise.resolve();
  }
  match(key: string): Promise<string | StoredJson | undefined> {
    return Promise.resolve(this.entries.get(key));
  }
}

class FakeCaches {
  readonly stores = new Map<string, FakeCache>();
  constructor(private readonly broken = false) {}
  open(name: string): Promise<FakeCache> {
    const cache = this.stores.get(name) ?? new FakeCache(this.broken);
    this.stores.set(name, cache);
    return Promise.resolve(cache);
  }
  keys(): Promise<string[]> {
    return Promise.resolve([...this.stores.keys()]);
  }
  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.delete(name));
  }
  match(key: string, options: { cacheName: string }): Promise<string | undefined> {
    return Promise.resolve(this.stores.get(options.cacheName)?.entries.get(key) as string | undefined);
  }
}

/** A window of this origin, as `clients.matchAll` hands one to a worker. */
interface ClientSpec {
  url: string;
  /** The page a person is looking at right now: the one that shows the toast itself */
  visible?: boolean;
  /** The page answers the worker's hand-off message, i.e. it routed the path itself */
  acks?: boolean;
  /** `navigate()` is refused for a window this worker does not control */
  navigable?: boolean;
}

class FakeClient {
  readonly url: string;
  readonly visibilityState: string;
  focused = false;
  navigated: string | null = null;
  readonly messages: unknown[] = [];
  constructor(private readonly spec: ClientSpec) {
    this.url = spec.url;
    this.visibilityState = spec.visible ? 'visible' : 'hidden';
  }
  focus(): Promise<FakeClient> {
    this.focused = true;
    return Promise.resolve(this);
  }
  navigate(url: string): Promise<FakeClient> {
    if (this.spec.navigable === false) return Promise.reject(new Error('not a client this worker may navigate'));
    this.navigated = url;
    return Promise.resolve(this);
  }
  postMessage(message: unknown, transfer: ReadonlyArray<{ postMessage(data: unknown): void }>): void {
    this.messages.push(message);
    if (this.spec.acks) transfer[0]?.postMessage('opened');
  }
}

interface FakeSubscription {
  endpoint: string;
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
}

const subscription = (endpoint: string, keys: Record<string, string> | null = { p256dh: 'p256', auth: 'auth' }): FakeSubscription => ({
  endpoint,
  toJSON: () => (keys ? { endpoint, keys } : { endpoint }),
});

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

interface Shown {
  title: string;
  options: Record<string, unknown>;
}

interface WorkerOptions {
  broken?: boolean;
  seeded?: string[];
  clients?: ClientSpec[];
  /** What the page left in the push-state cache, or nothing at all */
  pushState?: Record<string, unknown> | null;
  /** The subscription `pushManager.getSubscription()` finds */
  held?: FakeSubscription | null;
  /** What `pushManager.subscribe()` returns; null makes it refuse, as a revoked permission does */
  renewed?: FakeSubscription | null;
  /** How the server answers the worker's re-registration */
  postOk?: boolean;
  /** Let the hand-off timer fire at once instead of never: the page that does not answer */
  fireTimers?: boolean;
}

interface Worker {
  caches: FakeCaches;
  fetched: string[];
  sent: Sent[];
  shown: Shown[];
  clients: FakeClient[];
  opened: string[];
  subscribeCalls: Array<Record<string, unknown>>;
  claimed: () => boolean;
  install(): Promise<void>;
  activate(): Promise<void>;
  /** What the worker answered with, or `null` when it left the request to the browser */
  fetch(req: SwRequest): Promise<string | null>;
  /** A push as it arrives: a payload, an unreadable body, or nothing at all */
  push(payload: unknown): Promise<void>;
  click(data: unknown): Promise<void>;
  rotate(event: { oldSubscription?: FakeSubscription | null; newSubscription?: FakeSubscription | null }): Promise<void>;
}

/** Runs sw.js in a sandbox with the globals a service worker actually has. */
function load(shell: readonly string[] = SHELL, options: WorkerOptions = {}): Worker {
  const { broken = false, seeded = [], clients: specs = [], pushState = null, held = null, renewed = null, postOk = true, fireTimers = false } = options;
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const fakeCaches = new FakeCaches(broken);
  for (const name of seeded) void fakeCaches.open(name);
  if (pushState) {
    void fakeCaches.open('agentry-push').then((cache) => cache.entries.set('/__agentry-push-state', { json: () => Promise.resolve(pushState) }));
  }
  const fetched: string[] = [];
  const sent: Sent[] = [];
  const shown: Shown[] = [];
  const opened: string[] = [];
  const subscribeCalls: Array<Record<string, unknown>> = [];
  const clients = specs.map((spec) => new FakeClient(spec));
  let claimed = false;

  const registration = {
    showNotification: (title: string, notificationOptions: Record<string, unknown>) => {
      shown.push({ title, options: notificationOptions });
      return Promise.resolve();
    },
    pushManager: {
      getSubscription: () => Promise.resolve(held),
      subscribe: (subscribeOptions: Record<string, unknown>) => {
        subscribeCalls.push(subscribeOptions);
        return renewed ? Promise.resolve(renewed) : Promise.reject(new Error('the browser refused to subscribe'));
      },
    },
  };

  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => handlers.set(type, handler),
      skipWaiting: () => Promise.resolve(),
      registration,
      clients: {
        claim: () => {
          claimed = true;
          return Promise.resolve();
        },
        matchAll: () => Promise.resolve(clients),
        openWindow: (url: string) => {
          opened.push(url);
          return Promise.resolve(null);
        },
      },
    },
    caches: fakeCaches,
    fetch: (req: SwRequest | string, init?: { method?: string; body?: string }) => {
      if (typeof req === 'string') {
        sent.push({ url: req, method: init?.method ?? 'GET', body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
        return Promise.resolve({ ok: postOk });
      }
      fetched.push(req.url);
      return Promise.resolve(`network ${req.url}`);
    },
    // A hand-off either answers at once or never: the worker's own timer decides the rest, and a
    // real 600 ms wait would only make this file slow.
    setTimeout: (fn: () => void) => {
      if (fireTimers) queueMicrotask(fn);
      return 1;
    },
    clearTimeout: () => undefined,
    // Two ports, wired to each other and to nothing else; Node's own would hold the event loop open
    MessageChannel: class {
      readonly port1: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(data: unknown): void };
      readonly port2: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(data: unknown): void };
      constructor() {
        this.port1 = { onmessage: null, postMessage: (data: unknown) => this.port2.onmessage?.({ data }) };
        this.port2 = { onmessage: null, postMessage: (data: unknown) => this.port1.onmessage?.({ data }) };
      }
    },
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    console: { warn: () => {} },
    URL,
  };
  runInContext(buildServiceWorker(SOURCE, shell, 'test'), createContext(sandbox));

  const drive = async (type: string, event: Record<string, unknown>): Promise<void> => {
    const waiting: Array<Promise<unknown>> = [];
    handlers.get(type)?.({ ...event, waitUntil: (promise: Promise<unknown>) => void waiting.push(promise) });
    await Promise.all(waiting);
  };

  return {
    caches: fakeCaches,
    fetched,
    sent,
    shown,
    clients,
    opened,
    subscribeCalls,
    claimed: () => claimed,
    install: () => drive('install', {}),
    activate: () => drive('activate', {}),
    async fetch(req) {
      let answer: Promise<string> | null = null;
      handlers.get('fetch')?.({ request: req, respondWith: (promise: Promise<string>) => void (answer = promise) });
      return answer === null ? null : await (answer as Promise<string>);
    },
    push: (payload) =>
      drive('push', {
        data:
          payload === undefined
            ? null
            : {
                json: () => {
                  if (payload === 'broken') throw new SyntaxError('not JSON');
                  return payload;
                },
              },
      }),
    click: (data) => drive('notificationclick', { notification: { close: () => undefined, data } }),
    rotate: (event) => drive('pushsubscriptionchange', event as Record<string, unknown>),
  };
}

async function ready(shell?: readonly string[], options: WorkerOptions = {}): Promise<Worker> {
  const worker = load(shell, options);
  await worker.install();
  await worker.activate();
  return worker;
}

test('the worker leaves the API, the docs and every other origin entirely alone', async () => {
  const worker = await ready();
  const untouched = [
    request('/api/events'),
    navigation('/api/events'),
    request('/api/chats/abc/stream'),
    request('/api/overview'),
    request('/api/chats', { method: 'POST' }),
    navigation('/docs'),
    request('/docs/'),
    request('/openapi.json'),
    request('https://fcm.googleapis.com/fcm/send/abc'),
    request('/index.html', { range: true }),
  ];
  for (const req of untouched) {
    assert.equal(await worker.fetch(req), null, `${req.method} ${req.url} must be left to the browser`);
  }
  assert.deepEqual(worker.fetched, [], 'the worker did not even re-issue them itself');
});

test('a navigation to a route of the app is painted from the cached shell', async () => {
  const worker = await ready();
  for (const route of ['/', '/chats', '/chats/abc-123', '/settings?tab=install', '/orchestration/7']) {
    assert.equal(await worker.fetch(navigation(route)), 'cached /index.html', `${route} is served the app shell`);
  }
});

test('a navigation to a path the app does not route is left to the server, which owns it', async () => {
  const worker = await ready();
  // /docs is the live one; anything the API grows later behaves the same, and the worst a route
  // missing from the worker's list costs is the round trip it would have saved
  assert.equal(await worker.fetch(navigation('/uploads/file.png')), null);
});

test('a hashed asset of the shell is served from the cache, one from another build is not', async () => {
  const worker = await ready();
  assert.equal(await worker.fetch(request('/assets/index-Aa11Bb22.js')), 'cached /assets/index-Aa11Bb22.js');
  assert.equal(await worker.fetch(request('/assets/CodeEditorImpl-Zz99.js')), null, 'a lazy chunk is not the shell');
});

test('a new build takes over: the previous shell cache is dropped and nothing else is', async () => {
  const worker = load(SHELL, { seeded: ['agentry-shell-oldbuild', 'some-other-cache'] });
  await worker.install();
  await worker.activate();
  assert.deepEqual([...worker.caches.stores.keys()].sort(), [`agentry-shell-${shellId([...SHELL].sort().concat('test'))}`, 'some-other-cache']);
  assert.ok(worker.claimed(), 'and it claims the pages already open');
});

test('a shell asset that cannot be cached leaves the worker installed and passing through', async () => {
  const worker = load(SHELL, { broken: true });
  await worker.install();
  await worker.activate();
  // Push is delivered to the worker and to nothing else: an uninstallable worker would cost more
  // than a cold start does, so a failed precache degrades to no cache at all.
  assert.equal(await worker.fetch(navigation('/chats')), `network ${ORIGIN}/chats`);
});

test('a worker with no shell — what `pnpm dev` would get — intercepts nothing', async () => {
  const worker = await ready([]);
  assert.equal(await worker.fetch(navigation('/chats')), null);
  assert.equal(await worker.fetch(request('/index.html')), null);
});

test('the shell list is sorted, deduplicated and stamped into the worker', () => {
  const built = buildServiceWorker(SOURCE, ['/b.js', '/a.js', '/b.js'], '');
  assert.match(built, /const SHELL = \[\n {2}"\/a\.js",\n {2}"\/b\.js",\n\];/);
  assert.doesNotMatch(built, /const SHELL = \[\];/);
});

test('the cache name changes when the assets change, and when only index.html does', () => {
  const base = shellId(['/assets/a.js', 'html']);
  assert.notEqual(base, shellId(['/assets/b.js', 'html']));
  assert.notEqual(base, shellId(['/assets/a.js', 'other html']), 'a page whose assets are unchanged still ships a new worker');
  assert.equal(base, shellId(['/assets/a.js', 'html']));
});

test('a service worker that lost its generated block fails the build instead of shipping empty', () => {
  assert.throws(() => buildServiceWorker('self.addEventListener("fetch", () => {});', SHELL), /shell:start/);
});

test('the manifest describes an installable, standalone app at the root', () => {
  const manifest: unknown = JSON.parse(readFileSync(path.join(WEB, 'public', 'manifest.webmanifest'), 'utf8'));
  assert.ok(manifest && typeof manifest === 'object');
  const app = manifest as Record<string, unknown>;
  assert.equal(app['start_url'], '/');
  assert.equal(app['scope'], '/');
  assert.equal(app['display'], 'standalone');
  assert.equal(app['orientation'], 'any');
  assert.equal(app['name'], 'Agentry');

  const icons = app['icons'] as Array<Record<string, string>>;
  const sizes = icons.map((icon) => `${icon['sizes']} ${icon['purpose']}`);
  assert.ok(sizes.includes('192x192 any') && sizes.includes('512x512 any'), `192 and 512 are what Android asks for: ${sizes.join(', ')}`);
  assert.ok(sizes.includes('512x512 maskable'), 'a maskable icon, or Android draws the mark inside a white circle');
  for (const icon of icons) assert.ok(existsSync(path.join(WEB, 'public', icon['src'] ?? '')), `${icon['src']} is committed`);
});

test('the page links the manifest and tells iOS what the manifest cannot', () => {
  const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
  // Safari reads none of the manifest: without these it opens a tab with an address bar
  for (const meta of ['apple-mobile-web-app-capable', 'apple-mobile-web-app-status-bar-style', 'apple-mobile-web-app-title']) {
    assert.match(html, new RegExp(`<meta name="${meta}"`), `index.html declares ${meta}`);
  }
  const apple = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html)?.[1];
  assert.ok(apple && existsSync(path.join(WEB, 'public', apple)), `the apple-touch-icon ${apple} is committed`);
});

test('the splash screen is the colour the page paints before React does', () => {
  const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const manifest = JSON.parse(readFileSync(path.join(WEB, 'public', 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>;
  // A manifest holds one colour where the page has two; the dark one is what an unset preference
  // gets, from `color-scheme: dark light` and from the theme module's own default.
  const dark = /<meta name="theme-color" content="([^"]+)" media="\(prefers-color-scheme: dark\)"/.exec(html)?.[1];
  assert.equal(manifest['theme_color'], dark);
  assert.equal(manifest['background_color'], dark);
});

// ---------- Web Push ----------
//
// None of this is reachable from the e2e harness: it would mean a real push service signing a real
// delivery to a browser under test. The worker is the whole of the client side of push, so it is
// driven here event by event instead — a payload in, a notification and a fetch out.

/** What the server sends for a chat that stopped on a permission prompt. */
const WAITING = {
  kind: 'waiting',
  key: 'waiting:run1:p1',
  title: 'fix the build needs your approval to use Bash',
  body: 'Bash',
  href: '/chats/run1?prompt=p1',
  at: '2026-01-01T12:00:00.000Z',
  priority: 'high',
  runId: 'run1',
  orchestrationId: null,
};

const FALLBACK = { title: 'Agentry', body: 'Something is waiting for you.' };
// `QUJD` is `ABC`: enough to prove the key reaches `subscribe` as the bytes it was stored as
const STATE = { applicationServerKey: 'QUJD', kinds: ['waiting', 'limit'], label: 'Android · Chrome · PWA', fallback: FALLBACK };

test('a push arriving while a page of ours is visible shows nothing: that page has the toast', async () => {
  const worker = await ready(SHELL, { clients: [{ url: `${ORIGIN}/chats`, visible: true }, { url: `${ORIGIN}/usage` }] });
  await worker.push(WAITING);
  assert.deepEqual(worker.shown, [], 'the same news as a toast and as a notification is the news twice');
});

test('with no page visible the payload becomes the notification, tagged with its dedupe key', async () => {
  const worker = await ready(SHELL, { clients: [{ url: `${ORIGIN}/chats` }] });
  await worker.push(WAITING);
  assert.equal(worker.shown.length, 1);
  const [shown] = worker.shown;
  assert.equal(shown?.title, WAITING.title);
  assert.equal(shown?.options['body'], WAITING.body);
  // The same key the page collapses its own list by: a chat that asks twice replaces itself
  assert.equal(shown?.options['tag'], WAITING.key);
  assert.equal(shown?.options['requireInteraction'], true, 'a question stays up until it is answered');
  // Spread first: the worker built this object in its own realm, where the prototype is another one
  assert.deepEqual({ ...(shown?.options['data'] as object) }, { href: WAITING.href, key: WAITING.key });
  assert.equal(shown?.options['timestamp'], Date.parse(WAITING.at));
});

test('a notification that is not a question does not demand to be dealt with', async () => {
  const worker = await ready(SHELL);
  await worker.push({ ...WAITING, kind: 'run', priority: 'normal', at: 'not a date' });
  assert.equal(worker.shown[0]?.options['requireInteraction'], false);
  assert.equal(worker.shown[0]?.options['renotify'], false);
  assert.ok(typeof worker.shown[0]?.options['timestamp'] === 'number', 'an unreadable date does not become NaN');
});

test('a push with no payload, or one that is not ours, shows the words the page left behind', async () => {
  for (const payload of [undefined, 'broken']) {
    const worker = await ready(SHELL, { pushState: STATE });
    await worker.push(payload);
    assert.equal(worker.shown[0]?.title, FALLBACK.title, `payload ${String(payload)}`);
    assert.equal(worker.shown[0]?.options['body'], FALLBACK.body);
  }
});

test('a click on a page already at that path only focuses it', async () => {
  const worker = await ready(SHELL, { clients: [{ url: `${ORIGIN}/chats/run1?prompt=p1` }] });
  await worker.click({ href: WAITING.href });
  assert.equal(worker.clients[0]?.focused, true);
  assert.deepEqual(worker.clients[0]?.messages, [], 'it is already there; there is nothing to route');
  assert.deepEqual(worker.opened, []);
});

test('a click hands the path to a page that is open, which routes it in place', async () => {
  const worker = await ready(SHELL, { clients: [{ url: `${ORIGIN}/usage`, acks: true }] });
  await worker.click({ href: WAITING.href });
  const client = worker.clients[0];
  assert.equal(client?.focused, true);
  assert.deepEqual(client?.messages.map((message) => ({ ...(message as object) })), [{ type: 'agentry:open', href: '/chats/run1?prompt=p1' }]);
  // Reloading it would throw away whatever is half-typed in a composer
  assert.equal(client?.navigated, null);
  assert.deepEqual(worker.opened, []);
});

test('a page too old to answer that message is navigated instead', async () => {
  const worker = await ready(SHELL, { clients: [{ url: `${ORIGIN}/usage` }], fireTimers: true });
  await worker.click({ href: WAITING.href });
  assert.equal(worker.clients[0]?.navigated, `${ORIGIN}/chats/run1?prompt=p1`);
  assert.deepEqual(worker.opened, []);
});

test('a window this worker may not navigate gets a new one, and so does having none', async () => {
  const stubborn = await ready(SHELL, { clients: [{ url: `${ORIGIN}/usage`, navigable: false }], fireTimers: true });
  await stubborn.click({ href: WAITING.href });
  assert.deepEqual(stubborn.opened, [`${ORIGIN}/chats/run1?prompt=p1`]);

  const closed = await ready(SHELL);
  await closed.click({ href: WAITING.href });
  assert.deepEqual(closed.opened, [`${ORIGIN}/chats/run1?prompt=p1`]);
});

test('a notification with nowhere in particular to go opens the app', async () => {
  const worker = await ready(SHELL);
  await worker.click(undefined);
  assert.deepEqual(worker.opened, [`${ORIGIN}/`]);
});

test('a rotated subscription is registered with what this install asked for, and the old one dropped', async () => {
  const worker = await ready(SHELL, { pushState: STATE });
  await worker.rotate({ oldSubscription: subscription('https://push.example/old'), newSubscription: subscription('https://push.example/new') });
  assert.equal(worker.sent.length, 2, JSON.stringify(worker.sent));
  assert.deepEqual(worker.sent[0], {
    url: '/api/push/subscriptions',
    method: 'POST',
    body: { endpoint: 'https://push.example/new', keys: { p256dh: 'p256', auth: 'auth' }, kinds: STATE.kinds, label: STATE.label },
  });
  assert.deepEqual(worker.sent[1], { url: '/api/push/subscriptions', method: 'DELETE', body: { endpoint: 'https://push.example/old' } });
});

test('a browser that rotated without handing over a subscription is re-subscribed with the stored key', async () => {
  const worker = await ready(SHELL, { pushState: STATE, renewed: subscription('https://push.example/renewed') });
  await worker.rotate({ oldSubscription: subscription('https://push.example/old') });
  assert.equal(worker.subscribeCalls.length, 1);
  assert.equal(worker.subscribeCalls[0]?.['userVisibleOnly'], true, 'a push nobody is shown is a push Chrome stops delivering');
  assert.deepEqual([...(worker.subscribeCalls[0]?.['applicationServerKey'] as Iterable<number>)], [65, 66, 67]);
  assert.equal(worker.sent[0]?.body['endpoint'], 'https://push.example/renewed');
});

test('the old endpoint is kept when the new one could not be registered', async () => {
  const worker = await ready(SHELL, { pushState: STATE, postOk: false });
  await worker.rotate({ oldSubscription: subscription('https://push.example/old'), newSubscription: subscription('https://push.example/new') });
  // Deleting it on a failed POST would leave the install reachable by nothing at all
  assert.deepEqual(worker.sent.map((call) => call.method), ['POST']);
});

test('a rotation with nothing to re-register, and nothing stored, asks the server for nothing', async () => {
  const worker = await ready(SHELL);
  await worker.rotate({ oldSubscription: subscription('https://push.example/old') });
  assert.deepEqual(worker.sent, []);
  assert.deepEqual(worker.subscribeCalls, [], 'there is no key to subscribe against');
});

test('a subscription with no encryption keys is not registered: nothing could be sent to it', async () => {
  const worker = await ready(SHELL, { pushState: STATE });
  await worker.rotate({ newSubscription: subscription('https://push.example/new', null) });
  assert.deepEqual(worker.sent, []);
});

test('the worker and the page name the same cache for the state they share', () => {
  assert.match(SOURCE, new RegExp(`const PUSH_STATE_CACHE = '${PUSH_STATE_CACHE}';`));
  assert.match(SOURCE, new RegExp(`const PUSH_STATE_KEY = '${PUSH_STATE_KEY}';`));
  // The shell cache is dropped on every new build; this one holds what a rotation needs and is not
  assert.ok(!PUSH_STATE_CACHE.startsWith('agentry-shell-'));
});
