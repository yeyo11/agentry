// YouTrack as an issue tracker, end to end through the fake youtrack-app (e2e/fake-trackers), which
// answers in the shapes youtrack-app 1.0.3 was recorded to print and never reaches a network.
//
// 1. Settings → Integrations: YouTrack has no access yet and offers Connect. A token the instance
//    refuses is saved and said so; the right one makes the row ready, naming the account. The token
//    never comes back from the API, and the field says one is saved. On a phone the form is a sheet.
// 2. A project with no code host at all can use YouTrack: its tracker form takes the project's short
//    name and a State per column, typed by hand, and saves them.
// 3. The issues of the project are listed and imported; the bug's type and the issue's address come
//    from YouTrack. Moving the task to In progress sets the State, read back; a State the project
//    does not have is a failed sync on the task, with its reason.
// 4. Forgetting the access makes the row signed out again, and the import refuses with a reason.
//
// Every screen counts its gradient surfaces and fails over two; axe runs on the new surfaces in both
// themes.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const timeout = 300_000;

const overflow = `return document.documentElement.scrollWidth - innerWidth`;

async function scan(page, check, label) {
  await page.reduceMotion(true);
  const violations = await page.axe();
  check(violations.length === 0, `axe on ${label}: ${JSON.stringify(violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })))}`);
}

export default async ({ page, api, check, dirs }) => {
  const fakeDir = join(dirs.dataDir, 'fake-trackers');
  const root = join(dirs.workspaceDir, 'e2e-youtrack');
  let projectId = null;
  const issueState = (key) => {
    try {
      return JSON.parse(readFileSync(join(fakeDir, 'youtrack.json'), 'utf8')).issues.find((i) => i.idReadable === key)?.state ?? 'Open';
    } catch {
      return 'Open';
    }
  };
  const row = () =>
    page.eval(
      `const r = document.querySelector('[data-tracker="youtrack"]'); return r && { state: r.dataset.state, actions: [...r.querySelectorAll('[data-action]')].map((a) => a.dataset.action), text: r.textContent }`,
    );
  const press = (label) =>
    page.eval(`const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) throw new Error('no ${label} button'); b.click(); return true`);
  const gradients = () =>
    page.eval(
      `const root = document.querySelector('[role=dialog]') ?? document;
       const seen = new Set();
       for (const el of root.querySelectorAll('.btn-primary, .grad-border, .fab')) if (el.getClientRects().length) seen.add(el.closest('.split-btn') ?? el);
       for (const el of root.querySelectorAll('.grad-text')) if (!el.closest('.grad-border') && el.getClientRects().length) seen.add(el);
       return seen.size`,
    );
  const setTheme = (theme) => page.eval(`localStorage.setItem('agentry-theme', ${JSON.stringify(theme)}); return true`);
  const waitState = async (state, label) => {
    await page.waitFor(`return document.querySelector('[data-tracker="youtrack"]')?.dataset.state === ${JSON.stringify(state)}`, { timeout: 20_000, label });
  };

  try {
    rmSync(fakeDir, { recursive: true, force: true });
    await api.del('/trackers/youtrack/credentials');

    // ================= 1. Settings → Integrations =================
    await page.goto('/', 300);
    for (const theme of ['dark', 'light']) {
      await setTheme(theme);
      await page.goto('/settings?tab=integrations', 300);
      await waitState('signed-out', `[${theme}] YouTrack has no access yet`);
      const before = await row();
      check(before.actions[0] === 'connect', `[${theme}] Connect is the first action (${before.actions})`);
      check(/address of your YouTrack and a permanent token/.test(before.text), `[${theme}] the row says what is missing (${before.text.replace(/\s+/g, ' ')})`);
    }
    await setTheme('dark');
    await page.goto('/settings?tab=integrations', 300);
    await waitState('signed-out', 'the row again');
    await page.click('[data-tracker="youtrack"] [data-action="connect"]', undefined, 300);
    await page.waitFor(`return Boolean(document.querySelector('input[type=password]'))`, { label: 'the access form opens under the row' });
    await page.shot('youtrack-access-dark');
    await scan(page, check, 'the YouTrack access form, dark');
    check((await gradients()) <= 2, `the access form keeps at most two gradient surfaces (${await gradients()})`);
    await page.fill('input[type=url]', 'https://acme.youtrack.cloud/');
    await page.fill('input[type=password]', 'perm-wrong');
    await press('Check and save');
    await waitState('signed-out', 'a refused token leaves YouTrack signed out');
    await page.waitFor(`return [...document.querySelectorAll('.toast')].some((e) => /not ready/.test(e.innerText) && /did not accept the token/.test(e.innerText))`, { label: 'the toast says the token was refused' });
    check(/did not accept the token/.test((await row()).text), 'the row says the token was refused');
    const saved = (await api.get('/trackers/youtrack/credentials')).body;
    check(saved.host === 'https://acme.youtrack.cloud' && saved.tokenSet === true && !JSON.stringify(saved).includes('perm-'), `the API keeps the address, says a token is saved and never returns it (${JSON.stringify(saved)})`);
    await page.waitFor(`return document.querySelector('input[type=password]')?.placeholder.startsWith('Saved')`, { label: 'the token field says one is saved, empty' });
    await page.fill('input[type=password]', 'perm-good');
    await press('Check and save');
    await waitState('ready', 'the right token makes YouTrack ready');
    const ready = await row();
    check(/as e2e-user/.test(ready.text) && ready.text.includes('acme.youtrack.cloud'), `the ready row names the instance and the account (${ready.text.replace(/\s+/g, ' ')})`);
    await page.shot('youtrack-ready-dark');
    check(ready.actions.join() === 'connect,choose-binary', `a ready YouTrack offers Change access and Choose binary (${ready.actions})`);
    const calls = readFileSync(join(fakeDir, 'youtrack.calls'), 'utf8');
    check(!calls.includes('perm-'), 'the token never reached the program’s argv');
    await setTheme('light');
    await page.goto('/settings?tab=integrations', 300);
    await waitState('ready', '[light] ready');
    await page.click('[data-tracker="youtrack"] [data-action="connect"]', undefined, 300);
    await page.waitFor(`return Boolean(document.querySelector('input[type=password]'))`, { label: '[light] the access form opens' });
    await page.shot('youtrack-access-light');
    await scan(page, check, 'the YouTrack access form, light');
    await setTheme('dark');
    await page.viewport(390, 844);
    await page.goto('/settings?tab=integrations', 300);
    await page.waitFor(`return document.querySelector('.prov-cell[data-tracker="youtrack"]')?.dataset.state === 'ready'`, { label: 'a cell on a phone' });
    await page.click('.prov-cell[data-tracker="youtrack"] [data-action="connect"]', undefined, 300);
    await page.waitFor(`return Boolean(document.querySelector('[role=dialog] input[type=password]'))`, { label: 'on a phone the access form is a sheet' });
    const size = await page.eval(`return parseFloat(getComputedStyle(document.querySelector('[role=dialog] input[type=url]')).fontSize)`);
    check(size >= 16, `the phone's inputs are at least 16 px (${size})`);
    check((await page.eval(overflow)) <= 1, `[390px] nothing scrolls sideways (${await page.eval(overflow)}px)`);
    await page.shot('youtrack-access-phone');
    await scan(page, check, 'the YouTrack access sheet, phone');
    await page.key('Escape');
    await page.viewport(1440, 900);

    // ================= 2. A project with no code host =================
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    const project = (await api.post('/projects/import', { path: root, name: 'e2e-youtrack', template: 'software' })).body;
    projectId = project?.id ?? null;
    check(Boolean(projectId), 'the project was imported');
    await page.goto(`/?project=${encodeURIComponent(projectId)}&view=settings`, 300);
    const option = `[...document.querySelectorAll('.project-tracker-card .trk-opt')].find((o) => o.textContent.includes('YouTrack'))`;
    await page.waitFor(`return ${option}?.getAttribute('aria-disabled') === 'false'`, { timeout: 40_000, label: 'YouTrack can be chosen on a project with no code host' });
    await page.eval(`${option}.click(); return true`);
    await page.waitFor(`return document.querySelector('#project-tracker-scope')?.placeholder === 'PROJ'`, { label: 'the scope asks for the short name' });
    await page.fill('#project-tracker-scope', 'PROJ');
    const states = await page.eval(`return [...document.querySelectorAll('.trk-map-row input')].map((i) => i.value)`);
    check(states.join('|') === 'In Progress||Done', `the State names of a new project are filled in, In review left unsynced (${states.join('|')})`);
    await page.eval(`const i = document.querySelectorAll('.trk-map-row input')[1]; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Nonsense'); i.dispatchEvent(new Event('input', { bubbles: true })); return true`);
    await page.shot('youtrack-project-dark');
    await scan(page, check, 'the project tracker form with YouTrack');
    await page.click('.project-tracker-card .btn-primary', undefined, 600);
    let tracker = null;
    for (const end = Date.now() + 15_000; Date.now() < end && !tracker; ) tracker = (await api.get(`/projects/${projectId}/tracker`)).body;
    check(tracker?.id === 'youtrack' && tracker.scope === 'PROJ' && tracker.statusMap.in_progress === 'In Progress' && tracker.statusMap.in_review === 'Nonsense', `the tracker is saved (${JSON.stringify(tracker)})`);

    // ================= 3. Import and sync =================
    const listed = (await api.get(`/projects/${projectId}/tracker/issues`)).body;
    check(listed?.issues?.map((i) => i.key).join() === 'PROJ-1,PROJ-2,PROJ-3', `the unresolved issues of PROJ are listed (${JSON.stringify(listed?.issues?.map((i) => i.key))})`);
    const bug = listed.issues.find((i) => i.key === 'PROJ-1');
    check(bug?.type === 'bug' && bug.url === 'https://acme.youtrack.cloud/issue/PROJ-1' && bug.state === 'Open', `the bug type, the address and the State come from YouTrack (${JSON.stringify(bug)})`);
    const imported = (await api.post(`/projects/${projectId}/tracker/import`, { keys: ['proj-1'] })).body;
    check(imported?.imported?.[0]?.key === 'PROJ-1', `the key is taken as YouTrack writes it (${JSON.stringify(imported)})`);
    const itemId = imported.imported[0].itemId;
    await api.post(`/work-items/${itemId}/move`, { status: 'in_progress' });
    for (const end = Date.now() + 15_000; Date.now() < end && issueState('PROJ-1') !== 'In Progress'; ) await new Promise((r) => setTimeout(r, 200));
    check(issueState('PROJ-1') === 'In Progress', `moving the task set the State (${issueState('PROJ-1')})`);
    let synced = null;
    for (const end = Date.now() + 15_000; Date.now() < end && synced?.syncState !== 'synced'; ) synced = (await api.get(`/work-items/${itemId}`)).body.issues?.[0];
    check(synced?.syncState === 'synced' && synced.state === 'In Progress', `the link reads the State back (${JSON.stringify(synced)})`);
    await api.post(`/work-items/${itemId}/move`, { status: 'in_review' });
    let failed = null;
    for (const end = Date.now() + 15_000; Date.now() < end && failed?.syncState !== 'failed'; ) failed = (await api.get(`/work-items/${itemId}`)).body.issues?.[0];
    check(failed?.syncState === 'failed' && failed.syncReason === 'transition-unknown' && issueState('PROJ-1') === 'In Progress', `a State the project lacks fails with its reason and changes nothing (${JSON.stringify(failed)})`);
    const item = (await api.get(`/work-items/${itemId}`)).body;
    await page.goto(`/tasks/${encodeURIComponent(item.key)}`, 300);
    await page.waitFor(`return document.body.textContent.includes('PROJ-1')`, { timeout: 20_000, label: 'the task shows its YouTrack issue' });
    await scan(page, check, 'the task with a failed YouTrack sync');

    // ================= 4. Forget =================
    await api.del('/trackers/youtrack/credentials');
    await page.goto('/settings?tab=integrations', 300);
    await waitState('signed-out', 'forgotten access is signed out again');
    const refused = await api.get(`/projects/${projectId}/tracker/issues`);
    check(refused.status === 409, `the import refuses without access (${refused.status})`);
  } finally {
    await api.del('/trackers/youtrack/credentials').catch(() => undefined);
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
};
