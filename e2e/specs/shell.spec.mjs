// The shell: a one-row top bar whose "New chat ▾" also starts a workflow or an orchestration,
// Settings → Appearance as the one place for theme, language and motion (they left the top bar),
// the palette reaching the same preferences, and a phone's bottom tab bar instead of a slide-over.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** The figure beside Tasks in the sidebar, without the words said to a screen reader */
const tasksCount = `(document.querySelector('#sidebar a.nav-link[href="/tasks"] .nav-count')?.childNodes[0]?.textContent ?? null)`;
const pageHeading = `(document.querySelector('main h1')?.textContent.trim() ?? null)`;

const openNewMenu = async (page) => {
  await page.focus('.topbar-new .split-btn-more');
  await page.press('Enter');
  await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the New chat menu opens' });
};

export default async ({ page, api, check, dirs }) => {
  let projectId = null;
  let chatId = null;
  let orchestrationId = null;
  let scheduleId = null;
  // True once the page shows what `body` looks for: pages are code-split and a loaded machine draws
  // them later than a goto's fixed wait, so a check reads the page once it has settled
  const until = (body, timeout = 10000) => page.waitFor(body, { timeout }).then(() => true, () => false);
  try {
    await page.viewport(1440, 900);
    await page.goto('/', 0);

    // ---- the top bar: one row, no preferences in it ----
    await page.waitFor(`return !!document.querySelector('.topbar .select-trigger')`, { label: 'the top bar and its project select' });
    const bar = await page.eval(`const b = document.querySelector('.topbar'); return { text: b.innerText, height: b.getBoundingClientRect().height, selects: b.querySelectorAll('.select-trigger').length }`);
    check(bar.selects === 1, `the top bar has one select, the project (got ${bar.selects})`);
    check(!/theme/i.test(await page.eval(`return [...document.querySelectorAll('.topbar [aria-label]')].map((e) => e.getAttribute('aria-label')).join('|')`)), 'the theme toggle left the top bar');
    check(bar.height <= 60, `the top bar is one row (${bar.height}px)`);
    // The palette is the sidebar's search field on a desktop, not a second one in the bar
    check(await page.eval(`return !!document.querySelector('#sidebar .palette-trigger')?.getClientRects().length`), 'the palette trigger is in the sidebar');
    check(!(await page.eval(`return !!document.querySelector('.topbar .palette-trigger')?.getClientRects().length`)), 'and not in the top bar on a desktop');
    // The sidebar's two groups, and the status bar at the bottom of the column
    const groups = await page.eval(`return [...document.querySelectorAll('#sidebar .nav-group')].map((g) => [...g.querySelectorAll('a')].map((a) => a.getAttribute('href').split('?')[0]))`);
    check(
      JSON.stringify(groups) === JSON.stringify([['/', '/assistant', '/chats', '/tasks', '/orchestration', '/schedules'], ['/projects', '/connectors', '/usage', '/settings']]),
      `the sidebar has the Work and Space groups, the Assistant under Home and Tasks between Chats and Orchestrations (${JSON.stringify(groups)})`,
    );
    const status = await page.eval(`const s = document.querySelector('.statusbar'); if (!s) return null; const r = s.getBoundingClientRect(); return { height: r.height, bottom: r.bottom, text: s.innerText }`);
    check(status !== null && Math.round(status.height) === 30 && Math.abs(status.bottom - 900) <= 1, `the status bar is 30px at the bottom (${JSON.stringify(status)})`);
    check(/Claude Code|Codex|Checking agents|No agent detected|signed out|Connecting|unreachable/.test(status?.text ?? ''), `the status bar says the connection or the agents (${status?.text})`);
    check((await page.text('.topbar-new .split-btn-main')).trim() === 'New chat', 'the primary action is New chat');

    await openNewMenu(page);
    const items = await page.eval(`return [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((i) => i.textContent.trim())`);
    for (const item of ['Run workflow', 'New orchestration']) check(items.includes(item), `"${item}" is behind New chat ▾ (${items.join(', ')})`);
    await page.click('[role=menu] [role=menuitem]', 'New orchestration', 900);
    check((await page.eval(`return location.pathname + location.search`)) === '/orchestration?new=1', 'New orchestration opens the Orchestrations page with its form');

    // ---- Tasks: the open items of the selected project, kept current by the event feed ----
    const dir = join(dirs.workspaceDir, 'e2e-shell-tasks');
    mkdirSync(dir, { recursive: true });
    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-shell-tasks', template: 'software' });
    check(imported.status === 201 && imported.body.modules.includes('board'), `a project with its board was imported (${imported.status})`);
    projectId = imported.body.id;
    const created = [];
    for (const title of ['First task', 'Second task', 'Third task']) {
      const made = await api.post(`/projects/${projectId}/work-items`, { title });
      check(made.status === 201, `"${title}" was created (${made.status})`);
      created.push(made.body);
    }
    const moved = await api.post(`/work-items/${created[2].id}/move`, { status: 'done' });
    check(moved.status === 200, `a task was moved to Done (${moved.status})`);
    // An epic groups the two open tasks: it is not a third
    const epic = await api.post(`/projects/${projectId}/work-items`, { title: 'The epic', type: 'epic' });
    check(epic.status === 201, `an epic was created (${epic.status})`);
    await page.goto(`/?project=${projectId}`, 1200);
    await page.waitFor(`return ${tasksCount} === '2'`, { label: 'Tasks counts the two open items of the project, not the one done nor the epic' });
    const said = await page.text('#sidebar a.nav-link[href="/tasks"] .nav-count .sr-only');
    check(said.trim() === 'open', `the count is said with its word (${said})`);
    // A task created elsewhere (an agent, another tab) shows without a reload
    await api.post(`/projects/${projectId}/work-items`, { title: 'Fourth task' });
    await page.waitFor(`return ${tasksCount} === '3'`, { label: 'the count follows a task created through the API' });
    // With All projects, every project's open items
    const all = (await api.get('/work-items/board')).body;
    const open = all.columns.filter((c) => c.status !== 'done').reduce((sum, c) => sum + c.count, 0);
    await page.goto('/?project=all', 1200);
    await page.waitFor(`return ${tasksCount} === '${open}'`, { label: `All projects counts every open item (${open})` });

    // Every new route renders, under its crumb
    await page.goto(`/?project=${projectId}`, 900);
    // A project's page lives at `/`, yet it is one of the projects: Projects is the current section (gap 22)
    await page.waitFor(`return document.querySelector('#sidebar a.nav-link[href="/projects"]')?.classList.contains('is-active')`, { label: "Projects is current on a project's page" });
    check(!(await page.eval(`return document.querySelector('#sidebar a.nav-link[href="/"]').classList.contains('is-active')`)), "Home is not current on a project's page");
    check((await page.eval(`return document.querySelector('#sidebar a.nav-link[href="/projects"]').getAttribute('aria-current')`)) === 'page', 'and a screen reader hears it as the current page');
    check((await page.eval(`return document.querySelectorAll('#sidebar .nav-link[aria-current=page]').length`)) === 1, 'one current section');
    await page.goto(`/?project=${projectId}&view=board`, 0);
    await page.waitFor(`return document.querySelector('#sidebar a.nav-link[href="/projects"]')?.classList.contains('is-active')`, { label: "and on the project's tabs" });
    await page.goto('/?project=all', 900);
    await page.waitFor(`return document.querySelector('#sidebar a.nav-link[href="/"]')?.classList.contains('is-active')`, { label: 'Home is current on the Home of every project' });
    await page.goto(`/?project=${projectId}`, 900);
    await page.click('#sidebar a.nav-link[href="/tasks"]', undefined, 900);
    check((await page.eval(`return location.pathname`)) === '/tasks', 'Tasks opens /tasks');
    await page.waitFor(`return ${pageHeading} === 'Tasks'`, { label: 'the Tasks page' });
    check((await page.eval(`return document.querySelector('#sidebar a.nav-link[href="/tasks"]').classList.contains('is-active')`)) === true, 'Tasks is the current section');
    check((await page.text('.topbar .crumb-page')).trim() === 'Tasks', 'the crumb reads Tasks');
    await page.goto('/tasks/milestones', 900);
    // The milestones are a view of Tasks: the title stays, and the view switch says which (DesktopHitos)
    await page.waitFor(`return ${pageHeading} === 'Tasks' && document.querySelector('main [role=radiogroup] [role=radio][aria-checked=true]')?.textContent.trim() === 'Milestones'`, { label: 'the milestones page' });
    const key = created[0].key;
    await page.goto(`/tasks/${key.toLowerCase()}`, 900);
    await page.waitFor(`return ${pageHeading} === 'First task' && document.querySelector('main .workitem-key.boxed')?.textContent.trim() === '${key}'`, {
      label: `a work item's page, by its key in any case (${key})`,
    });
    const crumbs = await page.eval(`return [...document.querySelectorAll('.topbar .crumb-page')].map((c) => c.textContent.trim())`);
    check(JSON.stringify(crumbs) === JSON.stringify(['Tasks', key]), `the crumb reads Tasks / ${key} (${JSON.stringify(crumbs)})`);
    await page.goto('/projects/new', 900);
    await page.waitFor(`return ${pageHeading} === 'New project'`, { label: 'the new project wizard' });

    // The palette starts a task and goes to Tasks
    await page.key('k', 2);
    await page.waitFor(`return !!document.querySelector('[role=dialog][aria-label="Command palette"]')`, { label: 'palette open' });
    await page.type('new task');
    await page.sleep(300);
    check((await page.text('.palette-list [role=option][aria-selected=true]')).includes('New task'), 'the palette offers New task');
    await page.key('Enter');
    await page.waitFor(`return location.pathname + location.search === '/tasks?new=1'`, { label: 'New task opens Tasks with its form' });

    // ---- Settings → Appearance: the first tab, and what /settings opens on ----
    await page.goto('/settings', 0);
    const selected = await page.waitFor(`return document.querySelector('main [role=tab][aria-selected=true]')?.textContent.trim()`, { label: 'the selected Settings tab' });
    check(selected === 'Appearance', `Settings opens on Appearance (got ${selected})`);
    const panel = await page.text('[role=tabpanel]');
    for (const heading of ['Theme', 'Language', 'Motion']) check(panel.includes(heading), `Appearance has ${heading}`);

    await page.click('[role=tabpanel] [role=radio]', 'Light');
    await page.waitFor(`return document.documentElement.dataset.theme === 'light'`, { label: 'Light applies the light theme' });
    await page.click('[role=tabpanel] [role=radio]', 'Subtle');
    await page.waitFor(`return document.documentElement.dataset.motion === 'subtle' && localStorage.getItem('agentry-motion') === 'subtle'`, { label: 'Subtle is applied and stored' });
    check((await page.text('[role=tabpanel]')).includes('spinners hold still'), 'the chosen level says what it does');

    // The operating system's reduced motion wins, and the page says so instead of silently ignoring the choice
    await page.reduceMotion(true);
    await page.waitFor(`return document.documentElement.dataset.motion === 'off'`, { label: 'reduced motion forces off' });
    await page.waitFor(`return !!document.querySelector('[role=tabpanel] [role=note]')`, { label: 'the override is explained' });
    await page.reduceMotion(false);
    await page.waitFor(`return document.documentElement.dataset.motion === 'subtle'`, { label: 'the stored choice is back once the system stops asking' });

    await page.select('[role=tabpanel] .select-trigger', 'Español');
    await page.waitFor(`return document.documentElement.lang === 'es'`, { label: 'the language changes from Appearance' });
    await page.select('[role=tabpanel] .select-trigger', 'English');
    await page.waitFor(`return document.documentElement.lang === 'en'`, { label: 'and changes back' });

    // ---- the palette reaches the same preferences ----
    await page.key('k', 2);
    await page.waitFor(`return !!document.querySelector('[role=dialog][aria-label="Command palette"]')`, { label: 'palette open' });
    await page.type('motion full');
    await page.sleep(300);
    await page.key('Enter');
    await page.waitFor(`return document.documentElement.dataset.motion === 'full'`, { label: 'the palette sets the motion level' });
    await page.waitFor(`return !document.querySelector('.palette')`, { label: 'palette closed' });

    // ---- a phone: the tab bar, nothing sideways, fingers get room ----
    await page.viewport(390, 844);
    for (const path of ['/', '/chats', '/tasks', '/orchestration', '/settings']) {
      await page.goto(path, 900);
      const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
      check(overflow <= 1, `[390px ${path}] nothing scrolls sideways (${overflow}px)`);
      const tabbar = await page.eval(`const t = document.querySelector('.tabbar'); if (!t) return null; const r = t.getBoundingClientRect(); return { bottom: r.bottom, tabs: [...t.querySelectorAll('.tabbar-tab')].map((e) => e.getBoundingClientRect().height) }`);
      check(tabbar !== null && Math.abs(tabbar.bottom - 844) <= 1, `[390px ${path}] the tab bar sits on the bottom edge`);
      check(tabbar !== null && tabbar.tabs.length === 4 && tabbar.tabs.every((h) => h >= 44), `[390px ${path}] four tabs, each at least 44px tall (${tabbar?.tabs.join(', ')})`);
      check(!(await page.eval(`return !!document.querySelector('.topbar-new')?.getClientRects().length`)), `[390px ${path}] New chat moved from the top bar to the FAB`);
      check(!(await page.eval(`return !!document.querySelector('.statusbar')?.getClientRects().length`)), `[390px ${path}] the status bar is desktop only`);
      // Labels are whole words: "Orchestrations" used to be cut to "Orquestaciones" minus its end
      const cut = await page.eval(`return [...document.querySelectorAll('.tabbar-label')].filter((l) => l.scrollWidth > l.clientWidth + 1).map((l) => l.textContent)`);
      check(cut.length === 0, `[390px ${path}] no tab label is truncated (${cut.join(', ')})`);
    }
    // The FAB: the same round icon everywhere, named New chat, New orchestration on its page, none on
    // Settings — and none where the page's own empty state already offers what it would start
    const fab = async (path) => {
      await page.goto(path, 900);
      return page.eval(`const standIn = !!document.querySelector('main .state-empty .btn-primary'); const f = document.querySelector('.fab'); if (!f || !f.getClientRects().length) return { standIn, shown: false }; const r = f.getBoundingClientRect(), t = document.querySelector('.tabbar').getBoundingClientRect(); return { standIn, shown: true, text: f.innerText.trim(), name: f.getAttribute('aria-label') ?? f.innerText.trim(), above: t.top - r.bottom, height: r.height, width: r.width, right: innerWidth - r.right }`);
    };
    const expectFab = (seen, path, name) => {
      if (seen.standIn) check(!seen.shown, `[390px ${path}] the empty state offers the action, so there is no FAB (${JSON.stringify(seen)})`);
      else check(seen.shown && seen.text === '' && seen.name === name, `[390px ${path}] the FAB is an icon named ${name} (${JSON.stringify(seen)})`);
    };
    const home = await fab('/');
    expectFab(home, '/', 'New chat');
    if (home.shown) check(home.above >= 8 && home.height >= 44 && home.width >= 44 && home.right >= 8, `[390px /] the FAB sits above the tab bar, inside the screen, 44px or larger (${JSON.stringify(home)})`);
    expectFab(await fab('/chats'), '/chats', 'New chat');
    const orchestrations = await fab('/orchestration');
    expectFab(orchestrations, '/orchestration', 'New orchestration');
    if (orchestrations.shown) {
      await page.click('.fab', undefined, 900);
      check((await page.eval(`return location.pathname + location.search`)) === '/orchestration?new=1', 'the Orchestrations FAB opens the new orchestration form');
    }
    await page.goto('/orchestration?new=1', 900);
    check(await until(`return !document.querySelector('.fab')`), 'the new orchestration form is open, so the FAB steps aside');
    // Tasks is in the More sheet on a phone, and its FAB starts a task
    const tasksFab = await fab('/tasks');
    expectFab(tasksFab, '/tasks', 'New task');
    check((await page.eval(`return document.querySelector('.tabbar-more')?.classList.contains('is-active')`)) === true, '[390px /tasks] More is the current tab, where Tasks lives');
    // A project's page is behind More too, where Projects lives (MobileProyecto), not under Home
    await page.goto(`/?project=${projectId}`, 900);
    await page.waitFor(`return document.querySelector('.tabbar-more')?.classList.contains('is-active') === true`, { label: "[390px a project's page] More is the current tab" });
    check(!(await page.eval(`return document.querySelector('.tabbar a[href="/"]').classList.contains('is-active')`)), "[390px a project's page] Home is not");
    // A phone's detail screens head themselves with a way back, as their references do: no top bar
    // there, and the bar with the scope, search and the bell everywhere else (gap 21)
    // Both read a drawn shell: the bar is in the DOM on every route, and hidden by CSS on a phone's detail screens
    const topBarShown = `const t = document.querySelector('.topbar'); return !!t && t.getClientRects().length > 0`;
    const topBarHidden = `const t = document.querySelector('.topbar'); return !!t && t.getClientRects().length === 0`;
    for (const path of [`/?project=${projectId}`, `/?project=${projectId}&view=team`, `/?project=${projectId}&view=documents`, `/tasks`, '/tasks/milestones', `/tasks/${key}`, `/projects/${projectId}/assistant`]) {
      await page.goto(path, 1200);
      await page.waitFor(`return !!document.querySelector('main h1')`, { label: `[390px ${path}] the page` });
      check(await until(topBarHidden), `[390px ${path}] no top bar over a screen that heads itself`);
      const back = await page.eval(`const b = [...document.querySelectorAll('main button, main a')].find((e) => e.getAttribute('aria-label') && e.querySelector(':scope > svg.lucide-chevron-left')); if (!b) return null; const r = b.getBoundingClientRect(); return { top: r.top, h: r.height }`);
      check(back !== null && back.top < 80 && back.h >= 44, `[390px ${path}] its header leads back, at the top, as a 44 px target (${JSON.stringify(back)})`);
      check((await page.eval(`return document.querySelector('.shell')?.dataset.phoneHeader`)) === 'page', `[390px ${path}] the shell marks the route phoneHeader: 'page'`);
    }
    // The rest of the app heads itself too (CW-8): a chat (also a task's and a flow run's), an
    // orchestration, the review of changes, and the screens reached from More
    const chat = await api.post('/chats', { prompt: 'e2e-shell phone header', cwd: dirs.workspaceDir });
    check(chat.status === 201 || chat.status === 202, `a chat to head (${chat.status})`);
    chatId = chat.body?.id ?? null;
    const orchestration = await api.post('/orchestrations', { name: 'e2e-shell-phone-head', objective: 'a phone header', cwd: dirs.workspaceDir, maxAttempts: 1, tasks: [{ id: 'one', name: 'One', prompt: 'Say hi' }] });
    check(orchestration.status === 201, `an orchestration to head (${orchestration.status})`);
    orchestrationId = orchestration.body?.id ?? null;
    const headed = [`/chats/${chatId}`, `/chats/${chatId}/changes`, `/tasks/${key}/changes`, `/orchestration/${orchestrationId}`, `/orchestration/${orchestrationId}/changes`, `/orchestration/${orchestrationId}/tasks/one/changes`, '/projects', '/schedules', '/usage', '/connectors', '/settings', '/settings?tab=appearance'];
    for (const path of headed) {
      await page.goto(path, 1200);
      await page.waitFor(`return !!document.querySelector('main h1')`, { label: `[390px ${path}] the page` });
      check(await until(topBarHidden), `[390px ${path}] no top bar over a screen that heads itself`);
      const back = await page.eval(`const b = [...document.querySelectorAll('main button, main a')].find((e) => e.getAttribute('aria-label') && e.querySelector(':scope > svg.lucide-chevron-left')); if (!b) return null; const r = b.getBoundingClientRect(); return { top: r.top, h: r.height, w: r.width }`);
      check(back !== null && back.top < 80 && back.h >= 44 && back.w >= 44, `[390px ${path}] its header leads back, at the top, as a 44 px target (${JSON.stringify(back)})`);
      check((await page.eval(`return document.querySelector('.shell')?.dataset.phoneHeader`)) === 'page', `[390px ${path}] the shell marks the route phoneHeader: 'page'`);
    }
    // PhoneHeader's h1 is the screen's title on the screens it heads
    for (const [path, title] of [['/projects', 'Projects'], ['/schedules', 'Schedules'], ['/usage', 'Usage'], ['/connectors', 'Connectors'], ['/settings', 'Settings']]) {
      await page.goto(path, 1200);
      await until(`return document.querySelector('main .phone-head h1')?.textContent.trim() === ${JSON.stringify(title)}`);
      const h1 = await page.eval(`return document.querySelector('main .phone-head h1')?.textContent.trim() ?? null`);
      check(h1 === title, `[390px ${path}] PhoneHeader names the screen (${h1})`);
    }
    await page.goto(`/orchestration/${orchestrationId}`, 1200);
    check(await until(`return document.querySelector('main .phone-head h1')?.textContent.trim() === 'e2e-shell-phone-head' && !document.querySelector('main .orch-summary')`), '[390px an orchestration] PhoneHeader carries its name, in place of the desktop summary');
    // Schedules follows the project scope, so its selector comes into its own header
    await page.goto('/schedules', 1200);
    check(await until(`return !!document.querySelector('main .phone-head .project-selector')?.getClientRects().length`), '[390px /schedules] the project scope is in the header');
    // A Settings tab goes back to the list, not through history
    await page.goto('/settings?tab=appearance', 1200);
    await page.click('main .phone-head .phone-head-back', undefined, 900);
    check((await page.eval(`return location.pathname + location.search`)) === '/settings', '[390px a Settings tab] back returns to the list');
    // The chat keeps its own header, whose ⋯ opens as a sheet with the chat's entries
    await page.goto(`/chats/${chatId}`, 1200);
    check(await until(`return !!document.querySelector('main .chat-head') && !document.querySelector('main .phone-head')`), '[390px a chat] the chat keeps its own header');
    await page.click('main .chat-head .chat-more', undefined, 900);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .sheet-actions')`, { label: "[390px a chat] ⋯ opens a sheet" });
    const sheet = await page.eval(`const d = document.querySelector('[role=dialog] .sheet-actions'); return { downloads: d.querySelectorAll('a[download]').length, buttons: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()) }`);
    check(sheet.downloads === 2 && sheet.buttons.some((b) => /fork/i.test(b)) && sheet.buttons.some((b) => /copy/i.test(b)) && sheet.buttons.some((b) => /delete/i.test(b)), `[390px a chat] the sheet has export, fork, copy id and delete (${JSON.stringify(sheet)})`);
    await page.press('Escape');
    // A new chat and the schedule editor are modal flows: ✕ and "Cancel", no arrow
    await page.goto('/chats/new', 1200);
    check(await until(`return !!document.querySelector('main .new-chat-head') && document.querySelector('.topbar')?.getClientRects().length === 0`), '[390px /chats/new] no top bar over a new chat');
    const close = await page.eval(`const b = document.querySelector('main .new-chat-head a[href="/chats"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { top: r.top, h: r.height, w: r.width, x: !!b.querySelector('svg.lucide-x') }`);
    check(close !== null && close.x && close.top < 80 && close.h >= 44 && close.w >= 44, `[390px /chats/new] a 44 px ✕ closes it, at the top (${JSON.stringify(close)})`);
    await page.goto('/schedules/new', 1200);
    check(await until(`return !!document.querySelector('main .phone-head') && document.querySelector('.topbar')?.getClientRects().length === 0`), '[390px /schedules/new] no top bar over the editor');
    check(await page.eval(`return !!document.querySelector('main .phone-head .phone-head-cancel') && !document.querySelector('main .phone-head svg.lucide-chevron-left')`), '[390px /schedules/new] "Cancel" leaves it, with no back arrow');
    await page.click('main .phone-head .phone-head-cancel', undefined, 900);
    check((await page.eval(`return location.pathname`)) === '/schedules', '[390px /schedules/new] Cancel goes back to the schedules');
    // Editing one is the same modal flow; disabled and yearly, so it never fires during the run
    const schedule = await api.post('/schedules', { name: 'e2e-shell-phone-head', cron: '0 3 1 1 *', enabled: false, target: { kind: 'chat', chat: { prompt: 'hi', cwd: dirs.workspaceDir } } });
    check(schedule.status === 201, `a schedule to edit (${schedule.status})`);
    scheduleId = schedule.body?.id ?? null;
    await page.goto(`/schedules/${scheduleId}/edit`, 1200);
    await page.waitFor(`return !!document.querySelector('main .phone-head .phone-head-cancel')`, { label: '[390px a schedule\'s editor] its header' });
    check(await until(topBarHidden), "[390px a schedule's editor] no top bar over the editor");
    check((await page.eval(`return document.querySelector('.shell')?.dataset.phoneHeader`)) === 'page', "[390px a schedule's editor] the shell marks the route phoneHeader: 'page'");
    check(!(await page.eval(`return !!document.querySelector('main .phone-head svg.lucide-chevron-left')`)), "[390px a schedule's editor] \"Cancel\" and no back arrow");
    // The desktop app keeps its top bar, the window's title bar, at any width
    await page.goto('/projects', 1200);
    await page.eval(`document.documentElement.classList.add('is-desktop'); return true`);
    check(await page.eval(topBarShown), '[390px /projects, desktop app] the top bar stays');
    await page.eval(`document.documentElement.classList.remove('is-desktop'); return true`);
    // The new project wizard is a modal flow: no top bar either, and a ✕ in place of the arrow
    await page.goto('/projects/new', 1200);
    await page.waitFor(`return !!document.querySelector('main h1')`, { label: '[390px /projects/new] the wizard' });
    check(await until(topBarHidden), '[390px /projects/new] no top bar over the wizard, which heads itself');
    check(await page.eval(`const b = document.querySelector('main a[href="/projects"] svg.lucide-x, main button svg.lucide-x'); return !!b && b.closest('a, button').getBoundingClientRect().top < 80`), '[390px /projects/new] its header closes it, at the top');
    // Tasks keeps the project scope, in its own header
    await page.goto('/tasks', 0);
    await page.waitFor(`return !!document.querySelector('main .tasks-phone-head .project-selector')?.getClientRects().length`, { label: '[390px /tasks] the project scope is in the header' });
    for (const path of ['/chats', '/orchestration', '/orchestration?new=1', '/?project=all', '/nowhere']) {
      await page.goto(path, 0);
      await page.waitFor(topBarShown, { label: `[390px ${path}] the top bar stays` });
      check((await page.eval(`return document.querySelector('.shell')?.dataset.phoneHeader`)) === 'app', `[390px ${path}] the route keeps the app's header`);
    }
    await page.goto(`/?project=${projectId}`, 900);
    await page.goto('/tasks', 900);
    if (tasksFab.shown) {
      await page.click('.fab', undefined, 900);
      check((await page.eval(`return location.pathname + location.search`)) === '/tasks?new=1', 'the Tasks FAB opens the New task form');
    }
    check(!(await fab(`/tasks/${key}`)).shown, "[390px a work item] no FAB on a work item's page");
    check(!(await fab('/settings')).shown, '[390px /settings] no FAB where there is nothing to start');
    if ((await fab('/')).shown) {
      await page.click('.fab', undefined, 900);
      check((await page.eval(`return location.pathname`)) === '/chats/new', 'the Home FAB opens New chat');
    } else await page.goto('/chats/new', 900);
    check(!(await page.eval(`return !!document.querySelector('.fab')`)), 'New chat has its own composer, so the FAB steps aside');
    await page.goto('/orchestration', 900);
    check(await until(`return document.querySelector('.tabbar a[href="/orchestration"]')?.classList.contains('is-active') === true`), 'the current tab is marked');
    // A wide window keeps the app's top bar over the same screens: only a phone heads them itself
    await page.viewport(1440, 900);
    for (const path of [`/chats/${chatId}`, `/orchestration/${orchestrationId}`, '/projects', '/settings', '/schedules/new']) {
      await page.goto(path, 1200);
      check(await until(topBarShown), `[1440px ${path}] the top bar stays`);
      check(!(await page.eval(`return !!document.querySelector('main .phone-head')`)), `[1440px ${path}] no phone header`);
    }
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); localStorage.removeItem('agentry-motion'); localStorage.removeItem('agentry-language'); localStorage.removeItem('agentry-palette-recent'); localStorage.removeItem('agentry:project'); return true`).catch(() => {});
    // schedules.spec starts from none
    if (scheduleId) await api.del(`/schedules/${scheduleId}`).catch(() => {});
    if (orchestrationId) await api.del(`/orchestrations/${orchestrationId}`).catch(() => {});
    if (chatId) await api.del(`/chats/${chatId}`).catch(() => {});
    // Later specs count the projects
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
