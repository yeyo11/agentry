// The Tasks, work item and Documents screens as the review of the whole feature left them (audit,
// "Review of the whole feature before the pull request"): "Create another" keeps New task open and
// focus lands on what was made (17); Escape closes only the dialog on top (18); an editor survives a
// failed refetch (19) and the panel asks before dropping an edited description; filters the scope
// cannot show leave the address (21); New task on a project whose Board is off asks for a project
// (22); delete and Back return to the board as it was (23); a tied document can be untied (24);
// phone labels are 16 px and 44 px (29); the save shortcut is the keyboard's own (30); the list
// walks with J and K from anywhere, never swallowing Ctrl+K, and counts as the board does; Enter in
// the relate dialog takes the first match; "Move to Done" asks while criteria are unchecked; an
// item open while its prefix changes follows its new key.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const timeout = 240_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(condition, label, limit = 15_000) {
  const end = Date.now() + limit;
  for (;;) {
    const value = await condition().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(200);
  }
}

export default async ({ page, api, check, dirs }) => {
  const made = [];
  try {
    // A fresh name each run: a project removed from Agentry keeps its items, and importing the same
    // folder again would bring them back
    const run = Date.now().toString(36);
    const dir = join(dirs.workspaceDir, `e2e-tasks-review-${run}`);
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'spec.md'), '# The spec\n\nWhat it does.\n');
    const imported = await api.post('/projects/import', { path: dir, name: `e2e-tasks-review-${run}`, template: 'software' });
    check(imported.status === 201, `a project with a board (${imported.status})`);
    const project = imported.body;
    made.push(project.id);
    const offDir = join(dirs.workspaceDir, `e2e-tasks-review-off-${run}`);
    mkdirSync(offDir, { recursive: true });
    const other = (await api.post('/projects/import', { path: offDir, name: `e2e-tasks-review-off-${run}`, template: 'simple' })).body;
    check(Boolean(other?.id) && !other.modules.includes('board'), 'a project with its Board off');
    if (other?.id) made.push(other.id);
    const add = async (req, status) => {
      const created = await api.post(`/projects/${project.id}/work-items`, req);
      check(created.status === 201, `"${req.title}" was created (${created.status})`);
      if (status) await api.post(`/work-items/${created.body.id}/move`, { status });
      return created.body;
    };
    const epic = await add({ type: 'epic', title: 'Review epic' }, 'todo');
    const first = await add({ title: 'Review first', labels: ['web'], acceptanceCriteria: [{ text: 'one' }, { text: 'two' }] }, 'todo');
    const second = await add({ title: 'Review second' }, 'todo');
    const third = await add({ title: 'Review third' });
    await api.post(`/work-items/${first.id}/documents`, { path: 'docs/spec.md', kind: 'spec' });

    await page.viewport(1440, 900);
    // Each part is checked on its own: one that fails is reported, and the next still runs
    const part = async (name, run) => {
      try {
        await run();
      } catch (error) {
        check(false, `${name}: ${error.message}`);
        await page.key('Escape').catch(() => {});
      }
    };

    await part('the list: J and K from anywhere, Ctrl+K left to the palette, counts without epics', async () => {
      await page.goto(`/tasks?project=${project.id}&view=list`, 1500);
      await page.waitFor(`return document.querySelectorAll('.workitem-row').length === 4`, { label: 'the list' });
      const todoCount = await page.eval(`return document.querySelector('.workitem-list-group[aria-label="To do"] .workitem-col-count')?.textContent`);
      check(todoCount === '2', `a group counts what its board column counts, the epic left out (${todoCount})`);
      check(await page.eval(`return document.querySelectorAll('.workitem-list-group ul > li > .workitem-row').length === 4`), 'each column is a list of rows');
      await page.eval(`document.activeElement?.blur(); return true`);
      await page.key('j');
      check((await page.eval(`return [...document.querySelectorAll('.workitem-row')].indexOf(document.activeElement)`)) === 0, 'J from nowhere takes the first row');
      await page.key('j');
      check((await page.eval(`return [...document.querySelectorAll('.workitem-row')].indexOf(document.activeElement)`)) === 1, 'J moves down');
      await page.key('k', 2);
      await page.waitFor(`return !!document.querySelector('.palette-backdrop')`, { label: 'Ctrl+K opens the palette over the list' });
      check((await page.eval(`return [...document.querySelectorAll('.workitem-row')].indexOf(document.activeElement)`)) !== 0, 'Ctrl+K does not move the list');
      await page.key('Escape');
    });

    await part('a filter the scope cannot show leaves the address (21)', async () => {
      await page.goto(`/tasks?project=${project.id}&projects=${other?.id ?? 'x'}&epic=00000000-0000-0000-0000-000000000000`, 1500);
      await page.waitFor(`const q = new URLSearchParams(location.search); return !q.has('projects') && !q.has('epic')`, { label: 'stray filters removed' });
      await page.waitFor(`return document.querySelectorAll('.workitem-col [data-item-id]').length === 4`, { label: 'every card, not "0 of N"' });
    });

    await part('New task: "Create another" keeps the form, and focus lands on the new card (17)', async () => {
      await page.goto(`/tasks?project=${project.id}`, 1500);
      await page.key('n');
      await page.waitFor(`return !!document.querySelector('.newtask-form')`, { label: 'New task' });
      await page.click('.dialog-foot .check, .dialog-foot [role=checkbox]', undefined, 300);
      await page.fill('.newtask-title', 'Made with another');
      await page.click('.dialog-foot .btn-primary', undefined, 1200);
      await until(async () => (await api.get(`/projects/${project.id}/work-items?q=${encodeURIComponent('Made with another')}`)).body.length === 1, 'the first one was created');
      check(await page.eval(`return !!document.querySelector('.newtask-form') && document.querySelector('.newtask-title').value === ''`), '"Create another" keeps the form open, emptied');
      check(await page.eval(`return document.activeElement?.classList.contains('newtask-title')`), 'and focus is back on the title');
      await page.fill('.newtask-title', 'Made last');
      await page.click('.dialog-foot [role=checkbox], .dialog-foot .check', undefined, 300);
      await page.click('.dialog-foot .btn-primary', undefined, 1500);
      const last = await until(async () => (await api.get(`/projects/${project.id}/work-items?q=${encodeURIComponent('Made last')}`)).body[0], 'the second one was created');
      await page.waitFor(`return !document.querySelector('.newtask-form') && document.activeElement?.closest('[data-item-id]')?.dataset.itemId === ${JSON.stringify(last.id)}`, { label: 'focus on the new card' });
    });

    await part('Escape in a dialog opened from the panel closes only that dialog (18)', async () => {
      await page.goto(`/tasks?project=${project.id}&type=task&item=${second.key}`, 1500);
      await page.waitFor(`return !!document.querySelector('.dialog-drawer .workitem-title')`, { label: 'the panel' });
      await page.click('.dialog-drawer .workitem-section .workitem-add', 'Relate', 600);
      await page.waitFor(`return document.querySelectorAll('[role=dialog]').length === 2`, { label: 'the relate dialog over the panel' });
      await page.key('Escape');
      check(await page.eval(`return document.querySelectorAll('[role=dialog]').length === 1 && !!document.querySelector('.dialog-drawer')`), 'Escape closed the relate dialog and left the panel');
    });

    await part('Enter in the relate dialog takes the first match', async () => {
      await page.click('.dialog-drawer .workitem-section .workitem-add', 'Relate', 600);
      await page.focus('.relation-search input');
      await page.type(third.key);
      await sleep(800);
      await page.press('Enter');
      await until(async () => (await api.get(`/work-items/${second.id}`)).body.relations.some((r) => r.item.id === third.id), 'Enter related the first match');
    });

    await part('an edited description is not lost to closing the panel', async () => {
      await page.click('.dialog-drawer .workitem-description .workitem-edit', undefined, 800);
      await page.focus('.dialog-drawer .workitem-description .cm-content');
      await page.type('Unsaved words');
      await page.key('Escape');
      await page.waitFor(`return [...document.querySelectorAll('[role=dialog] h2')].some((h) => /discard|unsaved/i.test(h.textContent))`, { label: 'the discard question' });
      await page.click('[role=dialog] .btn', 'Keep editing', 500);
      check(await page.eval(`return !!document.querySelector('.dialog-drawer .workitem-description.is-editing')`), 'keeping on editing leaves the panel and the text');
    });

    await part('an API blip keeps the editor and its text (19)', async () => {
      const unblock = await page.blockUrls(['*/api/work-items/*']);
      await page.eval(`window.dispatchEvent(new Event('focus')); return true`);
      await sleep(2500);
      check(await page.eval(`return !!document.querySelector('.dialog-drawer .workitem-description.is-editing') && !document.querySelector('.dialog-drawer .error-box, .dialog-drawer [role=alert]')`), 'a failed refetch leaves the open editor');
      await unblock();
      // Left dirty, the edit would hold the next navigation behind the browser's own "leave?" prompt
      await page.click('.dialog-drawer .workitem-edit-actions .btn', 'Cancel', 400);
    });

    await part('delete from the panel: the board stays as it was (23)', async () => {
      await page.goto(`/tasks?project=${project.id}&view=list&type=task&item=${third.key}`, 1500);
      await page.waitFor(`return !!document.querySelector('.dialog-drawer .workitem-title')`, { label: 'the panel on the list' });
      // Radix opens a menu on pointerdown, which a synthetic click is not: the keyboard's way
      await page.focus('.dialog-drawer button[aria-label="More actions"]');
      await page.press('Enter');
      await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the item menu' });
      await page.click('[role=menu] [role=menuitem]', 'Delete the task', 500);
      await page.click('[role=dialog] .btn-danger-solid', undefined, 1200);
      await page.waitFor(`const q = new URLSearchParams(location.search); return location.pathname === '/tasks' && q.get('view') === 'list' && q.get('type') === 'task' && !q.has('item')`, { label: 'the list with its filter after a delete' });
    });

    await part('Move to Done asks while criteria are unchecked', async () => {
      await page.goto(`/tasks/${first.key}`, 1500);
      await page.waitFor(`return !!document.querySelector('.workitem-done')`, { label: 'the page' });
      await page.click('.workitem-done', undefined, 500);
      await page.waitFor(`return [...document.querySelectorAll('[role=dialog] h2')].some((h) => h.textContent.includes('to Done?'))`, { label: 'the unchecked criteria question' });
      await page.click('[role=dialog] .btn', 'Cancel', 400);
      check((await api.get(`/work-items/${first.id}`)).body.status === 'todo', 'cancelled, the item did not move');
    });

    await part('a tied document is untied, and the file stays (24)', async () => {
      await page.click('.workitem-doc-untie', undefined, 1200);
      await until(async () => !(await api.get(`/work-items/${first.id}`)).body.links.some((l) => l.kind === 'document'), 'untied');
      check((await api.get(`/projects/${project.id}/documents/file?path=${encodeURIComponent('docs/spec.md')}`)).status === 200, 'the file stays');
    });

    await part('an open item follows a new prefix (key-rename)', async () => {
      await api.request('PATCH', `/projects/${project.id}`, { key: 'REV' });
      await page.waitFor(`return location.pathname === '/tasks/REV-' + ${JSON.stringify(first.key.split('-')[1])}`, { label: 'the address follows the new key' });
      check(await page.eval(`return !!document.querySelector('.workitem-title h1')`), 'and the item is still shown');
    });

    await part('the save shortcut names the keyboard (30)', async () => {
      await page.goto(`/?project=${project.id}&view=documents&doc=docs/spec.md&mode=edit`, 1500);
      const kbd = await page.waitFor(`return document.querySelector('.doc-pane-foot .kbd')?.textContent`, { label: 'the save shortcut' });
      const mac = await page.eval(`return /mac|iphone|ipad/i.test(navigator.platform)`);
      check(kbd === (mac ? '⌘S' : 'Ctrl+S'), `the shortcut as this keyboard names it (${kbd})`);
    });

    await part('New task on a project whose Board is off asks for one that has it (22)', async () => {
      if (other?.id) {
        await page.goto(`/tasks?project=${other.id}&new=1`, 1500);
        await page.waitFor(`return !!document.querySelector('.newtask-form [role=combobox], .newtask-form .select-trigger[aria-label="Project"]')`, { label: 'the project picker' });
      }
    });

    await part("the phone: labels at 16 px and 44 px, the sheet's close at 44 px (29)", async () => {
      await page.viewport(390, 844);
      await page.goto(`/tasks/REV-${second.key.split('-')[1]}`, 1500);
      await page.waitFor(`return !!document.querySelector('.workitem-label-add')`, { label: 'the phone page' });
      const addLabel = await page.eval(`const r = document.querySelector('.workitem-label-add').getBoundingClientRect(); return [r.width, r.height]`);
      check(addLabel[0] >= 44 && addLabel[1] >= 44, `the add-label button is a 44 px target (${addLabel})`);
      await page.click('.workitem-label-add', undefined, 300);
      const font = await page.eval(`return parseFloat(getComputedStyle(document.querySelector('.workitem-label-input')).fontSize)`);
      check(font >= 16, `the label input is 16 px, so iOS does not zoom (${font})`);
      await page.key('Escape');
      await page.click('.workitem-chips .workitem-chip', undefined, 500);
      const close = await page.waitFor(`const b = document.querySelector('.sheet-head .icon-btn'); return b && b.getBoundingClientRect().height`, { label: 'the sheet' });
      check(close >= 44, `the sheet's close button is 44 px (${close})`);
      await page.key('Escape');
    });
  } finally {
    await page.viewport(1440, 900);
    for (const id of made) await api.del(`/projects/${id}`).catch(() => {});
  }
};
