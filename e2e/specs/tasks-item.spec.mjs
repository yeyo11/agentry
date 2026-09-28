// A work item's page, end to end against the fake CLI (e2e/fake-cli): every field edited in place
// and read back from the API, the acceptance checklist, relations, comments and the history, "Work
// on it" starting a real chat that moves the item to In review when its turn ends well, "Move to
// Done", and the New task form on both sizes. The phone checks the page's own bar, 44 px targets
// and a whole-row checklist.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 240_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls this side of the browser (the API) until `condition` holds. */
async function until(condition, label, limit = 15_000) {
  const end = Date.now() + limit;
  for (;;) {
    const value = await condition().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(200);
  }
}

/** Opens the menu behind a trigger the way a keyboard does (Radix opens on pointerdown, not on a synthetic click). */
async function openMenu(page, selector) {
  await page.focus(selector);
  await page.press('Enter');
  await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: `the menu of ${selector}` });
}

async function pick(page, selector, option) {
  await openMenu(page, selector);
  await page.click('[role=menu] [role=menuitemcheckbox]', option, 600);
}

const prop = (name) => `.workitem-props .prop-edit[aria-label^="${name}:"]`;

export default async ({ page, api, check, dirs }) => {
  let projectId = null;
  let chatId = null;
  const item = async (id) => (await api.get(`/work-items/${id}`)).body;
  try {
    const dir = join(dirs.workspaceDir, 'e2e-tasks-item');
    mkdirSync(dir, { recursive: true });
    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-tasks-item', template: 'software' });
    check(imported.status === 201 && imported.body.modules.includes('board'), `a project with its board (${imported.status})`);
    projectId = imported.body.id;
    const make = async (body) => {
      const made = await api.post(`/projects/${projectId}/work-items`, body);
      check(made.status === 201, `"${body.title}" was created (${made.status} ${JSON.stringify(made.body)})`);
      return made.body;
    };
    const epic = await make({ title: 'Project ecosystem', type: 'epic' });
    const main = await make({ title: 'Project templates', type: 'story', description: 'A new project picks a **template**.' });
    const other = await make({ title: 'Link tasks with chats' });
    const milestone = (await api.post(`/projects/${projectId}/milestones`, { name: 'v0.20' })).body;
    check(Boolean(milestone?.id), 'a milestone');

    // ---- the page, on a desktop ----
    await page.viewport(1440, 1000);
    await page.goto(`/tasks/${main.key}?project=${projectId}`, 1500);
    await page.waitFor(`return document.querySelector('main h1')?.textContent.trim() === 'Project templates'`, { label: 'the title is the heading' });
    check((await page.text('main .workitem-head .workitem-key.boxed')).trim() === main.key, 'the key heads the page, boxed');
    check((await page.text('main .workitem-status-badge')).trim().toLowerCase() === 'backlog', 'its column is a badge with its word');
    check((await page.text('main .workitem-description-text')).includes('template'), 'the description is rendered Markdown');
    // The Markdown renderer is its own chunk: the plain text stands in until it has loaded
    await page.waitFor(`return !!document.querySelector('main .workitem-description-text strong')`, { label: 'Markdown marks render' });
    check(await page.eval(`return !document.querySelector('.tabbar')`), 'no tab bar on a desktop');

    // Every field edits in place and persists
    await pick(page, prop('Priority'), 'High');
    await until(async () => (await item(main.id)).priority === 'high', 'the priority saved');
    await pick(page, prop('Status'), 'To do');
    await until(async () => (await item(main.id)).status === 'todo', 'the column saved');
    await page.waitFor(`return document.querySelector('main .workitem-status-badge')?.textContent.trim().toLowerCase() === 'to do'`, { label: 'the badge follows' });
    await pick(page, prop('Type'), 'Bug');
    await until(async () => (await item(main.id)).type === 'bug', 'the type saved');
    await pick(page, prop('Assignee'), 'No assignee');
    await pick(page, prop('Epic'), 'Project ecosystem');
    await until(async () => (await item(main.id)).epicId === epic.id, 'the epic saved');
    await page.waitFor(`return document.querySelector('.workitem-props .workitem-epic')?.textContent.includes('Project ecosystem')`, { label: 'the epic label shows' });
    await pick(page, prop('Milestone'), 'v0.20');
    await until(async () => (await item(main.id)).milestoneId === milestone.id, 'the milestone saved');
    await page.click('.workitem-props .workitem-label-add', undefined, 300);
    await page.fill('.workitem-props .workitem-label-input', 'web');
    await page.press('Enter');
    await until(async () => (await item(main.id)).labels.includes('web'), 'the label saved');

    // The title and the description, in the app's own editors
    await page.click('main .workitem-title .workitem-edit', undefined, 300);
    await page.fill('main .workitem-title-input', 'Project templates, five of them');
    await page.press('Enter');
    await until(async () => (await item(main.id)).title === 'Project templates, five of them', 'the title saved');
    await page.click('main .workitem-description .workitem-edit', undefined, 600);
    await page.waitFor(`return !!document.querySelector('main .workitem-description .cm-content')`, { label: 'the description opens in the code editor' });
    await page.focus('main .workitem-description .cm-content');
    // The cursor opens at the start: the new line goes first
    await page.type('Simple has no modules.\n\n');
    await page.click('main .workitem-edit-actions .btn', 'Save', 600);
    await until(async () => (await item(main.id)).description.includes('Simple has no modules.'), 'the description saved');

    // The acceptance checklist: add two, check one, and the row says who
    await page.click('main .workitem-section .workitem-add', 'Add criterion', 400);
    await page.fill('main .criteria-editor input', 'Five built-in templates');
    await page.click('main .criteria-editor .workitem-add', 'Add criterion', 300);
    await page.eval(`const inputs=[...document.querySelectorAll('main .criteria-editor input')];return inputs.length === 2`);
    await page.fill('main .criteria-editor .criteria-editor-row:nth-child(2) input', 'Imported projects keep modules off');
    await page.click('main .criteria-editor button[type=submit]', undefined, 600);
    await until(async () => (await item(main.id)).acceptanceCriteria.length === 2, 'two criteria saved');
    await page.waitFor(`return document.querySelectorAll('main .criterion-row').length === 2`, { label: 'the checklist shows them' });
    await page.click('main .criterion-row .criterion-text', 'Five built-in templates', 600);
    await until(async () => (await item(main.id)).acceptanceCriteria.find((c) => c.text === 'Five built-in templates')?.checked === true, 'a click on the row checks it');
    await page.waitFor(`return !!document.querySelector('main .criterion-row.on .criterion-by')`, { label: 'the checked row says who checked it' });
    check((await page.text('main .workitem-section-head .tnum')).startsWith('1/2'), 'the checklist counts what is checked');

    // Relations: blocks, and taken off again
    await page.click('main .workitem-section .workitem-add', 'Relate', 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .relation-dialog')`, { label: 'the relation dialog' });
    await page.click('[role=dialog] [role=radio]', 'Blocks', 300);
    await page.fill('[role=dialog] .relation-search input', other.key);
    await page.click('[role=dialog] .relation-pick', other.key, 600);
    await until(async () => (await item(main.id)).relations.some((r) => r.type === 'blocks' && r.item.id === other.id), 'the relation saved');
    await until(async () => (await item(other.id)).relations.some((r) => r.type === 'blocked_by' && r.item.id === main.id), 'the other end says blocked by');
    await page.waitFor(`return document.querySelector('main .relation-row .relation-kind')?.textContent.trim().toLowerCase() === 'blocks'`, { label: 'the row shows' });
    await page.click(`main .relation-remove[aria-label$="${other.key}"]`, undefined, 600);
    await until(async () => (await item(main.id)).relations.length === 0, 'the relation removed');

    // A comment, and the history the edits wrote
    await page.fill('main .comment-box textarea', 'Check criterion 2 against an imported project.');
    await page.click('main .comment-box button[type=submit]', undefined, 600);
    await until(async () => (await item(main.id)).comments.length === 1, 'the comment saved');
    await page.waitFor(`return document.querySelector('main .activity .comment .comment-text')?.textContent.includes('imported project')`, { label: 'the comment shows' });
    await page.click('main .workitem-activity [role=radio]', 'History', 400);
    const history = await page.text('main .activity');
    check(/Moved from Backlog to\s+To do/.test(history), `the history names the move (${history.slice(0, 200)})`);
    check(!(await page.eval(`return !!document.querySelector('main .activity .comment')`)), 'History leaves the comments out');
    await page.click('main .workitem-activity [role=radio]', 'All', 300);
    await page.shot('tasks-item-desktop');

    // ---- "Work on it": a chat through the API, which moves the item as its turn goes ----
    await page.click('main .workitem-head .workitem-work', 'Work on it', 600);
    await page.waitFor(`return !!document.querySelector('[role=dialog]')?.textContent.includes('task/${main.key.toLowerCase()}')`, { label: 'the start options name the branch' });
    await page.click('[role=dialog] .dialog-foot .btn-primary', 'Start the chat', 1200);
    chatId = await page.waitFor(`const m = location.pathname.match(/^\\/chats\\/([^/]+)$/); return m ? m[1] : null`, { label: 'the chat opens', timeout: 20_000 });
    await until(async () => (await item(main.id)).links.some((l) => l.chatId === chatId && l.role === 'work'), 'the chat is linked to the item');
    await until(async () => (await item(main.id)).status === 'in_review', 'the turn ended well and the item is in review', 30_000);
    const prompt = await until(async () => (await api.get(`/chats/${chatId}`)).body?.chat?.firstPrompt ?? null, 'the chat has its prompt');
    check(String(prompt).startsWith(`${main.key} · `), `the chat was prompted with the item (${String(prompt).slice(0, 60)})`);
    await page.goto(`/tasks/${main.key}`, 1500);
    await page.waitFor(`return document.querySelectorAll('main .work-link-row').length === 1`, { label: 'the chat is listed on the item' });
    check((await page.text('main .work-link-row .work-link-meta')).includes('took it to In review'), 'the link says what it did');
    const history2 = await page.text('main .activity');
    check(history2.includes('automatic'), 'the automatic moves say so, with their cause');

    // ---- Move to Done is the person's; "Work on it" then says why it is not offered ----
    await page.click('main .workitem-head .workitem-done', 'Move to Done', 600);
    // One criterion is still unchecked: Done asks first, since it means every one is met
    await page.waitFor(`return [...document.querySelectorAll('[role=dialog] h2')].some((h) => h.textContent.includes('to Done?'))`, { label: 'Done asks about the unchecked criterion' });
    await page.click('[role=dialog] .btn-primary', 'Move to Done', 600);
    await until(async () => (await item(main.id)).status === 'done', 'the item is done');
    await page.waitFor(`return !document.querySelector('main .workitem-head .workitem-work') && !!document.querySelector('main .workitem-refusal')`, {
      label: 'Done refuses Work on it, in words',
    });
    check((await page.text('main .workitem-refusal')).includes('Done'), 'the reason is shown');

    // ---- New task: a dialog on a desktop (the board opens it at ?new=1) ----
    await page.goto(`/tasks?new=1&project=${projectId}`, 1500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .newtask-form')`, { label: 'the New task dialog' });
    await page.click('[role=dialog] .newtask-form [role=radio]', 'Bug', 300);
    await page.fill('[role=dialog] input.newtask-title', 'The limit badge overlaps the count');
    await page.fill('[role=dialog] textarea.newtask-description', 'Seen on a **narrow** column.');
    await openMenu(page, '[role=dialog] .newtask-grid .form-row:nth-child(2) .newtask-select');
    await page.click('[role=menu] [role=menuitemcheckbox]', 'Urgent', 500);
    await page.fill('[role=dialog] .newtask-labels input', 'board');
    await page.press('Enter');
    await page.click('[role=dialog] .newtask-add-inline', 'Add criterion', 300);
    await page.fill('[role=dialog] .newtask-criterion-row input', 'The badge never covers the count');
    await page.click('[role=dialog] .newtask-add-inline', 'Relate', 500);
    await page.fill('[role=dialog] .relation-search input', other.key);
    await page.click('[role=dialog] .relation-pick', other.key, 600);
    await page.click('[role=dialog] .dialog-foot .btn-primary', 'Create task', 1200);
    const created = await until(async () => (await api.get(`/projects/${projectId}/work-items?q=${encodeURIComponent('limit badge')}`)).body?.[0], 'the task was created');
    check(created.type === 'bug' && created.priority === 'urgent', `type and priority (${created.type}, ${created.priority})`);
    check(created.labels.includes('board'), 'its label');
    check(created.acceptanceCriteria.length === 1, 'its criterion');
    await until(async () => (await item(created.id)).relations.some((r) => r.type === 'blocked_by' && r.item.id === other.id), 'its relation');

    // ---- the phone ----
    await page.viewport(390, 844);
    await page.goto(`/tasks/${other.key}`, 1500);
    await page.waitFor(`return document.querySelector('main h1')?.textContent.trim() === 'Link tasks with chats'`, { label: 'the page on a phone' });
    check(await page.eval(`return !document.querySelector('.tabbar') && !document.querySelector('.fab')`), 'the page has its own bar instead of the tab bar and the FAB');
    const foot = await page.eval(`const r=document.querySelector('.workitem-mfoot')?.getBoundingClientRect();return r?{bottom:r.bottom,h:r.height}:null`);
    check(foot && foot.bottom <= 845, `the bottom bar is on screen (${JSON.stringify(foot)})`);
    const small = await page.eval(
      `return [...document.querySelectorAll('.workitem-mhead a, .workitem-mhead button, .workitem-chip, .workitem-mfoot .btn, .workitem-layout .segment')]` +
        `.map((el)=>[el.getAttribute('aria-label')||el.textContent.trim(),el.getBoundingClientRect().height]).filter(([,h])=>h>0&&h<44)`,
    );
    check(small.length === 0, `touch targets are at least 44px (${JSON.stringify(small)})`);
    // Its column is picked from a sheet, not a dropdown
    await page.click('.workitem-chips .workitem-chip', 'Backlog', 500);
    await page.waitFor(`return !!document.querySelector('.workitem-picker')`, { label: 'the column sheet' });
    await page.click('.workitem-picker .workitem-picker-option', 'In progress', 600);
    await until(async () => (await item(other.id)).status === 'in_progress', 'moved from the phone');
    await page.click('.workitem-layout .segment', 'Activity', 400);
    check(await page.eval(`return !!document.querySelector('.workitem-mfoot .comment-box')`), 'Activity puts the comment box in the bottom bar');
    await page.click('.workitem-layout .segment', 'Changes', 400);
    await page.waitFor(`return !!document.querySelector('.workitem-mbody .workitem-section')`, { label: 'the Changes section' });
    const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
    check(overflow <= 1, `[390px work item] nothing scrolls sideways (${overflow}px)`);
    await page.shot('tasks-item-phone');

    // New task is a full screen on a phone
    await page.goto(`/tasks?new=1&project=${projectId}`, 1500);
    await page.waitFor(`return !!document.querySelector('.newtask-screen')`, { label: 'the full-screen New task' });
    const inputs = await page.eval(
      `return [...document.querySelectorAll('.newtask-screen input, .newtask-screen textarea')].map((el)=>parseFloat(getComputedStyle(el).fontSize)).filter((s)=>s<16)`,
    );
    check(inputs.length === 0, `inputs are 16px on a phone (${JSON.stringify(inputs)})`);
    await page.click('.newtask-screen .newtask-cancel', 'Cancel', 500);
    check(await page.eval(`return !document.querySelector('.newtask-screen')`), 'Cancel closes it');
  } finally {
    await page.viewport(1440, 900);
    if (chatId) {
      await api.post(`/chats/${chatId}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${chatId}`).catch(() => ({ status: 0 }))).status === 200) break;
        await sleep(250);
      }
    }
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
