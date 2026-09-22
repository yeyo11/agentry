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
