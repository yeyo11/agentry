// Providers: the first-run step and Settings → Providers, on a desktop and on a phone, in both themes.
//
// The sandbox is a machine with Claude Code (the fake `claude`, first on PATH) and a Codex that is a
// fake too (e2e/fake-providers): `run.mjs` seeds `providers.json` so Codex is reached through its
// binary override, and points CODEX_HOME, GEMINI_CLI_HOME and COPILOT_HOME into the sandbox. The
// fakes read what they answer from `<data>/fake-providers/<name>.json`, so this spec makes Codex
// signed out, and Gemini and Copilot "used before" (their config home exists, their binary does not),
// without restarting the server.
//
// Gemini and Copilot are given an override that points nowhere, so a real install on the host's PATH
// cannot turn them into something else: the override is the first thing the detector looks at.
//
// What is not covered: the "nothing found" page (every provider not installed), because the fake
// `claude` is on PATH for every spec that asks for it and Claude Code cannot be made missing.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const fakeCli = true;
export const timeout = 170_000;

const NOWHERE = { codex: '/nonexistent/agentry-e2e/codex', gemini: '/nonexistent/agentry-e2e/gemini', copilot: '/nonexistent/agentry-e2e/copilot' };

const rowState = (id) => `return document.querySelector('.prov-row[data-provider="${id}"], .prov-cell[data-provider="${id}"]')?.getAttribute('data-state') ?? null`;
const ids = `return [...document.querySelectorAll('.prov-row[data-provider], .prov-cell[data-provider]')].map((r) => r.getAttribute('data-provider'))`;
const rowIs = (id, wanted) => `return (() => { ${rowState(id)} })() === ${JSON.stringify(wanted)}`;
const overflow = `return document.documentElement.scrollWidth - innerWidth`;

async function scan(page, check, label) {
  await page.reduceMotion(true);
  const violations = await page.axe();
  check(violations.length === 0, `axe on ${label}: ${JSON.stringify(violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })))}`);
}

async function theme(page, name) {
  await page.eval(`localStorage.setItem('agentry-theme', ${JSON.stringify(name)}); return true`);
}

export default async ({ page, api, check, dirs }) => {
  const sandbox = dirname(dirs.dataDir);
  const stateDir = join(dirs.dataDir, 'fake-providers');
  const homes = { codex: join(sandbox, 'codex-home'), gemini: join(sandbox, 'gemini-home', '.gemini'), copilot: join(sandbox, 'copilot-home') };
  const fakes = join(dirname(fileURLToPath(import.meta.url)), '..', 'fake-providers');
  const state = (name, value) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${name}.json`), JSON.stringify(value));
  };
  const statusOf = async (id) => (await api.get(`/providers/${id}`)).body;
  const settled = (id, wanted) => page.waitFor(`return fetch('/api/providers/${id}').then((r) => r.json()).then((s) => s.state === ${JSON.stringify(wanted)})`, { label: `${id} is ${wanted}` });
  const savedSettings = (await api.get('/providers/settings')).body;
  const savedApp = (await api.get('/settings/app')).body;
  check(savedApp.sources.providersStepSeen !== 'env', 'the sandbox leaves providersStepSeen to the settings file, so the step can be shown again');

  try {
    // ---- The sandbox: Codex signed out, Gemini and Copilot used before ----
    mkdirSync(homes.gemini, { recursive: true });
    mkdirSync(homes.copilot, { recursive: true });
    state('codex', { version: '0.50.0', signedIn: false });
    await api.put('/providers/settings', { providers: { codex: savedSettings.providers.codex, gemini: { enabled: true, binaryPath: NOWHERE.gemini }, copilot: { enabled: true, binaryPath: NOWHERE.copilot } }, order: ['claude-code', 'codex', 'gemini', 'copilot', 'opencode'], defaultProvider: null });
    await api.post('/providers/refresh');
    const codexAtStart = await statusOf('codex');
    check(codexAtStart.state === 'signed-out', `codex is signed out (${codexAtStart.state}, ${codexAtStart.reason})`);
    check((await statusOf('gemini')).state === 'used-before', `gemini is used before (${(await statusOf('gemini')).state})`);
    check((await statusOf('copilot')).state === 'used-before', 'copilot is used before');

    // ---- First run: the step stands in for the app until Continue or Skip ----
    await api.put('/settings/app', { providersStepSeen: false });
    state('codex', { version: '0.50.0', signedIn: true });
    await api.post('/providers/refresh');
    await theme(page, 'dark');
    await page.goto('/', 300);
    await page.waitFor(`return !!document.querySelector('[data-step="list"]')`, { label: 'the first-run step' });
    check((await page.eval(`return !!document.querySelector('.sidebar, #sidebar, .statusbar')`)) === false, 'the step has no shell around it');
    check((await page.text('.prov-first h1')).includes('These are the agents on your machine'), 'the step says what it found');
    const groups = await page.eval(`return [...document.querySelectorAll('.prov-group-head h2')].map((h) => h.textContent.trim())`);
    check(groups[0] === 'Ready' && groups.includes('Used before'), `the groups run from ready to used before (${groups.join(', ')})`);
    check((await page.eval(rowState('codex'))) === 'ready', 'codex is listed as ready');
    check((await page.eval(rowState('gemini'))) === 'used-before', 'gemini is listed as used before');
    const primary = await page.text('[data-action="continue"]');
    check(/^Continue with (Claude Code|Codex)$/.test(primary.trim()), `the primary action names the first ready provider (${primary})`);
    check((await page.eval(`return document.querySelectorAll('.grad, .btn-primary').length`)) >= 1, 'the primary action is drawn');

    await page.shot('providers-first-run-dark');
    await scan(page, check, 'the first-run step, dark');
    await theme(page, 'light');
    await page.goto('/', 300);
    await page.waitFor(`return !!document.querySelector('[data-step="list"]')`, { label: 'the step again, light' });
    await scan(page, check, 'the first-run step, light');
    await page.shot('providers-first-run-light');

    // Check again reads them all again and comes back
    await page.click('[data-action="recheck"]', undefined, 100);
    await page.waitFor(`return !document.querySelector('[data-step="list"]')?.hasAttribute('data-checking') && !!document.querySelector('[data-action="continue"]')`, { label: 'the re-check ends' });

    // Continue saves the step as seen and lets the app in
    await page.click('[data-action="continue"]', undefined, 600);
    await page.waitFor(`return !document.querySelector('[data-step]') && !!document.querySelector('.statusbar')`, { label: 'the app after Continue' });
    check((await api.get('/settings/app')).body.providersStepSeen === true, 'Continue records the step as seen');
    await page.goto('/', 300);
    await page.waitFor(`return !!document.querySelector('.statusbar')`, { label: 'the app on the next start' });
    check(!(await page.eval(`return !!document.querySelector('[data-step]')`)), 'the step does not come back once seen, with a provider ready');
    // The status bar has a dot per provider, each a link to Settings → Providers
    const dots = await page.eval(`return [...document.querySelectorAll('.statusbar a[href="/settings?tab=providers"]')].map((a) => a.getAttribute('aria-label'))`);
    check(dots.some((d) => d?.startsWith('Codex')) && dots.some((d) => d?.startsWith('Gemini CLI')), `the status bar has a dot for each provider that is there (${dots.join('; ')})`);

    // Skip: the same, without naming a provider
    await api.put('/settings/app', { providersStepSeen: false });
    await page.goto('/', 300);
    await page.click('[data-action="skip"]', undefined, 600);
    await page.waitFor(`return !document.querySelector('[data-step]') && !!document.querySelector('.statusbar')`, { label: 'the app after Skip' });
    check((await api.get('/settings/app')).body.providersStepSeen === true, 'Skip records the step as seen');

    // The first-run step on a phone: stacked, 44 px buttons, and nothing scrolls sideways
    await api.put('/settings/app', { providersStepSeen: false });
    await page.viewport(390, 844);
    await theme(page, 'dark');
    await page.goto('/', 300);
    await page.waitFor(`return !!document.querySelector('.prov-first-foot')`, { label: 'the phone step' });
    const short = await page.eval(`return [...document.querySelectorAll('.prov-first-foot .btn')].filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim())`);
    check(short.length === 0, `the buttons of the phone step are at least 44 px tall (${short.join(', ')})`);
    check((await page.eval(`return document.querySelectorAll('.prov-cell').length`)) >= 2, 'the phone step lists the providers as cells');
    check((await page.eval(overflow)) <= 0, 'the phone step does not scroll sideways');
    await scan(page, check, 'the phone first-run step, dark');
    await theme(page, 'light');
    await page.goto('/', 300);
    await page.waitFor(`return !!document.querySelector('.prov-first-foot')`, { label: 'the phone step, light' });
    await scan(page, check, 'the phone first-run step, light');
    await api.put('/settings/app', { providersStepSeen: true });

    // ---- Settings → Providers on a desktop ----
    await page.viewport(1440, 900);
    await theme(page, 'dark');
    await page.goto('/settings?tab=providers', 300);
    await page.waitFor(`return document.querySelectorAll('.prov-row[data-provider]').length === 4`, { label: 'the four rows' });
    check(JSON.stringify(await page.eval(ids)) === JSON.stringify(['claude-code', 'codex', 'gemini', 'copilot', 'opencode']), 'the rows follow the order of providers.json');
    check((await page.eval(rowState('codex'))) === 'ready', 'codex is ready');
    check((await page.eval(rowState('gemini'))) === 'used-before' && (await page.eval(rowState('copilot'))) === 'used-before', 'gemini and copilot are used before');
    check((await page.eval(`return document.querySelectorAll('.card.grad-border').length`)) === 1, 'the list is the screen\'s one gradient surface');
    await page.shot('providers-settings-dark');
    await scan(page, check, 'Settings → Providers, dark');
    await theme(page, 'light');
    await page.goto('/settings?tab=providers', 300);
    await page.waitFor(`return document.querySelectorAll('.prov-row[data-provider]').length === 4`, { label: 'the rows, light' });
    await scan(page, check, 'Settings → Providers, light');
    await page.shot('providers-settings-light');
    await theme(page, 'dark');
    await page.goto('/settings?tab=providers', 300);
    await page.waitFor(`return document.querySelectorAll('.prov-row[data-provider]').length === 4`, { label: 'the rows, dark again' });

    // States follow the machine: Codex signs out in a terminal, and the page learns it without a click
    state('codex', { version: '0.50.0', signedIn: false });
    await page.click('.prov-toolbar .btn', undefined, 200);
    await page.waitFor(rowIs('codex', 'signed-out'), { label: 'codex signed out on the page' });
    check((await page.text('.prov-row[data-provider="codex"] .prov-actions')).includes('Sign in'), 'a signed-out provider offers Sign in');
    check((await page.text('.prov-checked')).startsWith('Checked'), 'the page says when it checked');
    state('codex', { version: '0.50.0', signedIn: true });
    await page.click('.prov-toolbar .btn', undefined, 200);
    await page.waitFor(rowIs('codex', 'ready'), { label: 'codex ready again' });

    // The switch turns a provider off: it is shown as off and its remedies go
    await page.click('[aria-label="Turn off Copilot"]', undefined, 600);
    check((await api.get('/providers/settings')).body.providers.copilot.enabled === false, 'the switch saves the provider as off');
    await page.waitFor(rowIs('copilot', 'disabled'), { label: 'copilot shown as off' });
    check((await page.eval(`return document.querySelector('.prov-row[data-provider="copilot"] .prov-actions')?.children.length ?? 0`)) === 0, 'a provider that is off offers no remedy');
    await page.click('[aria-label="Turn on Copilot"]', undefined, 600);
    check((await api.get('/providers/settings')).body.providers.copilot.enabled === true, 'and back on');

    // Reorder from the keyboard: the arrow keys on the handle
    await page.focus('.prov-row[data-provider="codex"] .prov-grip');
    await page.press('ArrowUp');
    await page.waitFor(`return fetch('/api/providers/settings').then((r) => r.json()).then((s) => s.order[0] === 'codex')`, { label: 'codex moved up' });
    check(JSON.stringify(await page.eval(ids)) === JSON.stringify(['codex', 'claude-code', 'gemini', 'copilot', 'opencode']), 'the list shows the new order');
    // ...and by dragging the handle: the events a drag makes, on the row and the list
    await page.eval(`
      const grip = document.querySelector('.prov-row[data-provider="copilot"] .prov-grip');
      const list = document.querySelector('.prov-list');
      const top = document.querySelector('.prov-row').getBoundingClientRect().top + 2;
      const data = new DataTransfer();
      const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientY: top }));
      const tick = () => new Promise((r) => setTimeout(r, 120));
      fire(grip, 'dragstart'); await tick();
      fire(list, 'dragover'); await tick();
      fire(list, 'drop'); await tick();
      return true;`);
    await page.waitFor(`return fetch('/api/providers/settings').then((r) => r.json()).then((s) => s.order[0] === 'copilot')`, { label: 'copilot dragged to the top' });
    check(JSON.stringify(await page.eval(ids)) === JSON.stringify(['copilot', 'codex', 'claude-code', 'gemini', 'opencode']), 'the drop puts the row where the line was');

    // The default provider: a choice, and back to Automatic
    await page.select('.prov-default-select', 'Codex');
    check((await api.get('/providers/settings')).body.defaultProvider === 'codex', 'the default provider is saved');
    await page.select('.prov-default-select', 'Automatic (the first ready)');
    check((await api.get('/providers/settings')).body.defaultProvider === null, 'Automatic saves no default');

    // The binary override. Codex is made "used before" too (an override that points nowhere, and a config home)
    mkdirSync(homes.codex, { recursive: true });
    await api.put('/providers/settings', { ...(await api.get('/providers/settings')).body, providers: { ...(await api.get('/providers/settings')).body.providers, codex: { enabled: true, binaryPath: NOWHERE.codex } } });
    await api.post('/providers/refresh');
    await page.goto('/settings?tab=providers', 300);
    await page.waitFor(rowIs('codex', 'used-before'), { label: 'codex used before' });

    // A program that fails its version check is refused, and the earlier path stays
    state('copilot', { version: '0.0.1', versionExit: 3 });
    await page.click('.prov-row[data-provider="copilot"] [data-action="choose-binary"]', undefined, 400);
    await page.fill('.prov-bin input', join(fakes, 'copilot'));
    await page.click('.prov-bin .btn', 'Check and save', 300);
    await page.waitFor(`return !!document.querySelector('.prov-bin .field-error')`, { label: 'the refusal' });
    check((await page.text('.prov-bin .field-error')).startsWith('Not saved.'), 'a program that fails its version check is not saved');
    check((await api.get('/providers/settings')).body.providers.copilot.binaryPath === NOWHERE.copilot, 'the earlier path is put back');
    await page.click('.prov-bin .btn', 'Cancel', 300);
    check(await page.eval(`return !document.querySelector('.prov-bin')`), 'Cancel closes the editor');

    // So is one whose sign-in nothing can read for free: Gemini has no probe, and readiness says so
    await page.click('.prov-row[data-provider="gemini"] [data-action="choose-binary"]', undefined, 400);
    await page.fill('.prov-bin input', join(fakes, 'gemini'));
    await page.click('.prov-bin .btn', 'Check and save', 300);
    await page.waitFor(`return !!document.querySelector('.prov-bin .field-error')`, { label: 'the refusal of a program with no probe' });
    check((await api.get('/providers/settings')).body.providers.gemini.binaryPath === NOWHERE.gemini, 'gemini keeps its earlier path too');
    await page.click('.prov-bin .btn', 'Cancel', 300);

    // A working one is kept, and the row leaves "used before"
    await page.click('.prov-row[data-provider="codex"] [data-action="choose-binary"]', undefined, 400);
    await page.fill('.prov-bin input', join(fakes, 'codex'));
    await page.click('.prov-bin .btn', 'Check and save', 300);
    await page.waitFor(rowIs('codex', 'ready'), { label: 'codex ready through its new path' });
    const codex = await statusOf('codex');
    check(codex.binaryPath === join(fakes, 'codex') && codex.version === '0.50.0', `codex reads the version of the program it was given (${JSON.stringify(codex)})`);
    check((await api.get('/providers/settings')).body.providers.codex.binaryPath === join(fakes, 'codex'), 'and the path is saved');
    check(await page.eval(`return !document.querySelector('.prov-bin')`), 'the editor closes once it is saved');

    // "Use the one on PATH" takes the override away
    await page.click('.prov-row[data-provider="copilot"] [data-action="choose-binary"]', undefined, 400);
    await page.click('.prov-bin .btn', 'Use the one on PATH', 600);
    check((await api.get('/providers/settings')).body.providers.copilot.binaryPath === null, 'Use the one on PATH clears the override');

    // ---- The same page on a phone ----
    await api.put('/providers/settings', { providers: { codex: savedSettings.providers.codex, gemini: { enabled: true, binaryPath: NOWHERE.gemini }, copilot: { enabled: true, binaryPath: NOWHERE.copilot } }, order: ['claude-code', 'codex', 'gemini', 'copilot'], defaultProvider: null });
    await api.post('/providers/refresh');
    await page.viewport(390, 844);
    await theme(page, 'dark');
    await page.goto('/settings?tab=providers', 300);
    await page.waitFor(`return document.querySelectorAll('.prov-cell[data-provider]').length === 4`, { label: 'the four cells' });
    check((await page.eval(overflow)) <= 0, 'the phone page does not scroll sideways');
    const small = await page.eval(`return [...document.querySelectorAll('.prov-cell .btn, .prov-order-cell')].filter((b) => b.getBoundingClientRect().height < 44).map((b) => (b.getAttribute('aria-label') || b.textContent).trim())`);
    check(small.length === 0, `the phone targets are at least 44 px (${small.join(', ')})`);
    check((await page.eval(`return !!document.querySelector('.prov-grip')`)) === false, 'the phone has no drag handle');
    await page.shot('providers-settings-phone-dark');
    await scan(page, check, 'Settings → Providers on a phone, dark');

    // Default and order: a sheet, nothing saved until Save
    await page.click('.prov-order-cell', undefined, 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] [role=radiogroup]')`, { label: 'the order sheet' });
    await page.click('[role=dialog] [aria-label="Move Codex up"]', undefined, 200);
    check(JSON.stringify((await api.get('/providers/settings')).body.order) === JSON.stringify(['claude-code', 'codex', 'gemini', 'copilot']), 'moving inside the sheet saves nothing yet');
    await scan(page, check, 'the order sheet, dark');
    await page.click('[role=dialog] .btn-primary', 'Save', 600);
    await page.waitFor(`return fetch('/api/providers/settings').then((r) => r.json()).then((s) => s.order[0] === 'codex')`, { label: 'Save writes the order' });

    // Choose binary in a sheet
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the sheet closed' });
    await page.click('.prov-cell[data-provider="gemini"] [data-action="choose-binary"]', undefined, 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .prov-sheet-body input')`, { label: 'the binary sheet' });
    check((await page.eval(`return document.querySelector('[role=dialog] .prov-sheet-body input').getBoundingClientRect().height >= 44 && parseFloat(getComputedStyle(document.querySelector('[role=dialog] .prov-sheet-body input')).fontSize) >= 16`)), 'the field is 44 px tall at 16 px, so the phone does not zoom');
    await scan(page, check, 'the binary sheet, dark');
    await page.key('Escape');
    await theme(page, 'light');
    await page.goto('/settings?tab=providers', 300);
    await page.waitFor(`return document.querySelectorAll('.prov-cell[data-provider]').length === 4`, { label: 'the cells, light' });
    await scan(page, check, 'Settings → Providers on a phone, light');
    await page.shot('providers-settings-phone-light');
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); return true`).catch(() => {});
    await api.put('/providers/settings', savedSettings).catch(() => {});
    await api.put('/settings/app', { providersStepSeen: true }).catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(join(sandbox, 'gemini-home'), { recursive: true, force: true });
    rmSync(homes.codex, { recursive: true, force: true });
    rmSync(homes.copilot, { recursive: true, force: true });
    await api.post('/providers/refresh').catch(() => {});
  }
};
