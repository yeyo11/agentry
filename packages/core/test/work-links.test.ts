import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentryEvent, Orchestration, OrchestrationTaskStatus, RunStatus, WorkItemHistoryEntry, WorkItemStatus } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { mainCheckout } from '../src/git.ts';
import { itemWorktree, orchestrationDraft, titleFromMessage, WorkItemAutomation, workItemPrompt } from '../src/work-links.ts';
import { WorkItemService } from '../src/work-items.ts';
import { tempConfig } from './helpers.ts';

// The automation is fed the same events the bus carries and the results the runtime reports, over a
// real store: what it must move, and above all what it must leave alone.

function setup() {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const items = new WorkItemService({ db, project: (id) => (id === 'p1' ? { keyPrefix: 'AGN', columnLimits: {} } : null) });
  const writable = new Set(['p1']);
  const orchestrations = new Map<string, Orchestration>();
  const automation = new WorkItemAutomation({ items, writable: (id) => writable.has(id), orchestration: (id) => orchestrations.get(id) ?? null });
  return { db, items, automation, writable, orchestrations };
}

type Setup = ReturnType<typeof setup>;

let seq = 0;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function runUpdated(runId: string, status: RunStatus, previousStatus: RunStatus | null, at = iso()): AgentryEvent {
  return {
    id: ++seq,
    at,
    title: '',
    type: 'run.updated',
    runId,
    runName: runId,
    sessionId: runId,
    orchestrationId: null,
    internal: false,
    status,
    previousStatus,
    turns: 0,
    costUsd: 0,
    pendingPrompts: 0,
  };
}

function taskEvent(orchestrationId: string, taskId: string, status: OrchestrationTaskStatus, runId: string | null, at = iso()): AgentryEvent {
  return { id: ++seq, at, title: '', type: 'orchestration.task', orchestrationId, orchestrationName: 'g', taskId, taskName: taskId, status, previousStatus: null, runId, error: null };
}

function created(orchestrationId: string): AgentryEvent {
  return {
    id: ++seq,
    at: iso(),
    title: '',
    type: 'orchestration.updated',
    orchestrationId,
    orchestrationName: 'g',
    status: 'running',
    previousStatus: null,
    integrationStatus: null,
    costUsd: 0,
  };
}

/** Only the fields the automation reads: the id, where it came from and the nodes' items. */
function graph(id: string, tasks: Array<{ id: string; workItemId?: string; worktree?: string; branch?: string }>, templateId: string | null = null): Orchestration {
  return { id, templateId, tasks } as unknown as Orchestration;
}

const statusOf = (s: Setup, id: string): WorkItemStatus | undefined => s.items.find(id)?.status;
const automatic = (history: WorkItemHistoryEntry[]) => history.filter((e) => e.change === 'status' && e.actor.kind === 'system');

function workedBy(s: Setup, chatId: string, status: WorkItemStatus = 'todo') {
  const item = s.items.create('p1', { title: 'Fix the cart', status });
  s.items.link(item.id, { kind: 'chat', role: 'work', chatId });
  return item;
}

// ---------- a chat ----------

test('an item enters in_progress when its chat starts a turn and in_review when the turn ends well, each move with its cause', () => {
  const s = setup();
  const item = workedBy(s, 'chat-1');
  s.automation.observe(runUpdated('chat-1', 'busy', 'starting'));
  assert.equal(statusOf(s, item.id), 'in_progress');
  s.automation.chatResult('chat-1', { isError: false });
  assert.equal(statusOf(s, item.id), 'in_review');

  const moves = automatic(s.items.history(item.id));
  assert.deepEqual(
    moves.map((e) => [e.from, e.to, e.cause?.event, e.cause?.chatId]),
    [
      ['todo', 'in_progress', 'chat.started', 'chat-1'],
      ['in_progress', 'in_review', 'chat.turn-completed', 'chat-1'],
    ],
  );
});

test('a failed or stopped turn moves nothing', () => {
  const s = setup();
  const item = workedBy(s, 'chat-1');
  s.automation.observe(runUpdated('chat-1', 'busy', 'starting'));
  s.automation.chatResult('chat-1', { isError: true });
  s.automation.observe(runUpdated('chat-1', 'stopped', 'busy'));
  assert.equal(statusOf(s, item.id), 'in_progress');
});

function runEnded(runId: string, status: 'completed' | 'failed' | 'stopped'): AgentryEvent {
  return { id: ++seq, at: iso(), title: '', type: 'run.ended', runId, runName: runId, sessionId: runId, orchestrationId: null, internal: false, status, error: null, turns: 0, costUsd: 0 } as AgentryEvent;
}

test('a chat that fails before its turn gives any result puts the item back where it was', () => {
  const s = setup();
  const item = workedBy(s, 'chat-1');
  s.automation.chatStarted('chat-1');
  assert.equal(statusOf(s, item.id), 'in_progress');
  // The CLI could not be spawned, or refused a flag: the process ends with no result at all
  s.automation.observe(runEnded('chat-1', 'failed'));
  assert.equal(statusOf(s, item.id), 'todo');
  assert.deepEqual(
    automatic(s.items.history(item.id)).map((e) => [e.to, e.cause?.event]),
    [
      ['in_progress', 'chat.started'],
      ['todo', 'chat.failed-to-start'],
    ],
  );
});

test('a chat whose turn gave a result, or that a person moved past, is not put back when it fails', () => {
  const s = setup();
  const answered = workedBy(s, 'chat-1');
  s.automation.chatStarted('chat-1');
  s.automation.chatResult('chat-1', { isError: true });
  s.automation.observe(runEnded('chat-1', 'failed'));
  assert.equal(statusOf(s, answered.id), 'in_progress');

  const moved = workedBy(s, 'chat-2');
  s.automation.chatStarted('chat-2');
  s.items.move(moved.id, { status: 'in_review' });
  s.items.move(moved.id, { status: 'in_progress' });
  s.automation.observe(runEnded('chat-2', 'failed'));
  assert.equal(statusOf(s, moved.id), 'in_progress');

  const stopped = workedBy(s, 'chat-3');
  s.automation.chatStarted('chat-3');
  s.automation.observe(runEnded('chat-3', 'stopped'));
  assert.equal(statusOf(s, stopped.id), 'in_progress');
});

test('a person who moves the item while the turn runs wins over the move its end would make', () => {
  const s = setup();
  const item = workedBy(s, 'chat-1');
  s.automation.observe(runUpdated('chat-1', 'busy', 'starting', iso(-60_000)));
  assert.equal(statusOf(s, item.id), 'in_progress');
  s.items.move(item.id, { status: 'todo' });
  s.automation.chatResult('chat-1', { isError: false });
  assert.equal(statusOf(s, item.id), 'todo');
});

test("a person's move wins over the coalesced updates a busy chat keeps sending", () => {
  const s = setup();
  const item = workedBy(s, 'chat-1');
  s.automation.observe(runUpdated('chat-1', 'busy', 'starting', iso(-60_000)));
  s.items.move(item.id, { status: 'todo' });
  // What RunEventPublisher sends about every 250 ms while the turn runs: the same status, no previous one
  s.automation.observe(runUpdated('chat-1', 'busy', null, iso(1_000)));
  assert.equal(statusOf(s, item.id), 'todo');
  s.automation.chatResult('chat-1', { isError: false });
  assert.equal(statusOf(s, item.id), 'todo');
});

test('a chat announced already busy starts its turn: it has no transition to report', () => {
  const s = setup();
  const item = workedBy(s, 'chat-1');
  s.automation.observe({ id: ++seq, at: iso(-60_000), title: '', type: 'run.created', runId: 'chat-1', runName: 'chat-1', sessionId: 'chat-1', orchestrationId: null, internal: false, status: 'busy' } as AgentryEvent);
  assert.equal(statusOf(s, item.id), 'in_progress');
  s.automation.chatResult('chat-1', { isError: false });
  assert.equal(statusOf(s, item.id), 'in_review');
});

test('a person who moved the item before the turn began does not hold that turn back', () => {
  const s = setup();
  const item = workedBy(s, 'chat-1', 'backlog');
  s.items.move(item.id, { status: 'todo' });
  s.automation.observe(runUpdated('chat-1', 'busy', 'idle', iso(60_000)));
  s.automation.chatResult('chat-1', { isError: false });
  assert.equal(statusOf(s, item.id), 'in_review');
});

test('an automatic move never takes an item out of done, nor back to an earlier column', () => {
  const s = setup();
  const done = workedBy(s, 'chat-1', 'done');
  const reviewed = workedBy(s, 'chat-2', 'in_review');
  for (const chat of ['chat-1', 'chat-2']) {
    s.automation.observe(runUpdated(chat, 'busy', 'idle'));
    s.automation.chatResult(chat, { isError: false });
  }
  assert.equal(statusOf(s, done.id), 'done');
  assert.equal(statusOf(s, reviewed.id), 'in_review');
  assert.equal(automatic(s.items.history(done.id)).length, 0);
});

test('only a work link moves an item: the chat an item was created from does not', () => {
  const s = setup();
  const item = s.items.create('p1', { title: 'From a message' });
  s.items.link(item.id, { kind: 'chat', role: 'origin', chatId: 'chat-1' });
  s.automation.observe(runUpdated('chat-1', 'busy', 'idle'));
  s.automation.chatResult('chat-1', { isError: false });
  assert.equal(statusOf(s, item.id), 'backlog');
});

test('nothing moves in a project whose Board module is off', () => {
  const s = setup();
  const item = workedBy(s, 'chat-1');
  s.writable.delete('p1');
  s.automation.observe(runUpdated('chat-1', 'busy', 'starting'));
  s.automation.chatResult('chat-1', { isError: false });
  assert.equal(statusOf(s, item.id), 'todo');
});

test('the links are rows: after a restart the item stays where it was, and the next turn moves it again', () => {
  const s = setup();
  const item = workedBy(s, 'chat-1');
  s.automation.observe(runUpdated('chat-1', 'busy', 'starting'));
  // A new process knows nothing of the turn the restart cut; the cut chat ends with no result
  const after = new WorkItemAutomation({ items: new WorkItemService({ db: s.db, project: () => ({ keyPrefix: 'AGN', columnLimits: {} }) }), writable: () => true, orchestration: () => null });
  after.observe({ id: ++seq, at: iso(), title: '', type: 'run.ended', runId: 'chat-1', runName: 'c', sessionId: 'chat-1', orchestrationId: null, internal: false, status: 'failed', error: 'interrupted', turns: 1, costUsd: 0 });
  assert.equal(statusOf(s, item.id), 'in_progress');
  after.observe(runUpdated('chat-1', 'busy', 'completed'));
  after.chatResult('chat-1', { isError: false });
  assert.equal(statusOf(s, item.id), 'in_review');
});

// ---------- an orchestration ----------

test('the nodes of a new graph are linked to their items, which follow the node and learn its chat', () => {
  const s = setup();
  const a = s.items.create('p1', { title: 'API' });
  const b = s.items.create('p1', { title: 'UI', status: 'todo' });
  s.orchestrations.set('o1', graph('o1', [{ id: 'agn-1', workItemId: a.id }, { id: 'agn-2', workItemId: b.id }, { id: 'extra' }]));
  s.automation.observe(created('o1'));
  assert.equal(s.items.links(a.id)[0]?.taskId, 'agn-1');
  assert.equal(s.items.links(b.id)[0]?.orchestrationId, 'o1');

  s.automation.observe(taskEvent('o1', 'agn-1', 'running', 'worker-1'));
  assert.equal(statusOf(s, a.id), 'in_progress');
  assert.equal(s.items.links(a.id)[0]?.chatId, 'worker-1');
  // The worker's own chat events are not what moves a node's item
  s.automation.chatResult('worker-1', { isError: false });
  assert.equal(statusOf(s, a.id), 'in_progress');
  s.automation.observe(taskEvent('o1', 'agn-1', 'completed', 'worker-1'));
  assert.equal(statusOf(s, a.id), 'in_review');
  const cause = automatic(s.items.history(a.id)).at(-1)?.cause;
  assert.deepEqual(cause, { kind: 'orchestration', chatId: 'worker-1', orchestrationId: 'o1', taskId: 'agn-1', event: 'orchestration.task.completed' });

  s.automation.observe(taskEvent('o1', 'agn-2', 'running', 'worker-2'));
  for (const status of ['failed', 'stopped', 'blocked', 'skipped', 'interrupted'] as const) s.automation.observe(taskEvent('o1', 'agn-2', status, 'worker-2'));
  assert.equal(statusOf(s, b.id), 'in_progress');
});

test("an item worked by a node records the node's worktree and branch, where its changes are", () => {
  const s = setup();
  const a = s.items.create('p1', { title: 'API' });
  const node = { id: 'agn-1', workItemId: a.id, worktree: '/repo/.claude/worktrees/o1-agn-1', branch: 'agentry/o1/agn-1' };
  s.orchestrations.set('o1', graph('o1', [node]));
  s.automation.observe(created('o1'));
  s.automation.observe(taskEvent('o1', 'agn-1', 'running', 'worker-1'));
  const worked = s.items.get(a.id);
  assert.deepEqual([worked.worktree, worked.branch], [node.worktree, node.branch]);
});

test('a person who moves a node\'s item while it runs keeps it there', () => {
  const s = setup();
  const a = s.items.create('p1', { title: 'API' });
  s.orchestrations.set('o1', graph('o1', [{ id: 'agn-1', workItemId: a.id }]));
  s.automation.observe(created('o1'));
  s.automation.observe(taskEvent('o1', 'agn-1', 'running', 'worker-1', iso(-60_000)));
  s.items.move(a.id, { status: 'backlog' });
  s.automation.observe(taskEvent('o1', 'agn-1', 'completed', 'worker-1'));
  assert.equal(statusOf(s, a.id), 'backlog');
});

test('a graph launched from a saved template does not take over the items its nodes name', () => {
  const s = setup();
  const a = s.items.create('p1', { title: 'API' });
  s.orchestrations.set('o1', graph('o1', [{ id: 'agn-1', workItemId: a.id }], 'template-1'));
  s.automation.observe(created('o1'));
  s.automation.observe(taskEvent('o1', 'agn-1', 'running', 'worker-1'));
  assert.equal(s.items.links(a.id).length, 0);
  assert.equal(statusOf(s, a.id), 'backlog');
});

// ---------- the item's worktree ----------

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=Someone', '-c', 'user.email=s@example.com', ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();

function repoWithCommit(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-links-repo-'));
  gitIn(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'project\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

test('a worktree deleted by hand is made again on the same branch, keeping its commits', () => {
  const repo = repoWithCommit();
  const first = itemWorktree(repo, { key: 'AGN-1', worktree: null, branch: null });
  assert.ok(first);
  writeFileSync(join(first.worktree, 'work.txt'), 'kept\n');
  gitIn(first.worktree, 'add', '-A');
  gitIn(first.worktree, 'commit', '-q', '-m', 'work');
  rmSync(first.worktree, { recursive: true, force: true });

  const again = itemWorktree(repo, { key: 'AGN-1', worktree: first.worktree, branch: first.branch });
  assert.deepEqual(again, first);
  assert.ok(existsSync(join(first.worktree, 'work.txt')), 'the branch came back with its commit');
  assert.equal(gitIn(first.worktree, 'branch', '--show-current'), first.branch);
});

test("recovering an item's worktree leaves git's record of every other worktree alone", () => {
  const repo = repoWithCommit();
  const other = join(mkdtempSync(join(tmpdir(), 'agentry-other-')), 'elsewhere');
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'elsewhere', other);
  rmSync(other, { recursive: true, force: true });
  const first = itemWorktree(repo, { key: 'AGN-1', worktree: null, branch: null });
  assert.ok(first);
  rmSync(first.worktree, { recursive: true, force: true });
  itemWorktree(repo, { key: 'AGN-1', worktree: first.worktree, branch: first.branch });
  assert.match(gitIn(repo, 'worktree', 'list', '--porcelain'), /elsewhere/, 'the other worktree is still known to git');
});

test("a plain directory where the item's worktree should be is refused, not worked in", () => {
  const repo = repoWithCommit();
  const path = join(repo, '.claude', 'worktrees', 'task-agn-2');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'notes.txt'), 'mine\n');
  assert.throws(
    () => itemWorktree(repo, { key: 'AGN-2', worktree: null, branch: null }),
    (err: Error & { statusCode?: number }) => err.statusCode === 409 && /not a worktree/.test(err.message),
  );
});

test('"Work on it" in a linked worktree branches from that worktree\'s HEAD, not the main checkout\'s', () => {
  const repo = repoWithCommit();
  const linked = join(mkdtempSync(join(tmpdir(), 'agentry-linked-')), 'feature');
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
  writeFileSync(join(linked, 'feature.txt'), 'only on the feature branch\n');
  gitIn(linked, 'add', '-A');
  gitIn(linked, 'commit', '-q', '-m', 'feature');
  const place = itemWorktree(linked, { key: 'AGN-1', worktree: null, branch: null });
  assert.ok(place);
  assert.equal(gitIn(place.worktree, 'rev-parse', 'HEAD'), gitIn(linked, 'rev-parse', 'HEAD'));
  assert.ok(place.worktree.startsWith(join(repo, '.claude', 'worktrees')), 'kept under the main checkout, where the CLI keeps its own');
});

test("a submodule's item worktree hangs off the submodule's checkout, not its git directory", () => {
  const sub = repoWithCommit();
  const sup = repoWithCommit();
  gitIn(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'lib');
  gitIn(sup, 'commit', '-q', '-m', 'add lib');
  const project = join(sup, 'lib');
  const place = itemWorktree(project, { key: 'AGN-1', worktree: null, branch: null });
  assert.ok(place);
  assert.equal(place.worktree, join(project, '.claude', 'worktrees', 'task-agn-1'));
  assert.equal(mainCheckout(place.worktree), project, 'and its own linked worktrees find the submodule again');
});

test('"Work on it" after a node never works in the node\'s worktree, so retrying the node clean loses nothing of it', () => {
  const repo = repoWithCommit();
  const nodeTree = join(repo, '.claude', 'worktrees', 'o1-agn-1');
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'worktree-o1-agn-1', nodeTree);
  writeFileSync(join(nodeTree, 'node.txt'), "the node's work\n");
  gitIn(nodeTree, 'add', '-A');
  gitIn(nodeTree, 'commit', '-q', '-m', 'node');

  const place = itemWorktree(repo, { key: 'AGN-1', projectId: 'p1', worktree: nodeTree, branch: 'worktree-o1-agn-1' });
  assert.ok(place);
  assert.deepEqual([place.worktree, place.branch], [join(repo, '.claude', 'worktrees', 'task-agn-1'), 'task/agn-1']);
  assert.ok(existsSync(join(place.worktree, 'node.txt')), "the item's branch starts from the node's work");
  writeFileSync(join(place.worktree, 'mine.txt'), "a person's work\n");

  // What "Retry clean" does to the node
  gitIn(repo, 'worktree', 'remove', '--force', nodeTree);
  gitIn(repo, 'branch', '-D', 'worktree-o1-agn-1');
  assert.ok(existsSync(join(place.worktree, 'mine.txt')));
  assert.deepEqual(itemWorktree(repo, { key: 'AGN-1', projectId: 'p1', worktree: place.worktree, branch: place.branch }), place);
});

test("a node that works on an item with a worktree of its own does not take the item's place over", () => {
  const s = setup();
  const a = s.items.create('p1', { title: 'API' });
  s.items.setWorktree(a.id, { worktree: '/repo/.claude/worktrees/task-agn-1', branch: 'task/agn-1' });
  s.orchestrations.set('o1', graph('o1', [{ id: 'agn-1', workItemId: a.id, worktree: '/repo/.claude/worktrees/o1-agn-1', branch: 'worktree-o1-agn-1' }]));
  s.automation.observe(created('o1'));
  s.automation.observe(taskEvent('o1', 'agn-1', 'running', 'worker-1'));
  const item = s.items.get(a.id);
  assert.deepEqual([item.worktree, item.branch], ['/repo/.claude/worktrees/task-agn-1', 'task/agn-1']);
});

test("an item's branch checked out in another checkout is a 409 that says where, not git's error", () => {
  const repo = repoWithCommit();
  const other = join(mkdtempSync(join(tmpdir(), 'agentry-other-')), 'elsewhere');
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'task/agn-3', other);
  assert.throws(
    () => itemWorktree(repo, { key: 'AGN-3', worktree: null, branch: null }),
    (err: Error & { statusCode?: number }) => err.statusCode === 409 && err.message.includes(other),
  );
});

test('two projects of one repository with the same key do not share an item worktree', () => {
  const repo = repoWithCommit();
  const linked = join(mkdtempSync(join(tmpdir(), 'agentry-linked-')), 'feature');
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
  const first = itemWorktree(repo, { key: 'AGN-1', projectId: 'p1', worktree: null, branch: null });
  assert.ok(first);
  assert.throws(
    () => itemWorktree(linked, { key: 'AGN-1', projectId: 'p2', worktree: null, branch: null }),
    (err: Error & { statusCode?: number }) => err.statusCode === 409 && /another project/.test(err.message),
  );
  assert.deepEqual(itemWorktree(repo, { key: 'AGN-1', projectId: 'p1', worktree: first.worktree, branch: first.branch }), first);
});

// ---------- prompts and drafts ----------

test('the prompt opens with the key and the title, and carries the description and the checklist', () => {
  const s = setup();
  const epic = s.items.create('p1', { title: 'Checkout', type: 'epic' });
  const item = s.items.create('p1', {
    title: 'Cart loses items',
    type: 'bug',
    epicId: epic.id,
    description: 'Reload the page with items in the cart.',
    acceptanceCriteria: [{ text: 'Items survive a reload' }, { text: 'A test covers it' }],
  });
  const criterion = item.acceptanceCriteria[1];
  assert.ok(criterion);
  s.items.checkCriterion(item.id, criterion.id, { checked: true });
  const prompt = workItemPrompt(s.items.get(item.id));
  assert.match(prompt, /^AGN-2 · Cart loses items\n/);
  assert.match(prompt, /bug AGN-2 .*epic AGN-1 "Checkout"/);
  assert.match(prompt, /Reload the page with items in the cart\./);
  assert.match(prompt, /- \[ \] Items survive a reload\n- \[x\] A test covers it/);
});

test('a selection becomes a draft with one node per item and dependsOn from the blocks inside it', () => {
  const s = setup();
  const api = s.items.create('p1', { title: 'API' });
  const ui = s.items.create('p1', { title: 'UI' });
  const docs = s.items.create('p1', { title: 'Docs' });
  const outside = s.items.create('p1', { title: 'Design' });
  const finished = s.items.create('p1', { title: 'Spike', status: 'done' });
  s.items.relate(api.id, { type: 'blocks', itemId: ui.id });
  s.items.relate(ui.id, { type: 'blocks', itemId: docs.id });
  s.items.relate(outside.id, { type: 'blocks', itemId: ui.id });
  s.items.relate(finished.id, { type: 'blocks', itemId: api.id });

  const picked = [docs.id, api.id, ui.id].map((id) => s.items.get(id));
  const { spec, externalBlockers } = orchestrationDraft({ name: 'Shop', path: '/repo' }, picked, true);
  assert.deepEqual(
    spec.tasks.map((t) => [t.id, t.dependsOn ?? [], t.workItemId]),
    [
      ['agn-3', ['agn-2'], docs.id],
      ['agn-1', [], api.id],
      ['agn-2', ['agn-1'], ui.id],
    ],
  );
  assert.equal(spec.cwd, '/repo');
  assert.equal(spec.worktree, true);
  assert.equal(spec.engine, 'graph');
  assert.match(spec.tasks[0]?.prompt ?? '', /^AGN-3 · Docs\n/);
  // A blocker left out is named; one already done does not hold anything back
  assert.deepEqual(externalBlockers.map((r) => r.key), ['AGN-4']);
  assert.equal(orchestrationDraft({ name: 'Shop', path: '/repo' }, picked, false).spec.worktree, false);
});

test("a task made from a message is titled with the message's first line", () => {
  assert.equal(titleFromMessage('\n## Cart loses items\n\nWhen the page reloads…'), 'Cart loses items');
  assert.equal(titleFromMessage('- first point\n- second'), 'first point');
  assert.equal(titleFromMessage('   '), 'Untitled task');
  const long = titleFromMessage('x'.repeat(300));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});
