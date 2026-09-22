// Agentry's service worker: the app shell, and nothing else.
//
// It exists for two reasons. An installed Agentry has to paint its own frame before the network
// answers — on a phone the alternative is a white rectangle for as long as the wrapper takes to
// reply — and a worker is the only place a browser will ever deliver a Web Push.
//
// The one thing it must not do is come between the page and the API. `GET /api/events` and the
// chat streams are long-lived `text/event-stream` responses; a worker that answers them for any
// reason at all risks buffering, truncating or closing them, and a wrapper whose feed is dead
// looks broken in a way nobody traces back to a cache. So `handles()` is an allowlist of the
// requests this worker answers, and for everything else the `fetch` listener simply returns —
// without calling `respondWith`, which leaves the request to the browser as if no worker existed.
//
// Everything in the cache is named by a hashed filename or covered by BUILD, so entries are
// served as they are and never revalidated: the cache is dropped whole when the build changes.

/* shell:start */
// Replaced at build time by apps/web/scripts/sw-shell.ts. An empty shell makes the worker a
// no-op, which is what `pnpm dev` would get if it ever registered it (it does not).
const BUILD = 'dev';
const SHELL = [];
/* shell:end */

const CACHE = `agentry-shell-${BUILD}`;
const SHELL_PATHS = new Set(SHELL);

/**
 * The first path segment of every route the app's own router owns. A navigation to one of them is
 * answered with the cached `index.html`; anything else — `/docs`, `/openapi.json`, a path this
 * list has not heard of — goes to the network, where the API answers it or falls back to the same
 * `index.html` itself. Forgetting an entry here costs a round trip, never a broken page, which is
 * why this is a list of what we handle rather than a list of what we skip.
 */
const APP_ROUTES = new Set(['', 'accounts', 'chats', 'connectors', 'orchestration', 'projects', 'schedules', 'settings', 'usage']);

/** The page's own shell for a navigation: one URL for every route, since the app routes in place. */
const SHELL_DOCUMENT = '/index.html';

function handles(request, url) {
  // Nothing is cached before the first install finishes, and in development nothing ever is
  if (SHELL.length === 0) return false;
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  // A range request is a partial read the network has to serve; a cache hit would answer 200
  if (request.headers.has('range')) return false;
  if (request.mode === 'navigate') return APP_ROUTES.has(url.pathname.split('/')[1] ?? '');
  return SHELL_PATHS.has(url.pathname);
}

async function answer(request, key) {
  const cached = await caches.match(key, { cacheName: CACHE });
  return cached ?? fetch(request);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      // One asset that fails to download must not leave the worker uninstalled forever: it would
      // also take Web Push with it. An empty cache is a worker that passes everything through.
      .catch((error) => console.warn('[agentry] the app shell was not cached:', error))
      // The next build takes over on the next load instead of waiting for every tab to close. What
      // it costs is that a page open across a deploy may ask for a chunk the new build renamed —
      // which is equally true without a worker, since the server no longer has the old one either.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith('agentry-shell-') && name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!handles(event.request, url)) return;
  event.respondWith(answer(event.request, event.request.mode === 'navigate' ? SHELL_DOCUMENT : url.pathname));
});

// ---------- Web Push ----------
//
// The second reason this file exists: a browser delivers a push to a service worker and to nothing
// else, whether or not a page of ours is open. Everything below runs with no DOM, no bundle and no
// translations — so the words it shows come from the payload the server signed, and what it cannot
// get from there it reads out of the small state the page left in a cache of its own.
//
// The rule that keeps this from being noise: while a window of ours is visible, the page is already
// showing the toast for this very notification, and the worker shows nothing. Chrome's
// `userVisibleOnly` bargain is satisfied by exactly that condition — a visible page of the origin
// is the notification.

/** Written by the page (see src/lib/push-model.ts); the two names are asserted equal in the tests. */
const PUSH_STATE_CACHE = 'agentry-push';
const PUSH_STATE_KEY = '/__agentry-push-state';

/** A focused page gets this long to route the click itself before the worker reloads it. */
const HANDOFF_MS = 600;

const PUSH_ICON = '/icons/icon-192.png';

/** Every window of this origin, open or not, controlled by this worker or not. */
const windows = () => self.clients.matchAll({ type: 'window', includeUncontrolled: true });

async function pushState() {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const stored = await cache.match(PUSH_STATE_KEY);
    return stored ? await stored.json() : null;
  } catch {
    return null;
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(notify(event.data));
});

async function notify(data) {
  let payload = null;
  try {
    payload = data ? data.json() : null;
  } catch {
    // A push that is not our JSON is still a push: it is shown with the fallback words below
  }

  const open = await windows();
  if (open.some((client) => client.visibilityState === 'visible')) return;

  const state = await pushState();
  const fallback = state && state.fallback ? state.fallback : null;
  const at = Date.parse((payload && payload.at) || '');
  await self.registration.showNotification((payload && payload.title) || (fallback && fallback.title) || 'Agentry', {
    body: (payload && payload.body) || (fallback && fallback.body) || '',
    // The dedupe key the page uses for its own list: a chat that asks twice replaces its
    // notification instead of stacking a second one on the lock screen.
    tag: (payload && payload.key) || 'agentry',
    renotify: Boolean(payload && payload.priority === 'high'),
    requireInteraction: Boolean(payload && payload.priority === 'high'),
    icon: PUSH_ICON,
    timestamp: Number.isNaN(at) ? Date.now() : at,
    data: { href: (payload && payload.href) || '/', key: (payload && payload.key) || '' },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  event.waitUntil(openPath((data && data.href) || '/'));
});

/**
 * Opens what the notification was about: the prompt of a `waiting`, the chat of a run that ended.
 *
 * A page that is already open is preferred over a new window, and is asked to route the path
 * itself — the app routes in place, and reloading it would throw away whatever is half-typed in a
 * composer. `navigate()` is the fallback for a page too old to know that message, and a new window
 * the fallback for having none.
 */
async function openPath(href) {
  const url = new URL(href || '/', self.location.origin);
  const open = await windows();
  const here = open.find((client) => client.url === url.href);
  if (here) return void (await here.focus());

  const first = open[0];
  if (first) {
    const client = (await first.focus().catch(() => null)) || first;
    if (await handOff(client, url.pathname + url.search)) return;
    try {
      return void (await client.navigate(url.href));
    } catch {
      // Not a client this worker may navigate; a new window is still better than nothing
    }
  }
  await self.clients.openWindow(url.href);
}

/** True once the page answers that it has routed there itself. */
function handOff(client, path) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), HANDOFF_MS);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    try {
      client.postMessage({ type: 'agentry:open', href: path }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

// A push service may retire an endpoint on its own, and everything registered against the old one
// is then dead. The page repairs this too, on its next load — this is what happens while there is
// no page at all. It carries no credential, because a worker cannot read the browser's stored
// token: on a guarded wrapper the server answers 401 and the next load of the app puts it right.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(resubscribe(event));
});

async function resubscribe(event) {
  const state = await pushState();
  let subscription = event.newSubscription || (await self.registration.pushManager.getSubscription());
  if (!subscription && state && state.applicationServerKey) {
    subscription = await self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.applicationServerKey) })
      .catch(() => null);
  }
  if (!subscription) return;
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys) return;

  const registered = await post('/api/push/subscriptions', {
    endpoint: json.endpoint,
    keys: json.keys,
    // Omitted when the page left nothing behind, and the server then takes it to mean every kind
    kinds: state ? state.kinds : undefined,
    label: state ? state.label : undefined,
  });
  const old = event.oldSubscription;
  // Only once the new endpoint is registered: losing both would leave this install unreachable
  if (registered && old && old.endpoint && old.endpoint !== json.endpoint) {
    await post('/api/push/subscriptions', { endpoint: old.endpoint }, 'DELETE');
  }
}

async function post(path, body, method = 'POST') {
  try {
    const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.ok;
  } catch {
    return false;
  }
}

/** URL-safe base64 to the bytes `subscribe` takes; Firefox has never accepted the string form. */
function keyBytes(key) {
  const binary = atob(key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
