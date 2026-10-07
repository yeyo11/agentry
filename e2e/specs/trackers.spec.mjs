// Issue trackers (GitHub Issues, GitLab Issues), end to end through the fake gh and glab
// (e2e/fake-hosts) and the fake claude (e2e/fake-cli): every piece of the web for trackers is reached
// from a screen, in both themes and on a phone.
//
// Reference screens: DesktopIntegracionesTrackers*, MobileIntegracionesTrackers*, DesktopProyectoTracker*,
// MobileProyectoTracker*, DesktopImportarIssues, MobileImportarIssues*, DesktopTableroIssues,
// MobileTableroIssues, DesktopTareaIssues* and MobileTareaIssues*. With E2E_SHOTS set the screens are
// saved for comparing them with the reference screenshots.
//
// 1. Settings → Integrations: four tracker rows. GitHub Issues and GitLab Issues are ready and offer
//    only "Choose binary"; YouTrack has no access saved yet and offers "Connect" (youtrack.spec.mjs
//    walks it). Jira is not a tracker.
// 2. A project whose origin is a GitHub repository: its tracker form refuses the trackers that cannot
//    work (GitLab's, YouTrack without its access), takes GitHub Issues with the repository filled in, saves, and
//    reads back after a reload. On a phone the form is a sheet.
// 3. The Tasks page: "Import issues" opens the dialog with the project's query. One issue is already
//    an item and is marked, not pickable; `issue.triage` (the fake claude) marks the rest; two are
//    imported into work items whose description is the quoted source block. A stranger's HTML is
//    text everywhere. On a phone choosing issues is a mode and nothing has a checkbox.
// 4. The item's chips and the card's key; a close the host refuses is a failed sync, shown on the
//    chip, the panel and the done card, and "Sync again" closes the issue for real.
// 5. A GitLab project: the same screens with GitLab's own words and glab's calls.
//
// Every screen counts all its gradient surfaces (a primary button, a gradient border, gradient text, the
// FAB; the split New chat button counts once) and fails over two. Axe runs on each new surface in both
// themes, at full contrast.
//
// What is not covered: "Show more" (it needs more than a page of issues, and the fake has six), a
// tracker's binary override (integrations.spec.mjs walks the same editor for the hosts), and the status
// sync that follows a merge (the core suite covers it against the same fake).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 420_000;

const GH_ORIGIN = 'https://github.com/acme/shop.git';
const GL_ORIGIN = 'https://gitlab.com/acme/shop.git';
const POINT = 'issue.triage';
const overflow = `return document.documentElement.scrollWidth - innerWidth`;

function git(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
}

async function scan(page, check, label) {
  await page.reduceMotion(true);
  const violations = await page.axe();
  check(violations.length === 0, `axe on ${label}: ${JSON.stringify(violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })))}`);
}

export default async ({ page, api, check, dirs }) => {
  const stateDir = join(dirs.dataDir, 'fake-hosts');
  const ghRoot = join(dirs.workspaceDir, 'e2e-trackers-gh');
  const glRoot = join(dirs.workspaceDir, 'e2e-trackers-gl');
  const projects = [];
  const state = (name, value) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${name}.json`), JSON.stringify(value));
  };
  const calls = (name) => {
    try {
      return readFileSync(join(stateDir, `${name}.calls`), 'utf8').split('\n');
    } catch {
      return [];
    }
  };
  const closed = (name) => {
    try {
      return readFileSync(join(stateDir, `${name}.issues-closed`), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const resetFakes = () => {
    for (const name of ['gh', 'glab']) {
      for (const file of [`${name}.json`, `${name}.issues-closed`, `${name}.calls`]) rmSync(join(stateDir, file), { force: true });
    }
  };
  const repository = (root, origin) => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'e2e@example.com');
    git(root, 'config', 'user.name', 'e2e');
    writeFileSync(join(root, 'README.md'), '# shop\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'first commit');
    git(root, 'remote', 'add', 'origin', origin);
  };
  const setTheme = (theme) => page.eval(`localStorage.setItem('agentry-theme', ${JSON.stringify(theme)}); return true`);
  // The items of a project that came from the given issue keys, with the issue each one is linked to
  const itemsOf = async (projectId, keys) => {
    const cards = (await api.get(`/projects/${projectId}/work-items`)).body;
    const found = [];
    for (const key of keys) {
      const card = (Array.isArray(cards) ? cards : cards.items ?? []).find((i) => i.issues?.some((x) => x.key === key));
      if (card) found.push({ key, item: card });
    }
    return found;
  };
  const text = (selector) => page.eval(`return document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
  // Every gradient surface of the screen, whatever draws it. The split New chat button is one surface drawn as two buttons.
  const gradients = () =>
    page.eval(
      `// With a dialog open, the page behind it is dimmed and inert: what the person sees lit is the dialog's
       const root = document.querySelector('[role=dialog]') ?? document;
       const seen = new Set();
       const list = [];
       // A surface the person cannot see (the phone's FAB on a desktop, hidden by CSS) is not drawn: it does not count
       const add = (el, kind) => {
         if (seen.has(el) || getComputedStyle(el).display === 'none' || el.getClientRects().length === 0) return;
         seen.add(el);
         list.push({ kind, text: el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 40) });
       };
       for (const b of root.querySelectorAll('.btn-primary')) add(b.closest('.split-btn') ?? b, 'button');
       for (const el of root.querySelectorAll('.grad-border')) add(el, 'border');
       for (const el of root.querySelectorAll('.grad-text')) if (!el.closest('.grad-border')) add(el, 'text');
       for (const el of root.querySelectorAll('.fab')) add(el, 'fab');
       return list`,
    );
  const atMostTwo = async (label) => {
    const every = await gradients();
    check(every.length <= 2, `${label}: at most two gradient surfaces (${JSON.stringify(every)})`);
    return every;
  };
  // The project's settings tabs each carry their own Save (General, Decisions and now Tracker), so the page as a whole is
  // not the tracker's to fix: what the tracker's own card adds is, and it is one
  const trackerCardGradients = async (label) => {
    const own = await page.eval(`return [...document.querySelectorAll('.project-tracker-card .btn-primary')].map((b) => b.textContent.trim())`);
    check(own.length <= 1, `${label}: the tracker card adds at most one gradient surface (${JSON.stringify(own)})`);
  };
  const press = (scope, label) =>
    page.eval(`const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) throw new Error('no ${label} button in ${scope}'); b.click(); return true`);
  const closeDialog = async () => {
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the dialog closes' });
  };

  const triageInfo = (await api.get('/decisions/points')).body.find((p) => p.id === POINT);
  const triageSettings = async (mode) => {
    const { jev, ...rest } = (await api.get('/decisions/settings')).body;
    await api.put('/decisions/settings', { ...rest, points: { ...rest.points, [POINT]: { mode, threshold: triageInfo.defaultThreshold, consent: null } } });
  };

  try {
    check(Boolean(triageInfo), `${POINT} is a decision point of the build`);
    resetFakes();
    state('gh', {});
    state('glab', {});
    await api.post('/hosts/refresh');
    await api.post('/trackers/refresh');

    // ================= 1. Settings → Integrations =================
    await page.goto('/', 300);
    for (const theme of ['dark', 'light']) {
      await setTheme(theme);
      await page.goto('/settings?tab=integrations', 300);
      await page.waitFor(`return document.querySelectorAll('.prov-row[data-tracker]').length === 3`, { label: `[${theme}] one row per tracker` });
      const rows = await page.eval(
        `return [...document.querySelectorAll('.prov-row[data-tracker]')].map((r) => ({ id: r.dataset.tracker, state: r.dataset.state, actions: [...r.querySelectorAll('[data-action]')].map((a) => a.dataset.action), text: r.textContent }))`,
      );
      check(rows.map((r) => r.id).join() === 'github-issues,gitlab-issues,youtrack', `[${theme}] the trackers come in the order GitHub, GitLab, YouTrack (${rows.map((r) => r.id)})`);
      const [github, gitlab, youtrack] = rows;
      check(github.state === 'ready' && gitlab.state === 'ready', `[${theme}] GitHub Issues and GitLab Issues are ready (${github.state}, ${gitlab.state})`);
      check(github.actions.join() === 'choose-binary' && gitlab.actions.join() === 'choose-binary', `[${theme}] a ready tracker offers only Choose binary (${github.actions}; ${gitlab.actions})`);
      check(github.text.includes('#12') && gitlab.text.includes('#12'), `[${theme}] each row says how its issues are numbered`);
      check(youtrack.state === 'signed-out' && youtrack.actions.join() === 'connect,choose-binary', `[${theme}] YouTrack has no access yet and offers Connect first (${youtrack.state}; ${youtrack.actions})`);
      check(youtrack.text.includes('PROJ-12'), `[${theme}] YouTrack says how its issues are numbered`);
      await atMostTwo(`[${theme}] Integrations`);
      await page.shot(`trackers-integrations-${theme}`);
      await scan(page, check, `Settings → Integrations with the trackers, ${theme}`);
    }
    await setTheme('dark');
    await page.viewport(390, 844);
    await page.goto('/settings?tab=integrations', 300);
    await page.waitFor(`return document.querySelectorAll('.prov-cell[data-tracker]').length === 3`, { label: 'a cell per tracker on a phone' });
    check((await page.eval(overflow)) <= 1, `[390px Integrations] nothing scrolls sideways (${await page.eval(overflow)}px)`);
    await atMostTwo('[390px] Integrations');
    await page.shot('trackers-integrations-phone');
    await scan(page, check, 'Settings → Integrations with the trackers, on a phone');
    await page.viewport(1440, 900);

    // ================= 2. The project's tracker =================
    repository(ghRoot, GH_ORIGIN);
    const gh = (await api.post('/projects/import', { path: ghRoot, name: 'e2e-trackers-gh', template: 'software' })).body;
    check(Boolean(gh?.id), 'the GitHub project was imported');
    projects.push(gh.id);
    check((await api.get(`/projects/${gh.id}/tracker`)).body === null, 'a new project has no tracker');
    const settingsUrl = `/?project=${encodeURIComponent(gh.id)}&view=settings`;
    const option = (label) => `[...document.querySelectorAll('.project-tracker-card .trk-opt')].find((o) => o.textContent.includes(${JSON.stringify(label)}))`;

    await page.goto(settingsUrl, 300);
    await page.waitFor(`return document.querySelectorAll('.project-tracker-card .trk-opt').length === 4`, { timeout: 40_000, label: 'three trackers and None to choose from' });
    const disabled = await page.eval(`return { gitlab: ${option('GitLab Issues')}?.getAttribute('aria-disabled'), youtrack: ${option('YouTrack')}?.getAttribute('aria-disabled'), github: ${option('GitHub Issues')}?.getAttribute('aria-disabled') }`);
    check(disabled.github === 'false', `GitHub Issues can be chosen on a GitHub project (${JSON.stringify(disabled)})`);
    check(disabled.gitlab === 'true' && disabled.youtrack === 'true', `GitLab Issues (another host) and YouTrack without its access cannot (${JSON.stringify(disabled)})`);
    check((await page.eval(`return ${option('GitLab Issues')}.textContent`)).includes('github.com'), "GitLab Issues says why: this project's host");
    check(!(await page.eval(`return document.querySelector('.project-tracker-card').textContent`)).includes('Jira'), 'Jira is not offered');
    await page.eval(`${option('GitHub Issues')}.click(); return true`);
    await page.waitFor(`return document.querySelector('#project-tracker-scope')?.value === 'acme/shop'`, { label: 'choosing GitHub Issues fills in the origin repository' });
    await page.fill('#project-tracker-query', 'is:open');
    await trackerCardGradients('[dark] project settings with the tracker form');
    await page.shot('trackers-project-dark');
    await scan(page, check, 'the project tracker form, dark');
    await page.click('.project-tracker-card .btn-primary', undefined, 600);
    let saved = null;
    for (const end = Date.now() + 15_000; Date.now() < end; ) {
      saved = (await api.get(`/projects/${gh.id}/tracker`)).body;
      if (saved) break;
      await page.sleep(300);
    }
    check(saved?.id === 'github-issues' && saved.scope === 'acme/shop' && saved.query === 'is:open' && saved.statusMap?.done === 'completed', `Save writes the tracker, with Done mapped to completed (${JSON.stringify(saved)})`);
    await setTheme('light');
    await page.goto(settingsUrl, 300);
    await page.waitFor(`return !!document.querySelector('.project-tracker-card .trk-opt.on')`, { timeout: 40_000, label: 'the saved tracker is read back' });
    const back = await page.eval(`return { on: document.querySelector('.project-tracker-card .trk-opt.on').textContent, scope: document.querySelector('#project-tracker-scope')?.value, query: document.querySelector('#project-tracker-query')?.value }`);
    check(back.on.includes('GitHub Issues') && back.scope === 'acme/shop' && back.query === 'is:open', `the form reads back what was saved (${JSON.stringify(back)})`);
    await trackerCardGradients('[light] project settings with the tracker form');
    await page.shot('trackers-project-light');
    await scan(page, check, 'the project tracker form, light');
    await setTheme('dark');

    await page.viewport(390, 844);
    await page.goto(settingsUrl, 300);
    await page.waitFor(`return [...document.querySelectorAll('.settings-cell')].some((c) => c.textContent.includes('Issues'))`, { timeout: 40_000, label: 'the tracker is a cell on a phone' });
    await page.click('.settings-cell', 'Issues', 500);
    await page.waitFor(`return document.querySelectorAll('[role=dialog] .trk-opt').length === 5`, { label: 'the phone sheet lists the trackers and None' });
    check((await page.eval(`return [...document.querySelectorAll('[role=dialog] .trk-opt')].every((o) => o.getBoundingClientRect().height >= 44)`)) === true, 'each tracker choice is a 44 px target');
    check((await page.eval(overflow)) <= 1, `[390px project tracker] nothing scrolls sideways (${await page.eval(overflow)}px)`);
    await trackerCardGradients('[390px] the project tracker sheet');
    await page.shot('trackers-project-phone');
    await scan(page, check, 'the project tracker sheet, on a phone');
    await closeDialog();
    await page.viewport(1440, 900);

    // ================= 3. Import =================
    // One issue is already an item: it comes in through the API, as the person's earlier import would have
    const first = (await api.post(`/projects/${gh.id}/tracker/import`, { keys: ['31'] })).body;
    check(first.imported?.length === 1 && first.imported[0].key === '31', `#31 was imported (${JSON.stringify(first)})`);
    const quoted = (await api.get(`/work-items/${first.imported[0].itemId}`)).body;
    check(quoted.description?.startsWith('> **From GitHub Issues #31**') && quoted.description.includes('> Steps:'), `the issue's text is a quoted source block under its origin (${JSON.stringify(quoted.description?.slice(0, 80))})`);
    check(quoted.type === 'bug', `a bug label makes the item a bug (${quoted.type})`);

    // issue.triage on: the fake claude marks the issues in the order asked
    await api.put(`/decisions/points/${POINT}/consent`, { granted: true, stateVersion: triageInfo.stateVersion, providers: ['cli'] });
    await triageSettings('shadow');
    const listed = (await api.get(`/projects/${gh.id}/tracker/issues`)).body;
    check(listed.issues.map((i) => i.key).join() === '31,32,33,34' && listed.issues[0].importedItemId === quoted.id, `the list says which issue is already an item (${listed.issues.map((i) => `${i.key}:${i.importedItemId ? 'item' : '-'}`)})`);
    let answered = null;
    for (const end = Date.now() + 40_000; Date.now() < end; ) {
      answered = (await api.get(`/decisions?point=${POINT}`)).body?.items?.[0];
      if (answered) break;
      await page.sleep(300);
    }
    check(answered?.answers?.['32']?.value === 'ready' && answered.answers['33']?.value === 'needs-refining' && answered.answers['34']?.value === 'not-for-agents', `issue.triage marked the issues that are not items yet (${JSON.stringify(answered?.answers)})`);

    const board = `/tasks?project=${encodeURIComponent(gh.id)}`;
    for (const theme of ['dark', 'light']) {
      await setTheme(theme);
      await page.goto(board, 300);
      await page.waitFor(`return !!document.querySelector('.workitem-import')`, { timeout: 40_000, label: `[${theme}] Import issues is in the Tasks header` });
      check((await page.eval(`return document.querySelector('.workitem-import').classList.contains('btn-primary')`)) === false, `[${theme}] Import issues is neutral on a board that has items`);
      await atMostTwo(`[${theme}] the Tasks page`);
      await page.click('.workitem-import', undefined, 400);
      await page.waitFor(`return document.querySelectorAll('[role=dialog] .addr-thread').length === 4`, { timeout: 40_000, label: `[${theme}] the dialog lists the four open issues` });
      const dialog = await page.eval(
        `const d = document.querySelector('[role=dialog]');
         const rows = [...d.querySelectorAll('.addr-thread')].map((r) => ({ text: r.textContent.replace(/\\s+/g, ' '), imported: r.classList.contains('imported'), box: !!r.querySelector('[role=checkbox], input[type=checkbox]') || r.getAttribute('role') === 'checkbox' }));
         return { title: d.textContent, query: d.querySelector('.iss-search input')?.value, rows, primaries: d.querySelectorAll('.btn-primary').length, marks: [...d.querySelectorAll('.addr-thread .badge')].map((b) => b.textContent.trim()), titleHtml: !!d.querySelector('.iss-title b, .iss-title img') }`,
      );
      check(dialog.title.includes('Import issues from GitHub Issues'), `[${theme}] the dialog names the tracker`);
      check(dialog.query === 'is:open', `[${theme}] the search starts from the project's own query (${dialog.query})`);
      check(dialog.rows[0].imported && dialog.rows[0].text.includes('#31') && dialog.rows[0].text.includes('already imported') && !dialog.rows[0].box, `[${theme}] the issue that is already an item is marked, with no box (${dialog.rows[0].text})`);
      check(dialog.rows.slice(1).every((r) => !r.imported), `[${theme}] the others can be chosen`);
      check(['ready', 'needs refining', 'not for agents'].every((m) => dialog.marks.includes(m)), `[${theme}] issue.triage's marks are shown, with words (${dialog.marks})`);
      check(dialog.title.includes('suggested · issue.triage'), `[${theme}] the marks say where they come from`);
      check(!dialog.titleHtml && dialog.rows[3].text.includes('<b>now</b>'), `[${theme}] an issue's HTML is text, not an element (${dialog.rows[3].text})`);
      check(dialog.primaries === 1, `[${theme}] Import is the dialog's one gradient action (${dialog.primaries})`);
      await atMostTwo(`[${theme}] the import dialog`);
      await page.shot(`trackers-import-${theme}`);
      await scan(page, check, `the import dialog, ${theme}`);
      await closeDialog();
    }

    await setTheme('dark');
    await page.goto(board, 300);
    await page.click('.workitem-import', undefined, 400);
    await page.waitFor(`return document.querySelectorAll('[role=dialog] .addr-thread').length === 4`, { timeout: 40_000, label: 'the dialog, to import' });
    check((await page.eval(`return [...document.querySelectorAll('[role=dialog] .btn-primary')].every((b) => b.disabled)`)) === true, 'Import is off until something is chosen');
    await page.click('[role=dialog] .addr-thread:not(.imported)', undefined, 200);
    await page.eval(`document.querySelectorAll('[role=dialog] .addr-thread:not(.imported)')[1].click(); return true`);
    await page.waitFor(`return /Import 2 issues/.test(document.querySelector('[role=dialog] .btn-primary')?.textContent ?? '')`, { label: 'the button counts what is chosen' });
    await page.click('[role=dialog] .btn-primary', undefined, 500);
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { timeout: 40_000, label: 'the dialog closes once the issues are imported' });
    const imported = await itemsOf(gh.id, ['31', '32', '33', '34']);
    check(imported.map((i) => i.key).join() === '31,32,33', `two issues became two work items beside the first (${imported.map((i) => i.key)})`);
    const second = (await api.get(`/work-items/${imported[1].item.id}`)).body;
    check(second.description?.startsWith('> **From GitHub Issues #32**') && second.description.includes('> Add a coupon code field'), `#32's text is the quoted source block (${JSON.stringify(second.description?.slice(0, 90))})`);
    check(second.status === 'backlog' && second.title === 'Add a coupon field to the checkout', `it is in the backlog under the issue's own title (${second.status}, ${second.title})`);
    check((await api.get(`/work-items/${imported[2].item.id}`)).body.type === 'bug', '#33 is a bug');
    await page.waitFor(`return [...document.querySelectorAll('.iss-fact')].some((f) => f.textContent.includes('#32'))`, { timeout: 40_000, label: 'the board card says which issue it came from' });
    await page.shot('trackers-board-dark');
    await atMostTwo('[dark] the board after the import');

    // Open it again: all three are items now, and only one can be chosen
    await page.click('.workitem-import', undefined, 400);
    await page.waitFor(`return document.querySelectorAll('[role=dialog] .addr-thread.imported').length === 3`, { timeout: 40_000, label: 'three issues are marked as imported' });
    check((await page.eval(`return document.querySelectorAll('[role=dialog] .addr-thread:not(.imported)').length`)) === 1, 'only #34 can still be chosen');
    check(/[A-Z]+-\d+/.test(await text('[role=dialog] .addr-thread.imported')), 'an imported row names the item it became');
    await closeDialog();
    check(calls('gh').some((l) => /^issue list -R github\.com\/acme\/shop --state open .*--search is:open /.test(l)), `gh was asked with the project's repository and query (${calls('gh').filter((l) => l.startsWith('issue list')).slice(0, 1)})`);

    // A phone: choosing is a mode, and nothing has a checkbox
    await page.viewport(390, 844);
    await page.goto(board, 300);
    await page.waitFor(`return !!document.querySelector('.workitem-import-icon')`, { timeout: 40_000, label: 'the phone has Import issues as an icon' });
    check((await page.eval(`return document.querySelector('.fab') ? true : false`)) === true, 'the phone keeps its FAB');
    await atMostTwo('[390px] the Tasks page');
    await page.click('.workitem-import-icon', undefined, 500);
    await page.waitFor(`return document.querySelectorAll('[role=dialog] .addr-thread').length === 4`, { timeout: 40_000, label: 'the phone sheet lists the issues' });
    check((await page.eval(`return document.querySelectorAll('[role=dialog] [role=checkbox], [role=dialog] input[type=checkbox]').length`)) === 0, 'no checkbox is shown on a phone');
    check((await page.eval(`return document.querySelectorAll('[role=dialog] button.addr-thread').length`)) === 0, 'browsing is plain text until the person chooses to select');
    await atMostTwo('[390px] the import sheet');
    await page.shot('trackers-import-phone');
    await scan(page, check, 'the import sheet, on a phone');
    await press('[role=dialog]', 'Select issues');
    await page.waitFor(`return document.querySelectorAll('[role=dialog] button.addr-thread').length === 1`, { label: 'selecting turns the one open issue into a button' });
    check((await page.eval(`return [...document.querySelectorAll('[role=dialog] button.addr-thread, [role=dialog] .addr-foot .btn')].every((b) => b.getBoundingClientRect().height >= 44)`)) === true, 'the targets are 44 px');
    await page.click('[role=dialog] button.addr-thread', undefined, 200);
    await page.waitFor(`return /Import 1 issue/.test(document.querySelector('[role=dialog] .btn-primary')?.textContent ?? '')`, { label: 'the sheet counts what is chosen' });
    check((await page.eval(overflow)) <= 1, `[390px import] nothing scrolls sideways (${await page.eval(overflow)}px)`);
    await page.click('[role=dialog] .btn-primary', undefined, 500);
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { timeout: 40_000, label: 'the sheet closes once #34 is imported' });
    check((await itemsOf(gh.id, ['31', '32', '33', '34'])).length === 4, 'all four issues are items now');
    await page.viewport(1440, 900);

    // ================= 4. Chips, the failed sync and Sync again =================
    const item31 = (await api.get(`/work-items/${first.imported[0].itemId}`)).body;
    const item32 = imported[1].item;
    await page.goto(`/tasks/${item31.key}`, 300);
    await page.waitFor(`return !!document.querySelector('.iss-chip')`, { timeout: 40_000, label: "the item's chip" });
    check(
      await page.eval(`return !document.querySelector('main img[src=x], .tab-panel img[src=x], [class*=markdown] img') && window.__pwned !== 1`),
      "a stranger's HTML in the quoted text did not become an element or run",
    );
    await page.goto(`/tasks/${item32.key}`, 300);
    for (const theme of ['dark', 'light']) {
      await setTheme(theme);
      await page.goto(`/tasks/${item32.key}`, 300);
      await page.waitFor(`return !!document.querySelector('.iss-chip')`, { timeout: 40_000, label: `[${theme}] the chip` });
      const chip = await page.eval(`const c = document.querySelector('.iss-chip'); return { text: c.textContent.trim().replace(/\\s+/g, ' '), href: c.getAttribute('href'), target: c.getAttribute('target'), panel: document.querySelector('.iss-panel')?.textContent ?? '', again: !!document.querySelector('.iss-panel .addr-acts .btn') }`);
      check(chip.text.includes('#32') && chip.text.includes('pending'), `[${theme}] the chip names the issue and its sync in words (${chip.text})`);
      check(chip.href === 'https://github.com/acme/shop/issues/32' && chip.target === '_blank', `[${theme}] and links to the tracker (${chip.href})`);
      check(chip.panel.includes('GitHub Issues') && chip.panel.includes('Add a coupon field') && !chip.again, `[${theme}] the panel shows the issue and no Sync again while nothing failed`);
      await atMostTwo(`[${theme}] the item with an issue`);
      await page.shot(`trackers-item-${theme}`);
      await scan(page, check, `the item page with its issue, ${theme}`);
    }

    // A close the host refuses is a failed sync, written on the issue's row
    await setTheme('dark');
    state('gh', { issueWriteFail: true });
    await api.post(`/work-items/${item32.id}/move`, { status: 'done' });
    const failed = (await api.post(`/work-items/${item32.id}/issues/32/sync?tracker=github-issues`, {})).body;
    check(failed.issues?.[0]?.syncState === 'failed' && Boolean(failed.issues[0].syncReason), `a close the host refuses is a failed sync with its reason (${JSON.stringify(failed.issues?.[0])})`);
    check(!closed('gh').includes('32'), 'and nothing was closed');
    await page.goto(board, 300);
    await page.waitFor(`return !!document.querySelector('.iss-failure')`, { timeout: 40_000, label: 'the done card says its write failed' });
    const card = await text('.iss-failure');
    check(card.includes('Failed') && card.includes('#32') && card.includes(failed.issues[0].syncReason), `the done card says it failed, for which issue and why (${card})`);
    await atMostTwo('[dark] the board with a failed sync');
    await page.shot('trackers-board-failed-dark');
    await scan(page, check, 'the board with a failed sync, dark');

    for (const theme of ['dark', 'light']) {
      await setTheme(theme);
      await page.goto(`/tasks/${item32.key}`, 300);
      await page.waitFor(`return !!document.querySelector('.iss-panel .addr-acts .btn')`, { timeout: 40_000, label: `[${theme}] Sync again appears for a failed write` });
      const panel = await page.eval(`return { chip: document.querySelector('.iss-chip').textContent.replace(/\\s+/g, ' '), panel: document.querySelector('.iss-panel').textContent.replace(/\\s+/g, ' '), reason: document.querySelector('.iss-reason')?.textContent ?? '' }`);
      check(panel.chip.includes('failed'), `[${theme}] the chip says failed (${panel.chip})`);
      check(panel.panel.includes('The write to GitHub Issues failed') && panel.panel.includes('Sync again') && panel.reason.includes(failed.issues[0].syncReason), `[${theme}] the panel says why, and offers Sync again (${panel.reason})`);
      check(!/gh issue|--reason/.test(panel.panel), `[${theme}] no command to copy`);
      await atMostTwo(`[${theme}] the item with a failed sync`);
      await page.shot(`trackers-item-failed-${theme}`);
      await scan(page, check, `the item page with a failed sync, ${theme}`);
    }
    await page.viewport(390, 844);
    await page.goto(`/tasks/${item32.key}`, 300);
    await page.waitFor(`return !!document.querySelector('.iss-panel .addr-acts .btn')`, { timeout: 40_000, label: 'the phone shows Sync again too' });
    check((await page.eval(`return document.querySelector('.iss-panel .addr-acts .btn').getBoundingClientRect().height`)) >= 44, 'Sync again is a 44 px target on a phone');
    check((await page.eval(overflow)) <= 1, `[390px item] nothing scrolls sideways (${await page.eval(overflow)}px)`);
    await atMostTwo('[390px] the item with a failed sync');
    await page.shot('trackers-item-failed-phone');
    await scan(page, check, 'the item page with a failed sync, on a phone');
    await page.viewport(1440, 900);

    // The host is back: Sync again is the one second try, and it closes the issue for real
    state('gh', {});
    await page.goto(`/tasks/${item32.key}`, 300);
    await page.click('.iss-panel .addr-acts .btn', 'Sync again', 400);
    await page.waitFor(`return /synced/.test(document.querySelector('.iss-chip')?.textContent ?? '') && !document.querySelector('.iss-panel .addr-acts .btn')`, { timeout: 40_000, label: 'the chip says synced and Sync again goes away' });
    check(closed('gh').includes('32') && calls('gh').some((l) => /^issue close 32 -R github\.com\/acme\/shop --reason completed/.test(l)), `Sync again closed the issue as completed (${closed('gh')})`);
    await page.goto(board, 300);
    await page.waitFor(`return !!document.querySelector('.iss-fact')`, { timeout: 40_000, label: 'the board again' });
    check((await page.eval(`return !document.querySelector('.iss-failure')`)) === true, 'the done card no longer says it failed');

    // ================= 5. A GitLab project =================
    repository(glRoot, GL_ORIGIN);
    const gl = (await api.post('/projects/import', { path: glRoot, name: 'e2e-trackers-gl', template: 'software' })).body;
    check(Boolean(gl?.id), 'the GitLab project was imported');
    projects.push(gl.id);
    const savedGl = (await api.put(`/projects/${gl.id}/tracker`, { id: 'gitlab-issues', scope: 'acme/shop', query: '', statusMap: { done: 'completed' } })).body;
    check(savedGl?.id === 'gitlab-issues', 'GitLab Issues is saved for a GitLab project');
    const glSettings = `/?project=${encodeURIComponent(gl.id)}&view=settings`;
    await page.goto(glSettings, 300);
    await page.waitFor(`return !!document.querySelector('.project-tracker-card .trk-opt.on')`, { timeout: 40_000, label: "the GitLab project's saved tracker" });
    const glOptions = await page.eval(`return { on: document.querySelector('.project-tracker-card .trk-opt.on').textContent, github: ${option('GitHub Issues')}.getAttribute('aria-disabled'), hint: document.querySelector('.project-tracker-card')?.textContent ?? '' }`);
    check(glOptions.on.includes('GitLab Issues') && glOptions.github === 'true', `GitLab Issues is on, and GitHub Issues cannot be chosen here (${glOptions.on.slice(0, 40)}, ${glOptions.github})`);
    check(/text GitLab searches/.test(glOptions.hint), "the query's hint says GitLab searches text");
    await trackerCardGradients('[dark] a GitLab project settings');
    await scan(page, check, 'the GitLab project tracker form, dark');

    const glBoard = `/tasks?project=${encodeURIComponent(gl.id)}`;
    await page.goto(glBoard, 300);
    await page.waitFor(`return !!document.querySelector('.workitem-import')`, { timeout: 40_000, label: 'Import issues on the GitLab board' });
    await atMostTwo('[dark] the GitLab board, empty');
    await page.click('.workitem-import', undefined, 400);
    await page.waitFor(`return document.querySelectorAll('[role=dialog] .addr-thread').length === 2`, { timeout: 40_000, label: 'the dialog lists the two GitLab issues' });
    const glDialog = await page.eval(`const d = document.querySelector('[role=dialog]'); return { text: d.textContent, rows: [...d.querySelectorAll('.addr-thread')].map((r) => r.textContent.replace(/\\s+/g, ' ')), primaries: d.querySelectorAll('.btn-primary').length, script: !!d.querySelector('script') }`);
    check(glDialog.text.includes('Import issues from GitLab Issues') && glDialog.rows[0].includes('#41') && glDialog.rows[1].includes('#42'), `GitLab's own words and numbers (${glDialog.rows})`);
    check(glDialog.primaries === 1 && !glDialog.script, 'Import is the one gradient action, and nothing came of an issue\'s markup');
    await atMostTwo('[dark] the GitLab import dialog');
    await page.shot('trackers-import-gitlab');
    await scan(page, check, 'the GitLab import dialog, dark');
    await page.click('[role=dialog] .addr-thread', undefined, 200);
    await page.click('[role=dialog] .btn-primary', undefined, 500);
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { timeout: 40_000, label: 'the GitLab dialog closes' });
    await page.waitFor(`return [...document.querySelectorAll('.iss-fact')].some((f) => f.textContent.includes('#41'))`, { timeout: 40_000, label: 'the GitLab card says #41' });
    const glItem = (await itemsOf(gl.id, ['41']))[0]?.item;
    check(Boolean(glItem), '#41 is an item');
    const glFull = (await api.get(`/work-items/${glItem?.id}`)).body;
    check(glFull.description?.startsWith('> **From GitLab Issues #41**') && glFull.description.includes('<script>window.__pwned=1</script>'), `#41 is a quoted source block under GitLab's name (${JSON.stringify(glFull.description?.slice(0, 70))})`);
    check(glFull.issues?.[0]?.url === 'https://gitlab.com/acme/shop/-/work_items/41', `its chip links to glab's own URL (${glFull.issues?.[0]?.url})`);
    check(calls('glab').some((l) => /^issue list -R https:\/\/gitlab\.com\/acme\/shop -O json -P 100 -p 1/.test(l)), 'glab was asked for the project by its URL, one page of 100');
    check(await page.eval(`return window.__pwned !== 1`), 'no issue markup ran');
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); return true`).catch(() => {});
    if (triageInfo) {
      await api.put(`/decisions/points/${POINT}/consent`, { granted: false, stateVersion: triageInfo.stateVersion, providers: [] }).catch(() => {});
      await triageSettings('off').catch(() => {});
    }
    resetFakes();
    await api.post('/hosts/refresh').catch(() => {});
    await api.post('/trackers/refresh').catch(() => {});
    for (const id of projects) await api.del(`/projects/${id}`).catch(() => {});
    for (const dir of [ghRoot, glRoot]) rmSync(dir, { recursive: true, force: true });
  }
};
