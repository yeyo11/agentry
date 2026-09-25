// A newer Agentry shows up where a person looks: the Updates card in Settings, with the way to take
// it for this install, and a dot on the Settings entry that never goes in the bell. The release
// comes from the fixture run.mjs serves for AGENTRY_RELEASES_URL; the harness sets
// AGENTRY_DISTRIBUTION=docker, so the card offers the Docker commands.

const CARD = '[data-testid=updates-card]';
const SIDEBAR_SETTINGS = '.sidebar .nav-link[href^="/settings"]';

export default async ({ page, api, check, releases }) => {
  const before = await api.get('/system/release');
  check(before.status === 200, `GET /system/release (${before.status})`);
  const { current } = before.body;
  check(before.body.distribution === 'docker', `the harness runs as a Docker install (${before.body.distribution})`);
  check(before.body.updateAvailable === false, 'nothing is known before a check: the daily one is off in the harness');

  releases.set('v999.0.0');
  await page.goto('/settings?tab=account');
  await page.waitFor(`return document.querySelector(${JSON.stringify(CARD)})?.innerText.includes(${JSON.stringify(current)})`, { label: 'the card to show the version in use' });
  check(!(await page.eval(`return !!document.querySelector('.nav-dot')`)), 'no dot while no newer release is known');
  const bellBefore = await page.eval(`return document.querySelector('.bell')?.getAttribute('aria-label') ?? null`);

  // ---- Check for updates ----
  await page.click(`${CARD} button`, 'Check for updates');
  await page.waitFor(`return document.querySelector(${JSON.stringify(CARD)})?.textContent.includes('Agentry 999.0.0 is available')`, { label: 'the newer release in the card' });
  const steps = await page.text('[data-testid=update-steps-docker]');
  check(steps.includes('docker compose pull && docker compose up -d'), `the Docker commands are offered: ${steps}`);
  check(!(await page.eval(`return !!document.querySelector(${JSON.stringify(CARD)} + ' .alert')`)), 'a page on this machine is not told to ask whoever runs the server');
  const notes = await page.eval(`return [...document.querySelectorAll(${JSON.stringify(`${CARD} a`)})].map((a) => a.href)`);
  check(notes.includes(releases.url), `the card links the release notes: ${notes.join(', ')}`);

  // ---- The indicator, on the Settings entry and never in the bell ----
  const dot = await page.waitFor(`return document.querySelector(${JSON.stringify(`${SIDEBAR_SETTINGS} .nav-dot`)})?.textContent`, { label: 'the dot on Settings' });
  check(dot === 'update available', `the dot says what it means to a screen reader: "${dot}"`);
  const href = await page.eval(`return document.querySelector(${JSON.stringify(SIDEBAR_SETTINGS)})?.getAttribute('href')`);
  check(href === '/settings?tab=account', `the dot leads to the Updates card: ${href}`);
  const bellAfter = await page.eval(`return document.querySelector('.bell')?.getAttribute('aria-label') ?? null`);
  check(bellAfter === bellBefore, `the bell stays out of it: "${bellBefore}" became "${bellAfter}"`);

  const violations = await page.axe({ include: CARD });
  check(violations.length === 0, `the card passes axe: ${JSON.stringify(violations, null, 2)}`);

  // On a phone, Settings is behind More: the dot shows on the button that leads there
  await page.viewport(390, 844);
  try {
    await page.waitFor(`return document.querySelector('.tabbar-more .nav-dot')?.textContent === 'update available'`, { label: 'the dot on More in the tab bar' });
  } finally {
    await page.viewport(1440, 900);
  }

  // ---- A release found by the server reaches an open page through system.release ----
  releases.set('v999.1.0');
  const found = await api.post('/system/release/check');
  check(found.body?.latest === '999.1.0', `the server found the next release: ${JSON.stringify(found.body)}`);
  await page.waitFor(`return document.querySelector(${JSON.stringify(CARD)})?.textContent.includes('Agentry 999.1.0 is available')`, { label: 'the card to follow system.release without a reload' });

  // ---- Back to the version in use: the card says so and the dot goes, for the specs after this one ----
  releases.set(`v${current}`);
  await page.click(`${CARD} button`, 'Check for updates');
  await page.waitFor(`return document.querySelector(${JSON.stringify(CARD)})?.textContent.includes('Agentry is up to date.')`, { label: 'the card to say it is up to date' });
  await page.waitFor(`return !document.querySelector('.nav-dot')`, { label: 'the dot to go' });
};
