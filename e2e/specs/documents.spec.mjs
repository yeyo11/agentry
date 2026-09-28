// The Documents tab of a project (decision 34 of docs/plans/project-ecosystem.md): the folder as a
// tree, a document rendered with where it came from, edited in the one editor and saved, a write an
// agent made meanwhile refused and offered as a reload, the documents tied to tasks, new documents
// blank and from a task, the tab following its module, and the phone's screens.
import { seedEcosystem, seedProject } from './memory-seed.mjs';

export const timeout = 180_000;

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

const param = (name) => `new URLSearchParams(location.search).get(${JSON.stringify(name)})`;

export default async ({ page, api, check, dirs }) => {
  let projectId = null;
  try {
    const project = await seedProject({ api, check, dirs }, 'e2e-documents');
    projectId = project.id;
    const seeded = await seedEcosystem({ api, check, dirs }, project);
    const file = async (path) => (await api.get(`/projects/${projectId}/documents/file?path=${encodeURIComponent(path)}`)).body;

    // ---- a desktop: tree, document, tied list ----
    await page.viewport(1440, 1000);
    await page.goto(`/?project=${projectId}&view=documents`, 1500);
    await page.waitFor(`return !!document.querySelector('.doc-tree')`, { label: 'the tree' });
    const tabs = await page.eval(`return [...document.querySelectorAll('.project-tabs [role=tab]')].map((t) => t.textContent.trim())`);
    const docTab = tabs.findIndex((t) => t.startsWith('Documents'));
    check(docTab > 0 && docTab < tabs.findIndex((t) => t.startsWith('Memory')), `Documents sits before Memory (${JSON.stringify(tabs)})`);
    check(tabs[docTab].endsWith('6'), `the tab counts the documents (${tabs[docTab]})`);
    check((await page.text('.doc-tree')).includes('docs/'), 'the root folder heads the tree');
    check((await page.eval(`return document.querySelectorAll('.doc-tied .doc-row').length`)) === 3, 'three documents are tied to tasks');

    // A tied document opens rendered, with the role and the task it came from
    await page.click('.doc-tied .doc-row', 'Board with fixed columns and limits', 1200);
    await page.waitFor(`return ${param('doc')} === 'docs/specs/board.md'`, { label: 'the address names the document' });
    await page.waitFor(`return document.querySelector('.doc-view .md-h1')?.textContent === 'Board with fixed columns and limits'`, { label: 'the document renders' });
    const origin = await page.text('.doc-origin');
    check(origin.includes('Architect') && origin.includes(seeded.board.key), `the document says who wrote it and from which task (${origin})`);
    check(await page.eval(`return !!document.querySelector('.doc-tree .tree-row-on')`), 'the open file is marked in the tree');

    // Edit and save
    await page.click('.doc-pane-bar [role=radio]', 'Edit', 800);
    await page.waitFor(`return !!document.querySelector('.doc-pane .cm-content')`, { label: 'the editor' });
    await page.focus('.doc-pane .cm-content');
    await page.press('End', 2);
    await page.type('\nSaved from the e2e spec.\n');
    await page.waitFor(`return document.querySelector('.doc-pane-foot')?.textContent.includes('unsaved changes')`, { label: 'unsaved changes are said in words' });
    await page.click('.doc-pane-foot .doc-save', undefined, 800);
    await until(async () => (await file('docs/specs/board.md')).content.includes('Saved from the e2e spec.'), 'the edit was saved');

    // An agent writes the file while the person edits it: saving is refused, and reload takes its version
    await page.focus('.doc-pane .cm-content');
    await page.type('A line the person typed.');
    await api.put(`/projects/${projectId}/documents/file?path=${encodeURIComponent('docs/specs/board.md')}`, { content: '# Board with fixed columns and limits\n\nWritten by an agent.\n' });
    await page.click('.doc-pane-foot .doc-save', undefined, 800);
    await page.waitFor(`return document.querySelector('.doc-pane .alert')?.textContent.includes('changed since you opened it')`, { label: 'the conflict is said' });
    check(!(await file('docs/specs/board.md')).content.includes('A line the person typed.'), "the agent's write was not overwritten");
    await page.click('.doc-pane .alert .btn', 'Reload', 1000);
    await page.waitFor(`return document.querySelector('.doc-pane .cm-content')?.textContent.includes('Written by an agent.')`, { label: "the agent's version is loaded" });
    await page.click('.doc-pane-bar [role=radio]', 'View', 800);

    // A filter narrows the tree to what matches, keeping the folders on the way
    await page.fill('.doc-filter input', 'ADR-007');
    await page.waitFor(`const tree = document.querySelector('.doc-tree')?.textContent ?? ''; return tree.includes('ADR-007-links.md') && tree.includes('adr/') && !tree.includes('status.md')`, {
      label: 'the filter keeps the match and its folder only',
    });
    await page.fill('.doc-filter input', '');

    // A blank document, written and opened in the editor
    await page.click('.doc-new .btn', 'Blank', 600);
    await page.fill('.dialog .doc-new-form input:not(.mono)', 'Release checklist');
    await page.click('.dialog-foot .btn-primary', 'Create and edit', 1200);
    await until(async () => (await file('docs/release-checklist.md'))?.content?.startsWith('# Release checklist'), 'the blank document was written');
    await page.waitFor(`return ${param('doc')} === 'docs/release-checklist.md' && ${param('mode')} === 'edit'`, { label: 'it opens in the editor' });

    // A document from a task is tied to it from the start, with its kind
    await page.click('.doc-new .btn', 'From a task', 600);
    await page.fill('.dialog .relation-search input', seeded.cost.title.slice(0, 12));
    await page.click('.dialog .relation-pick', seeded.cost.key, 600);
    await page.click('.dialog-foot .btn-primary', 'Create and edit', 1500);
    const tied = await until(async () => {
      const item = (await api.get(`/work-items/${seeded.cost.id}`)).body;
      return item.links.find((l) => l.kind === 'document' && l.documentKind === 'spec');
    }, 'the new document is tied to the task');
    check(tied.documentPath.startsWith('docs/specs/'), `a specification goes under specs/ (${tied.documentPath})`);

    // The tab follows its module: off, it is gone and its address lands on Resumen; the files stay
    const settings = (await api.get(`/projects/${projectId}/settings`)).body;
    await api.put(`/projects/${projectId}/settings`, { ...settings, modules: settings.modules.filter((m) => m !== 'documents') });
    await page.goto(`/?project=${projectId}&view=documents`, 1500);
    await page.waitFor(`return ${param('view')} === null`, { label: 'a hidden tab lands on Resumen' });
    check(!(await page.eval(`return [...document.querySelectorAll('.project-tabs [role=tab]')].some((t) => t.textContent.startsWith('Documents'))`)), 'no Documents tab while the module is off');
    check((await file('docs/status.md')).content.includes('Status'), 'switching the module off keeps the files');
    await api.put(`/projects/${projectId}/settings`, settings);

    // ---- a phone: the list, a folder, a document, its editor ----
    await page.viewport(390, 844);
    await page.goto(`/?project=${projectId}&view=documents`, 1500);
    await page.waitFor(`return document.querySelectorAll('.doc-cells .doc-cell').length > 0`, { label: 'the folder as cells' });
    const small = await page.eval(`return [...document.querySelectorAll('.doc-cell, .doc-phone .doc-row')].filter((el) => el.getBoundingClientRect().height < 44).length`);
    check(small === 0, 'every cell is at least 44 px');
    const fontSize = await page.eval(`return getComputedStyle(document.querySelector('.doc-filter-phone input')).fontSize`);
    check(fontSize === '16px', `the search is 16 px on a phone (${fontSize})`);
    await page.click('.doc-cell', 'specs/', 800);
    await page.waitFor(`return ${param('dir')} === 'docs/specs'`, { label: 'the folder opens' });
    await page.click('.doc-cell', 'board.md', 1200);
    await page.waitFor(`return !!document.querySelector('.doc-phone-head h1') && !!document.querySelector('.doc-view')`, { label: 'the document screen' });
    check(await page.eval(`return !document.querySelector('.project-head-phone')`), "the document heads its own screen, without the tab's bar");
    check(!(await page.eval(`return document.querySelector('.topbar').getClientRects().length > 0`)), 'and without the top bar (MobileDocumento)');
    // "Edit" is the screen's bar at the bottom edge, however short the document (MobileDocumento)
    const foot = await page.eval(`const r = document.querySelector('.doc-phone-view > .doc-phone-foot').getBoundingClientRect(); return { bottom: r.bottom, width: r.width }`);
    check(Math.abs(foot.bottom - 844) <= 1 && foot.width >= 389, `the Edit bar spans the bottom of the screen (${JSON.stringify(foot)})`);
    await page.click('.doc-phone-foot .btn', 'Edit', 1200);
    await page.waitFor(`return !!document.querySelector('.doc-phone-edit .cm-content')`, { label: 'the editor on a phone' });
    await page.click('.doc-phone-cancel', 'Cancel', 800);
    await page.waitFor(`return ${param('mode')} === null && !!document.querySelector('.doc-phone-view')`, { label: 'Cancel goes back to the document' });
  } finally {
    await page.viewport(1440, 900);
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
