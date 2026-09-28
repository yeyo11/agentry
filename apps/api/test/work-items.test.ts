import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type {
  AgentryEvent,
  AuditPage,
  Board,
  Milestone,
  MoveWorkItemResult,
  Project,
  ProjectSettings,
  WorkItem,
  WorkItemComment,
  WorkItemDetail,
  WorkItemHistoryEntry,
  WorkItemLink,
  WorkItemPage,
} from '@agentry/shared';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

// The work item routes over a real core with scratch dirs and a missing CLI: nothing here spawns
// Claude or reads the real ~/.claude.
let app: FastifyInstance;
let core: Core;
let root: string;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const scratch = () => mkdtempSync(join(tmpdir(), 'agentry-api-wi-'));

async function importProject(name: string, modules: string[] = ['board']): Promise<Project> {
  const res = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: scratch(), name, modules }) });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<Project>();
}

async function createItem(projectId: string, body: Record<string, unknown>): Promise<WorkItem> {
  const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/work-items`, ...json(body) });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<WorkItem>();
}

/** Collects what reaches the feed while `fn` runs. */
async function feed(fn: () => Promise<void>): Promise<AgentryEvent[]> {
  const events: AgentryEvent[] = [];
  const stop = core.events.subscribe((e) => events.push(e));
  try {
    await fn();
  } finally {
    stop();
  }
  return events;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-work-items-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(() => app.close());

test('a project with its Board module off refuses changes with a clear error, and keeps showing what it holds', async () => {
  const project = await importProject('Switchy', []);
  const off = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items`, ...json({ title: 'Too early' }) });
  assert.equal(off.statusCode, 409);
  assert.match(off.json().error, /Board module is off/);
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/milestones`, ...json({ name: 'v1' }) })).statusCode, 409);

  await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, ...json({ modules: ['board'] }) });
  const item = await createItem(project.id, { title: 'Kept' });
  await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, ...json({ modules: [] }) });

  // Reads go on: switching a module off hides it, it does not look like the data is gone
  assert.deepEqual((await app.inject(`/api/projects/${project.id}/work-items`)).json<WorkItem[]>().map((i) => i.id), [item.id]);
  assert.equal((await app.inject(`/api/projects/${project.id}/work-items/board`)).statusCode, 200);
  assert.equal((await app.inject(`/api/projects/${project.id}/milestones`)).statusCode, 200);
  assert.equal((await app.inject(`/api/work-items/${item.id}`)).statusCode, 200);
  assert.equal((await app.inject(`/api/work-items/${item.id}/history`)).statusCode, 200);

  for (const req of [
    { method: 'PATCH' as const, url: `/api/work-items/${item.id}`, ...json({ title: 'x' }) },
    { method: 'POST' as const, url: `/api/work-items/${item.id}/move`, ...json({ status: 'todo' }) },
    { method: 'POST' as const, url: `/api/work-items/${item.id}/comments`, ...json({ body: 'hi' }) },
    { method: 'DELETE' as const, url: `/api/work-items/${item.id}` },
  ]) {
    assert.equal((await app.inject(req)).statusCode, 409, `${req.method} ${req.url}`);
  }
  // Not in the All projects view either, while its board is off
  assert.equal((await app.inject('/api/work-items')).json<WorkItem[]>().some((i) => i.id === item.id), false);

  assert.equal((await app.inject('/api/projects/nope/work-items')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects/nope/work-items', ...json({ title: 'x' }) })).statusCode, 404);
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
});

test('items are created, listed with filters, updated and deleted, and each change reaches the feed', async () => {
  const project = await importProject('Agentry');
  let epic!: WorkItem;
  let bug!: WorkItem;
  const created = await feed(async () => {
    epic = await createItem(project.id, { title: 'Checkout', type: 'epic' });
    bug = await createItem(project.id, {
      title: 'Cart loses items',
      type: 'bug',
      priority: 'urgent',
      labels: ['Frontend'],
      epicId: epic.id,
      acceptanceCriteria: [{ text: 'Items survive a reload' }],
    });
  });
  assert.deepEqual([epic.key, bug.key, bug.status, bug.epic?.id], ['AGN-1', 'AGN-2', 'backlog', epic.id]);
  assert.deepEqual(
    created.filter((e) => e.type === 'workitem.created').map((e) => e.type === 'workitem.created' && [e.key, e.itemType, e.projectId]),
    [
      ['AGN-1', 'epic', project.id],
      ['AGN-2', 'bug', project.id],
    ],
  );

  const list = async (query: string) => (await app.inject(`/api/projects/${project.id}/work-items?${query}`)).json<WorkItem[]>().map((i) => i.key);
  assert.deepEqual(await list('type=bug,story'), ['AGN-2']);
  assert.deepEqual(await list('priority=urgent&labels=frontend'), ['AGN-2']);
  assert.deepEqual(await list('q=agn-1'), ['AGN-1']);
  assert.deepEqual(await list(`epicId=${epic.id}`), ['AGN-2']);
  assert.deepEqual(await list('assignee=none'), ['AGN-1', 'AGN-2']);
  for (const bad of ['status=doing', 'type=spike', 'priority=asap', 'assignee=somebody']) {
    const res = await app.inject(`/api/projects/${project.id}/work-items?${bad}`);
    assert.equal(res.statusCode, 400, bad);
  }

  // Validation from the store reaches the caller as a 4xx with its own words
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items`, ...json({}) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items` })).statusCode, 400);
  const nested = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items`, ...json({ title: 'Sub', type: 'epic', epicId: epic.id }) });
  assert.equal(nested.statusCode, 400);

  const updated = await feed(async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/work-items/${bug.id}`, ...json({ title: 'Cart forgets items', priority: 'high' }) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json<WorkItem>().title, 'Cart forgets items');
  });
  const change = updated.find((e) => e.type === 'workitem.updated');
  assert.ok(change?.type === 'workitem.updated');
  assert.deepEqual([change.itemId, [...change.changes].sort(), change.actor.kind], [bug.id, ['priority', 'title'], 'person']);

  const history = (await app.inject(`/api/work-items/${bug.id}/history`)).json<WorkItemHistoryEntry[]>();
  assert.deepEqual(
    history.map((h) => h.change),
    ['created', 'title', 'priority'],
  );

  const detail = (await app.inject(`/api/work-items/${epic.id}`)).json<WorkItemDetail>();
  assert.deepEqual(detail.children.map((c) => c.key), ['AGN-2']);
  assert.equal((await app.inject('/api/work-items/nope')).statusCode, 404);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/work-items/nope', ...json({ title: 'x' }) })).statusCode, 404);

  const removed = await feed(async () => {
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/work-items/${bug.id}` })).statusCode, 200);
  });
  assert.ok(removed.some((e) => e.type === 'workitem.removed' && e.itemId === bug.id && e.key === 'AGN-2'));
  assert.equal((await app.inject(`/api/work-items/${bug.id}`)).statusCode, 404);
  // The number of a deleted item is never handed out again
  assert.equal((await createItem(project.id, { title: 'Next' })).key, 'AGN-3');
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
});

test('the board keeps the order a person drags, and a move over a limit is reported, never refused', async () => {
  const project = await importProject('Board');
  const settings = (await app.inject(`/api/projects/${project.id}/settings`)).json<ProjectSettings>();
  await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/settings`, ...json({ ...settings, board: { ...settings.board, columnLimits: { todo: 1 } } }) });
  const a = await createItem(project.id, { title: 'A', status: 'todo' });
  const b = await createItem(project.id, { title: 'B' });
  const c = await createItem(project.id, { title: 'C' });

  const events = await feed(async () => {
    const res = await app.inject({ method: 'POST', url: `/api/work-items/${b.id}/move`, ...json({ status: 'todo', afterId: null }) });
    assert.equal(res.statusCode, 200);
    const moved = res.json<MoveWorkItemResult>();
    assert.deepEqual([moved.item.status, moved.column.count, moved.column.limit, moved.column.overLimit], ['todo', 2, 1, true]);
  });
  const moved = events.find((e) => e.type === 'workitem.moved');
  assert.ok(moved?.type === 'workitem.moved');
  assert.deepEqual([moved.itemId, moved.previousStatus, moved.status, moved.overLimit], [b.id, 'backlog', 'todo', true]);

  await app.inject({ method: 'POST', url: `/api/work-items/${c.id}/move`, ...json({ status: 'todo', afterId: b.id }) });
  const board = (await app.inject(`/api/projects/${project.id}/work-items/board`)).json<Board>();
  assert.deepEqual(
    board.columns.map((col) => col.status),
    ['backlog', 'todo', 'in_progress', 'in_review', 'done'],
  );
  const todo = board.columns[1];
  assert.deepEqual([todo?.items.map((i) => i.title), todo?.count, todo?.overLimit], [['B', 'C', 'A'], 3, true]);

  // A filter narrows the items, never the count a limit is about
  const filtered = (await app.inject(`/api/projects/${project.id}/work-items/board?q=A`)).json<Board>().columns[1];
  assert.deepEqual([filtered?.items.map((i) => i.title), filtered?.count], [['A'], 3]);

  const bad = await app.inject({ method: 'POST', url: `/api/work-items/${a.id}/move`, ...json({ status: 'doing' }) });
  assert.equal(bad.statusCode, 400);
  const elsewhere = await app.inject({ method: 'POST', url: `/api/work-items/${a.id}/move`, ...json({ status: 'done', afterId: b.id }) });
  assert.equal(elsewhere.statusCode, 400);
  const done = (await app.inject({ method: 'POST', url: `/api/work-items/${a.id}/move`, ...json({ status: 'done' }) })).json<MoveWorkItemResult>();
  assert.ok(done.item.closedAt);
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
});

test('criteria, comments, relations and links are changed through their own routes', async () => {
  const project = await importProject('Parts');
  const item = await createItem(project.id, { title: 'Login', acceptanceCriteria: [{ text: 'Works' }, { text: 'Is fast' }] });
  const other = await createItem(project.id, { title: 'Signup' });
  const criterion = item.acceptanceCriteria[0];
  assert.ok(criterion);

  const checked = await app.inject({ method: 'PATCH', url: `/api/work-items/${item.id}/criteria/${criterion.id}`, ...json({ checked: true }) });
  assert.equal(checked.statusCode, 200);
  assert.deepEqual(checked.json<WorkItem>().acceptanceCriteria[0]?.checkedBy, { kind: 'person', role: null });
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/work-items/${item.id}/criteria/nope`, ...json({ checked: true }) })).statusCode, 404);

  const commented = await feed(async () => {
    const res = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/comments`, ...json({ body: 'Looks **good**' }) });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json<WorkItemComment>().author.kind, 'person');
  });
  assert.ok(commented.some((e) => e.type === 'workitem.updated' && e.changes.includes('comment')));
  assert.deepEqual((await app.inject(`/api/work-items/${item.id}/comments`)).json<WorkItemComment[]>().map((c) => c.body), ['Looks **good**']);
  assert.equal((await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/comments`, ...json({ body: '' }) })).statusCode, 400);

  const related = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/relations`, ...json({ type: 'blocks', itemId: other.id }) });
  assert.equal(related.statusCode, 201);
  assert.deepEqual(related.json<WorkItem>().relations.map((r) => [r.type, r.item.id]), [['blocks', other.id]]);
  const self = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/relations`, ...json({ type: 'blocks', itemId: item.id }) });
  assert.equal(self.statusCode, 400);
  const cycle = await app.inject({ method: 'POST', url: `/api/work-items/${other.id}/relations`, ...json({ type: 'blocks', itemId: item.id }) });
  assert.equal(cycle.statusCode, 409);
  const unrelated = await app.inject({ method: 'DELETE', url: `/api/work-items/${other.id}/relations/${item.id}` });
  assert.deepEqual([unrelated.statusCode, unrelated.json<WorkItem>().relations], [200, []]);

  // A link names a chat that exists, in the item's project: this core has no CLI, so the chat list is stood in for
  const nowhere = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/links`, ...json({ kind: 'chat', role: 'work', chatId: 'chat-1' }) });
  assert.equal(nowhere.statusCode, 400);
  assert.match(nowhere.json().error, /chat chat-1 not found/);
  const summaryOf = core.chats.summaryOf.bind(core.chats);
  const chatIn = (projectId: string) => (async (id: string) => ({ id, project: { id: projectId, name: 'p' } })) as unknown as typeof core.chats.summaryOf;
  core.chats.summaryOf = chatIn('another-project');
  const elsewhere = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/links`, ...json({ kind: 'chat', role: 'work', chatId: 'chat-1' }) });
  assert.equal(elsewhere.statusCode, 400);
  assert.match(elsewhere.json().error, /not a chat of this item's project/);
  core.chats.summaryOf = chatIn(project.id);
  const linked = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/links`, ...json({ kind: 'chat', role: 'work', chatId: 'chat-1' }) });
  assert.equal(linked.statusCode, 201);
  const link = linked.json<WorkItemLink>();
  // A chat this process is not running reads with no name and no state
  assert.deepEqual([link.chatId, link.name, link.chatState], ['chat-1', null, null]);
  const again = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/links`, ...json({ kind: 'chat', role: 'work', chatId: 'chat-1' }) });
  assert.equal(again.json<WorkItemLink>().id, link.id);
  core.chats.summaryOf = summaryOf;
  assert.equal((await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/links`, ...json({ kind: 'orchestration', role: 'work' }) })).statusCode, 400);
  const noGraph = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/links`, ...json({ kind: 'orchestration', role: 'work', orchestrationId: 'o-1', taskId: 't1' }) });
  assert.equal(noGraph.statusCode, 400);
  assert.match(noGraph.json().error, /orchestration o-1 not found/);
  assert.deepEqual((await app.inject(`/api/work-items/${item.id}/links`)).json<WorkItemLink[]>().map((l) => l.id), [link.id]);
  // A link is only unlinked under its own item
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/work-items/${other.id}/links/${link.id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/work-items/${item.id}/links/${link.id}` })).statusCode, 200);
  assert.deepEqual((await app.inject(`/api/work-items/${item.id}/links`)).json<WorkItemLink[]>(), []);

  const changes = (await app.inject(`/api/work-items/${item.id}/history`)).json<WorkItemHistoryEntry[]>().map((h) => h.change);
  assert.deepEqual(changes, ['created', 'criterion', 'relation', 'relation', 'link', 'link']);
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
});

test('milestones are created, closed, reopened and deleted, with their progress and their events', async () => {
  const project = await importProject('Releases');
  let milestone!: Milestone;
  const events = await feed(async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/milestones`, ...json({ name: 'v0.19', description: 'First cut' }) });
    assert.equal(res.statusCode, 201);
    milestone = res.json<Milestone>();
    const item = await createItem(project.id, { title: 'Ship', milestoneId: milestone.id });
    await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/move`, ...json({ status: 'done' }) });
    await createItem(project.id, { title: 'Polish', milestoneId: milestone.id });
    await app.inject({ method: 'PATCH', url: `/api/milestones/${milestone.id}`, ...json({ state: 'closed' }) });
    await app.inject({ method: 'PATCH', url: `/api/milestones/${milestone.id}`, ...json({ state: 'open' }) });
    await app.inject({ method: 'PATCH', url: `/api/milestones/${milestone.id}`, ...json({ name: 'v0.20' }) });
  });
  assert.deepEqual(
    events.flatMap((e) => (e.type === 'milestone.changed' ? [e.action] : [])),
    ['created', 'closed', 'reopened', 'updated'],
  );

  const read = (await app.inject(`/api/milestones/${milestone.id}`)).json<Milestone>();
  assert.deepEqual([read.name, read.state, read.progress.total, read.progress.done], ['v0.20', 'open', 2, 1]);
  assert.deepEqual((await app.inject(`/api/projects/${project.id}/milestones`)).json<Milestone[]>().map((m) => m.id), [milestone.id]);
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/milestones`, ...json({ name: '' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/milestones/${milestone.id}`, ...json({ state: 'done' }) })).statusCode, 400);

  const deleted = await feed(async () => {
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/milestones/${milestone.id}` })).statusCode, 200);
  });
  assert.ok(deleted.some((e) => e.type === 'milestone.changed' && e.action === 'deleted'));
  assert.equal(deleted.filter((e) => e.type === 'workitem.updated' && e.changes.includes('milestone')).length, 2);
  assert.equal((await app.inject(`/api/milestones/${milestone.id}`)).statusCode, 404);
  assert.deepEqual((await app.inject(`/api/projects/${project.id}/work-items`)).json<WorkItem[]>().map((i) => i.milestoneId), [null, null]);
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
});

test('the All projects view shows the boards that are on, and a removed project keeps its items readable', async () => {
  const one = await importProject('Alpha One');
  const two = await importProject('Beta Two');
  const hidden = await importProject('Gamma Three', []);
  try {
    const a = await createItem(one.id, { title: 'In one' });
    await createItem(two.id, { title: 'In two', status: 'todo' });
    await app.inject({ method: 'PATCH', url: `/api/projects/${hidden.id}`, ...json({ modules: ['board'] }) });
    await createItem(hidden.id, { title: 'Hidden' });
    await app.inject({ method: 'PATCH', url: `/api/projects/${hidden.id}`, ...json({ modules: [] }) });

    const all = (await app.inject('/api/work-items')).json<WorkItem[]>();
    const mine = all.filter((i) => [one.id, two.id, hidden.id].includes(i.projectId));
    assert.deepEqual(mine.map((i) => i.title).sort(), ['In one', 'In two']);
    const board = (await app.inject('/api/work-items/board')).json<Board>();
    assert.equal(board.projectId, null);
    assert.ok(board.columns.every((c) => c.limit === null));
    assert.equal(board.columns.flatMap((c) => c.items).some((i) => i.projectId === hidden.id), false);
    assert.equal(board.columns.reduce((n, c) => n + c.count, 0), board.columns.flatMap((c) => c.items).length);
    // An epic is not counted, as on the project's own board, so the figure does not change with the scope
    await createItem(two.id, { title: 'Grouping', type: 'epic', status: 'todo' });
    const todo = (b: Board) => b.columns.find((c) => c.status === 'todo')?.count;
    const withEpic = (await app.inject('/api/work-items/board')).json<Board>();
    assert.equal(todo(withEpic), todo(board));
    assert.equal(todo((await app.inject(`/api/projects/${two.id}/work-items/board`)).json<Board>()), 1);
    assert.equal((await app.inject('/api/work-items?status=todo')).json<WorkItem[]>().some((i) => i.id === a.id), false);

    // Removed: its items stay, readable by id but out of every list, and nothing changes them
    await app.inject({ method: 'DELETE', url: `/api/projects/${one.id}` });
    assert.equal((await app.inject(`/api/work-items/${a.id}`)).statusCode, 200);
    assert.equal((await app.inject('/api/work-items')).json<WorkItem[]>().some((i) => i.id === a.id), false);
    const write = await app.inject({ method: 'PATCH', url: `/api/work-items/${a.id}`, ...json({ title: 'x' }) });
    assert.equal(write.statusCode, 409);
    assert.match(write.json().error, /not imported/);
    assert.equal((await app.inject(`/api/projects/${one.id}/work-items`)).statusCode, 404);
  } finally {
    for (const p of [one, two, hidden]) await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
  }
});

test('a repeated query parameter or a body of the wrong shape is a 400, never a 500', async () => {
  const project = await importProject('Malformed', ['board', 'memory']);
  const item = await createItem(project.id, { title: 'Probed' });
  try {
    // A list parameter takes its repeats as more members; a single one refuses them
    const both = await app.inject(`/api/projects/${project.id}/work-items?status=backlog&status=todo`);
    assert.equal(both.statusCode, 200, both.body);
    assert.deepEqual(both.json<WorkItem[]>().map((i) => i.id), [item.id]);
    for (const base of [`/api/projects/${project.id}/work-items`, `/api/projects/${project.id}/work-items/board`, '/api/work-items', '/api/work-items/board']) {
      for (const query of ['type=task&type=bug', 'labels=a&labels=b', 'priority=low&priority=high']) {
        assert.equal((await app.inject(`${base}?${query}`)).statusCode, 200, `${base}?${query}`);
      }
      for (const query of ['q=a&q=b', 'epicId=a&epicId=b', 'milestoneId=a&milestoneId=b', 'status=x&status=y']) {
        assert.equal((await app.inject(`${base}?${query}`)).statusCode, 400, `${base}?${query}`);
      }
    }
    assert.equal((await app.inject(`/api/work-items/${item.id}/changes?commit=a&commit=b`)).statusCode, 400);
    assert.equal((await app.inject(`/api/work-items/${item.id}/changes/diff?path=a&path=b`)).statusCode, 400);
    assert.equal((await app.inject(`/api/work-items/${item.id}/changes/diff?path=a&context=1&context=2`)).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/journal`, ...json({ text: 'x', itemId: { a: 1 } }) })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 12 }) })).statusCode, 400);
    // A move is not a field: PATCH says so instead of answering 200 with the status unchanged
    const moved = await app.inject({ method: 'PATCH', url: `/api/work-items/${item.id}`, ...json({ status: 'done' }) });
    assert.equal(moved.statusCode, 400);
    assert.match(moved.json().error, /move/);
    assert.equal((await app.inject(`/api/work-items/${item.id}`)).json<WorkItem>().status, 'backlog');
    assert.equal((await app.inject({ method: 'POST', url: '/api/orchestrations', ...json({ name: 'g', objective: 'o', tasks: [null] }) })).statusCode, 400);
  } finally {
    await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
  }
});

test('an item is read by its key in any case, and a key no project has is a 404', async () => {
  const project = await importProject('Keyed Place');
  try {
    const item = await createItem(project.id, { title: 'Found by key', description: 'The whole text' });
    for (const key of [item.key, item.key.toLowerCase()]) {
      const res = await app.inject(`/api/work-items/by-key/${key}`);
      assert.equal(res.statusCode, 200, res.body);
      const detail = res.json<WorkItemDetail>();
      assert.equal(detail.id, item.id);
      // The item's page, whole: its description and what only the detail carries
      assert.equal(detail.description, 'The whole text');
      assert.ok(Array.isArray(detail.history) && Array.isArray(detail.comments));
    }
    const prefix = item.key.split('-')[0] ?? '';
    for (const key of [`${prefix}-999`, 'ZZZZ-1', 'not-a-key', 'board']) {
      assert.equal((await app.inject(`/api/work-items/by-key/${key}`)).statusCode, 404, key);
    }
    // A removed project's item stays readable by key, as it is by id, while no other project takes the prefix
    await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
    assert.equal((await app.inject(`/api/work-items/by-key/${item.key}`)).json<WorkItemDetail>().id, item.id);
  } finally {
    await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
  }
});

test('the board and the lists serve cards without descriptions, and page the Done column and the lists', async () => {
  const project = await importProject('Paged Place');
  const other = await importProject('Paged Other');
  try {
    const described = await createItem(project.id, { title: 'Described', description: 'd'.repeat(10_000) });
    const bare = await createItem(project.id, { title: 'Bare' });
    const done: WorkItem[] = [];
    for (let n = 0; n < 23; n += 1) done.push(await createItem(project.id, { title: `Closed ${String(n)}`, status: 'done' }));
    await createItem(other.id, { title: 'Elsewhere' });

    // No description in any list payload, and the flag says which have one
    const board = (await app.inject(`/api/projects/${project.id}/work-items/board`)).json<Board>();
    const list = (await app.inject(`/api/projects/${project.id}/work-items`)).json<WorkItem[]>();
    const all = (await app.inject('/api/work-items')).json<WorkItem[]>();
    for (const card of [...board.columns.flatMap((c) => c.items), ...list, ...all]) assert.equal(card.description, '', card.key);
    assert.equal(list.find((i) => i.id === described.id)?.hasDescription, true);
    assert.equal(list.find((i) => i.id === bare.id)?.hasDescription, false);
    assert.equal((await app.inject(`/api/work-items/${described.id}`)).json<WorkItemDetail>().description.length, 10_000);

    // The Done column: its newest 20, the count over all of them, and "3 more" that a larger limit shows
    const column = board.columns.find((c) => c.status === 'done');
    assert.equal(column?.count, 23);
    assert.equal(column?.items.length, 20);
    assert.equal(column?.more, 3);
    const grown = (await app.inject(`/api/projects/${project.id}/work-items/board?doneLimit=40`)).json<Board>().columns.find((c) => c.status === 'done');
    assert.equal(grown?.items.length, 23);
    assert.equal(grown?.more, undefined);
    const allDone = (await app.inject('/api/work-items/board?doneLimit=1')).json<Board>().columns.find((c) => c.status === 'done');
    assert.equal(allDone?.items.length, 1);
    assert.equal((allDone?.items.length ?? 0) + (allDone?.more ?? 0), allDone?.count);

    // A project's list a page at a time, the filter with it, until the last page
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/api/projects/${project.id}/work-items/page?status=done&limit=10${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await app.inject(url);
      assert.equal(res.statusCode, 200, res.body);
      const page = res.json<WorkItemPage>();
      assert.equal(page.total, 23);
      assert.ok(page.items.every((i) => i.description === '' && i.status === 'done'));
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, list.filter((i) => i.status === 'done').map((i) => i.id));
    // All projects pages the same list as `/work-items`
    const first = (await app.inject('/api/work-items/page?limit=5')).json<WorkItemPage>();
    assert.equal(first.total, all.length);
    assert.deepEqual(
      first.items.map((i) => i.id),
      all.slice(0, 5).map((i) => i.id),
    );

    // A count that is not a whole number, a repeated one or a cursor this list did not hand out is a 400
    for (const query of ['limit=abc', 'limit=-1', 'limit=0', 'limit=1&limit=2', 'cursor=nope']) {
      assert.equal((await app.inject(`/api/projects/${project.id}/work-items/page?${query}`)).statusCode, 400, query);
      assert.equal((await app.inject(`/api/work-items/page?${query}`)).statusCode, 400, query);
    }
    for (const query of ['doneLimit=x', 'doneLimit=-2', 'doneLimit=1&doneLimit=2']) {
      assert.equal((await app.inject(`/api/projects/${project.id}/work-items/board?${query}`)).statusCode, 400, query);
      assert.equal((await app.inject(`/api/work-items/board?${query}`)).statusCode, 400, query);
    }
  } finally {
    for (const p of [project, other]) await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
  }
});

test('creations, moves and deletions are written to the audit log under their route summary', async () => {
  const project = await importProject('Audited');
  const item = await createItem(project.id, { title: 'Watched' });
  await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/move`, ...json({ status: 'todo' }) });
  await app.inject({ method: 'DELETE', url: `/api/work-items/${item.id}` });
  const page = (await app.inject('/api/audit?limit=50')).json<AuditPage>();
  const summaries = page.entries.filter((e) => e.path.includes(item.id) || e.path === `/api/projects/${project.id}/work-items`).map((e) => e.summary);
  assert.deepEqual(summaries.sort(), ['Create a work item', 'Delete a work item', 'Move a work item']);
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
});

test('every work item route is documented with a summary and a tag', async () => {
  const spec = (await app.inject('/openapi.json')).json<{ paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> }>();
  const routes: Array<[string, string[]]> = [
    ['/api/projects/{id}/work-items', ['get', 'post']],
    ['/api/projects/{id}/work-items/board', ['get']],
    ['/api/projects/{id}/milestones', ['get', 'post']],
    ['/api/work-items', ['get']],
    ['/api/work-items/board', ['get']],
    ['/api/projects/{id}/work-items/page', ['get']],
    ['/api/work-items/page', ['get']],
    ['/api/work-items/by-key/{key}', ['get']],
    ['/api/work-items/{itemId}', ['get', 'patch', 'delete']],
    ['/api/work-items/{itemId}/move', ['post']],
    ['/api/work-items/{itemId}/criteria/{criterionId}', ['patch']],
    ['/api/work-items/{itemId}/comments', ['get', 'post']],
    ['/api/work-items/{itemId}/relations', ['post']],
    ['/api/work-items/{itemId}/relations/{otherId}', ['delete']],
    ['/api/work-items/{itemId}/links', ['get', 'post']],
    ['/api/work-items/{itemId}/links/{linkId}', ['delete']],
    ['/api/work-items/{itemId}/history', ['get']],
    ['/api/milestones/{milestoneId}', ['get', 'patch', 'delete']],
  ];
  for (const [path, methods] of routes) {
    for (const method of methods) {
      const op = spec.paths[path]?.[method];
      assert.ok(op?.summary && op.tags?.[0] === 'Work items', `${method.toUpperCase()} ${path} is not documented`);
    }
  }
});
