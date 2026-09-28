// A project is created through the wizard (a directory, a template, its modules and a key prefix),
// opens on its page with the tabs its modules allow, and is edited in its settings: a clashing
// prefix is said in the field, switching the Board off hides its tab and keeps its tasks, and the
// column limits persist. The phone walks the same wizard one step at a time.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const tabsText = `return [...(document.querySelector('main [role=tablist]')?.querySelectorAll('[role=tab]') ?? [])].map((t) => t.childNodes[1]?.textContent?.trim() ?? t.textContent.trim()).join(',')`;
const patch = (api, path, body) => api.request('PATCH', path, body);

export default async ({ page, api, check, dirs }) => {
  const dir = join(dirs.workspaceDir, 'e2e-wizard');
  mkdirSync(dir, { recursive: true });
  const phoneDir = join(dirs.workspaceDir, 'e2e-wizard-phone');
  mkdirSync(phoneDir, { recursive: true });
  // Another project whose prefix the settings must refuse
  const other = await api.post('/projects', { name: 'e2e-other-prefix' });
  check(other.status === 201, `a second project exists (${other.status})`);
  const otherKey = other.body.key;
  const made = [other.body.id];

  try {
    // ---- the wizard on a desktop: the four parts on one page, the summary beside them
    await page.viewport(1440, 1024);
    await page.goto('/projects', 1200);
    await page.click('main .page-header a', 'New project', 900);
    await page.waitFor(`return location.pathname === '/projects/new' && !!document.querySelector('main .template-grid')`, { label: 'the wizard' });
    check((await page.eval(`return document.querySelectorAll('main .template-card[role=radio]').length`)) === 5, 'five templates, as radio cards');
    check(
      (await page.eval(`return document.querySelector('main .template-card[aria-checked=true]')?.dataset.template`)) === 'software',
      'Professional software is the template chosen to start with',
    );
    check((await page.eval(`return document.querySelectorAll('main .module-grid .module-card.is-on').length`)) === 4, 'it switches every module on');
    const team = await page.text('main .wizard-summary .summary-team');
    check(team.includes('.claude/agents/') && !/\byet\b/.test(team), `the summary says the roles become agent files once accepted (${team})`);

    await page.fill('main input[aria-label="Directory"]', dir);
    await page.fill('main .wizard-name input', 'e2e-wizard');
    await page.click('main .template-card[data-template=library]', undefined, 400);
    check(
      (await page.eval(`return [...document.querySelectorAll('main .module-grid .module-card.is-on')].map((c) => c.dataset.module).join(',')`)) === 'board,documents,memory',
      'Library preselects Board, Documents and Shared memory',
    );
    // A module switched off by hand, and a prefix of the person's own
    await page.click('main .module-card[data-module=documents] [role=switch]', undefined, 300);
    await page.fill('main .wizard-prefix input', 'WZ');
    const summary = await page.text('main .wizard-summary');
    check(summary.includes('Library or package') && summary.includes('WZ-1'), `the summary names the template and the first key (${summary})`);
    check(/Documents · off/.test(summary), 'the summary says which module stays off');
    check(/in progress 2/.test(summary), `the summary carries the template's limit (${summary})`);
    check((await page.eval(`return document.querySelectorAll('main .btn-primary').length`)) === 1, 'the wizard has one primary action');

    // Proposing is on for this template and would hand the project to the assistant, which starts a
    // CLI run: that hand-off is assistant.spec's, against the fake CLI; this one lands on the project
    const propose = `document.querySelector('main .wizard-propose [role=switch]')?.getAttribute('aria-checked')`;
    check((await page.eval(`return ${propose}`)) === 'true', 'the wizard offers to propose a team, resources and tasks');
    await page.click('main .wizard-propose [role=switch]', undefined, 300);
    check((await page.eval(`return ${propose}`)) === 'false', 'proposing can be switched off');
    await page.click('main .wizard-create', undefined, 1500);
    await page.waitFor(`return location.pathname === '/' && document.querySelector('main h1')?.textContent === 'e2e-wizard'`, { label: 'the new project page' });
    const project = (await api.get('/projects')).body.find((p) => p.path === dir);
    check(!!project, 'the directory was imported');
    made.push(project.id);
    check(project.key === 'WZ', `the typed prefix was kept (${project.key})`);
    check(project.modules.join(',') === 'board,memory', `the modules chosen were saved (${project.modules})`);
    const settings = (await api.get(`/projects/${project.id}/settings`)).body;
    check(settings.template === 'library' && settings.board.columnLimits.in_progress === 2, 'the template configured the board');

    // ---- the tabs follow the modules
    await page.waitFor(`return !!document.querySelector('main [role=tablist]')`, { label: 'the project tabs' });
    check((await page.eval(tabsText)) === 'Overview,Board,Memory,Resources,Worktrees,Settings', `the tabs of a project with Board and Memory (${await page.eval(tabsText)})`);
    check((await page.text('main .project-head')).includes('WZ'), 'the header shows the key');
    await page.waitFor(`return !!document.querySelector('main .dashboard-grid')`, { label: 'Overview is the dashboard' });
    await page.click('main [role=tab]', 'Board', 800);
    check((await page.eval('return location.search')).includes('view=board'), 'the Board tab is in the address');

    // ---- settings: a clash is said in the field; switching the Board off hides its tab
    await page.goto(`/?project=${encodeURIComponent(project.id)}&view=settings`, 1500);
    await page.waitFor(`return !!document.querySelector('main .project-general')`, { label: 'the project settings' });
    // A form with its own Save: the header carries no actions there (DesktopProyectoAjustes)
    check(!(await page.eval(`return !!document.querySelector('main .project-head .page-actions')`)), 'the settings header has no actions');
    await page.fill('main .project-prefix input', otherKey);
    await page.waitFor(`return /already used/.test(document.querySelector('main .project-prefix .field-error')?.textContent ?? '')`, { label: 'the clash in the field' });
    check(await page.eval(`return [...document.querySelectorAll('main .project-general-actions .btn-primary')].every((b) => b.disabled)`), 'a clashing prefix cannot be saved');
    await page.fill('main .project-prefix input', 'WZD');
    check((await page.eval(`return document.querySelectorAll('main .limit-field').length`)) === 4, 'every column but Done takes a limit');
    await page.fill('main .limit-field input[aria-label="Limit of In review"]', '4');
    await page.click('main .module-card[data-module=board] [role=switch]', undefined, 300);
    check((await page.text('main .module-card[data-module=board] .module-note')).includes('hidden'), 'a module switched off says it is hidden and kept');
    await page.click('main .project-general-actions button', 'Save changes', 1500);
    await page.waitFor(`return !document.querySelector('main [role=tab][aria-selected=true] .tab-dirty')`, { label: 'saved' });
    const saved = (await api.get('/projects')).body.find((p) => p.id === project.id);
    check(saved.key === 'WZD' && !saved.modules.includes('board'), `the prefix and the modules were saved (${saved.key}, ${saved.modules})`);
    check((await api.get(`/projects/${project.id}/settings`)).body.board.columnLimits.in_review === 4, 'the column limit was saved');
    await page.waitFor(`return !${tabsText.replace('return ', '')}.includes('Board')`, { label: 'the Board tab is gone' });

    // An address for a hidden tab lands on Overview; the Board comes back with its module
    await page.goto(`/?project=${encodeURIComponent(project.id)}&view=board`, 1500);
    await page.waitFor(`return !location.search.includes('view=board') && !!document.querySelector('main .dashboard-grid')`, { label: 'a hidden tab falls back to Overview' });
    await patch(api, `/projects/${project.id}`, { modules: ['board', 'memory'] });
    await page.goto(`/?project=${encodeURIComponent(project.id)}`, 1500);
    await page.waitFor(`return ${tabsText.replace('return ', '')}.includes('Board')`, { label: 'the Board tab is back' });

    // ---- the Projects list shows each project's key and modules
    await page.goto('/projects', 1200);
    const card = `[...document.querySelectorAll('main .project-card')].find((c) => c.textContent.includes('e2e-wizard'))`;
    check((await page.eval(`return ${card}?.querySelector('.workitem-key')?.textContent`)) === 'WZD', 'the card shows the key');
    check((await page.eval(`return ${card}?.querySelectorAll('.module-mark.is-on').length`)) === 2, 'the card marks the modules that are on');

    // ---- a new directory: the name is said as it is typed, and the folder takes what it can of it
    await page.goto('/projects/new', 1200);
    await page.waitFor(`return !!document.querySelector('main .wizard-name input')`, { label: 'the wizard again' });
    await page.fill('main .wizard-name input', '¡¡');
    await page.waitFor(`return !!document.querySelector('main .wizard-name .field-error')`, { label: 'a name that makes no folder is said at once' });
    check(await page.eval(`return document.querySelector('main .wizard-create').disabled`), 'and it cannot be created');
    await page.fill('main .wizard-name input', 'E2E Página nueva');
    await page.waitFor(`return document.querySelector('main .wizard-name .form-hint')?.textContent.includes('E2E-Pagina-nueva')`, { label: 'the folder the name makes' });
    await page.click('main .template-card[data-template=simple]', undefined, 400);
    if ((await page.eval(`return ${propose}`)) === 'true') await page.click('main .wizard-propose [role=switch]', undefined, 300);
    await page.click('main .wizard-create', undefined, 1500);
    await page.waitFor(`return location.pathname === '/' && document.querySelector('main h1')?.textContent === 'E2E Página nueva'`, { label: 'a project with spaces and accents in its name' });
    const spaced = (await api.get('/projects')).body.find((p) => p.name === 'E2E Página nueva');
    check(spaced?.path.endsWith('/E2E-Pagina-nueva'), `its folder is the name as a folder can hold it (${spaced?.path})`);
    if (spaced) made.push(spaced.id);

    // ---- the phone: one step per screen, no tab bar under it
    await page.viewport(390, 844);
    await page.goto('/projects/new', 1500);
    await page.waitFor(`return !!document.querySelector('main .wizard-phone')`, { label: 'the phone wizard' });
    check(!(await page.eval(`return !!document.querySelector('.tabbar')`)), 'the wizard hides the tab bar');
    check((await page.text('main .wizard-phone-title')).includes('step 1 of 4'), 'the header says the step');
    await page.fill('main input[aria-label="Directory"]', phoneDir);
    await page.click('main .wizard-phone-foot button', 'Next', 400);
    await page.waitFor(`return !!document.querySelector('main .template-grid')`, { label: 'the template step' });
    await page.click('main .template-card[data-template=simple]', undefined, 300);
    await page.click('main .wizard-phone-foot button', 'Next', 400);
    check((await page.eval(`return document.querySelectorAll('main .module-card.is-on').length`)) === 0, 'Simple switches nothing on');
    const small = await page.eval(`return [...document.querySelectorAll('main .wizard-phone-foot .btn, main [role=switch]')].filter((b) => b.getBoundingClientRect().height < 44 && !b.matches('[role=switch]')).length`);
    check(small === 0, 'the step buttons are 44 px targets');
    await page.click('main .wizard-phone-foot button', 'Next', 400);
    check((await page.text('main .wizard-summary')).includes('Simple'), 'the last step is the summary');
    await page.click('main .wizard-create', undefined, 1500);
    await page.waitFor(`return location.pathname === '/' && document.querySelector('main h1')?.textContent === 'e2e-wizard-phone'`, { label: 'the phone project page' });
    const phoneProject = (await api.get('/projects')).body.find((p) => p.path === phoneDir);
    if (phoneProject) made.push(phoneProject.id);
    check(phoneProject?.modules.length === 0, 'the Simple project has no modules');
    // Its tabs are cells, and without a Board there is none for it
    const cells = await page.eval(`return [...document.querySelectorAll('main .project-tab-cell .settings-cell-name')].map((c) => c.textContent).join(',')`);
    check(cells === 'Resources,Worktrees,Settings', `the phone's tab cells follow the modules (${cells})`);
    // The page heads itself (MobileProyecto): back, the monogram, the key and path, a "⋯" sheet, and
    // the assistant as a row above the sections
    check(await page.eval(`return !!document.querySelector('main .phone-head.project-phone-head .phone-head-lead .monogram')`), 'the phone project header leads with the monogram');
    check(await page.eval(`const bar = document.querySelector('.topbar'); return !bar || bar.getClientRects().length === 0`), 'no top bar over the phone project page');
    const row = await page.eval(`const a = document.querySelector('main .project-assistant-row'); return a ? a.getAttribute('href') + '|' + a.textContent : ''`);
    check(row.startsWith(`/projects/${encodeURIComponent(phoneProject.id)}/assistant|`) && row.includes('Project assistant'), `the assistant row leads to the assistant (${row})`);
    check(
      await page.eval(`const r = document.querySelector('main .project-assistant-row'), c = document.querySelector('main .project-tab-cells'); return !!(r && c && (r.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING))`),
      'the assistant row sits above the sections',
    );
    const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
    check(overflow <= 2, `the phone project page does not scroll sideways (${overflow}px)`);
  } finally {
    await page.viewport(1440, 900);
    await page.eval(`localStorage.removeItem('agentry:project'); return true`);
    for (const id of made) await api.del(`/projects/${id}`);
  }
};
