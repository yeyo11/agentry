// Settings → Remote access, and the layered settings in Security (docs/plans/tunnel.md, task `web`).
//
// The suite's wrapper runs with authentication off, so against the real server the tab can only say
// why the tunnel stays closed. A real tunnel would verify its address over the internet, which a
// spec never touches, so the open tunnel is a fake: a script that runs before the app answers
// `/api/tunnel` (and says the guard is on) the way the server does; the tab, its QR code and its
// buttons are the real ones.

const TAB = '[role=tabpanel]';
const FAKE_URL = 'https://0a1b2c3d4e5f67.lhr.life';

/** Answers the tunnel's routes from `window.__tunnel`, starting at `initial`; everything else is the server's. */
const fakeTunnel = (initial) => `(() => {
  const real = window.fetch.bind(window);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  window.__tunnel = ${JSON.stringify(initial)};
  window.__tunnelCalls = [];
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = (init.method ?? 'GET').toUpperCase();
    if (url.pathname === '/api/tunnel' && method === 'GET') return json(window.__tunnel);
    if (url.pathname === '/api/tunnel/stop') {
      window.__tunnelCalls.push('stop');
      window.__tunnel = { ...window.__tunnel, state: 'stopped', url: null, since: null };
      return json(window.__tunnel);
    }
    if (url.pathname === '/api/security/auth' && method === 'GET') {
      const res = await real(input, init);
      return json({ ...(await res.json()), mode: 'token' });
    }
    return real(input, init);
  };
})();`;

const status = (state, extra = {}) => ({
  state,
  url: state === 'active' ? FAKE_URL : null,
  since: state === 'active' ? new Date().toISOString() : null,
  reason: null,
  sshAvailable: true,
  settings: { startWithAgentry: false },
  ...extra,
});

export default async ({ page, api, check }) => {
  // ---- The real server, with the guard open ----
  const refused = await api.post('/tunnel/start');
  check(refused.status === 409, `the server refuses a tunnel while authentication is off (got ${refused.status})`);

  await page.goto('/settings?tab=remote', 1500);
  await page.waitFor(`return !!document.querySelector('[data-testid=tunnel-auth-required]')`, { label: 'the authentication warning' });
  const open = await page.text(TAB);
  check(open.includes('Turn on authentication first'), 'the tab says why the tunnel stays closed');
  check(!(await page.eval(`return !!document.querySelector('[data-testid=tunnel-start]')`)), 'no start button while the guard is open');
  check(/closed/i.test(open), 'the state is said in words');
  await page.click(`${TAB} a`, 'Open Security', 1200);
  check((await page.eval('return location.search')) === '?tab=security', 'the warning leads to Security');

  // "Start with Agentry" is saved, and a change made elsewhere reaches the page through the feed
  const before = (await api.get('/tunnel')).body.settings.startWithAgentry;
  try {
    await page.goto('/settings?tab=remote', 1500);
    await page.click(`${TAB} [role=switch]`, undefined, 800);
    check((await api.get('/tunnel')).body.settings.startWithAgentry === !before, 'the switch saved the setting');
    await api.put('/tunnel/settings', { startWithAgentry: before });
    await page.waitFor(`return document.querySelector('${TAB} [role=switch]')?.getAttribute('aria-checked') === ${JSON.stringify(String(before))}`, {
      label: 'the switch following tunnel.changed',
    });
  } finally {
    await api.put('/tunnel/settings', { startWithAgentry: before });
  }

  // ---- A fake open tunnel ----
  let remove = await page.onNewDocument(fakeTunnel(status('active')));
  try {
    await page.goto('/settings?tab=remote', 1500);
    await page.waitFor(`return !!document.querySelector('[data-testid=tunnel-address]')`, { label: 'the open address' });
    const url = await page.eval(`return document.querySelector('[data-testid=tunnel-url]')?.textContent ?? ''`);
    check(url === FAKE_URL, `the address is shown (got ${url})`);
    check(await page.eval(`return getComputedStyle(document.querySelector('[data-testid=tunnel-url]')).fontFamily.includes('Mono')`), 'the address is in mono');
    check(await page.eval(`return !!document.querySelector('${TAB} svg.qr[role=img][aria-label*="lhr.life"]')`), 'a QR code of the address is drawn, and named');
    check(await page.eval(`return !!document.querySelector('${TAB} button[aria-label="Copy address"]')`), 'the address can be copied');
    check(/open/i.test(await page.text(`${TAB} .card-head .badge`)), 'the state reads open');
    await page.click('[data-testid=tunnel-stop]', undefined, 800);
    await page.waitFor(`return !!document.querySelector('[data-testid=tunnel-start]')`, { label: 'the start button after closing' });
    check((await page.eval('return window.__tunnelCalls.join()')) === 'stop', 'the stop button asked the server once');
    check(!(await page.eval(`return !!document.querySelector('[data-testid=tunnel-address]')`)), 'the address is gone once closed');
  } finally {
    await remove();
  }

  // ---- A machine without ssh ----
  remove = await page.onNewDocument(fakeTunnel(status('failed', { sshAvailable: false, reason: { code: 'tunnel.sshMissing', text: 'No ssh' } })));
  try {
    await page.goto('/settings?tab=remote', 1500);
    await page.waitFor(`return !!document.querySelector('${TAB} .state-illustrated')`, { label: 'the ssh-missing state' });
    const text = await page.text(TAB);
    check(text.includes('ssh not found') && text.includes('openssh-client'), 'the tab says ssh is missing and how to install it');
  } finally {
    await remove();
  }

  // ---- The layered settings in Security ----
  const settings = (await api.get('/settings/app')).body;
  check(Array.isArray(settings.allowedHosts) && typeof settings.sources === 'object', 'the settings come with their sources');
  if (settings.sources.maxConcurrentRuns !== 'env') {
    const next = settings.maxConcurrentRuns === 5 ? 6 : 5;
    try {
      await page.goto('/settings?tab=security', 1500);
      await page.fill(`${TAB} input[aria-label="Runs at once"]`, String(next));
      const runsCard = `[...document.querySelectorAll('${TAB} .card')].find(c => c.querySelector('h2')?.textContent === 'Runs')`;
      await page.eval(`${runsCard}.querySelector('button[type=submit]').click(); return true`);
      await page.waitFor(`return fetch('/api/settings/app').then(r => r.json()).then(s => s.maxConcurrentRuns === ${next})`, { label: 'the new run limit saved' });
      check(true, 'the run limit was saved from the Security tab');
    } finally {
      await api.put('/settings/app', { maxConcurrentRuns: settings.maxConcurrentRuns });
    }
  }
};
