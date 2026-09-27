// The ways between work items and chats or orchestrations, both ways round: a task created from a
// message of a chat, a chat started from a task ("Work on it"), and a graph drafted from a selection
// on the board, reviewed in the orchestration editor and launched. Each shows its link on the chat or
// the graph, and the item keeps the link back. Runs against the fake CLI, so the chat and the
// workers really start and end.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 240_000;

const SESSION = 'e2e-tasks-links-0000-0000-000000000000';
const MESSAGE = 'Moving a card with the keyboard does not announce its new column to a screen reader.';
const line = (o) => JSON.stringify(o);
const at = (s) => `2026-09-27T10:00:${String(s).padStart(2, '0')}.000Z`;

/** A chat of the project's directory with one answer in it, as the CLI would have written it. */
function seedChat(configDir, cwd) {
  const dir = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const base = { cwd, version: '2.1.0', sessionId: SESSION };
  const lines = [
    { ...base, type: 'user', uuid: 'tl-1', timestamp: at(0), message: { role: 'user', content: 'Check the board columns' } },
    { ...base, type: 'assistant', uuid: 'tl-2', timestamp: at(2), message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: MESSAGE }] } },
  ];
  writeFileSync(join(dir, `${SESSION}.jsonl`), lines.map(line).join('\n'));
}

/** Waits for the API to answer `probe` with something truthy. */
async function until(probe, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const path = `return location.pathname`;

export default async ({ page, api, check, dirs }) => {
  let projectId = null;
  const chats = [];
  try {
    await page.viewport(1440, 1024);
    const dir = join(dirs.workspaceDir, 'e2e-tasks-links');
    mkdirSync(dir, { recursive: true });
    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-tasks-links', template: 'software' });
    check(imported.status === 201 && imported.body.modules.includes('board'), `a project with its board was imported (${imported.status})`);
    projectId = imported.body.id;
    seedChat(dirs.configDir, dir);

    // ---- 1. a task from a message: the message's menu, then the task in Backlog, linked both ways ----
    await page.goto(`/chats/${SESSION}`, 1500);
    await page.waitFor(`return [...document.querySelectorAll('.transcript .msg-assistant')].some((m) => m.innerText.includes('announce'))`, { label: 'the seeded answer' });
    const hidden = await page.eval(`return getComputedStyle(document.querySelector('.msg-assistant .msg-actions')).opacity`);
    check(hidden === '0', `a message's actions wait out of sight until it is pointed at or focused (opacity ${hidden})`);
    await page.focus('.msg-assistant .msg-actions button[aria-label="Message actions"]');
    // They fade in over --dur-fast: read once the fade is over, not in the middle of it
    await page.waitFor(`return getComputedStyle(document.querySelector('.msg-assistant .msg-actions')).opacity === '1'`, { label: 'focus shows them' });
    check(!!(await page.eval(`return !!document.querySelector('.msg-assistant .msg-actions button[aria-label="Copy the message"]')`)), 'a desktop has a copy button beside the ⋯');
    await page.key('Enter');
    await page.waitFor(`return !!document.querySelector('[role=menu][aria-label="Message actions"]')`, { label: 'the message menu' });
    const menu = await page.text('[role=menu][aria-label="Message actions"]');
    check(menu.includes('Copy the message'), 'the menu copies the message');
    check(menu.includes('Create a task from this message') && menu.includes('In Backlog of e2e-tasks-links, linked to this chat'), `the menu makes a task, and says where it lands (${menu})`);
    await page.click('[role=menu] [role=menuitem]', 'Create a task from this message', 900);
    const toast = await page.waitFor(`const t=[...document.querySelectorAll('.toast')].find((e)=>/created in Backlog/.test(e.innerText));return t?t.innerText:null`, { label: 'the toast of the new task' });
    const made = await until(async () => {
      const list = (await api.get(`/chats/${SESSION}/work-items`)).body;
      return Array.isArray(list) && list.length === 1 ? list[0] : null;
    }, 'the chat linked to its new task');
    check(made.status === 'backlog' && made.description.includes('announce'), `the task is in Backlog with the message as its description (${made.status})`);
    check(toast.includes(made.key), `the toast names the task (${toast})`);
    // Linked both ways: the chat names the item it was made from, the item keeps the chat
    const row = await page.waitFor(`const r=document.querySelector('.chat-part-of-item');return r?r.innerText:null`, { label: 'the chat names its task' });
    check(row.includes('Created from this chat') && row.includes(made.key) && row.includes('Backlog'), `the row says what the chat is to the task, its key and its column (${row})`);
    const back = (await api.get(`/work-items/${made.id}/links`)).body;
    check(back.some((l) => l.kind === 'chat' && l.chatId === SESSION && l.role === 'origin'), 'the task keeps the chat it was made from');
    await page.click('.toast .toast-action', 'Open', 900);
    check((await page.eval(path)) === `/tasks/${made.key}`, `the toast's Open goes to the task (${await page.eval(path)})`);

    // The same menu is a sheet on a phone, quoting the message it acts on
    await page.viewport(390, 844);
    await page.goto(`/chats/${SESSION}`, 1500);
    await page.waitFor(`return !!document.querySelector('.msg-assistant .msg-actions')`, { label: 'the message actions on a phone' });
    check(!(await page.eval(`return !!document.querySelector('.msg-assistant .msg-actions button[aria-label="Copy the message"]')`)), 'a phone has no separate copy button');
    await page.click('.msg-assistant .msg-actions button[aria-label="Message actions"]', undefined, 700);
    const sheet = await page.waitFor(`const s=document.querySelector('[role=dialog]');return s?s.innerText:null`, { label: 'the message sheet' });
    check(sheet.includes('«Moving a card') && sheet.includes('Create a task from this message'), `the sheet quotes the message and offers the task (${sheet})`);
    const targets = await page.eval(`return [...document.querySelectorAll('[role=dialog] .sheet-actions .btn')].map((b)=>Math.round(b.getBoundingClientRect().height))`);
    check(targets.length >= 2 && targets.every((h) => h >= 44), `every action is a finger's target (${targets})`);
    await page.key('Escape');
    const phoneRow = await page.eval(`const r=document.querySelector('.chat-part-of-item');return r?Math.round(r.getBoundingClientRect().height):0`);
    check(phoneRow >= 44, `the row is a finger's target on a phone (${phoneRow}px)`);
    const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
    check(overflow <= 1, `nothing scrolls sideways (${overflow}px)`);
    await page.viewport(1440, 1024);

    // ---- 2. "Work on it": the chat says which task it works on, and the task keeps the chat ----
    const item = (await api.post(`/projects/${projectId}/work-items`, { title: 'Announce the new column', description: 'Say it to a screen reader.', acceptanceCriteria: [{ text: 'The column is announced' }, { text: 'Tests cover it' }] })).body;
    const work = await api.post(`/work-items/${item.id}/work`, {});
    check(work.status === 201 || work.status === 200, `a chat was started on the task (${work.status})`);
    const chatId = work.body.chat.id;
    chats.push(chatId);
    await page.goto(`/chats/${chatId}`, 1500);
    const works = await page.waitFor(`const r=document.querySelector('.chat-part-of-item');return r?r.innerText:null`, { label: 'the chat names the task it works on' });
    check(works.includes('Works on') && works.includes(item.key) && works.includes('Announce the new column'), `"Works on" with the key and the title (${works})`);
    check(works.includes('criteria 0/2'), `and how far its criteria have got (${works})`);
    const card = await page.waitFor(`const c=document.querySelector('.chat-inspector .insp-item');return c?c.innerText:null`, { label: "the inspector's task card" });
    check(card.includes(item.key), `the inspector's summary has the task (${card})`);
    // The turn ends well, and the task moves to In review without a reload
    await page.waitFor(`return document.querySelector('.chat-part-of-item')?.innerText.includes('In review')`, { label: 'the task follows the chat into In review', timeout: 40_000 });
    const linked = (await api.get(`/work-items/${item.id}/links`)).body;
    check(linked.some((l) => l.kind === 'chat' && l.chatId === chatId && l.role === 'work'), 'the task keeps the chat that worked on it');
    // The row is the link: its title opens the task
    await page.click('.chat-part-of-item .chat-part-of-name', undefined, 900);
    check((await page.eval(path)) === `/tasks/${item.key}`, 'the row opens the task');

    // ---- 3. a selection orchestrated: the draft opens in the editor, each node with its key ----
    const first = (await api.post(`/projects/${projectId}/work-items`, { title: 'Draw the columns' })).body;
    const second = (await api.post(`/projects/${projectId}/work-items`, { title: 'Wire the moves' })).body;
    const outside = (await api.post(`/projects/${projectId}/work-items`, { title: 'Agree on the column names' })).body;
    await api.post(`/work-items/${first.id}/relations`, { type: 'blocks', itemId: second.id });
    await api.post(`/work-items/${outside.id}/relations`, { type: 'blocks', itemId: first.id });
    const drafted = await api.post(`/projects/${projectId}/work-items/orchestrate`, { itemIds: [first.id, second.id] });
    check(drafted.status === 200 || drafted.status === 201, `the selection became a draft (${drafted.status})`);
    check(drafted.body.externalBlockers.some((b) => b.id === outside.id), 'the draft names the blocker left out of the selection');
    // The board hands the draft over in the router state, as `navigate('/orchestration', { state })` does
    await page.goto('/', 900);
    await page.waitFor(`return !!document.querySelector('.topbar')`, { label: 'the shell, before the router is handed a draft' });
    await page.eval(
      `history.pushState({ usr: { workItemDraft: ${JSON.stringify(drafted.body)} }, key: 'e2e-draft', idx: (history.state?.idx ?? 0) + 1 }, '', '/orchestration'); dispatchEvent(new PopStateEvent('popstate', { state: history.state })); return true`,
    );
    await page.waitFor(`return document.querySelectorAll('.task-editor').length === 2`, { label: 'the editor opens on the draft, one node per task' });
    // Each node reads its item by id, so its key lands once that request does
    await page.waitFor(`return document.querySelectorAll('.task-editor .workitem-key-link').length === 2`, { label: "each node's item has loaded" });
    const keysShown = await page.eval(`return [...document.querySelectorAll('.task-editor .workitem-key-link')].map((a)=>a.textContent)`);
    check(JSON.stringify(keysShown) === JSON.stringify([first.key, second.key]), `each node shows its task's key (${keysShown})`);
    const note = await page.text('.orch-draft-note');
    check(note.includes('From the board: 2 tasks'), `the form says where the graph came from (${note})`);
    const warning = await page.eval(`const a=document.querySelector('.orch-draft-blockers');return a?{text:a.innerText,warn:a.classList.contains('alert-warn')}:null`);
    check(warning?.warn && warning.text.includes(outside.key) && warning.text.includes('outside the selection'), `a blocker outside the selection is a warning before launching (${warning?.text})`);
    await page.click('.form-actions .btn-primary', 'Launch', 1500);
    await page.waitFor(`return /^\\/orchestration\\/[^/]+$/.test(location.pathname)`, { label: 'the launched graph opens' });
    const orchId = await page.eval(`return location.pathname.split('/').pop()`);
    // Launching sent each node's item: the items follow their nodes and keep them
    const orch = (await api.get(`/orchestrations/${orchId}`)).body;
    check(orch.tasks.every((t) => t.workItemId === first.id || t.workItemId === second.id), 'every node was launched with its workItemId');
    const firstLinks = await until(async () => {
      const links = (await api.get(`/work-items/${first.id}/links`)).body;
      return links.some((l) => l.kind === 'orchestration' && l.orchestrationId === orchId) ? links : null;
    }, 'the first task linked to its node');
    check(firstLinks.length > 0, 'the task keeps the orchestration that works on it');
    // The graph names each node's task by its key, and the key opens it
    await page.goto(`/orchestration/${orchId}?view=graph`, 1500);
    await page.waitFor(`return document.querySelectorAll('main .workitem-key-link').length >= 1`, { label: "the graph's nodes show their keys" });
    const names = await page.eval(`return [...document.querySelectorAll('main .workitem-key-link')].map((a)=>a.textContent)`);
    check(names.includes(first.key), `the running stage names its task (${names})`);
    const heading = await page.eval(`const h=[...document.querySelectorAll('main .task-row-name, main .board-task-name')].find((e)=>e.querySelector('.workitem-key-link'));return h?h.innerText:null`);
    check(heading !== null && heading.split(first.key).length === 2, `the node's name does not repeat its key (${heading})`);
    await page.click('main .workitem-key-link', first.key, 900);
    check((await page.eval(path)) === `/tasks/${first.key}`, "the node's key opens its task");
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    for (const id of chats) await api.post(`/chats/${id}/stop`).catch(() => {});
    // Later specs count the projects
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
