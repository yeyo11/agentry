// Agentry as an installed app: a manifest a phone can read, icons it can draw, and a service
// worker that paints the shell before the network answers.
//
// The last third of this spec is the reason it exists. Every page of the UI follows the server
// through `GET /api/events`, and a chat through its own stream; both are long-lived
// `text/event-stream` responses. A service worker that answered them — even by passing them
// through — could buffer or close them, and the page would simply stop updating with nothing
// anywhere to say why. So the worker is checked against the API while it is actually controlling
// the page, which is the only state in which the bug could exist.

export default async ({ page, api, check }) => {
  // ---- What the server hands a phone ----
  const manifestRes = await fetch(`${api.baseUrl}/manifest.webmanifest`);
  check(manifestRes.status === 200, `GET /manifest.webmanifest (${manifestRes.status})`);
  const contentType = manifestRes.headers.get('content-type') ?? '';
  check(/manifest\+json|application\/json/.test(contentType), `the manifest is served as JSON: ${contentType}`);
  const manifest = JSON.parse(await manifestRes.text());
  check(manifest.display === 'standalone', `it asks for a standalone window (${manifest.display})`);
  check(manifest.start_url === '/' && manifest.scope === '/', 'it starts at the root and owns the whole origin');
  check(manifest.icons.some((icon) => icon.purpose === 'maskable'), 'it offers Android a maskable icon');
  for (const { src } of manifest.icons.concat({ src: '/icons/apple-touch-icon.png' })) {
    const res = await fetch(`${api.baseUrl}${src}`);
    check(res.status === 200 && (res.headers.get('content-type') ?? '').startsWith('image/png'), `${src} is served as a PNG (${res.status})`);
  }

  const workerRes = await fetch(`${api.baseUrl}/sw.js`);
  check(workerRes.status === 200, `GET /sw.js (${workerRes.status})`);
  const source = await workerRes.text();
  const generated = source.split('/* shell:end */')[0] ?? '';
  check(/const SHELL = \[\n\s+"/.test(generated), 'the build stamped the asset list into the worker');
  check(/const BUILD = "[0-9a-f]{16}"/.test(generated), 'and named the cache after that build');
  check(!/"\/(api|docs)/.test(generated), 'and put nothing of the API in it');

  // ---- The worker takes over the page ----
  await page.goto('/', 1500);
  await page.waitFor(`const registration = await navigator.serviceWorker.getRegistration(); return !!registration?.active`, { label: 'the service worker to install' });
  await page.waitFor(`return !!navigator.serviceWorker.controller`, { label: 'the worker to take control of the page' });

  const cached = await page.eval(
    `const name = (await caches.keys()).find((key) => key.startsWith('agentry-shell-'));` +
      `if (!name) return null;` +
      `const cache = await caches.open(name);` +
      `return (await cache.keys()).map((request) => new URL(request.url).pathname);`,
  );
  check(Array.isArray(cached), 'the worker opened a shell cache');
  check(cached.includes('/index.html'), `the page itself is cached, so a cold start paints: ${cached.join(', ')}`);
  check(
    cached.some((path) => path.endsWith('.js')) && cached.some((path) => path.endsWith('.css')) && cached.some((path) => path.endsWith('.woff2')),
    `the bundle, the stylesheet and the fonts are cached with it: ${cached.join(', ')}`,
  );
  const forbidden = cached.filter((path) => path.startsWith('/api') || path.startsWith('/docs') || path === '/openapi.json');
  check(forbidden.length === 0, `the worker cached what it must never cache: ${forbidden.join(', ')}`);

  // ---- The regression: the streams are untouched while the worker controls the page ----
  const feed = await page.eval(
    `return await new Promise((resolve) => {` +
      `const source = new EventSource('/api/events');` +
      `const done = (what) => { source.close(); resolve(what); };` +
      `source.addEventListener('stream.hello', () => done('hello'));` +
      `source.onerror = () => done('error');` +
      `setTimeout(() => done('timeout'), 10000);` +
      `});`,
  );
  check(feed === 'hello', `/api/events opens with its hello through a controlled page (got: ${feed})`);

  const created = await api.post('/chats', { prompt: 'e2e-pwa stream' });
  check(created.status === 201, `the chat was created (${created.status})`);
  try {
    const stream = await page.eval(
      `const res = await fetch('/api/chats/${created.body.id}/stream');` + `const type = res.headers.get('content-type') ?? '';` + `await res.body.cancel();` + `return type;`,
    );
    check(stream.startsWith('text/event-stream'), `the chat stream is still a stream, not a cached answer (${stream})`);
  } finally {
    await api.post(`/chats/${created.body.id}/stop`);
    for (let i = 0; i < 40; i++) {
      if ((await api.del(`/chats/${created.body.id}`)).status === 200) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // ---- What Settings offers about installing it ----
  await page.goto('/settings?tab=install', 1500);
  await page.waitFor(`return !!document.querySelector('[data-testid=install-card]')`, { label: 'the install card' });
  const card = await page.text('[data-testid=install-card]');
  check(card.length > 40, `the card says how to install, whatever this browser supports: "${card}"`);
  // 127.0.0.1 is a secure origin, so the sentence about insecure ones must not be the one showing
  check(!(await page.eval(`return !!document.querySelector('[data-testid=install-insecure]')`)), 'nothing warns about the origin on a secure one');

  // The shell the worker now serves is the app, not a stale page from another build
  await page.goto('/chats', 1200);
  check((await page.text('main')).trim().length > 10, 'the app still renders from the shell the worker serves');
};
