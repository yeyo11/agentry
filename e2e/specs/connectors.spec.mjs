// The connectors page. The sandbox has no claude.ai login, so the CLI lists no connectors (or fails
// to answer): what has to hold either way is that the page says which of the two it is instead of
// showing a blank, says what a person must do to authorise one, and says plainly what is out of reach.
export default async ({ page, api, check }) => {
  await page.goto('/', 1200);
  const nav = await page.eval(`return [...document.querySelectorAll('#sidebar nav a')].map((a) => a.getAttribute('href'))`);
  check(nav.includes('/connectors'), 'Connectors is in the navigation');

  await page.goto('/connectors', 1500);
  await page.waitFor(`return document.querySelector('main')?.innerText.includes('Out of reach')`, { label: 'the connectors overview', timeout: 60_000 });
  const text = await page.text('main');

  // What the CLI has no command for is said in the page, in words, not left as a gap
  for (const sentence of ['Agentry talks to Claude Code only through its CLI', 'Web artifacts', 'claude.ai memory', 'no public API and no CLI command']) {
    check(text.includes(sentence), `the page says: "${sentence}"`);
  }
  check((await api.get('/connectors')).body.unavailable.length === 2, 'the two things out of reach come from the server');

  // An empty list is never a silent one
  const failed = text.includes('The CLI could not list its connectors');
  const none = text.includes('No claude.ai connectors listed');
  const cards = await page.eval(`return document.querySelectorAll('main .lrows .connector-row').length`);
  check(failed || none || cards > 0, 'the page shows connectors, says there are none, or says the CLI failed');
  if (none) {
    check(text.includes('How to authorise a connector'), 'with nothing connected the page says how to authorise one');
    check(text.includes('Not listed by the CLI'), 'it names the connectors the CLI did not list');
    const links = await page.eval(`return [...document.querySelectorAll('main a[target=_blank]')].map((a) => a.rel)`);
    check(links.length >= 1 && links.every((rel) => rel.includes('noreferrer')), 'the instructions link out safely');
  }
  // A connector that is not authorised offers its instructions and no prepared prompt
  const offering = await page.eval(`return [...document.querySelectorAll('main .lrows .connector-row')].filter((c) => c.innerText.includes('Needs authorisation') && c.querySelector('.task-actions')).length`);
  check(offering === 0, 'a connector that needs authorisation offers no prepared prompt');

  // Asking the CLI again is a button, and the page survives it
  await page.click('main button', 'Ask the CLI again', 300);
  await page.waitFor(`return [...document.querySelectorAll('main button')].some((b) => b.textContent.includes('Ask the CLI again') && !b.disabled)`, { label: 'the refresh finished', timeout: 60_000 });
  check((await page.text('main')).includes('Out of reach'), 'the page is intact after asking again');
};
