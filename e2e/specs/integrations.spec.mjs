// Settings → Integrations: the code host CLIs (gh, glab), on a desktop and on a phone, in both themes.
//
// Reference screens: DesktopIntegraciones*, MobileIntegraciones* and DSIntegraciones. With E2E_SHOTS
// set the screens are saved for comparing them with the reference screenshots.
//
// The sandbox's hosts are the fakes of e2e/fake-hosts: `run.mjs` seeds `hosts.json` with their paths
// and a glab config that knows gitlab.com. They read what they answer from
// `<data>/fake-hosts/<name>.json`, so this spec walks both through every state without restarting the
// server, then puts the files and the settings back.
//
// What is not covered: the "nothing found" page (both programs not installed), because the binary
// override in `hosts.json` is what makes the sandbox's hosts work, and taking it away would send the
// detector to the real PATH of the machine running the suite.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const timeout = 170_000;

const row = (id) => `.prov-row[data-host="${id}"], .prov-cell[data-host="${id}"]`;
const stateOf = (id) => `return document.querySelector(${JSON.stringify(row(id))})?.getAttribute('data-state') ?? null`;
const stateIs = (id, wanted) => `return (() => { ${stateOf(id)} })() === ${JSON.stringify(wanted)}`;
const overflow = `return document.documentElement.scrollWidth - innerWidth`;
const NOWHERE = '/nonexistent/agentry-e2e/gh';

async function scan(page, check, label) {
  await page.reduceMotion(true);
  const violations = await page.axe();
  check(violations.length === 0, `axe on ${label}: ${JSON.stringify(violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })))}`);
}

async function theme(page, name) {
  await page.eval(`localStorage.setItem('agentry-theme', ${JSON.stringify(name)}); return true`);
}

export default async ({ page, api, check, dirs }) => {
  const stateDir = join(dirs.dataDir, 'fake-hosts');
  const fakes = join(dirname(fileURLToPath(import.meta.url)), '..', 'fake-hosts');
  const state = (name, value) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${name}.json`), JSON.stringify(value));
  };
  const statusOf = async (id) => (await api.get(`/hosts/${id}`)).body;
  const toolbarIdle = `return !!document.querySelector('.prov-toolbar .btn') && !document.querySelector('.prov-toolbar .btn:disabled')`;
  const checkAgain = async () => {
    // A click on the button while an earlier check still runs does nothing, so it is idle before and after
    await page.waitFor(toolbarIdle, { timeout: 40_000, label: 'the toolbar is idle' });
    await page.click('.prov-toolbar .btn', 'Check again', 300);
    // Check again reads the programs and the trackers, and a row offers its actions only once both are in
    await page.sleep(300);
    await page.waitFor(toolbarIdle, { timeout: 40_000, label: 'Check again finished' });
  };
  const savedSettings = (await api.get('/hosts/settings')).body;

  try {
    // ---- Both programs ready ----
    state('gh', {});
    state('glab', {});
    await api.post('/hosts/refresh');
    check((await statusOf('github')).state === 'ready', `gh is ready (${JSON.stringify(await statusOf('github'))})`);
    check((await statusOf('gitlab')).state === 'ready', `glab is ready (${JSON.stringify(await statusOf('gitlab'))})`);

    // The theme lives in the app's localStorage, which a blank page does not have: open the app first
    await page.goto('/', 300);
    await theme(page, 'dark');
    await page.goto('/settings?tab=integrations', 300);
    await page.waitFor(`return document.querySelectorAll('.prov-row[data-host]').length === 2`, { label: 'one row per host' });
    const tabs = await page.eval(`return [...document.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim())`);
    check(tabs.indexOf('Integrations') === tabs.indexOf('Providers') + 1, `the tab sits right after Providers (${tabs.join(', ')})`);
    check((await page.eval(stateOf('github'))) === 'ready' && (await page.eval(stateOf('gitlab'))) === 'ready', 'both rows are ready');
    const names = await page.eval(`return [...document.querySelectorAll('.prov-row[data-host] .prov-name')].map((n) => n.textContent)`);
    check(names[0].includes('GitHub') && names[0].includes('#12') && names[1].includes('GitLab') && names[1].includes('!12'), `each row says the host and how its requests are numbered (${names.join(' | ')})`);
    const summary = await page.text('.prov-summary');
    check(/2 programs/.test(summary) && /2 ready/.test(summary), `the card says how many are ready (${summary})`);
    const known = await page.text('.prov-row[data-host="gitlab"] .host-known');
    check(known.includes('gitlab.com') && known.includes('tanuki'), `glab's row names the host it knows and the account (${known})`);
    check((await page.eval(`return document.querySelectorAll('.grad-border').length`)) <= 2, 'at most two gradient surfaces');
    check((await page.eval(`return !!document.querySelector('.prov-checked')`)) && (await page.text('.prov-checked')).startsWith('Checked'), 'the page says when it checked');
    await page.shot('integrations-dark');
    await scan(page, check, 'Settings → Integrations, dark');
    await theme(page, 'light');
    await page.goto('/settings?tab=integrations', 300);
    await page.waitFor(`return document.querySelectorAll('.prov-row[data-host]').length === 2`, { label: 'the rows, light' });
    await page.shot('integrations-light');
    await scan(page, check, 'Settings → Integrations, light');
    await theme(page, 'dark');
    await page.goto('/settings?tab=integrations', 300);

    // ---- Signed out: the remedy is the sign-in panel inside Agentry, never a command ----
    state('gh', { signedIn: false });
    await checkAgain();
    await page.waitFor(stateIs('github', 'signed-out'), { label: 'gh signed out after Check again' });
    const signIn = await page.eval(`const a = document.querySelector('.prov-row[data-host="github"] [data-action="sign-in"]'); return a ? { tag: a.tagName, pressed: a.getAttribute('aria-pressed') } : null`);
    check(signIn?.tag === 'BUTTON' && signIn.pressed === 'false', `signed out offers Sign in, a button that stays in Agentry (${JSON.stringify(signIn)})`);
    await page.click('.prov-row[data-host="github"] [data-action="sign-in"]', undefined, 300);
    await page.waitFor(`return !!document.querySelector('.prov-bin.signin')`, { label: 'the sign-in panel under the row' });
    check((await page.eval(`return document.querySelector('.prov-bin.signin-panel [role="radiogroup"]')?.textContent ?? ''`)).includes('Code'), 'gh offers the device code and a key');
    await page.click('.prov-bin.signin-panel .prov-quiet', undefined, 200);
    // The badge is uppercase on screen (innerText), so its word is read from the DOM's own text
    const word = await page.eval(`return document.querySelector('.prov-row[data-host="github"] .prov-state .badge-text')?.textContent ?? ''`);
    check(word === 'Signed out', `the state carries its word (${word})`);
    check((await page.eval(`return !document.querySelector('.prov-row[data-host="github"] code, .prov-row[data-host="github"] [data-copy]')`)), 'no command to copy');
    check((await page.eval(stateOf('gitlab'))) === 'ready', 'the other row is untouched');
    state('gh', {});

    // ---- Incompatible, degraded and unknown ----
    state('glab', { version: '1.0.0' });
    await checkAgain();
    await page.waitFor(stateIs('gitlab', 'incompatible'), { label: 'glab incompatible' });
    const actions = await page.eval(`return [...document.querySelectorAll('.prov-row[data-host="gitlab"] [data-action]')].map((a) => a.getAttribute('data-action'))`);
    check(actions.join(',') === 'update,choose-binary', `an old version offers Update, then Choose binary (${actions.join(',')})`);
    check((await page.text('.prov-row[data-host="gitlab"]')).includes('1.120.0'), 'and the reason names the oldest release that works');

    state('glab', { version: '9.9.9' });
    await checkAgain();
    await page.waitFor(stateIs('gitlab', 'degraded'), { label: 'glab degraded' });
    check((await page.text('.prov-row[data-host="gitlab"]')).includes('9.9.9'), 'a newer, untested release says which version it is');
    await page.shot('integrations-states-dark');
    await scan(page, check, 'Settings → Integrations with a degraded host, dark');

    state('glab', { versionExit: 3 });
    await checkAgain();
    await page.waitFor(stateIs('gitlab', 'unknown'), { label: 'glab unknown' });
    state('glab', {});
    await page.click('.prov-row[data-host="gitlab"] [data-action="retry"]', undefined, 200);
    await page.waitFor(stateIs('gitlab', 'ready'), { label: 'Retry reads glab again' });

    // ---- The binary override: refused, relative, kept ----
    // A ready row asks for nothing (the prototype offers Choose binary only where a state calls for it,
    // and gh treats an untested release as ready), so gh is made too old first
    state('gh', { version: '1.0.0' });
    await checkAgain();
    await page.waitFor(stateIs('github', 'incompatible'), { label: 'gh too old, so it offers Choose binary' });
    await page.click('.prov-row[data-host="github"] [data-action="choose-binary"]', undefined, 400);
    check(await page.eval(`return !!document.querySelector('.host-bin input')`), 'Choose binary opens the editor under the row');
    await page.fill('.host-bin input', 'gh');
    await page.click('.host-bin .btn', 'Check and save', 200);
    await page.waitFor(`return !!document.querySelector('.host-bin .field-error')`, { label: 'the relative path is refused' });
    check((await page.text('.host-bin .field-error')).includes('absolute'), 'a relative path asks for an absolute one');
    await page.fill('.host-bin input', NOWHERE);
    await page.click('.host-bin .btn', 'Check and save', 300);
    await page.waitFor(`return /^Not saved\\./.test(document.querySelector('.host-bin .field-error')?.textContent ?? '')`, { label: 'a missing program is refused' });
    check((await api.get('/hosts/settings')).body.hosts.github.binaryPath === savedSettings.hosts.github.binaryPath, 'the earlier path is put back');
    check((await page.eval(stateOf('github'))) === 'incompatible', 'and the row keeps its state');
    // The program at the new path is a release that works
    state('gh', {});
    await page.fill('.host-bin input', join(fakes, 'gh'));
    await page.click('.host-bin .btn', 'Check and save', 300);
    await page.waitFor(`return !document.querySelector('.host-bin')`, { label: 'the editor closes once it is saved' });
    check((await api.get('/hosts/settings')).body.hosts.github.binaryPath === join(fakes, 'gh'), 'a working program is saved');

    // ---- A host that is off ----
    await api.put('/hosts/settings', { hosts: { ...savedSettings.hosts, gitlab: { ...savedSettings.hosts.gitlab, enabled: false } } });
    await page.goto('/settings?tab=integrations', 300);
    await page.waitFor(stateIs('gitlab', 'disabled'), { label: 'gitlab off' });
    check((await page.eval(`return document.querySelectorAll('.prov-row[data-host="gitlab"] [data-action]').length`)) === 0, 'a host that is off offers no remedy');
    await api.put('/hosts/settings', savedSettings);

    // ---- A phone ----
    await api.post('/hosts/refresh');
    await page.viewport(390, 844);
    await theme(page, 'dark');
    await page.goto('/settings?tab=integrations', 300);
    await page.waitFor(`return document.querySelectorAll('.prov-cell[data-host]').length === 2`, { label: 'one cell per host' });
    check((await page.eval(overflow)) <= 0, 'the phone page does not scroll sideways');
    state('gh', { signedIn: false });
    await checkAgain();
    await page.waitFor(stateIs('github', 'signed-out'), { label: 'gh signed out on a phone' });
    const small = await page.eval(`return [...document.querySelectorAll('.prov-cell .btn, .prov-cell .host-actions a')].filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim())`);
    check(small.length === 0, `the phone targets are at least 44 px (${small.join(', ')})`);
    await page.shot('integrations-phone-dark');
    await scan(page, check, 'Settings → Integrations on a phone, dark');
    state('gh', {});
    await checkAgain();
    await page.waitFor(stateIs('github', 'ready'), { label: 'gh ready on a phone' });
    await theme(page, 'light');
    await page.goto('/settings?tab=integrations', 300);
    await page.waitFor(`return document.querySelectorAll('.prov-cell[data-host]').length === 2`, { label: 'the cells, light' });
    await page.shot('integrations-phone-light');
    await scan(page, check, 'Settings → Integrations on a phone, light');
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); return true`).catch(() => {});
    await api.put('/hosts/settings', savedSettings).catch(() => {});
    rmSync(join(stateDir, 'gh.json'), { force: true });
    rmSync(join(stateDir, 'glab.json'), { force: true });
    await api.post('/hosts/refresh').catch(() => {});
  }
};
