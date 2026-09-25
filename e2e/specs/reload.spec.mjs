// A page left open across a deploy: the server says in every `stream.hello` which version it runs,
// and a page built for another one offers a reload — and never takes it on its own, because a
// half-written message is worth more than being current.
//
// The harness has one server and one build, so a deploy is faked in the page instead: a script
// that runs before the app wraps `EventSource` and rewrites the version in the hello it hears.

const NEXT = '99.0.0';

// Every listener for `stream.hello` gets the same event with another version in it. Statics such
// as `EventSource.CLOSED`, which the feed reads, come with the subclass.
const FAKE_DEPLOY = `(() => {
  const Native = window.EventSource;
  window.EventSource = class extends Native {
    addEventListener(type, listener, options) {
      if (type !== 'stream.hello') return super.addEventListener(type, listener, options);
      return super.addEventListener(type, (event) => {
        const hello = JSON.parse(event.data);
        hello.version = ${JSON.stringify(NEXT)};
        listener.call(this, new MessageEvent(type, { data: JSON.stringify(hello), lastEventId: event.lastEventId }));
      }, options);
    }
  };
})();`;

const BANNER = '[data-testid=reload-banner]';

export default async ({ page, api, check }) => {
  // The build and the server come from the same release: nothing to offer
  const controller = new AbortController();
  const res = await fetch(`${api.baseUrl}/api/events`, { signal: controller.signal });
  const first = new TextDecoder().decode((await res.body.getReader().read()).value);
  controller.abort();
  const version = /"version":"([^"]+)"/.exec(first)?.[1];
  check(Boolean(version), `stream.hello names the server's version: ${first.slice(0, 200)}`);

  await page.goto('/', 1500);
  await page.waitFor(`return document.querySelector('main')?.innerText.trim().length > 10`, { label: 'home page' });
  const quiet = await page.eval(`return !document.querySelector(${JSON.stringify(BANNER)})`);
  check(quiet, 'a page built from the version the server runs offers no reload');

  const remove = await page.onNewDocument(FAKE_DEPLOY);
  try {
    await page.goto('/', 1500);
    const shown = await page.waitFor(`return (document.querySelector(${JSON.stringify(BANNER)})?.innerText ?? '').includes(${JSON.stringify(NEXT)})`, { label: 'the reload banner' });
    check(shown, 'a hello with another version shows the reload banner, naming the version');
    const role = await page.eval(`return document.querySelector(${JSON.stringify(BANNER)})?.getAttribute('role')`);
    check(role === 'status', `the banner is announced politely, without taking focus (${role})`);
    const violations = await page.axe({ include: BANNER });
    check(violations.length === 0, `the banner has accessibility violations: ${JSON.stringify(violations)}`);

    // Left alone, the page stays: whatever is in the composer survives
    await page.eval(`window.__agentryStay = true; return true`);
    await page.sleep(2500);
    const stayed = await page.eval(`return window.__agentryStay === true`);
    check(stayed, 'the page never reloads on its own');

    // Dismissed, it stays away for that version
    await page.click(`${BANNER} button[aria-label]`);
    const gone = await page.eval(`return !document.querySelector(${JSON.stringify(BANNER)})`);
    check(gone, 'the banner can be dismissed');

    // Pressed, it reloads (through the service worker when one controls the page)
    await page.goto('/', 1500);
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(BANNER)})`, { label: 'the reload banner again' });
    await page.eval(`window.__agentryStay = true; return true`);
    await page.click(`${BANNER} .btn-primary`);
    const reloaded = await page.waitFor(`return window.__agentryStay === undefined && document.readyState === 'complete'`, { label: 'the page to reload' });
    check(reloaded, 'Reload reloads the page');
  } finally {
    await remove();
  }

  // ---- A lazy page whose file the deploy removed ----
  // Blocking the Usage chunk is what a page built before a deploy meets: its import points at a
  // file the new build no longer has. The route stands in with a page that says so, and the same
  // banner offers the reload, instead of the app breaking.
  await page.goto('/', 1500);
  // The block makes the console report the failed load; what came before it is checked here instead
  const earlier = page.takeErrors();
  check(earlier.length === 0, `console errors before the block:\n  ${earlier.join('\n  ')}`);
  const unblock = await page.blockUrls(['*/assets/Usage-*.js']);
  try {
    await page.goto('/usage', 1500);
    const stale = await page.waitFor(`return (document.querySelector('main')?.innerText ?? '').includes('This page belongs to an older version of Agentry')`, { label: 'the stale page' });
    check(stale, 'a missing chunk renders the stale page instead of breaking');
    const banner = await page.waitFor(`return document.querySelector(${JSON.stringify(BANNER)})?.innerText ?? ''`, { label: 'the reload banner for a missing chunk' });
    check(banner.includes('Agentry was updated.'), `a missing chunk raises the banner: ${banner}`);
    const shell = await page.eval(`return !!document.querySelector('.sidebar')`);
    check(shell, 'the rest of the app keeps working around the missing page');
  } finally {
    await unblock();
  }
  page.takeErrors();
};
