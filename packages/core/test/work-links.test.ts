import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import type { AgentryEvent, Orchestration, OrchestrationTaskStatus, RunStatus, WorkItemHistoryEntry, WorkItemStatus } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { orchestrationDraft, titleFromMessage, WorkItemAutomation, workItemPrompt } from '../src/work-links.ts';
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
function graph(id: string, tasks: Array<{ id: string; workItemId?: string }>, templateId: string | null = null): Orchestration {
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
  assert.match(prompt, /^AGN-2: Cart loses items\n/);
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
  assert.match(spec.tasks[0]?.prompt ?? '', /^AGN-3: Docs/);
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
