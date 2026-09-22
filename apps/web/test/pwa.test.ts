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

class FakeCache {
  readonly entries = new Map<string, string>();
  constructor(private readonly broken: boolean) {}
  addAll(urls: readonly string[]): Promise<void> {
    if (this.broken) return Promise.reject(new Error('404 while precaching'));
    for (const url of urls) this.entries.set(url, `cached ${url}`);
    return Promise.resolve();
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
    return Promise.resolve(this.stores.get(options.cacheName)?.entries.get(key));
  }
}

interface Worker {
  caches: FakeCaches;
  fetched: string[];
  claimed: () => boolean;
  install(): Promise<void>;
  activate(): Promise<void>;
  /** What the worker answered with, or `null` when it left the request to the browser */
  fetch(req: SwRequest): Promise<string | null>;
}

/** Runs sw.js in a sandbox with the globals a service worker actually has. */
function load(shell: readonly string[] = SHELL, { broken = false, seeded = [] as string[] } = {}): Worker {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const fakeCaches = new FakeCaches(broken);
  for (const name of seeded) void fakeCaches.open(name);
  const fetched: string[] = [];
  let claimed = false;

  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => handlers.set(type, handler),
      skipWaiting: () => Promise.resolve(),
      clients: {
        claim: () => {
          claimed = true;
          return Promise.resolve();
        },
      },
    },
    caches: fakeCaches,
    fetch: (req: SwRequest) => {
      fetched.push(req.url);
      return Promise.resolve(`network ${req.url}`);
    },
    console: { warn: () => {} },
    URL,
  };
  runInContext(buildServiceWorker(SOURCE, shell, 'test'), createContext(sandbox));

  const lifecycle = async (type: string): Promise<void> => {
    const waiting: Array<Promise<unknown>> = [];
    handlers.get(type)?.({ waitUntil: (promise: Promise<unknown>) => void waiting.push(promise) });
    await Promise.all(waiting);
  };

  return {
    caches: fakeCaches,
    fetched,
    claimed: () => claimed,
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    async fetch(req) {
      let answer: Promise<string> | null = null;
      handlers.get('fetch')?.({ request: req, respondWith: (promise: Promise<string>) => void (answer = promise) });
      return answer === null ? null : await (answer as Promise<string>);
    },
  };
}

async function ready(shell?: readonly string[]): Promise<Worker> {
  const worker = load(shell);
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
