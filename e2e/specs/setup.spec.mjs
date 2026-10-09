// The setup assistant (docs/plans/in-app-setup.md, docs/setup.md) end to end: its four steps, Codex
// signed in with a device code, the summary, and Codex signed out again from Settings → Providers.
//
// Codex is the fake of e2e/fake-providers, reached through the binary override run.mjs seeds. Its
// `login --device-auth` prints the recorded output and waits for `<data>/fake-providers/codex.approve`,
// which this spec writes where a person would approve the code on their phone; the readiness probe
// (`codex login status`) then reads it as signed in. Nothing here signs in to a real account.
//
// The spec leaves the sandbox as it found it: setupSeen recorded and Codex's state file removed.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 120_000;

// Parenthesised: it is spliced into `a && ${rowState(id)} === 'ready'`, and `??` may not sit unparenthesised
// beside `&&` (a SyntaxError) nor before `===`, which would bind first and compare `null` instead
const rowState = (id) => `(document.querySelector('.prov-row[data-provider="${id}"], .prov-cell[data-provider="${id}"]')?.getAttribute('data-state') ?? null)`;
const onStep = (step) => `return !!document.querySelector('.setup-page[data-setup-step="${step}"]')`;

export default async ({ page, api, check, dirs }) => {
  const stateDir = join(dirs.dataDir, 'fake-providers');
  const codexState = join(stateDir, 'codex.json');
  const approve = join(stateDir, 'codex.approve');
  mkdirSync(stateDir, { recursive: true });
  const theme = (name) => page.eval(`localStorage.setItem('agentry-theme', ${JSON.stringify(name)}); return true`);

  try {
    writeFileSync(codexState, JSON.stringify({ signedIn: false }));
    rmSync(approve, { force: true });
    await api.post('/providers/refresh');
    await api.put('/settings/app', { setupSeen: false });
    check((await api.get('/setup')).body.seen === false, 'GET /setup says the assistant is not seen');

    await page.viewport(1440, 900);
    await page.goto('/', 300);
    await theme('dark');
    await page.goto('/', 300);

    // ---- Access: the step bar, the mode, and Continue as the one primary ----
    await page.waitFor(onStep('access'), { label: 'the assistant, on Access' });
    const marks = await page.eval(`return [...document.querySelectorAll('.setup-step')].map((s) => s.className.replace('setup-step ', ''))`);
    check(JSON.stringify(marks) === JSON.stringify(['is-current', 'is-pending', 'is-pending', 'is-pending']), `four steps, the first current (${marks.join(', ')})`);
    check((await page.eval(`return document.querySelector('.setup-step.is-current')?.getAttribute('aria-current')`)) === 'step', 'the current step is named for screen readers');
    check((await page.eval(`return document.querySelectorAll('.btn-primary').length`)) === 1, 'Continue is the one primary of the page');
    check(!(await page.eval(`return !!document.querySelector('[data-action="back"]')`)), 'the first step has no Back');

    // ---- Agents: Codex signs in with a device code ----
    await page.click('[data-action="continue"]', undefined, 600);
    await page.waitFor(`return ${rowState('codex')} === 'signed-out'`, { label: 'codex signed out on the Agents step' });
    await page.click('.prov-row[data-provider="codex"] [data-action="sign-in"]', undefined, 300);
    check((await page.eval(`return document.querySelector('.prov-row[data-provider="codex"]')?.classList.contains('open')`)) === true, 'the row joins the panel under it');
    check((await page.eval(`return document.querySelector('.signin-panel [role="radiogroup"] [aria-checked="true"]')?.textContent`)) === 'Code', 'Code is chosen first');
    await page.waitFor(`return !!document.querySelector('.signin-panel .signin-device')`, { label: 'the code waiting for the person', timeout: 30_000 });
    check((await page.text('[data-testid="signin-code"]')).trim() === 'LK0N-5V0Q5', 'the code is the one the CLI printed');
    const link = await page.eval(`const a = document.querySelector('.signin-url'); return a ? { href: a.getAttribute('href'), target: a.getAttribute('target') } : null`);
    check(link?.href === 'https://auth.openai.com/codex/device' && link.target === '_blank', `the page to open is a link (${JSON.stringify(link)})`);
    check((await page.eval(`return document.querySelectorAll('.live-energy').length`)) === 1, 'the waiting code is the one live surface');
    check((await page.text('.signin-wait')).includes('Waiting for you to approve'), 'it says it is waiting');
    check(/expires in \d+:\d\d/.test(await page.text('.signin-wait .left')), 'and how long the code has left');
    await page.shot('setup-device-waiting-dark');

    // The person approves on their own device: the panel closes and the row is the answer
    writeFileSync(approve, '');
    await page.waitFor(`return !document.querySelector('.signin-panel') && ${rowState('codex')} === 'ready'`, { label: 'codex ready after the approval', timeout: 30_000 });
    check((await api.get('/providers/codex')).body.state === 'ready', 'the server reads codex as signed in');
    check((await page.text('.setup-foot')).includes('ready'), 'the foot counts what is ready');

    // ---- Code and work items: skipped ----
    await page.click('[data-action="continue"]', undefined, 600);
    await page.waitFor(onStep('code'), { label: 'the Code and work items step' });
    check((await page.eval(`return document.querySelectorAll('.prov-row[data-host]').length`)) === 2, 'GitHub and GitLab are listed');
    await page.click('[data-action="skip"]', undefined, 600);

    // ---- Done: the summary, with the skipped step marked plainly ----
    await page.waitFor(onStep('done'), { label: 'the Done step' });
    check((await page.eval(`return !!document.querySelector('.setup-step.is-skipped[data-step="code"]')`)) === true, 'the skipped step is marked skipped');
    check((await page.eval(`return !!document.querySelector('.setup-sum-row[data-tool="codex"] .badge-ok')`)) === true, 'Codex reads Ready in the summary');
    check((await page.eval(`return document.querySelectorAll('svg.il').length`)) === 1, 'Done is the one screen with an illustration');
    await page.shot('setup-done-dark');
    await theme('light');
    await page.goto('/', 300);
    await page.waitFor(onStep('access'), { label: 'the assistant again, light: a reload starts it over' });
    await page.click('[data-action="skip"]', undefined, 400);
    await page.click('[data-action="skip"]', undefined, 400);
    await page.click('[data-action="skip"]', undefined, 600);
    await page.waitFor(onStep('done'), { label: 'Done, light' });
    await page.shot('setup-done-light');

    // ---- Start: the app, and the assistant never again ----
    await page.click('[data-action="start"]', undefined, 600);
    await page.waitFor(`return !document.querySelector('.setup-page') && !!document.querySelector('.statusbar')`, { label: 'the app after Start' });
    check((await api.get('/setup')).body.seen === true, 'Start records the assistant as seen');
    await page.goto('/', 300);
    await page.waitFor(`return !!document.querySelector('.statusbar')`, { label: 'the app on the next start' });
    check(!(await page.eval(`return !!document.querySelector('.setup-page')`)), 'the assistant does not come back');

    // ---- Settings → Providers: the same panel's sign-out, after a confirmation ----
    await theme('dark');
    await page.goto('/settings?tab=providers', 300);
    await page.waitFor(`return ${rowState('codex')} === 'ready'`, { label: 'codex ready in Settings' });
    await page.click('.prov-row[data-provider="codex"] [data-action="sign-out"]', undefined, 400);
    await page.waitFor(`return !!document.querySelector('[role="dialog"] .btn-danger-solid')`, { label: 'the confirmation, destructive' });
    await page.click('[role="dialog"] .btn-danger-solid', undefined, 600);
    await page.waitFor(`return ${rowState('codex')} === 'signed-out'`, { label: 'codex signed out from Settings', timeout: 30_000 });
    check((await page.eval(`return !!document.querySelector('.prov-row[data-provider="codex"] [data-action="sign-in"]')`)) === true, 'Settings offers Sign in again');
  } finally {
    rmSync(approve, { force: true });
    rmSync(codexState, { force: true });
    await api.post('/providers/refresh').catch(() => {});
    await api.post('/setup/seen').catch(() => {});
  }
};
