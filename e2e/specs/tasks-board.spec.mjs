// The Tasks board (web-board): five fixed columns with counts and limits, cards that say what they
// are, moves by keyboard and by drag that persist across a reload, a move made through the API that
// shows without one, filters kept in the address, selection handed to the orchestration editor, the
// list, All projects, milestones, the empty board, and the phone's board without columns side by side.
// An epic is on the board but in no count: not a column's, the subtitle's nor the phone's jump.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** The column a card is drawn in, by its key, on the desktop board */
const columnOf = (key) =>
  `([...document.querySelectorAll('.workitem-col')].find((c) => [...c.querySelectorAll('.workitem-key')].some((k) => k.textContent === ${JSON.stringify(key)}))?.dataset.status ?? null)`;
/** The keys drawn in a column, top to bottom */
const keysIn = (status) => `[...document.querySelectorAll('.workitem-col[data-status="${status}"] [data-item-id] .workitem-key')].map((k) => k.textContent)`;

export default async ({ page, api, check, dirs }) => {
  const made = [];
  const patch = (path, body) => api.request('PATCH', path, body);
  try {
    // ---- a project with a board, a limit, an epic, a relation and a milestone ----
    const dir = join(dirs.workspaceDir, 'e2e-board');
    mkdirSync(dir, { recursive: true });
    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-board', template: 'software' });
    check(imported.status === 201, `a project with a board was imported (${imported.status})`);
    const project = imported.body;
    made.push(project.id);
    const settings = (await api.get(`/projects/${project.id}/settings`)).body;
    await api.put(`/projects/${project.id}/settings`, { ...settings, board: { ...settings.board, columnLimits: { in_progress: 1 } } });

    const add = async (req, status) => {
      const created = await api.post(`/projects/${project.id}/work-items`, req);
      check(created.status === 201, `"${req.title}" was created (${created.status})`);
      if (status) await api.post(`/work-items/${created.body.id}/move`, { status });
      return created.body;
    };
    const epic = await add({ type: 'epic', title: 'Board epic' }, 'todo');
    const first = await add({ title: 'First card', labels: ['web'], epicId: epic.id, acceptanceCriteria: [{ text: 'one' }, { text: 'two' }] });
    const second = await add({ type: 'bug', title: 'Second card', priority: 'urgent' });
    const third = await add({ title: 'Third card', priority: 'high' }, 'in_progress');
    const fourth = await add({ title: 'Fourth card' }, 'in_progress');
    const blocker = await add({ title: 'Blocking card' }, 'todo');
    await api.post(`/work-items/${blocker.id}/relations`, { type: 'blocks', itemId: second.id });
    const milestone = (await api.post(`/projects/${project.id}/milestones`, { name: 'v9.9', description: 'The e2e milestone' })).body;
    await patch(`/work-items/${first.id}`, { milestoneId: milestone.id });
    await patch(`/work-items/${third.id}`, { milestoneId: milestone.id });

    // ---- the board ----
    await page.viewport(1440, 900);
    await page.goto(`/tasks?project=${project.id}`, 1200);
    await page.waitFor(`return document.querySelectorAll('.workitem-col').length === 5 && !!document.querySelector('[data-item-id]')`, { label: 'the board' });
    const order = await page.eval(`return [...document.querySelectorAll('.workitem-col')].map((c) => c.dataset.status)`);
    check(JSON.stringify(order) === JSON.stringify(['backlog', 'todo', 'in_progress', 'in_review', 'done']), `five fixed columns in order (${order})`);
    const over = await page.eval(`const c = document.querySelector('.workitem-col[data-status="in_progress"]'); return { over: c.classList.contains('is-over'), note: c.querySelector('.workitem-col-limit')?.textContent.trim() ?? null, count: c.querySelector('.workitem-col-count [aria-hidden]')?.textContent }`);
    check(over.over && over.note === 'Over the limit: 2 of 1' && over.count === '2/1', `a column over its limit says so in words (${JSON.stringify(over)})`);
    const card = await page.eval(
      `const c = document.querySelector('[data-item-id="${first.id}"]'); return { key: c.querySelector('.workitem-key')?.textContent, title: c.querySelector('.workitem-card-title')?.textContent, epic: c.querySelector('.workitem-epic')?.textContent, label: c.querySelector('.workitem-tag')?.textContent, prio: c.querySelector('.priority-mark')?.getAttribute('aria-label'), criteria: c.querySelector('.workitem-criteria')?.textContent, rows: [...c.children].map((row) => row.className.split(' ')[0]) }`,
    );
    check(card.key === first.key && card.title === 'First card' && card.epic === 'Board epic' && card.label === 'web', `a card shows its key, title, epic and labels (${JSON.stringify(card)})`);
    check(card.prio === 'Medium priority' && card.criteria?.startsWith('0/2'), `and its priority in words and its checklist (${JSON.stringify(card)})`);
    // DSTablero: what it is, the title, where it goes, then its facts; no strip on a card at rest
    check(JSON.stringify(card.rows) === JSON.stringify(['workitem-card-top', 'workitem-card-title', 'workitem-context', 'workitem-card-foot']), `a card reads in its rows, in order (${card.rows})`);
    const limitLine = await page.eval(`const l = document.querySelector('.workitem-col.is-over .workitem-col-limit'); const s = getComputedStyle(l); return { bg: s.backgroundColor, rule: getComputedStyle(l.closest('.workitem-col')).boxShadow }`);
    check(limitLine.bg === 'rgba(0, 0, 0, 0)' && limitLine.rule.includes('inset'), `the over-limit column is a hairline and a line of words, not a tinted box (${JSON.stringify(limitLine)})`);
    const urgent = await page.eval(`return getComputedStyle(document.querySelector('[data-item-id="${second.id}"] .priority-mark')).color`);
    const medium = await page.eval(`return getComputedStyle(document.querySelector('[data-item-id="${first.id}"] .priority-mark')).color`);
    check(urgent !== medium, 'urgent is the one priority drawn in a colour');
    const blocked = await page.eval(`return document.querySelector('[data-item-id="${second.id}"] .workitem-fact.is-blocked')?.getAttribute('title')`);
    check(blocked === `Blocked by ${blocker.key}`, `a blocked card names its blocker (${blocked})`);
    const epicCard = await page.eval(`return document.querySelector('[data-item-id="${epic.id}"] .workitem-card-epic')?.textContent`);
    check(epicCard === '0/1 tasks', `an epic's card counts its items (${epicCard})`);
    // An epic groups work rather than being some: it is on the board but in no count
    const todoCount = await page.eval(`return document.querySelector('.workitem-col[data-status="todo"] .workitem-col-count [aria-hidden]')?.textContent`);
    check(todoCount === '1', `To do counts the blocker, not the epic beside it (${todoCount})`);
    const sub = await page.text('main .workitem-head-sub');
    check(sub.includes('5 open'), `the subtitle's open items leave the epic out (${sub})`);
    check((await page.eval(`return document.querySelectorAll('.workitem-card.live-rail, .workitem-card .spinner-ring').length`)) === 0, 'a board at rest has nothing live on it');

    // ---- a card opens in the panel beside the board, and the board stays ----
    await page.click(`[data-item-id="${second.id}"] .workitem-key`, undefined, 800);
    await page.waitFor(`return location.pathname === '/tasks' && new URLSearchParams(location.search).get('item') === ${JSON.stringify(second.key)}`, { label: 'the card opens its panel' });
    await page.waitFor(`return document.querySelector('[role=dialog]')?.innerText.includes('Second card')`, { label: 'the panel shows the item' });
    check(await page.eval(`return document.querySelectorAll('.workitem-col').length === 5`), 'the board stays under the panel');
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('[role=dialog]') && !location.search.includes('item=')`, { label: 'Escape closes the panel' });

    // ---- moving by keyboard: Space picks it up, the arrows carry it, Space drops it ----
    await page.focus(`[data-item-id="${first.id}"]`);
    await page.press(' ');
    const picked = await page.text('.workitem-announce');
    check(picked.includes(`${first.key} picked up in Backlog`), `picking a card up is announced (${picked})`);
    await page.press('ArrowRight');
    check((await page.eval(`return ${columnOf(first.key)}`)) === 'todo', 'the arrow carries it into the next column');
    check((await page.eval(`return document.activeElement?.dataset.itemId`)) === first.id, 'and the card keeps the focus');
    await page.press('ArrowUp');
    await page.press(' ');
    await page.waitFor(`return (await fetch('/api/work-items/${first.id}').then((r) => r.json())).status === 'todo'`, { label: 'the move reached the API' });
    const todo = (await api.get(`/projects/${project.id}/work-items/board`)).body.columns.find((c) => c.status === 'todo').items.map((i) => i.id);
    check(todo[0] === first.id, `it landed first in To do, as dropped (${todo})`);
    // Escape puts it back
    await page.focus(`[data-item-id="${first.id}"]`);
    await page.press(' ');
    await page.press('ArrowRight');
    await page.press('Escape');
    check((await page.eval(`return ${columnOf(first.key)}`)) === 'todo', 'Escape puts the card back');

    // ---- moving by drag, inside a column ----
    const dragged = await page.eval(`
      const card = document.querySelector('[data-item-id="${fourth.id}"]');
      const body = card.closest('.workitem-col-body');
      const top = body.querySelector('[data-item-id]').getBoundingClientRect();
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      await new Promise((r) => setTimeout(r, 50));
      const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: top.left + 10, clientY: top.top + 2 };
      body.dispatchEvent(new DragEvent('dragover', at));
      await new Promise((r) => setTimeout(r, 50));
      const line = !!body.querySelector('.workitem-drop');
      body.dispatchEvent(new DragEvent('drop', at));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return line;`);
    check(dragged, 'dragging over a column draws where the card will land');
    await page.waitFor(`return JSON.stringify(${keysIn('in_progress')}) === ${JSON.stringify(JSON.stringify([fourth.key, third.key]))}`, { label: 'the dragged card is first in its column' });
    await page.goto(`/tasks?project=${project.id}`, 1200);
    await page.waitFor(`return JSON.stringify(${keysIn('in_progress')}) === ${JSON.stringify(JSON.stringify([fourth.key, third.key]))} && ${columnOf(first.key)} === 'todo'`, { label: 'both moves survive a reload' });

    // ---- a move made through the API shows without a reload ----
    await api.post(`/work-items/${second.id}/move`, { status: 'in_review' });
    await page.waitFor(`return ${columnOf(second.key)} === 'in_review'`, { label: 'a move made elsewhere shows on the open board' });

    // ---- filters live in the address ----
    await page.goto(`/tasks?project=${project.id}&type=bug`, 1200);
    await page.waitFor(`return document.querySelectorAll('[data-item-id]').length === 1`, { label: 'the type filter from the address' });
    check((await page.text('.workitem-facet.is-on .chip')).trim() === 'Type: Bug', 'the chip says the filter in force');
    await page.click('.workitem-facet-x', undefined, 800);
    check(!(await page.eval(`return location.search.includes('type=')`)), 'taking the chip off takes it out of the address');
    await page.key('/');
    check((await page.eval(`return document.activeElement?.closest('.workitem-search') !== null`)) === true, '/ focuses the search');
    await page.type('Third');
    await page.waitFor(`return location.search.includes('q=Third') && document.querySelectorAll('[data-item-id]').length === 1`, { label: 'the search narrows the board and is kept in the address' });
    // Kept until it is reset, as every list's filters are: a bare visit finds the search again
    await page.goto(`/tasks?project=${project.id}`, 1200);
    await page.waitFor(`return location.search.includes('q=Third') && document.querySelectorAll('[data-item-id]').length === 1`, { label: 'the search comes back on a later visit' });
    await page.eval(`const i = document.querySelector('.workitem-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return true`);
    await page.waitFor(`return !location.search.includes('q=') && document.querySelectorAll('[data-item-id]').length > 1`, { label: 'emptying the search takes it out of the address' });
    check((await page.eval(`return Object.keys(localStorage).filter((k) => k.startsWith('agentry:filters:tasks:')).length`)) === 0, 'and out of what the list keeps');

    // ---- selection and "Orchestrate" ----
    await page.goto(`/tasks?project=${project.id}`, 1200);
    await page.click('.workitem-select', undefined, 400);
    check((await page.eval(`return document.querySelector('.workitem-select').getAttribute('aria-pressed')`)) === 'true', 'Select is pressed');
    const epicPick = await page.eval(`return document.querySelector('[data-item-id="${epic.id}"]').getAttribute('aria-disabled')`);
    check(epicPick === 'true', 'an epic cannot be picked');
    await page.click(`[data-item-id="${blocker.id}"]`, undefined, 200);
    await page.click(`[data-item-id="${first.id}"]`, undefined, 300);
    const bar = await page.text('.selection-bar');
    check(bar.includes('2 selected'), `the selection bar counts the picks (${bar})`);
    check((await page.eval(`return document.querySelector('[data-item-id="${first.id}"]').getAttribute('aria-checked')`)) === 'true', 'a picked card is checked');
    await page.click('.selection-bar .btn-primary', undefined, 1500);
    check((await page.eval(`return location.pathname`)) === '/orchestration', 'Orchestrate opens the orchestration editor with the draft');

    // ---- the list ----
    await page.goto(`/tasks?project=${project.id}&view=list`, 1200);
    await page.waitFor(`return document.querySelectorAll('.workitem-row').length === 6`, { label: 'the list shows every item' });
    const groups = await page.eval(`return [...document.querySelectorAll('.workitem-list-group')].map((g) => g.getAttribute('aria-label'))`);
    check(JSON.stringify(groups) === JSON.stringify(['To do', 'In progress', 'In review']), `the list is grouped by column, empty ones left out (${groups})`);
    await page.focus('.workitem-row');
    await page.key('j');
    check((await page.eval(`return [...document.querySelectorAll('.workitem-row')].indexOf(document.activeElement)`)) === 1, 'J moves to the next row');

    // ---- milestones ----
    await page.goto(`/tasks/milestones?project=${project.id}`, 1200);
    await page.waitFor(`return document.querySelector('.milestone-card .milestone-name')?.textContent === 'v9.9'`, { label: 'the open milestone' });
    const pct = await page.text('.milestone-card .milestone-pct');
    check(pct.trim() === '0%', `its progress comes from its items (${pct})`);
    check((await page.eval(`return document.querySelector('.milestone-card').classList.contains('grad-border')`)) === true, 'the first open milestone is what the screen is about');
    await patch(`/milestones/${milestone.id}`, { state: 'closed' });
    await page.waitFor(`return !!document.querySelector('.milestone-rows .badge-ok')`, { label: 'a closed milestone moves to the closed rows' });
    check(!(await page.text('main')).match(/\b20\d\d-\d\d-\d\d\b/), 'no date anywhere');

    // ---- All projects ----
    await page.goto('/tasks?project=all', 1200);
    await page.waitFor(`return !!document.querySelector('[data-item-id="${first.id}"] .workitem-project')`, { label: 'each card names its project' });
    check((await page.eval(`return document.querySelectorAll('.workitem-col-limit, .workitem-col-add').length`)) === 0, 'All projects has no column limits and no per-column New task');

    // ---- an empty board ----
    const emptyDir = join(dirs.workspaceDir, 'e2e-board-empty');
    mkdirSync(emptyDir, { recursive: true });
    const empty = (await api.post('/projects/import', { path: emptyDir, name: 'e2e-board-empty', template: 'software' })).body;
    made.push(empty.id);
    await page.goto(`/tasks?project=${empty.id}`, 1200);
    await page.waitFor(`return document.querySelector('.workitem-empty .state-illustrated strong')?.textContent === 'No tasks yet'`, { label: 'the empty board' });
    const drawn = await page.eval(`return document.querySelector('.workitem-empty svg[data-illustration=board] text')?.textContent`);
    check(drawn === `${empty.key}-1`, `the empty board draws the project's own first key (${drawn}, ${empty.key})`);
    check((await page.text('.workitem-empty .btn-primary')).trim() === 'Create the first task', 'it offers to create the first task');

    // ---- Done and the list are paged: cards carry no description (gap 20) ----
    const pagedDir = join(dirs.workspaceDir, 'e2e-board-paged');
    mkdirSync(pagedDir, { recursive: true });
    const paged = (await api.post('/projects/import', { path: pagedDir, name: 'e2e-board-paged', template: 'software' })).body;
    made.push(paged.id);
    for (let i = 0; i < 105; i++) await api.post(`/projects/${paged.id}/work-items`, { title: `Open ${i}`, description: 'A description the board does not carry' });
    for (let i = 0; i < 25; i++) await api.post(`/projects/${paged.id}/work-items`, { title: `Closed ${i}`, status: 'done' });
    const pagedBoard = (await api.get(`/projects/${paged.id}/work-items/board`)).body;
    const pagedDone = pagedBoard.columns.find((c) => c.status === 'done');
    check(pagedDone.items.length === 20 && pagedDone.more === 5 && pagedDone.count === 25, `the board holds the newest 20 done items and counts the rest (${pagedDone.items.length}, ${pagedDone.more})`);
    check(pagedBoard.columns[0].items.every((i) => i.description === '' && i.hasDescription === true), 'cards leave their description out and say they have one');
    await page.goto(`/tasks?project=${paged.id}`, 1500);
    const doneCards = `document.querySelectorAll('.workitem-col[data-status="done"] [data-item-id]').length`;
    const doneMore = `(document.querySelector('.workitem-col[data-status="done"] .workitem-col-more')?.textContent.trim() ?? null)`;
    await page.waitFor(`return ${doneCards} === 3 && ${doneMore} === 'Show 22 more'`, { label: 'Done draws its first three and counts every other one, loaded or not' });
    check((await page.eval(`return document.querySelector('.workitem-col[data-status="done"] .workitem-col-more').tagName`)) === 'BUTTON', '"Show N more" is a button that stays on the board');
    await page.click('.workitem-col[data-status="done"] .workitem-col-more', undefined, 600);
    await page.waitFor(`return ${doneCards} === 20 && ${doneMore} === 'Show 5 more'`, { label: 'the page the board holds, then what the server left out' });
    await page.click('.workitem-col[data-status="done"] .workitem-col-more', undefined, 1200);
    await page.waitFor(`return ${doneCards} === 25 && ${doneMore} === null`, { label: 'the next page, asked of the server' });
    check((await page.eval(`return location.pathname + location.search`)) === `/tasks?project=${paged.id}`, 'and the board stays where it is');
    await page.goto(`/tasks?project=${paged.id}&view=list`, 1500);
    await page.waitFor(`return document.querySelectorAll('.workitem-row').length === 100 && !!document.querySelector('.workitem-list-load')`, { label: 'the list reads its first 100 rows' });
    check((await page.eval(`return document.querySelector('.workitem-list-group .workitem-col-count')?.textContent`)) === '105', 'a group counts every row it has, read or not');
    await page.eval(`document.querySelector('.workitem-list-load').scrollIntoView(); return true`);
    await page.waitFor(`return document.querySelectorAll('.workitem-row').length === 108 && !document.querySelector('.workitem-list-load')`, {
      label: 'the next page loads at the end of the list: every open row and the first three done',
    });
    await page.click('.workitem-list-more', undefined, 600);
    await page.waitFor(`return document.querySelectorAll('.workitem-row').length === 130`, { label: 'Done unfolds whole' });

    // ---- a phone: no horizontal board ----
    await page.viewport(390, 844);
    await page.goto(`/tasks?project=${project.id}`, 1400);
    await page.waitFor(`return document.querySelectorAll('.workitem-msection').length === 5`, { label: 'the phone board is one list of sections' });
    check(!(await page.eval(`return !!document.querySelector('.workitem-board')`)), 'no columns side by side on a phone');
    const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
    check(overflow <= 1, `nothing scrolls sideways (${overflow}px)`);
    const jumps = await page.eval(`return [...document.querySelectorAll('.workitem-jump [role=radio]')].map((b) => b.getBoundingClientRect().height)`);
    check(jumps.length === 5 && jumps.every((h) => h >= 44), `the column jump has five 44px targets (${jumps})`);
    const jumpCounts = await page.eval(`return [...document.querySelectorAll('.workitem-jump .workitem-jump-count')].map((c) => c.textContent)`);
    // To do holds the blocker, the first card (moved there by keyboard) and the epic
    check(jumpCounts[1] === '2', `the column jump leaves the epic out of To do (${jumpCounts})`);
    check((await page.eval(`return document.querySelectorAll('.workitem-msection input[type=checkbox], .workitem-msection .checkbox').length`)) === 0, 'no checkbox on a phone');
    // The page heads itself with the shell's phone header, and an over-limit section says so in one line
    check(await page.eval(`return !!document.querySelector('main .phone-head.tasks-phone-head h1') && !document.querySelector('.topbar')?.getClientRects().length`), 'the phone board heads itself, with no app top bar');
    const overPhone = await page.eval(`return document.querySelector('.workitem-msection[data-status="in_progress"] .workitem-msection-over')?.textContent.trim() ?? null`);
    check(/^Over the limit: \d+ of 1$/.test(overPhone ?? ''), `an over-limit section says so in its head (${overPhone})`);
    // A move through the row's sheet
    await page.click(`.workitem-mrow[data-item-id="${third.id}"] .workitem-mrow-more`, undefined, 600);
    await page.click('.sheet-actions .btn', 'Move to In review', 900);
    await page.waitFor(`return (await fetch('/api/work-items/${third.id}').then((r) => r.json())).status === 'in_review'`, { label: 'the phone moves a card from its sheet' });
    // Selection: the whole row is a pressed button that says so in words
    await page.click('.workitem-select-icon', undefined, 500);
    await page.click(`button.workitem-mrow[data-item-id="${blocker.id}"]`, undefined, 400);
    const chosen = await page.eval(`const b = document.querySelector('button.workitem-mrow[data-item-id="${blocker.id}"]'); return { pressed: b.getAttribute('aria-pressed'), text: b.innerText }`);
    check(chosen.pressed === 'true' && chosen.text.includes('Chosen'), `a chosen row is pressed and says Chosen (${JSON.stringify(chosen)})`);
    check((await page.text('.selection-foot')).includes('1 task'), 'the bottom bar counts the chosen tasks');
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry:project'); return true`).catch(() => {});
    // Later specs count the projects
    for (const id of made) await api.del(`/projects/${id}`).catch(() => {});
  }
};
