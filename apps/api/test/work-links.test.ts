import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type {
  AgentryEvent,
  ChatSummary,
  Orchestration,
  Project,
  WorkItem,
  WorkItemChanges,
  WorkItemDetail,
  WorkItemOrchestrationDraft,
  WorkItemStatus,
  WorkOnWorkItemResult,
} from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// Work items with the chats and orchestrations that work on them, over HTTP and a real core. The
// chats are the fake CLI the core tests use, which does what a line of its prompt says (write a
// file, hang, fail), in real git worktrees; nothing here reads the real ~/.claude.
const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude.mjs', import.meta.url));

let app: FastifyInstance;
let core: Core;
let repo: string;
let project: Project;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (done(value)) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function repoWithCommit(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-api-links-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(dir, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}

async function createItem(body: Record<string, unknown>, projectId = project.id): Promise<WorkItem> {
  const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/work-items`, ...json(body) });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<WorkItem>();
}

const item = async (id: string): Promise<WorkItemDetail> => (await app.inject(`/api/work-items/${id}`)).json<WorkItemDetail>();
const statusIs = (id: string, status: WorkItemStatus) => until(() => item(id), (i) => i.status === status, `the item to reach ${status}`);

async function workOn(id: string, body: Record<string, unknown> = {}): Promise<WorkOnWorkItemResult> {
  const res = await app.inject({ method: 'POST', url: `/api/work-items/${id}/work`, ...json(body) });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<WorkOnWorkItemResult>();
}

/** Waits until the chat's process has let go of its turn, so nothing of it is left running. */
const turnOver = (chatId: string) => until(() => core.runtime.get(chatId)?.status, (s) => s !== 'busy' && s !== 'starting', 'the turn to end');

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-links-data-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  repo = repoWithCommit();
  const res = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: repo, name: 'Shop', modules: ['board'] }) });
  assert.equal(res.statusCode, 201, res.body);
  project = res.json<Project>();
});

after(async () => {
  await app.close();
  core.shutdown();
});

// ---------- work on it ----------

test('working on an item starts a chat in its own worktree, and the item follows the chat to in_review', async () => {
  const events: AgentryEvent[] = [];
  const stop = core.events.subscribe((e) => events.push(e));
  const bug = await createItem({
    title: 'Cart loses items',
    type: 'bug',
    status: 'todo',
    description: 'FAKE-WRITE cart.txt fixed',
    acceptanceCriteria: [{ text: 'Items survive a reload' }],
  });
  const started = await workOn(bug.id, { model: 'sonnet', cwd: '/somewhere/else', prompt: 'ignored' });
  const slug = bug.key.toLowerCase();
  const worktree = join(repo, '.claude', 'worktrees', `task-${slug}`);

  assert.equal(started.item.worktree, worktree);
  assert.equal(started.item.branch, `task/${slug}`);
  assert.equal(started.link.chatId, started.chat.id);
  assert.equal(started.link.role, 'work');
  assert.equal(started.chat.project?.id, project.id);
  assert.match(started.chat.firstPrompt ?? started.chat.title, new RegExp(`^${bug.key}: Cart loses items`));
  assert.equal(execFileSync('git', ['-C', worktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), `task/${slug}`);

  const reviewed = await statusIs(bug.id, 'in_review');
  await turnOver(started.chat.id);
  stop();
  const moves = reviewed.history.filter((e) => e.change === 'status');
  assert.deepEqual(
    moves.map((e) => [e.to, e.actor.kind, e.cause?.event, e.cause?.chatId]),
    [
      ['in_progress', 'system', 'chat.started', started.chat.id],
      ['in_review', 'system', 'chat.turn-completed', started.chat.id],
    ],
  );
  // The history names the chat by its first prompt, as the chat list does, not by its session name
  assert.deepEqual(
    reviewed.history.filter((e) => e.change === 'link').map((e) => (e.to && typeof e.to === 'object' && 'label' in e.to ? e.to.label : null)),
    [`${bug.key}: Cart loses items`],
  );
  const moved = events.filter((e): e is Extract<AgentryEvent, { type: 'workitem.moved' }> => e.type === 'workitem.moved' && e.itemId === bug.id);
  assert.deepEqual(moved.map((e) => [e.status, e.cause?.event]), [['in_progress', 'chat.started'], ['in_review', 'chat.turn-completed']]);

  // What the chat wrote is on the item's branch, uncommitted
  const changes = (await app.inject(`/api/work-items/${bug.id}/changes`)).json<WorkItemChanges>();
  assert.equal(changes.branch, `task/${slug}`);
  assert.deepEqual(changes.summary?.uncommitted.map((f) => f.path), ['cart.txt']);
  const diff = await app.inject(`/api/work-items/${bug.id}/changes/diff?path=cart.txt`);
  assert.equal(diff.statusCode, 200, diff.body);
  assert.match(diff.json<{ diff: string }>().diff, /\+fixed/);
  // Read as the review screen reads a chat's or a task's: scoped, and with the whole file
  const loose = (await app.inject(`/api/work-items/${bug.id}/changes?uncommitted=1`)).json<WorkItemChanges>();
  assert.deepEqual(loose.summary?.files.map((f) => f.path), ['cart.txt']);
  const whole = await app.inject(`/api/work-items/${bug.id}/changes/diff?path=cart.txt&context=full&uncommitted=1`);
  assert.equal(whole.statusCode, 200, whole.body);
  assert.equal(whole.json<{ full: boolean }>().full, true);

  // The project counts the chat as its page lists it, before any transcript is on disk
  const counted = (await app.inject('/api/projects')).json<Project[]>().find((p) => p.id === project.id);
  const listed = (await app.inject(`/api/chats?project=${project.id}`)).json<ChatSummary[]>();
  assert.ok(listed.some((c) => c.id === started.chat.id));
  assert.equal(counted?.chatCount, listed.length);

  // The chat's header can name the item it works on
  assert.deepEqual((await app.inject(`/api/chats/${started.chat.id}/work-items`)).json<WorkItem[]>().map((i) => i.id), [bug.id]);

  // Working on it again continues in the same worktree, with a new chat, and the item keeps both
  const again = await workOn(bug.id);
  assert.equal(again.item.worktree, worktree);
  assert.notEqual(again.chat.id, started.chat.id);
  await turnOver(again.chat.id);
  const links = (await item(bug.id)).links.filter((l) => l.role === 'work').map((l) => l.chatId);
  assert.deepEqual(links, [started.chat.id, again.chat.id]);
});

test('a failed turn leaves the item in progress, and a chat still working refuses a second one', async () => {
  const failing = await createItem({ title: 'Flaky', description: 'FAKE-FAIL the tests broke' });
  const failed = await workOn(failing.id);
  await turnOver(failed.chat.id);
  await sleep(100);
  assert.equal((await item(failing.id)).status, 'in_progress');

  const hanging = await createItem({ title: 'Slow', description: 'FAKE-HANG' });
  const busy = await workOn(hanging.id);
  const twice = await app.inject({ method: 'POST', url: `/api/work-items/${hanging.id}/work`, ...json({}) });
  assert.equal(twice.statusCode, 409);
  assert.match(twice.json().error, /already being worked on/);
  // Stopping it moves nothing either
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${busy.chat.id}/stop` })).statusCode, 200);
  await turnOver(busy.chat.id);
  await sleep(100);
  assert.equal((await item(hanging.id)).status, 'in_progress');
});

test('a chat that never starts its turn puts the item back, so it is not left in progress with nobody on it', async () => {
  const refused = await createItem({ title: 'Never started', status: 'todo' });
  const started = await workOn(refused.id, { model: 'fake-refused' });
  await until(() => core.runtime.get(started.chat.id)?.status, (s) => s === 'failed', 'the chat to fail');
  const back = await statusIs(refused.id, 'todo');
  assert.deepEqual(
    back.history.filter((e) => e.change === 'status').map((e) => [e.to, e.cause?.event]),
    [
      ['in_progress', 'chat.started'],
      ['todo', 'chat.failed-to-start'],
    ],
  );
});

test('an item in done is not worked on, and start options of the wrong type are refused before a chat starts', async () => {
  const chats = () => core.runtime.list().length;
  const before = chats();
  const done = await createItem({ title: 'Shipped', status: 'done' });
  const refused = await app.inject({ method: 'POST', url: `/api/work-items/${done.id}/work`, ...json({}) });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json().error, /already done/);

  const open = await createItem({ title: 'Open' });
  for (const body of [
    { model: 42 },
    { allowedTools: 'Bash' },
    { disallowedTools: [1] },
    { permissionMode: 'anything' },
    { toolPreset: 7 },
    { mcp: { servers: 'all' } },
    { maxBudgetUsd: '5' },
    { maxBudgetUsd: -1 },
    { permissionPrompts: 'yes' },
    { account: {} },
  ]) {
    const res = await app.inject({ method: 'POST', url: `/api/work-items/${open.id}/work`, ...json(body) });
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)}: ${res.body}`);
  }
  assert.equal(chats(), before);
  assert.equal((await item(open.id)).status, 'backlog');
});

test('a chat whose link to its item could not be written is stopped, not left working unseen', async () => {
  const target = await createItem({ title: 'Unlinked', description: 'FAKE-HANG' });
  const before = new Set(core.runtime.list().map((c) => c.id));
  const link = core.workItems.link.bind(core.workItems);
  core.workItems.link = () => {
    throw new Error('disk full');
  };
  try {
    const res = await app.inject({ method: 'POST', url: `/api/work-items/${target.id}/work`, ...json({}) });
    assert.ok(res.statusCode >= 400, res.body);
    assert.match(res.json().error, /disk full/);
  } finally {
    core.workItems.link = link;
  }
  const started = core.runtime.list().filter((c) => !before.has(c.id));
  assert.equal(started.length, 1);
  const chatId = started[0]?.id ?? '';
  await turnOver(chatId);
  assert.equal(core.runtime.get(chatId)?.status, 'stopped');
});

test('an epic is not worked on directly, and a project with its board off refuses', async () => {
  const epic = await createItem({ title: 'Checkout', type: 'epic' });
  assert.equal((await app.inject({ method: 'POST', url: `/api/work-items/${epic.id}/work`, ...json({}) })).statusCode, 400);

  const other = (await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: repoWithCommit(), name: 'Other', modules: ['board'] }) })).json<Project>();
  const kept = await createItem({ title: 'Kept' }, other.id);
  await app.inject({ method: 'PATCH', url: `/api/projects/${other.id}`, ...json({ modules: [] }) });
  assert.equal((await app.inject({ method: 'POST', url: `/api/work-items/${kept.id}/work`, ...json({}) })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${other.id}/work-items/orchestrate`, ...json({ itemIds: [kept.id] }) })).statusCode, 409);
  await app.inject({ method: 'DELETE', url: `/api/projects/${other.id}` });
});

// ---------- orchestrate a selection ----------

test('a selection becomes a draft, and launching it makes each item follow its node', async () => {
  const api = await createItem({ title: 'API', description: 'FAKE-WRITE api.txt server' });
  const ui = await createItem({ title: 'UI', status: 'todo', description: 'FAKE-WRITE ui.txt client' });
  const design = await createItem({ title: 'Design' });
  for (const [from, to] of [
    [api, ui],
    [design, ui],
  ] as const) {
    const res = await app.inject({ method: 'POST', url: `/api/work-items/${from.id}/relations`, ...json({ type: 'blocks', itemId: to.id }) });
    assert.equal(res.statusCode, 201, res.body);
  }

  const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items/orchestrate`, ...json({ itemIds: [ui.id, api.id] }) });
  assert.equal(res.statusCode, 200, res.body);
  const draft = res.json<WorkItemOrchestrationDraft>();
  // A draft, not a graph: nothing was launched and nothing moved
  assert.equal(core.orchestrator.list().some((o) => o.name === draft.spec.name), false);
  assert.equal((await item(ui.id)).status, 'todo');
  const [uiNode, apiNode] = draft.spec.tasks;
  assert.deepEqual([uiNode?.workItemId, apiNode?.workItemId], [ui.id, api.id]);
  assert.deepEqual(uiNode?.dependsOn, [apiNode?.id]);
  assert.deepEqual(draft.externalBlockers.map((r) => r.id), [design.id]);
  assert.equal(draft.spec.cwd, repo);
  assert.equal(draft.spec.worktree, true);

  const launched = await app.inject({ method: 'POST', url: '/api/orchestrations', ...json({ ...draft.spec, synthesize: false }) });
  assert.equal(launched.statusCode, 201, launched.body);
  const graph = launched.json<Orchestration>();
  const done = await until(() => core.orchestrator.get(graph.id), (o) => !!o && o.status !== 'running', 'the graph to finish');
  assert.equal(done?.status, 'completed');

  for (const [id, node] of [
    [api.id, apiNode],
    [ui.id, uiNode],
  ] as const) {
    const followed = await statusIs(id, 'in_review');
    const link = followed.links.find((l) => l.kind === 'orchestration');
    assert.equal(link?.orchestrationId, graph.id);
    assert.equal(link?.taskId, node?.id);
    assert.equal(link?.taskStatus, 'completed');
    assert.ok(link?.chatId, 'the link learnt the chat its node ran in');
    assert.deepEqual(
      followed.history.filter((e) => e.change === 'status').map((e) => [e.to, e.cause?.event]),
      [
        ['in_progress', 'orchestration.task.started'],
        ['in_review', 'orchestration.task.completed'],
      ],
    );
  }

  // Each item shows what its node changed, in the node's own worktree
  const node = done?.tasks.find((t) => t.workItemId === api.id);
  const changes = (await app.inject(`/api/work-items/${api.id}/changes`)).json<WorkItemChanges>();
  assert.equal(changes.branch, node?.branch);
  assert.equal(changes.worktree, node?.worktree);
  const files = [...(changes.summary?.uncommitted ?? []), ...(changes.summary?.files ?? [])].map((f) => f.path);
  assert.ok(files.includes('api.txt'), `api.txt among ${files.join(', ')}`);
});

test('a relaunch keeps each node on its item and is checked as a launch is; a template keeps no item', async () => {
  const api = await createItem({ title: 'Relaunched', description: 'FAKE-WRITE again.txt server' });
  const other = await createItem({ title: 'Other' });
  const draft = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items/orchestrate`, ...json({ itemIds: [api.id] }) })).json<WorkItemOrchestrationDraft>();
  const first = (await app.inject({ method: 'POST', url: '/api/orchestrations', ...json({ ...draft.spec, synthesize: false }) })).json<Orchestration>();
  await until(() => core.orchestrator.get(first.id), (o) => !!o && o.status !== 'running', 'the graph to finish');

  const res = await app.inject({ method: 'POST', url: `/api/orchestrations/${first.id}/relaunch`, ...json({}) });
  assert.equal(res.statusCode, 201, res.body);
  const again = res.json<Orchestration>();
  assert.equal(again.relaunchedFrom, first.id);
  assert.equal(again.tasks[0]?.workItemId, api.id);
  await until(() => core.orchestrator.get(again.id), (o) => !!o && o.status !== 'running', 'the relaunch to finish');
  const graphs = (await item(api.id)).links.filter((l) => l.kind === 'orchestration').map((l) => l.orchestrationId);
  assert.deepEqual(graphs, [first.id, again.id]);

  const node = { id: 'n', name: 'n', prompt: 'p' };
  const relaunch = (tasks: unknown[]) => app.inject({ method: 'POST', url: `/api/orchestrations/${first.id}/relaunch`, ...json({ tasks }) });
  const before = core.orchestrator.list().length;
  assert.equal((await relaunch([{ ...node, workItemId: 'nope' }])).statusCode, 400);
  const twice = await relaunch([
    { ...node, workItemId: other.id },
    { ...node, id: 'm', workItemId: other.id },
  ]);
  assert.equal(twice.statusCode, 400);
  assert.match(twice.json().error, /another node/);

  const saved = await app.inject({ method: 'POST', url: '/api/orchestrations/templates', ...json({ name: 'Reusable', fromOrchestration: first.id }) });
  assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(saved.json<{ spec: { tasks: Array<{ workItemId?: string }> } }>().spec.tasks.some((t) => t.workItemId), false);
});

test('a selection or a launch naming items it may not have is refused before anything runs', async () => {
  const a = await createItem({ title: 'A' });
  const epic = await createItem({ title: 'E', type: 'epic' });
  const closed = await createItem({ title: 'Closed', status: 'done' });
  const orchestrate = (body: unknown) => app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items/orchestrate`, ...json(body) });
  assert.equal((await orchestrate({ itemIds: [] })).statusCode, 400);
  assert.equal((await orchestrate({ itemIds: [a.id, a.id] })).statusCode, 400);
  assert.equal((await orchestrate({ itemIds: [epic.id] })).statusCode, 400);
  assert.equal((await orchestrate({ itemIds: [closed.id] })).statusCode, 409);
  assert.equal((await orchestrate({ itemIds: ['nope'] })).statusCode, 400);

  const before = core.orchestrator.list().length;
  const launch = (tasks: unknown[]) => app.inject({ method: 'POST', url: '/api/orchestrations', ...json({ name: 'x', cwd: repo, tasks }) });
  assert.equal((await launch([{ id: 't1', name: 't1', prompt: 'p', workItemId: 'nope' }])).statusCode, 400);
  const twice = await launch([
    { id: 't1', name: 't1', prompt: 'p', workItemId: a.id },
    { id: 't2', name: 't2', prompt: 'p', workItemId: a.id },
  ]);
  assert.equal(twice.statusCode, 400);
  assert.match(twice.json().error, /another node/);
  // Held to what "Work on it" is: an epic, an item in done, or one a chat is on now
  const one = (workItemId: string) => launch([{ id: 't1', name: 't1', prompt: 'p', workItemId }]);
  assert.equal((await one(epic.id)).statusCode, 400);
  assert.equal((await one(closed.id)).statusCode, 409);
  const worked = await createItem({ title: 'Taken', description: 'FAKE-HANG' });
  const busy = await workOn(worked.id);
  const taken = await one(worked.id);
  assert.equal(taken.statusCode, 409);
  assert.match(taken.json().error, /already being worked on/);
  assert.equal((await orchestrate({ itemIds: [worked.id] })).statusCode, 409);
  assert.equal(core.orchestrator.list().length, before);
  await app.inject({ method: 'POST', url: `/api/chats/${busy.chat.id}/stop` });
  await turnOver(busy.chat.id);
});

// ---------- a task from a message ----------

test('a message of a chat becomes a task in backlog, linked to the chat it came from', async () => {
  const chat = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hello', cwd: repo }) });
  assert.equal(chat.statusCode, 201, chat.body);
  const chatId = chat.json<ChatSummary>().id;
  await turnOver(chatId);

  const res = await app.inject({ method: 'POST', url: `/api/chats/${chatId}/work-items`, ...json({ text: '## Cart loses items\n\nWhen the page reloads, the cart is empty.', type: 'bug' }) });
  assert.equal(res.statusCode, 201, res.body);
  const created = res.json<WorkItem>();
  assert.equal(created.projectId, project.id);
  assert.equal(created.status, 'backlog');
  assert.equal(created.type, 'bug');
  assert.equal(created.title, 'Cart loses items');
  assert.match(created.description, /the cart is empty/);

  const detail = await item(created.id);
  assert.deepEqual(detail.links.map((l) => [l.kind, l.role, l.chatId]), [['chat', 'origin', chatId]]);
  assert.equal(detail.history[0]?.cause?.event, 'chat.message');
  assert.ok((await app.inject(`/api/chats/${chatId}/work-items`)).json<WorkItem[]>().some((i) => i.id === created.id));

  // The chat that ends another turn does not move the item it was only the origin of
  const titled = await app.inject({ method: 'POST', url: `/api/chats/${chatId}/work-items`, ...json({ text: 'body', title: 'Own title' }) });
  assert.equal(titled.json<WorkItem>().title, 'Own title');
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${chatId}/work-items`, ...json({ text: '  ' }) })).statusCode, 400);

  const loose = mkdtempSync(join(tmpdir(), 'agentry-api-loose-'));
  const looseChat = (await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi', cwd: loose }) })).json<ChatSummary>();
  await turnOver(looseChat.id);
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${looseChat.id}/work-items`, ...json({ text: 'x' }) })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats/nope/work-items', ...json({ text: 'x' }) })).statusCode, 404);
  assert.ok(existsSync(repo));
});

test('every new route is documented', async () => {
  const doc = (await app.inject('/openapi.json')).json<{ paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> }>();
  for (const [path, method] of [
    ['/api/work-items/{itemId}/work', 'post'],
    ['/api/work-items/{itemId}/changes', 'get'],
    ['/api/work-items/{itemId}/changes/diff', 'get'],
    ['/api/projects/{id}/work-items/orchestrate', 'post'],
    ['/api/chats/{id}/work-items', 'post'],
    ['/api/chats/{id}/work-items', 'get'],
  ] as const) {
    const op = doc.paths[path]?.[method];
    assert.ok(op?.summary, `${method} ${path} has a summary`);
    assert.ok(op?.tags?.length, `${method} ${path} has a tag`);
  }
});
