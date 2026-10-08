// Editing a Home: each change is saved at once, the layout is the project's own (another project and
// All projects keep theirs), it survives a reload, Restablecer brings the default back, and a phone
// edits with taps only (up, down and remove buttons of 44 px, a Sheet to add).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// The widgets drawn, in order: the figures on top, then the wide column, then the narrow one
const widgetTypes = `return [...document.querySelectorAll('main .dashboard-grid > .dashboard-area > .widget-slot')].map((s) => s.dataset.widget).join(',')`;
const inEdit = `return !!document.querySelector('main .home-editbar')`;
const DEFAULT_PROJECT = 'kpis,limits,now,pickUp,flows,documents,export,today,schedules,memory,worktrees,resources';

export default async ({ page, api, check, dirs }) => {
  const make = async (name) => {
    const dir = join(dirs.workspaceDir, name);
    mkdirSync(dir, { recursive: true });
    const imported = await api.post('/projects/import', { path: dir, name });
    check(imported.status === 201, `${name} was imported (${imported.status})`);
    return imported.body.id;
  };
  const a = await make('e2e-home-edit-a');
  const b = await make('e2e-home-edit-b');
  const open = async (project) => {
    await page.goto(`/?project=${encodeURIComponent(project)}`, 1200);
    await page.waitFor(`return !!document.querySelector('main [data-widget=now]')`, { label: 'the dashboard' });
  };

  try {
    await page.viewport(1440, 900);

    // ---- Nothing is stored until someone edits: the default is drawn ----
    check((await api.get(`/dashboard/layout?project=${a}`)).body?.layout === null, 'no layout is stored for a project nobody edited');
    await open(a);
    check((await page.eval(widgetTypes)) === DEFAULT_PROJECT, `the default layout is drawn (${await page.eval(widgetTypes)})`);

    // ---- Edit mode: the bar, a frame on every widget ----
    await page.click('main button', 'Edit Home', 600);
    await page.waitFor(inEdit, { label: 'edit mode' });
    check((await page.text('main .home-editbar')).includes('Editing the Home of e2e-home-edit-a'), 'the bar says which Home is being edited');
    check(await page.eval(`return document.querySelectorAll('main [data-edit-widget]').length === 12`), 'every widget wears an edit frame');
    check(await page.eval(`return !!document.querySelector('main [data-edit-widget=now] .widget-handle[aria-label="Move In progress"]')`), 'a handle names its widget');

    // Remove, at once and without asking
    await page.click('main [data-edit-widget=export] .widget-remove', undefined, 700);
    check(!(await page.eval(widgetTypes)).includes('export'), 'Export is gone from the page');
    const afterRemove = await api.get(`/dashboard/layout?project=${a}`);
    check(afterRemove.body?.layout?.widgets.every((w) => w.type !== 'export'), 'the removal was saved without a Save button');

    // Resize: Pick up again goes from the whole width to half of it
    await page.click('main [data-edit-widget=pickUp] [role=radio]', 'M', 700);
    check(await page.eval(`return document.querySelector('main [data-widget=pickUp]').classList.contains('size-m')`), 'the widget took the size');
    check((await api.get(`/dashboard/layout?project=${a}`)).body?.layout?.widgets.find((w) => w.type === 'pickUp')?.size === 'm', 'the size was saved');
    // The strip's figures offer one size, so they have no control for it
    check(await page.eval(`return !document.querySelector('main [data-edit-widget=kpis] [role=radiogroup]')`), 'a widget with a single size has no size control');

    // Reorder with the keyboard: Space lifts, an arrow moves, Space drops
    await page.focus('main [data-edit-widget=flows] .widget-handle');
    await page.press(' ');
    check(await page.eval(`return document.querySelector('main [data-edit-widget=flows] .widget-handle').getAttribute('aria-pressed') === 'true'`), 'Space lifts the widget');
    await page.press('ArrowDown');
    check((await page.text('main [role=status]')).includes('position'), 'each step is announced');
    await page.press(' ');
    check((await page.eval(widgetTypes)).includes('now,pickUp,documents,flows'), `the widget moved down inside its area (${await page.eval(widgetTypes)})`);
    // Escape puts a lifted widget back where it was
    await page.press(' ');
    await page.press('ArrowUp');
    await page.press('Escape');
    check((await page.eval(widgetTypes)).includes('now,pickUp,documents,flows'), 'Escape cancels a move');

    // The picker lists what is not on the page and adds it back
    await page.click('main .home-editbar button', 'Add widget', 600);
    await page.waitFor(`return !!document.querySelector('.dialog .pick-list')`, { label: 'the picker' });
    const offered = await page.text('.dialog .pick-list');
    check(offered.includes('Export') && !offered.includes('Projects'), 'the picker offers Export and no widget of the other Home');
    check(offered.includes('Orchestrations') && offered.includes('Quick start'), 'the picker offers the types that fit the project');
    // The row is text; its Add button is what adds the type
    check(await page.eval(`const row = [...document.querySelectorAll('.dialog .pick-row')].find((r) => r.querySelector('.pick-name')?.textContent.includes('Export')); const add = row?.querySelector('.pick-add'); if (!add) return false; add.click(); return true;`), 'Export has its Add button in the picker');
    await new Promise((r) => setTimeout(r, 600));
    await page.click('.dialog button', 'Close', 600);
    // The picker closes and the page redraws from the saved layout: wait for it rather than read once
    const added = await page.waitFor(`${widgetTypes.replace('return ', 'return (')}).split(',').includes('export')`, { timeout: 10000 }).then(() => true, () => false);
    check(added, `a widget added from the picker is on the page (${await page.eval(widgetTypes)})`);
    await page.click('main [data-edit-widget=export] .widget-remove', undefined, 700);

    // Leaving edit mode keeps everything
    await page.click('main .home-editbar button', 'Done', 600);
    check(!(await page.eval(inEdit)), 'Done leaves edit mode');
    const edited = await page.eval(widgetTypes);
    check(!edited.includes('export'), 'the page shows the edited layout');

    // ---- It outlives a reload ----
    await open(a);
    check((await page.eval(widgetTypes)) === edited, `the layout persisted across a reload (${await page.eval(widgetTypes)})`);
    check(await page.eval(`return document.querySelector('main [data-widget=pickUp]').classList.contains('size-m')`), 'the size persisted too');

    // ---- And it is this project's own ----
    await open(b);
    check((await page.eval(widgetTypes)) === DEFAULT_PROJECT, `another project keeps the default (${await page.eval(widgetTypes)})`);
    check((await api.get(`/dashboard/layout?project=${b}`)).body?.layout === null, 'nothing is stored for the other project');

    // ---- All projects has a Home of its own ----
    await page.goto('/?project=all', 1200);
    await page.waitFor(`return !!document.querySelector('main [data-widget=projects]')`, { label: 'the All projects dashboard' });
    const allDefault = await page.eval(widgetTypes);
    check(allDefault === 'kpis,limits,now,pickUp,today,projects,schedules', `All projects draws its default (${allDefault})`);
    await page.click('main button', 'Edit Home', 600);
    await page.waitFor(inEdit, { label: 'edit mode of All projects' });
    check((await page.text('main .home-editbar')).includes('All projects'), 'the bar says it is the Home of All projects');
    check(await page.eval(`return !document.querySelector('.home-editbar + * [data-edit-widget=documents]')`), 'a widget of the project Home is not on it');
    await page.click('main [data-edit-widget=schedules] .widget-remove', undefined, 700);
    await page.click('main .home-editbar button', 'Done', 600);
    await page.goto('/?project=all', 1200);
    await page.waitFor(`return !!document.querySelector('main [data-widget=projects]')`, { label: 'the All projects dashboard again' });
    check(!(await page.eval(widgetTypes)).includes('schedules'), 'the All projects layout persisted');
    await open(a);
    check((await page.eval(widgetTypes)) === edited, 'editing All projects did not touch the project');

    // ---- Restablecer brings the default back, and Deshacer takes it back ----
    await page.click('main button', 'Edit Home', 600);
    await page.waitFor(inEdit, { label: 'edit mode again' });
    await page.click('main .home-editbar button', 'Reset', 800);
    check((await page.eval(widgetTypes)) === DEFAULT_PROJECT, 'Reset draws the default again');
    check((await api.get(`/dashboard/layout?project=${a}`)).body?.layout === null, 'Reset removed the stored layout');
    await page.click('.toast-action', 'Undo', 800);
    check((await page.eval(widgetTypes)) === edited, 'Undo brings the edited layout back');
    await page.click('main .home-editbar button', 'Done', 600);

    // ---- An invalid stored layout never reaches the page: the API refuses it ----
    const refused = await api.put(`/dashboard/layout?project=${a}`, { version: 1, widgets: [{ id: 'x', type: 'nothing', size: 'm' }] });
    check(refused.status === 400, `an unknown widget type is refused (${refused.status})`);

    // ---- A phone edits with taps only ----
    await page.viewport(390, 844);
    await open(a);
    await page.click('.project-phone-head .phone-head-more', undefined, 500);
    await page.click('[role=dialog] button', 'Edit Home', 600);
    await page.waitFor(`return document.querySelectorAll('main .move-row').length > 0`, { label: 'the phone list' });
    check(await page.eval(`return !document.querySelector('main [data-edit-widget] .widget-handle')`), 'a phone has no drag handle');
    const sizes = await page.eval(`return [...document.querySelectorAll('main .move-row button')].map((b) => Math.round(b.getBoundingClientRect().height))`);
    check(sizes.length > 0 && sizes.every((h) => h >= 44), `every button of the list is at least 44 px tall (${sizes.join(',')})`);
    check(await page.eval(`return document.querySelector('main .move-row button')?.disabled === true`), 'the first row cannot go up');
    const before = (await api.get(`/dashboard/layout?project=${a}`)).body?.layout?.widgets.map((w) => w.type) ?? [];
    await page.click('main .move-row button[aria-label="Move In progress down"]', undefined, 700);
    const after = (await api.get(`/dashboard/layout?project=${a}`)).body?.layout?.widgets.map((w) => w.type) ?? [];
    check(after.indexOf('now') > before.indexOf('now') || before.length === 0, `Down moved the widget with a tap (${before.join(',')} -> ${after.join(',')})`);
    await page.click('main .widget-add', undefined, 600);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .pick-list')`, { label: 'the Sheet to add' });
    await page.click('[role=dialog] .pick-row button', undefined, 600);
    await page.click('[role=dialog] button', 'Close', 600);
    await page.click('main .home-editbar button', 'Done', 600);
    check(!(await page.eval(inEdit)), 'Done leaves the phone edit mode');
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    for (const project of [a, b, 'all']) await api.del(`/dashboard/layout?project=${project}`);
    await api.del(`/projects/${a}`);
    await api.del(`/projects/${b}`);
  }
};
