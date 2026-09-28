import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { WorkItemActor, WorkItemCause, WorkItemLink, WorkItemStatus } from '@agentry/shared';
import { Db, WORK_ITEMS_SCHEMA_VERSION, migrate } from '../src/db.ts';
import type { AgentryEventInput } from '../src/events.ts';
import { WorkItemError, WorkItemService, type WorkItemLinkState, type WorkItemProject } from '../src/work-items.ts';
import { CRITERION_MAX, DESCRIPTION_MAX, MILESTONE_DESCRIPTION_MAX } from '../src/work-item-validation.ts';
import { tempConfig } from './helpers.ts';

type Emitted = AgentryEventInput;

function setup(opts: { limits?: Partial<Record<WorkItemStatus, number>>; linkState?: (id: string) => WorkItemLinkState | null } = {}) {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const projects = new Map<string, WorkItemProject>([
    ['p1', { keyPrefix: 'AGN', columnLimits: opts.limits ?? {} }],
    ['p2', { keyPrefix: 'LIB', columnLimits: {} }],
  ]);
  const events: Emitted[] = [];
  const linkState = opts.linkState;
  const service = new WorkItemService({
    db,
    project: (id) => projects.get(id) ?? null,
    emit: (event) => events.push(event),
    ...(linkState ? { linkState: (link: WorkItemLink) => linkState((link.kind === 'orchestration' ? link.taskId : link.chatId) ?? '') } : {}),
  });
  return { config, db, service, events, projects };
}

const refusal = (statusCode: number) => (err: unknown) => err instanceof WorkItemError && err.statusCode === statusCode;
const typesOf = (events: Emitted[]) => events.map((e) => e.type);
const orderIn = (service: WorkItemService, projectId: string, status: WorkItemStatus) =>
  service
    .board(projectId)
    .columns.find((c) => c.status === status)
    ?.items.map((i) => i.title) ?? [];

// ---------- keys and numbers ----------

test('numbers count up per project and the key is composed from the prefix when read', () => {
  const { service, projects } = setup();
  const a = service.create('p1', { title: 'First' });
  const b = service.create('p1', { title: 'Second' });
  const c = service.create('p2', { title: 'Elsewhere' });
  assert.deepEqual([a.key, b.key, c.key], ['AGN-1', 'AGN-2', 'LIB-1']);
  assert.equal(a.number, 1);

  // A new prefix renames every key at once, because only the number is stored
  projects.set('p1', { keyPrefix: 'NEW', columnLimits: {} });
  assert.equal(service.get(a.id).key, 'NEW-1');
  assert.equal(service.findByKey('p1', 'new-2')?.id, b.id);
  assert.equal(service.findByKey('p1', 'AGN-2'), null);
});

test('a number is never handed out again, even after the item that had it is deleted', () => {
  const { service } = setup();
  service.create('p1', { title: 'One' });
  const two = service.create('p1', { title: 'Two' });
  service.remove(two.id);
  assert.equal(service.create('p1', { title: 'Three' }).key, 'AGN-3');
  // Not even when the newest item is the one that went
  const all = service.list({ projectId: 'p1' });
  for (const item of all) service.remove(item.id);
  assert.equal(service.create('p1', { title: 'Four' }).key, 'AGN-4');
});

test('several processes on one data dir never hand out the same number nor the same rank', async () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  new Db(config).close();
  const root = dirname(config.dataDir);
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'work-item-writer.ts');
  const writers = ['a', 'b', 'c', 'd'].map(
    (label) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [...process.execArgv, fixture, root, label, '15'], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${label} exited ${String(code)}: ${stderr}`))));
      }),
  );
  await Promise.all(writers);

  const db = new Db(config);
  const service = new WorkItemService({ db, project: () => ({ keyPrefix: 'AGN', columnLimits: {} }) });
  const items = service.list({ projectId: 'p1' });
  assert.equal(items.length, 60);
  assert.deepEqual(
    items.map((i) => i.number).sort((x, y) => x - y),
    Array.from({ length: 60 }, (_, i) => i + 1),
  );
  const ranks = items.map((i) => i.rank);
  assert.equal(new Set(ranks).size, 60, 'every item of the column has its own rank');
  db.close();
});

// ---------- create and validation ----------

test('a malformed body or filter is refused with 400, never a crash the API answers with 500', () => {
  const { service } = setup();
  const item = service.create('p1', { title: 'Target' });
  const milestone = service.createMilestone('p1', { name: 'v1' });
  const as = (value: unknown) => value as never;
  const refusedWith400 = (label: string, run: () => unknown) => assert.throws(run, refusal(400), label);

  for (const [label, run] of [
    ['create', () => service.create('p1', as(undefined))],
    ['update', () => service.update(item.id, as(null))],
    ['move', () => service.move(item.id, as(undefined))],
    ['comment', () => service.comment(item.id, as(undefined))],
    ['relate', () => service.relate(item.id, as([]))],
    ['link', () => service.link(item.id, as(undefined))],
    ['check', () => service.checkCriterion(item.id, 'c', as(undefined))],
    ['milestone', () => service.createMilestone('p1', as(undefined))],
    ['milestone update', () => service.updateMilestone(milestone.id, as('x'))],
  ] as const) {
    refusedWith400(`no body: ${label}`, run);
  }

  for (const value of [true, 5, ['a'], { a: 1 }]) {
    const shown = JSON.stringify(value);
    refusedWith400(`create epicId ${shown}`, () => service.create('p1', { title: 't', epicId: as(value) }));
    refusedWith400(`update epicId ${shown}`, () => service.update(item.id, { epicId: as(value) }));
    refusedWith400(`create milestoneId ${shown}`, () => service.create('p1', { title: 't', milestoneId: as(value) }));
    refusedWith400(`update milestoneId ${shown}`, () => service.update(item.id, { milestoneId: as(value) }));
    refusedWith400(`move afterId ${shown}`, () => service.move(item.id, { status: 'todo', afterId: as(value) }));
    refusedWith400(`relate itemId ${shown}`, () => service.relate(item.id, { type: 'blocks', itemId: as(value) }));
  }
  for (const value of ['abc', 5, { text: 'a' }, [null], [{ text: 5 }], [{ text: 'a', id: 5 }]]) {
    const shown = JSON.stringify(value);
    refusedWith400(`create criteria ${shown}`, () => service.create('p1', { title: 't', acceptanceCriteria: as(value) }));
    refusedWith400(`update criteria ${shown}`, () => service.update(item.id, { acceptanceCriteria: as(value) }));
  }
  // A query string repeated or left bare can reach the filter in the wrong shape
  for (const filter of [{ status: 'todo' }, { labels: 'ui' }, { assignee: [null] }, { epicId: ['a', 'b'] }, { milestoneId: true }, { q: ['a'] }, { projectId: 5 }]) {
    refusedWith400(`filter ${JSON.stringify(filter)}`, () => service.list(as(filter)));
    refusedWith400(`board ${JSON.stringify(filter)}`, () => service.board(null, as(filter)));
  }
  // Nothing was written by any of it
  assert.equal(service.list({ projectId: 'p1' }).length, 1);
  assert.equal(service.get(item.id).acceptanceCriteria.length, 0);
});

test('a description, a criterion and a milestone description are capped, so no read of the board carries a pasted log', () => {
  const { service } = setup();
  const long = (n: number) => 'x'.repeat(n + 1);
  assert.throws(() => service.create('p1', { title: 't', description: long(DESCRIPTION_MAX) }), refusal(400));
  const item = service.create('p1', { title: 't', description: 'x'.repeat(DESCRIPTION_MAX) });
  assert.throws(() => service.update(item.id, { description: long(DESCRIPTION_MAX) }), refusal(400));
  assert.throws(() => service.create('p1', { title: 't', acceptanceCriteria: [{ text: long(CRITERION_MAX) }] }), refusal(400));
  assert.throws(() => service.update(item.id, { acceptanceCriteria: [{ text: long(CRITERION_MAX) }] }), refusal(400));
  assert.throws(() => service.createMilestone('p1', { name: 'm', description: long(MILESTONE_DESCRIPTION_MAX) }), refusal(400));
  const milestone = service.createMilestone('p1', { name: 'm', description: 'fits' });
  assert.throws(() => service.updateMilestone(milestone.id, { description: long(MILESTONE_DESCRIPTION_MAX) }), refusal(400));
  assert.equal(service.milestone(milestone.id).description, 'fits');
});

test('a new item takes the defaults, goes last in its column and opens its history', () => {
  const { service, events } = setup();
  const item = service.create('p1', {
    title: '  Board filters  ',
    labels: ['ui', ' UI ', '', 'web'],
    acceptanceCriteria: [{ text: 'filters by type' }, { text: 'filters by label' }],
  });
  assert.equal(item.title, 'Board filters');
  assert.equal(item.type, 'task');
  assert.equal(item.status, 'backlog');
  assert.equal(item.priority, 'medium');
  assert.deepEqual(item.labels, ['ui', 'web']);
  assert.equal(item.assignee, null);
  assert.equal(item.closedAt, null);
  assert.deepEqual(
    item.acceptanceCriteria.map((c) => [c.text, c.checked, c.checkedBy]),
    [
      ['filters by type', false, null],
      ['filters by label', false, null],
    ],
  );
  const history = service.history(item.id);
  assert.deepEqual(
    history.map((h) => h.change),
    ['created'],
  );
  assert.deepEqual(history[0]?.actor, { kind: 'person', role: null });
  assert.deepEqual(typesOf(events), ['workitem.created']);

  const second = service.create('p1', { title: 'Second' });
  assert.ok(second.rank > item.rank);
  assert.equal(service.create('p1', { title: 'Done already', status: 'done' }).closedAt !== null, true);
});

test('refuses what the model does not allow, with the status code the API answers', () => {
  const { service } = setup();
  assert.throws(() => service.create('p1', { title: '   ' }), refusal(400));
  assert.throws(() => service.create('p1', { title: 'x', type: 'saga' as never }), refusal(400));
  assert.throws(() => service.create('p1', { title: 'x', status: 'blocked' as never }), refusal(400));
  assert.throws(() => service.create('p1', { title: 'x', priority: 'asap' as never }), refusal(400));
  assert.throws(() => service.create('p1', { title: 'x', assignee: { kind: 'role', role: ' ' } }), refusal(400));
  assert.throws(() => service.create('nope', { title: 'x' }), refusal(404));
  assert.throws(() => service.get('missing'), refusal(404));
  assert.throws(() => service.create('p1', { title: 'x', milestoneId: 'missing' }), refusal(400));
  // A refused create hands out no number
  assert.equal(service.create('p1', { title: 'ok' }).key, 'AGN-1');
});

test('who acts must be the person, an agent or the system, and a stored kind the store does not know is never read as the person', () => {
  const { service, db } = setup();
  const item = service.create('p1', { title: 'x' });
  const entries = service.history(item.id).length;
  const bogus = { kind: 'robot' } as unknown as WorkItemActor;
  assert.throws(() => service.update(item.id, { title: 'y' }, { actor: bogus }), refusal(400));
  assert.throws(() => service.comment(item.id, { body: 'hi' }, { actor: { kind: 'agent', role: 'r'.repeat(65) } }), refusal(400));
  assert.throws(() => service.create('p1', { title: 'z' }, { actor: { kind: 'agent', role: 42 as unknown as string } }), refusal(400));
  assert.equal(service.get(item.id).title, 'x');
  assert.equal(service.history(item.id).length, entries);
  assert.equal(service.comments(item.id).length, 0);

  // A row written by something else, or by a later version with a kind this one does not know
  db.connection.prepare("UPDATE work_item_history SET actor_kind = 'robot' WHERE item_id = ?").run(item.id);
  assert.deepEqual(service.history(item.id)[0]?.actor, { kind: 'system', role: null });
});

// ---------- epics ----------

test('an epic groups items of its project and never has an epic of its own', () => {
  const { service } = setup();
  const epic = service.create('p1', { title: 'Board', type: 'epic' });
  const story = service.create('p1', { title: 'Columns', type: 'story', epicId: epic.id });
  assert.equal(story.epicId, epic.id);
  assert.deepEqual(story.epic, { id: epic.id, key: epic.key, title: 'Board', type: 'epic', status: 'backlog' });
  assert.deepEqual(
    service.get(epic.id).children.map((c) => c.id),
    [story.id],
  );

  const other = service.create('p1', { title: 'Another epic', type: 'epic' });
  assert.throws(() => service.create('p1', { title: 'Nested', type: 'epic', epicId: epic.id }), refusal(400));
  assert.throws(() => service.update(other.id, { epicId: epic.id }), refusal(400));
  assert.throws(() => service.update(epic.id, { epicId: epic.id }), refusal(400));
  // Only an epic can be one
  assert.throws(() => service.create('p1', { title: 'x', epicId: story.id }), refusal(400));
  // Nor one from another project
  const foreign = service.create('p2', { title: 'Foreign', type: 'epic' });
  assert.throws(() => service.create('p1', { title: 'x', epicId: foreign.id }), refusal(400));
  // An item with an epic cannot become an epic, and an epic that groups items cannot stop being one
  assert.throws(() => service.update(story.id, { type: 'epic' }), refusal(400));
  assert.throws(() => service.update(epic.id, { type: 'task' }), refusal(409));
  assert.equal(service.update(story.id, { type: 'epic', epicId: null }).type, 'epic');
});

test('deleting an epic leaves its items without one, and each says so in its history', () => {
  const { service } = setup();
  const epic = service.create('p1', { title: 'Board', type: 'epic' });
  const story = service.create('p1', { title: 'Columns', epicId: epic.id });
  service.remove(epic.id);
  const after = service.get(story.id);
  assert.equal(after.epicId, null);
  const last = after.history.at(-1);
  assert.equal(last?.change, 'epic');
  assert.deepEqual(last?.from, { id: epic.id, label: 'Board', key: 'AGN-1' });
  assert.equal(last?.to, null);
});

// ---------- update and history ----------

test('an update writes one history entry per field that changed, and nothing for what did not', () => {
  const { service, events } = setup();
  const milestone = service.createMilestone('p1', { name: 'v0.19' });
  const item = service.create('p1', { title: 'Old', priority: 'low' });
  events.length = 0;
  const cause: WorkItemCause = { kind: 'chat', chatId: 's1', orchestrationId: null, taskId: null, event: 'chat.turn-completed' };
  service.update(
    item.id,
    { title: 'New', priority: 'low', labels: ['x'], assignee: { kind: 'role', role: 'qa' }, milestoneId: milestone.id, description: '' },
    { actor: { kind: 'agent', role: 'developer' }, cause },
  );
  const history = service.history(item.id).slice(1);
  assert.deepEqual(
    history.map((h) => [h.change, h.from, h.to]),
    [
      ['title', 'Old', 'New'],
      ['labels', [], ['x']],
      ['assignee', null, { kind: 'role', role: 'qa' }],
      ['milestone', null, { id: milestone.id, label: 'v0.19' }],
    ],
  );
  assert.ok(history.every((h) => h.actor.kind === 'agent' && h.actor.role === 'developer'));
  assert.deepEqual(history[0]?.cause, cause);
  const updated = events.find((e) => e.type === 'workitem.updated');
  assert.deepEqual(updated && 'changes' in updated ? updated.changes : null, ['title', 'labels', 'assignee', 'milestone']);

  // The same values again change nothing and announce nothing
  events.length = 0;
  service.update(item.id, { title: 'New', labels: ['x'] });
  assert.equal(service.history(item.id).length, 5);
  assert.deepEqual(events, []);
});

test('the history of a milestone survives its rename and its deletion', () => {
  const { service } = setup();
  const milestone = service.createMilestone('p1', { name: 'v1' });
  const item = service.create('p1', { title: 'x', milestoneId: milestone.id });
  service.updateMilestone(milestone.id, { name: 'v1.0' });
  service.deleteMilestone(milestone.id);
  const detail = service.get(item.id);
  assert.equal(detail.milestoneId, null);
  const last = detail.history.at(-1);
  assert.equal(last?.change, 'milestone');
  assert.deepEqual(last?.from, { id: milestone.id, label: 'v1.0' });
});

// ---------- acceptance criteria ----------

test('a criterion is checked on its own, with who checked it, and a replaced list keeps the checks it names', () => {
  const { service } = setup();
  const item = service.create('p1', { title: 'x', acceptanceCriteria: [{ text: 'a' }, { text: 'b' }] });
  const [a, b] = item.acceptanceCriteria;
  assert.ok(a && b);
  const checked = service.checkCriterion(item.id, a.id, { checked: true }, { actor: { kind: 'agent', role: 'qa' } });
  assert.deepEqual(checked.acceptanceCriteria[0]?.checkedBy, { kind: 'agent', role: 'qa' });
  assert.equal(checked.acceptanceCriteria[1]?.checked, false);
  const entry = service.history(item.id).at(-1);
  assert.equal(entry?.change, 'criterion');
  assert.deepEqual(entry?.to, { id: a.id, text: 'a', checked: true });

  // Checking it again is no change at all
  const before = service.history(item.id).length;
  service.checkCriterion(item.id, a.id, { checked: true });
  assert.equal(service.history(item.id).length, before);

  const replaced = service.update(item.id, { acceptanceCriteria: [{ text: 'c' }, { id: a.id, text: 'a, reworded' }] });
  assert.deepEqual(
    replaced.acceptanceCriteria.map((c) => [c.text, c.checked]),
    [
      ['c', false],
      ['a, reworded', true],
    ],
  );
  const changes = service.history(item.id).slice(before);
  assert.deepEqual(changes.map((h) => (h.from === null ? 'added' : h.to === null ? 'removed' : 'reworded')).sort(), ['added', 'removed', 'reworded']);
  assert.throws(() => service.update(item.id, { acceptanceCriteria: [{ id: 'foreign', text: 'x' }] }), refusal(400));
  assert.throws(() => service.checkCriterion(item.id, 'missing', { checked: true }), refusal(404));
});

test('reordering the criteria alone is announced and returns the new updatedAt, without a history entry', async () => {
  const { service, events } = setup();
  const item = service.create('p1', { title: 'x', acceptanceCriteria: [{ text: 'a' }, { text: 'b' }] });
  const [a, b] = item.acceptanceCriteria;
  assert.ok(a && b);
  const entries = service.history(item.id).length;
  events.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 5));

  const reordered = service.update(item.id, { acceptanceCriteria: [{ id: b.id, text: 'b' }, { id: a.id, text: 'a' }] });
  assert.deepEqual(
    reordered.acceptanceCriteria.map((c) => c.text),
    ['b', 'a'],
  );
  assert.ok(reordered.updatedAt > item.updatedAt, 'the result carries the new updatedAt');
  assert.equal(reordered.updatedAt, service.get(item.id).updatedAt);
  assert.deepEqual(
    events.map((e) => [e.type, 'changes' in e ? e.changes : null]),
    [['workitem.updated', ['criterion']]],
  );
  assert.equal(service.history(item.id).length, entries);

  // The same order again is no change at all
  events.length = 0;
  service.update(item.id, { acceptanceCriteria: [{ id: b.id, text: 'b' }, { id: a.id, text: 'a' }] });
  assert.deepEqual(events, []);
});

// ---------- moves and ranks ----------

test('appending to a column keeps ranks short instead of respreading the column every hundred cards', () => {
  const { service, db } = setup();
  const first = service.create('p1', { title: 'first' });
  for (let i = 0; i < 400; i++) service.create('p1', { title: `card ${String(i)}` });
  // A respread would have rewritten the first card's rank
  assert.equal(service.get(first.id).rank, first.rank);
  const longest = db.connection.prepare('SELECT MAX(LENGTH(rank)) AS n FROM work_items').get() as { n: number };
  assert.ok(longest.n <= 8, `ranks grew to ${String(longest.n)} characters`);
});

test('neighbours a hand edit left with no valid rank between them get the column respread, in order', () => {
  const { service, db } = setup();
  const [a, b, c] = ['A', 'B', 'C'].map((t) => service.create('p1', { title: t }));
  assert.ok(a && b && c);
  // Nothing sorts strictly between `a` and `a0`, and a midpoint would land after `a0`
  const setRank = db.connection.prepare('UPDATE work_items SET rank = ? WHERE id = ?');
  setRank.run('a', a.id);
  setRank.run('a0', b.id);
  service.move(c.id, { status: 'backlog', afterId: a.id });
  assert.deepEqual(orderIn(service, 'p1', 'backlog'), ['A', 'C', 'B']);
  // A rank holding a character that is not a digit is respread too, rather than failing the move
  setRank.run('a!', b.id);
  service.move(c.id, { status: 'backlog', afterId: b.id });
  assert.deepEqual(orderIn(service, 'p1', 'backlog'), ['A', 'B', 'C']);
});

test('moves keep the order a person gives, first, last and after a neighbour', () => {
  const { service } = setup();
  const [a, b, c] = ['A', 'B', 'C'].map((t) => service.create('p1', { title: t }));
  assert.ok(a && b && c);
  assert.deepEqual(orderIn(service, 'p1', 'backlog'), ['A', 'B', 'C']);
  service.move(c.id, { status: 'backlog', afterId: null });
  assert.deepEqual(orderIn(service, 'p1', 'backlog'), ['C', 'A', 'B']);
  service.move(c.id, { status: 'backlog', afterId: a.id });
  assert.deepEqual(orderIn(service, 'p1', 'backlog'), ['A', 'C', 'B']);
  service.move(a.id, { status: 'backlog' });
  assert.deepEqual(orderIn(service, 'p1', 'backlog'), ['C', 'B', 'A']);

  service.move(b.id, { status: 'todo' });
  service.move(a.id, { status: 'todo', afterId: null });
  service.move(c.id, { status: 'todo', afterId: a.id });
  assert.deepEqual(orderIn(service, 'p1', 'todo'), ['A', 'C', 'B']);
  assert.deepEqual(orderIn(service, 'p1', 'backlog'), []);
  // The list follows the board: column by column, rank inside each
  assert.deepEqual(
    service.list({ projectId: 'p1' }).map((i) => i.title),
    ['A', 'C', 'B'],
  );
  assert.throws(() => service.move(a.id, { status: 'todo', afterId: a.id }), refusal(400));
  assert.throws(() => service.move(a.id, { status: 'done', afterId: b.id }), refusal(400));
});

test('dropping a card after the same neighbour over and over keeps the order and respreads the column', () => {
  const { service } = setup();
  const anchor = service.create('p1', { title: 'anchor' });
  const tail = service.create('p1', { title: 'tail' });
  const titles: string[] = [];
  for (let i = 0; i < 150; i++) {
    const item = service.create('p1', { title: `n${String(i)}` });
    service.move(item.id, { status: 'backlog', afterId: anchor.id });
    titles.unshift(`n${String(i)}`);
  }
  assert.deepEqual(orderIn(service, 'p1', 'backlog'), ['anchor', ...titles, 'tail']);
  assert.ok(service.list({ projectId: 'p1' }).every((i) => i.rank.length <= 24));
  assert.ok(service.find(tail.id));
});

test('a move records its status in the history, sets closedAt in done, and a reorder alone writes none', () => {
  const { service, events } = setup();
  const item = service.create('p1', { title: 'x' });
  const other = service.create('p1', { title: 'y' });
  events.length = 0;
  const cause: WorkItemCause = { kind: 'chat', chatId: 's1', orchestrationId: null, taskId: null, event: 'chat.started' };
  service.move(item.id, { status: 'in_progress' }, { actor: { kind: 'system' }, cause });
  const done = service.move(item.id, { status: 'done' }).item;
  assert.ok(done.closedAt);
  assert.equal(service.move(item.id, { status: 'in_review' }).item.closedAt, null);
  const moves = service.history(item.id).filter((h) => h.change === 'status');
  assert.deepEqual(
    moves.map((h) => [h.from, h.to]),
    [
      ['backlog', 'in_progress'],
      ['in_progress', 'done'],
      ['done', 'in_review'],
    ],
  );
  assert.deepEqual(moves[0]?.cause, cause);
  assert.deepEqual(moves[0]?.actor, { kind: 'system', role: null });

  const third = service.create('p1', { title: 'z' });
  const historyBefore = service.history(third.id).length;
  service.move(third.id, { status: 'backlog', afterId: null });
  assert.deepEqual(orderIn(service, 'p1', 'backlog'), ['z', 'y']);
  assert.equal(service.history(third.id).length, historyBefore);
  const reorder = events.at(-1);
  assert.equal(reorder?.type, 'workitem.moved');
  assert.ok(reorder?.type === 'workitem.moved' && reorder.status === reorder.previousStatus);

  // Asking for the place it already holds moves nothing and announces nothing
  events.length = 0;
  service.move(third.id, { status: 'backlog', afterId: null });
  service.move(other.id, { status: 'backlog', afterId: third.id });
  service.move(other.id, { status: 'backlog' });
  assert.deepEqual(events, []);
});

test('a move over the column limit succeeds and says so, in the result, the event and the board', () => {
  const { service, events } = setup({ limits: { in_progress: 1 } });
  const a = service.create('p1', { title: 'a' });
  const b = service.create('p1', { title: 'b' });
  assert.equal(service.move(a.id, { status: 'in_progress' }).column.overLimit, false);
  const over = service.move(b.id, { status: 'in_progress' });
  assert.equal(over.item.status, 'in_progress');
  assert.deepEqual(over.column, { status: 'in_progress', limit: 1, count: 2, overLimit: true });
  const event = events.at(-1);
  assert.ok(event?.type === 'workitem.moved' && event.overLimit);
  const column = service.board('p1').columns.find((c) => c.status === 'in_progress');
  assert.equal(column?.overLimit, true);
});

test('an epic stays on the board but counts neither as an open item nor against a column limit', () => {
  const { service } = setup({ limits: { in_progress: 1 } });
  const epic = service.create('p1', { title: 'Checkout', type: 'epic', status: 'in_progress' });
  const task = service.create('p1', { title: 'Pay', epicId: epic.id });
  service.create('p2', { title: 'Elsewhere', type: 'epic' });

  // The task fills the one place: the epic beside it does not make it 2 of 1
  const moved = service.move(task.id, { status: 'in_progress' });
  assert.deepEqual(moved.column, { status: 'in_progress', limit: 1, count: 1, overLimit: false });
  const column = service.board('p1').columns.find((c) => c.status === 'in_progress');
  assert.deepEqual(column?.items.map((i) => i.id), [epic.id, task.id]);
  assert.equal(column?.count, 1);
  assert.equal(column?.overLimit, false);

  // Moving the epic itself leaves the counts where they were, in its project and across all of them
  assert.equal(service.move(epic.id, { status: 'todo' }).column.count, 0);
  assert.deepEqual(
    service.board('p1').columns.map((c) => c.count),
    [0, 0, 1, 0, 0],
  );
  assert.deepEqual(
    service.board(null).columns.map((c) => c.count),
    [0, 0, 1, 0, 0],
  );
});

// ---------- relations ----------

test('a relation is stored once and read from both ends', () => {
  const { service } = setup();
  const a = service.create('p1', { title: 'a' });
  const b = service.create('p1', { title: 'b' });
  service.relate(b.id, { type: 'blocked_by', itemId: a.id });
  assert.deepEqual(
    service.get(a.id).relations.map((r) => [r.type, r.item.key]),
    [['blocks', 'AGN-2']],
  );
  assert.deepEqual(
    service.get(b.id).relations.map((r) => [r.type, r.item.key]),
    [['blocked_by', 'AGN-1']],
  );
  // Asked again, from the other end, it is the same relation
  service.relate(a.id, { type: 'blocks', itemId: b.id });
  assert.equal(service.get(a.id).relations.length, 1);
  assert.deepEqual(service.get(a.id).history.at(-1)?.to, { type: 'blocks', item: { id: b.id, key: 'AGN-2', title: 'b', type: 'task', status: 'backlog' } });

  service.unrelate(b.id, a.id);
  assert.deepEqual(service.get(a.id).relations, []);
  assert.equal(service.get(b.id).history.at(-1)?.to, null);
  assert.throws(() => service.unrelate(b.id, a.id), refusal(404));
});

test('a relation cannot point at its own item, cross projects, nor close a cycle of blocks', () => {
  const { service } = setup();
  const [a, b, c] = ['a', 'b', 'c'].map((t) => service.create('p1', { title: t }));
  assert.ok(a && b && c);
  assert.throws(() => service.relate(a.id, { type: 'blocks', itemId: a.id }), refusal(400));
  const foreign = service.create('p2', { title: 'x' });
  assert.throws(() => service.relate(a.id, { type: 'blocks', itemId: foreign.id }), refusal(400));
  service.relate(a.id, { type: 'blocks', itemId: b.id });
  service.relate(b.id, { type: 'blocks', itemId: c.id });
  assert.throws(() => service.relate(c.id, { type: 'blocks', itemId: a.id }), refusal(409));
  assert.throws(() => service.relate(a.id, { type: 'blocked_by', itemId: c.id }), refusal(409));
  assert.throws(() => service.relate(b.id, { type: 'blocks', itemId: a.id }), refusal(409));
  // A chain that does not loop back is fine
  service.relate(a.id, { type: 'blocks', itemId: c.id });
  assert.equal(service.get(c.id).relations.length, 2);
});

test('deleting an item removes its relations and the other ends record it', () => {
  const { service } = setup();
  const a = service.create('p1', { title: 'a' });
  const b = service.create('p1', { title: 'b' });
  service.relate(a.id, { type: 'blocks', itemId: b.id });
  service.remove(a.id);
  const after = service.get(b.id);
  assert.deepEqual(after.relations, []);
  assert.deepEqual(after.history.at(-1)?.from, { type: 'blocked_by', item: { id: a.id, key: 'AGN-1', title: 'a', type: 'task', status: 'backlog' } });
});

// ---------- comments and links ----------

test('comments by the person and by agents are their own list, oldest first, and announced', () => {
  const { service, events } = setup();
  const item = service.create('p1', { title: 'x' });
  events.length = 0;
  service.comment(item.id, { body: 'Looks good' });
  const source = { kind: 'chat' as const, chatId: 's1', orchestrationId: null, taskId: null };
  service.comment(item.id, { body: 'Rejected: the filter ignores labels' }, { actor: { kind: 'agent', role: 'qa' }, source });
  const detail = service.get(item.id);
  assert.deepEqual(
    detail.comments.map((c) => [c.author.kind, c.source?.chatId ?? null, c.body]),
    [
      ['person', null, 'Looks good'],
      ['agent', 's1', 'Rejected: the filter ignores labels'],
    ],
  );
  assert.deepEqual(
    detail.history.map((h) => h.change),
    ['created'],
  );
  assert.ok(events.every((e) => e.type === 'workitem.updated' && e.changes.includes('comment')));
  assert.throws(() => service.comment(item.id, { body: ' ' }), refusal(400));
});

test('the comments of a missing item are a 404, not an empty list, and a comment has a maximum length', () => {
  const { service } = setup();
  assert.throws(() => service.comments('missing'), refusal(404));
  const item = service.create('p1', { title: 'x' });
  assert.deepEqual(service.comments(item.id), []);
  assert.throws(() => service.comment(item.id, { body: 'x'.repeat(50_001) }), refusal(400));
  assert.equal(service.comment(item.id, { body: 'x'.repeat(50_000) }).body.length, 50_000);
  assert.equal(service.comments(item.id).length, 1);
});

test('an item keeps every link, a repeated link is the one already there, and a working one makes the item live', () => {
  const states = new Map<string, WorkItemLinkState>([
    ['s1', { name: 'First try', chatState: 'idle' }],
    ['s2', { name: 'Second try', chatState: 'working' }],
    ['t1', { name: 'Build it', taskStatus: 'running' }],
  ]);
  const { service } = setup({ linkState: (id) => states.get(id) ?? null });
  const item = service.create('p1', { title: 'x' });
  const first = service.link(item.id, { kind: 'chat', role: 'work', chatId: 's1' });
  assert.equal(service.link(item.id, { kind: 'chat', role: 'work', chatId: 's1' }).id, first.id);
  service.link(item.id, { kind: 'chat', role: 'origin', chatId: 's0' });
  assert.equal(service.find(item.id)?.activeLink ?? null, null);
  service.link(item.id, { kind: 'chat', role: 'work', chatId: 's2' });
  const detail = service.get(item.id);
  assert.equal(detail.links.length, 3);
  assert.equal(detail.links[0]?.name, 'First try');
  assert.equal(detail.links[0]?.chatState, 'idle');
  assert.equal(detail.activeLink?.chatId, 's2');
  assert.deepEqual(
    detail.history.filter((h) => h.change === 'link').map((h) => (h.to && typeof h.to === 'object' && 'label' in h.to ? h.to.label : null)),
    ['First try', 'chat s0', 'Second try'],
  );

  // A task is linked before its worker has a chat, and learns it later without becoming a second link
  const task = service.link(item.id, { kind: 'orchestration', role: 'work', orchestrationId: 'o1', taskId: 't1' });
  service.setLinkChat(task.id, 's9');
  assert.equal(service.link(item.id, { kind: 'orchestration', role: 'work', orchestrationId: 'o1', taskId: 't1' }).id, task.id);
  assert.deepEqual(
    service.linksOfTask('o1', 't1').map((l) => [l.chatId, l.taskStatus]),
    [['s9', 'running']],
  );
  assert.deepEqual(
    service.linksOfChat('s2').map((l) => l.itemId),
    [item.id],
  );

  assert.throws(() => service.link(item.id, { kind: 'chat', role: 'work' }), refusal(400));
  assert.throws(() => service.link(item.id, { kind: 'orchestration', role: 'work', orchestrationId: 'o1' }), refusal(400));
  service.unlink(first.id);
  assert.equal(service.links(item.id).length, 3);
});

test('the ids of a link must be non-empty text, refused with a 400 rather than failing in SQLite', () => {
  const { service } = setup();
  const item = service.create('p1', { title: 'x' });
  const bad = (value: unknown) => value as string;
  for (const chatId of [bad({}), bad(42), bad(['c1']), '', '   ']) {
    assert.throws(() => service.link(item.id, { kind: 'chat', role: 'work', chatId }), refusal(400), JSON.stringify(chatId));
  }
  assert.throws(() => service.link(item.id, { kind: 'orchestration', role: 'work', orchestrationId: bad({}), taskId: 't1' }), refusal(400));
  assert.throws(() => service.link(item.id, { kind: 'orchestration', role: 'work', orchestrationId: 'o1', taskId: bad(7) }), refusal(400));
  assert.throws(() => service.link(item.id, { kind: 'orchestration', role: 'work', orchestrationId: 'o1', taskId: 't1', chatId: bad(true) }), refusal(400));
  assert.deepEqual(service.links(item.id), []);

  const link = service.link(item.id, { kind: 'orchestration', role: 'work', orchestrationId: 'o1', taskId: 't1' });
  assert.throws(() => service.setLinkChat(link.id, bad(null)), refusal(400));
  assert.throws(() => service.setLinkChat(link.id, ''), refusal(400));
  assert.equal(service.setLinkChat(link.id, 'c9').chatId, 'c9');
});

test('the worktree and branch of an item are recorded as a fact: announced, but not written into its history', () => {
  const { service, events } = setup();
  const item = service.create('p1', { title: 'x' });
  const entries = service.history(item.id).length;
  events.length = 0;
  const placed = service.setWorktree(item.id, { worktree: '/repo/.claude/worktrees/agn-1', branch: 'task/agn-1' });
  assert.deepEqual([placed.worktree, placed.branch], ['/repo/.claude/worktrees/agn-1', 'task/agn-1']);
  assert.deepEqual(
    [service.get(item.id).worktree, service.get(item.id).branch],
    ['/repo/.claude/worktrees/agn-1', 'task/agn-1'],
  );
  assert.equal(service.history(item.id).length, entries);
  assert.deepEqual(
    events.map((e) => (e.type === 'workitem.updated' ? [e.itemId, e.changes, e.actor.kind] : e.type)),
    [[item.id, [], 'system']],
  );
  const cleared = service.setWorktree(item.id, { worktree: null, branch: null });
  assert.deepEqual([cleared.worktree, cleared.branch], [null, null]);
  assert.throws(() => service.setWorktree('missing', { worktree: '/x', branch: 'task/x' }), refusal(404));
});

// ---------- lists, filters, search and the board ----------

function seeded() {
  const s = setup();
  const { service } = s;
  const epic = service.create('p1', { title: 'Board epic', type: 'epic' });
  const milestone = service.createMilestone('p1', { name: 'v0.19' });
  const bug = service.create('p1', { title: 'Crash on drag', type: 'bug', priority: 'urgent', labels: ['UI'], epicId: epic.id, milestoneId: milestone.id });
  const story = service.create('p1', {
    title: 'Filter by label',
    type: 'story',
    description: 'Show 100% of the_items',
    labels: ['ui', 'filters'],
    assignee: { kind: 'role', role: 'developer' },
    milestoneId: milestone.id,
  });
  const task = service.create('p1', { title: 'Write docs', assignee: { kind: 'person' }, priority: 'low' });
  service.move(task.id, { status: 'done' });
  const foreign = service.create('p2', { title: 'Crash in lib', type: 'bug' });
  return { ...s, epic, milestone, bug, story, task, foreign };
}

test('filters combine as all of them, and the values of one filter as any of them', () => {
  const { service, epic, milestone, bug, story, task } = seeded();
  const ids = (filter: Parameters<WorkItemService['list']>[0]) => service.list({ projectId: 'p1', ...filter }).map((i) => i.id);
  assert.deepEqual(ids({ type: ['bug', 'story'] }), [bug.id, story.id]);
  assert.deepEqual(ids({ priority: ['urgent'] }), [bug.id]);
  assert.deepEqual(ids({ status: ['done'] }), [task.id]);
  // Labels match whatever the case
  assert.deepEqual(ids({ labels: ['ui'] }), [bug.id, story.id]);
  assert.deepEqual(ids({ labels: ['filters'], type: ['bug'] }), []);
  assert.deepEqual(ids({ assignee: ['person'] }), [task.id]);
  assert.deepEqual(ids({ assignee: ['role:developer'] }), [story.id]);
  assert.deepEqual(ids({ assignee: ['none'] }), [epic.id, bug.id]);
  assert.deepEqual(ids({ assignee: ['person', 'role:developer'] }), [story.id, task.id]);
  assert.deepEqual(ids({ epicId: epic.id }), [bug.id]);
  assert.deepEqual(ids({ milestoneId: milestone.id }), [bug.id, story.id]);
  assert.throws(() => ids({ assignee: ['someone'] }), refusal(400));
});

test('search looks in the title and the description, takes wildcards literally and matches keys', () => {
  const { service, bug, story, foreign } = seeded();
  const titles = (q: string, projectId?: string) => service.list({ q, ...(projectId ? { projectId } : {}) }).map((i) => i.id);
  assert.deepEqual(titles('crash', 'p1'), [bug.id]);
  assert.deepEqual(titles('CRASH').sort(), [bug.id, foreign.id].sort());
  assert.deepEqual(titles('100%', 'p1'), [story.id]);
  assert.deepEqual(titles('the_items', 'p1'), [story.id]);
  assert.deepEqual(titles('%', 'p1'), [story.id]);
  assert.deepEqual(titles('the%items', 'p1'), []);
  assert.deepEqual(titles(story.key, 'p1'), [story.id]);
  // A key names one project's item, even across every project
  assert.deepEqual(titles('lib-1'), [foreign.id]);
});

test('search and the label filter fold case in every language, not only in ASCII', () => {
  const { service } = setup();
  const session = service.create('p1', { title: 'SESIÓN caducada', labels: ['Übersetzung'] });
  const street = service.create('p1', { title: 'x', description: 'Die STRASSE ist gesperrt' });
  const ids = (filter: Parameters<WorkItemService['list']>[0]) => service.list({ projectId: 'p1', ...filter }).map((i) => i.id);
  assert.deepEqual(ids({ q: 'sesión' }), [session.id]);
  assert.deepEqual(ids({ q: 'Sesión CADUCADA' }), [session.id]);
  assert.deepEqual(ids({ q: 'straße' }), [street.id]);
  assert.deepEqual(ids({ labels: ['übersetzung'] }), [session.id]);
  assert.deepEqual(ids({ labels: ['ÜBERSETZUNG'] }), [session.id]);
});

test('the board holds the five columns in order; a filter narrows the items but not the counts', () => {
  const { service, bug, story, task } = seeded();
  const board = service.board('p1', { type: ['bug'] });
  assert.equal(board.projectId, 'p1');
  assert.deepEqual(
    board.columns.map((c) => c.status),
    ['backlog', 'todo', 'in_progress', 'in_review', 'done'],
  );
  const backlog = board.columns[0];
  // The bug and the story; the epic they share is on the board but not in the count
  assert.equal(backlog?.count, 2);
  assert.deepEqual(
    backlog?.items.map((i) => i.id),
    [bug.id],
  );
  assert.equal(board.columns[4]?.count, 1);
  assert.deepEqual(board.columns[4]?.items, []);
  assert.equal(story.status, 'backlog');
  assert.equal(task.id, service.board('p1').columns[4]?.items[0]?.id);

  // All projects: every project's items, and no limits
  const all = service.board(null);
  assert.equal(all.projectId, null);
  assert.equal(all.columns[0]?.count, 3);
  assert.ok(all.columns.every((c) => c.limit === null && !c.overLimit));
  assert.deepEqual(
    all.columns[0]?.items.map((i) => i.key),
    ['AGN-1', 'AGN-2', 'AGN-3', 'LIB-1'],
  );
});

// ---------- milestones ----------

test('a milestone has no date, and its progress is derived from its items, epics left out', () => {
  const { service, events } = setup();
  const milestone = service.createMilestone('p1', { name: 'v0.19', description: 'The board' });
  assert.deepEqual(milestone.progress, { total: 0, done: 0, byStatus: { backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0 } });
  service.create('p1', { title: 'Epic', type: 'epic', milestoneId: milestone.id });
  const a = service.create('p1', { title: 'a', milestoneId: milestone.id });
  service.create('p1', { title: 'b', milestoneId: milestone.id, status: 'in_progress' });
  service.move(a.id, { status: 'done' });
  const read = service.milestones('p1')[0];
  assert.equal(read?.progress.total, 2);
  assert.equal(read?.progress.done, 1);
  assert.equal(read?.progress.byStatus.in_progress, 1);

  const closed = service.updateMilestone(milestone.id, { state: 'closed' });
  assert.equal(closed.state, 'closed');
  assert.ok(closed.closedAt);
  const reopened = service.updateMilestone(milestone.id, { state: 'open' });
  assert.equal(reopened.closedAt, null);
  assert.deepEqual(
    events.filter((e) => e.type === 'milestone.changed').map((e) => (e.type === 'milestone.changed' ? e.action : null)),
    ['created', 'closed', 'reopened'],
  );
  assert.throws(() => service.createMilestone('p1', { name: ' ' }), refusal(400));
  assert.throws(() => service.updateMilestone('missing', { name: 'x' }), refusal(404));
  // A milestone of another project is not this project's to use
  const foreign = service.createMilestone('p2', { name: 'lib v1' });
  assert.throws(() => service.update(a.id, { milestoneId: foreign.id }), refusal(400));
});

// ---------- events ----------

test('every change reaches the feed with the ids to refetch, and only once it is committed', () => {
  const { service, events } = setup();
  const seen: string[] = [];
  const a = service.create('p1', { title: 'a' });
  const b = service.create('p1', { title: 'b' });
  service.relate(a.id, { type: 'blocks', itemId: b.id });
  service.move(a.id, { status: 'todo' });
  service.remove(a.id);
  for (const e of events) if ('key' in e) seen.push(`${e.type}:${e.key}`);
  assert.deepEqual(seen, [
    'workitem.created:AGN-1',
    'workitem.created:AGN-2',
    'workitem.updated:AGN-1',
    'workitem.updated:AGN-2',
    'workitem.moved:AGN-1',
    'workitem.removed:AGN-1',
    'workitem.updated:AGN-2',
  ]);
  assert.ok(events.every((e) => e.title.length > 0 && 'projectId' in e && e.projectId === 'p1'));

  // A refused change announces nothing
  events.length = 0;
  assert.throws(() => service.relate(b.id, { type: 'blocks', itemId: b.id }));
  assert.deepEqual(events, []);
});

test('a listener that throws does not undo the change nor reach the caller', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const service = new WorkItemService({
    db,
    project: () => ({ keyPrefix: 'AGN', columnLimits: {} }),
    emit: () => {
      throw new Error('broken listener');
    },
  });
  const item = service.create('p1', { title: 'x' });
  assert.equal(service.get(item.id).title, 'x');
  db.close();
});

test('a ROLLBACK that fails does not hide the error that caused it, and the store stays usable', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  let sabotage = false;
  const service = new WorkItemService({
    db,
    project: () => ({ keyPrefix: 'AGN', columnLimits: {} }),
    // Runs inside the link's transaction: ends it early, so the store's own ROLLBACK finds none
    linkState: () => {
      if (!sabotage) return null;
      db.connection.exec('ROLLBACK');
      throw new Error('the original failure');
    },
  });
  const item = service.create('p1', { title: 'x' });
  sabotage = true;
  assert.throws(() => service.link(item.id, { kind: 'chat', role: 'work', chatId: 'c1' }), /the original failure/);
  sabotage = false;
  assert.deepEqual(service.links(item.id), []);
  assert.equal(service.update(item.id, { title: 'y' }).title, 'y');
  db.close();
});

// ---------- persistence ----------

test('the migration applies on top of a database at the previous version and keeps what it held', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  // Build the store as the release before the work items left it, whatever migrations came since:
  // every migration up to the one before theirs, with a row in it
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(raw, WORK_ITEMS_SCHEMA_VERSION - 1);
  const workTables = () =>
    (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'work_item%' OR name = 'milestones')").all() as Array<{ name: string }>).map((t) => t.name);
  assert.deepEqual(workTables(), []);
  raw
    .prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, kinds, level, label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('sub-1', 'https://push.example/1', 'k', 'a', '[]', 'important', 'Phone', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
  raw.close();

  const reopened = new Db(config);
  assert.equal(reopened.pushSubscriptions()[0]?.label, 'Phone');
  const service = new WorkItemService({ db: reopened, project: () => ({ keyPrefix: 'AGN', columnLimits: {} }) });
  const item = service.create('p1', { title: 'After the upgrade' });
  assert.equal(item.key, 'AGN-1');
  reopened.close();

  const check = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  assert.ok((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= WORK_ITEMS_SCHEMA_VERSION);
  const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'work_item%' OR name = 'milestones')").all() as Array<{ name: string }>).map(
    (t) => t.name,
  );
  assert.deepEqual(tables.sort(), ['milestones', 'work_item_comments', 'work_item_counters', 'work_item_criteria', 'work_item_history', 'work_item_labels', 'work_item_links', 'work_item_relations', 'work_items']);
  const indexes = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'work_items'").all() as Array<{ name: string }>).map((i) => i.name);
  assert.ok(indexes.includes('work_items_board'), 'indexed by project and status');
  check.close();
});

test('work items survive a reopen, and a project the store does not know still reads with a key', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const first = new Db(config);
  const known = new WorkItemService({ db: first, project: () => ({ keyPrefix: 'AGN', columnLimits: {} }) });
  const item = known.create('p1', { title: 'Kept', labels: ['a'] });
  first.close();

  const second = new Db(config);
  const forgetful = new WorkItemService({ db: second, project: () => null });
  const read = forgetful.get(item.id);
  assert.equal(read.title, 'Kept');
  assert.deepEqual(read.labels, ['a']);
  assert.equal(read.key, 'ITEM-1');
  // Writing into a project that does not exist is refused
  assert.throws(() => forgetful.create('p1', { title: 'x' }), refusal(404));
  second.close();
});

// ---------- payloads and paging ----------

test('the board, the lists and their pages leave descriptions out, and the item and the store keep them', () => {
  const { service, story, bug, task } = seeded();
  const long = 'x'.repeat(50_000);
  service.update(bug.id, { description: long });
  const cards = [
    ...service.board('p1').columns.flatMap((c) => c.items),
    ...service.cards({ projectId: 'p1' }),
    ...service.page({ projectId: 'p1' }).items,
    ...service.cardsOf([story.id, bug.id]),
  ];
  assert.ok(cards.length >= 8);
  for (const card of cards) assert.equal(card.description, '', card.key);
  const flag = (id: string) => [...new Set(cards.filter((c) => c.id === id).map((c) => c.hasDescription))];
  assert.deepEqual(flag(bug.id), [true]);
  assert.deepEqual(flag(story.id), [true]);
  assert.deepEqual(flag(task.id), [false]);
  // Whole wherever one item is read, and for the code that works on it
  assert.equal(service.get(bug.id).description, long);
  assert.equal(service.get(bug.id).hasDescription, undefined);
  assert.equal(service.list({ projectId: 'p1' }).find((i) => i.id === bug.id)?.description, long);
  assert.deepEqual(
    service.cardsOf(['missing', story.id]).map((i) => i.id),
    [story.id],
  );
});

test('a list is paged by a cursor in its own order: nothing repeats or is skipped when items arrive meanwhile', () => {
  const { service } = setup();
  const made = Array.from({ length: 7 }, (_, n) => service.create('p1', { title: `item ${String(n)}`, status: n % 2 ? 'todo' : 'backlog' }));
  service.create('p2', { title: 'other project' });
  const whole = service.cards({ projectId: 'p1' }).map((i) => i.id);
  assert.equal(whole.length, made.length);

  const first = service.page({ projectId: 'p1' }, { limit: 3 });
  assert.equal(first.total, 7);
  assert.deepEqual(
    first.items.map((i) => i.id),
    whole.slice(0, 3),
  );
  assert.ok(first.nextCursor);
  // An item put at the top of the backlog after the first page does not push another one back into view
  const late = service.create('p1', { title: 'late' });
  service.move(late.id, { status: 'backlog', afterId: null });
  const second = service.page({ projectId: 'p1' }, { limit: 3, cursor: first.nextCursor });
  assert.equal(second.total, 8);
  assert.deepEqual(
    second.items.map((i) => i.id),
    whole.slice(3, 6),
  );
  const third = service.page({ projectId: 'p1' }, { limit: 3, cursor: second.nextCursor });
  assert.deepEqual(
    third.items.map((i) => i.id),
    whole.slice(6),
  );
  assert.equal(third.nextCursor, null);

  // The filter applies before the page, and the default page holds them all here
  const todo = service.page({ projectId: 'p1', status: ['todo'] });
  assert.equal(todo.total, 3);
  assert.equal(todo.nextCursor, null);
  assert.ok(todo.items.every((i) => i.status === 'todo'));
  // Above the maximum is brought down; below one, a fraction and a cursor this list did not hand out are refused
  assert.equal(service.page({ projectId: 'p1' }, { limit: 10_000 }).items.length, 8);
  assert.throws(() => service.page({}, { limit: 0 }), refusal(400));
  assert.throws(() => service.page({}, { limit: 2.5 }), refusal(400));
  assert.throws(() => service.page({}, { cursor: 'not-a-cursor' }), refusal(400));
  assert.throws(() => service.page({}, { cursor: Buffer.from('[1,2]').toString('base64url') }), refusal(400));
});

test('the Done column holds its newest closed items in rank order, counts the rest in more, and counts stay whole', () => {
  const { service, db } = setup();
  const closed = Array.from({ length: 25 }, (_, n) => service.create('p1', { title: `done ${String(n)}`, type: n === 0 ? 'bug' : 'task', status: 'done' }));
  // Closed a minute apart, oldest first, so "newest" does not hang on the clock
  closed.forEach((item, n) =>
    db.connection.prepare('UPDATE work_items SET closed_at = ? WHERE id = ?').run(new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), item.id),
  );
  const open = service.create('p1', { title: 'still open' });

  const board = service.board('p1');
  const done = board.columns.find((c) => c.status === 'done');
  assert.equal(done?.count, 25);
  assert.equal(done?.items.length, 20);
  assert.equal(done?.more, 5);
  // The newest twenty, left in the order a person ranked them
  assert.deepEqual(
    done?.items.map((i) => i.id),
    closed.slice(5).map((i) => i.id),
  );
  const backlog = board.columns.find((c) => c.status === 'backlog');
  assert.equal(backlog?.items[0]?.id, open.id);
  assert.equal(backlog?.more, undefined);

  // "And 5 more" asks again with a larger limit
  const whole = service.board('p1', {}, { doneLimit: 40 }).columns.find((c) => c.status === 'done');
  assert.equal(whole?.items.length, 25);
  assert.equal(whole?.more, undefined);
  assert.equal(service.board('p1', {}, { doneLimit: 0 }).columns.find((c) => c.status === 'done')?.more, 25);
  // A filter narrows the items and what is left out, never the count
  const bugs = service.board('p1', { type: ['bug'] }, { doneLimit: 0 }).columns.find((c) => c.status === 'done');
  assert.equal(bugs?.more, 1);
  assert.equal(bugs?.count, 25);
  // An item moved into Done is the newest: it shows at once, where the board's optimistic move put it
  const moved = service.move(open.id, { status: 'done' });
  const after = service.board('p1').columns.find((c) => c.status === 'done');
  assert.ok(after?.items.some((i) => i.id === moved.item.id));
  assert.equal(after?.count, 26);
  assert.equal(after?.more, 6);
  assert.throws(() => service.board('p1', {}, { doneLimit: -1 }), refusal(400));
});

test('the All projects board and list keep to the projects asked for, counts included', () => {
  const { service } = seeded();
  const shown = new Set(['p2']);
  const board = service.board(null, {}, {}, shown);
  assert.deepEqual(
    board.columns.map((c) => c.count),
    [1, 0, 0, 0, 0],
  );
  assert.deepEqual(
    board.columns.flatMap((c) => c.items).map((i) => i.key),
    ['LIB-1'],
  );
  assert.deepEqual(
    service.cards({}, shown).map((i) => i.key),
    ['LIB-1'],
  );
  assert.equal(service.page({}, {}, shown).total, 1);
  assert.equal(service.page({}, {}, new Set()).total, 0);
});

test('an item is found by its key in any case, in whichever project holds that prefix', () => {
  const { service, projects } = setup();
  const a = service.create('p1', { title: 'One', description: 'whole' });
  const b = service.create('p2', { title: 'Lib one' });
  assert.deepEqual(
    service.withKey('agn-1').map((i) => i.id),
    [a.id],
  );
  assert.equal(service.withKey('AGN-1')[0]?.description, 'whole');
  assert.deepEqual(
    service.withKey('LIB-1').map((i) => i.id),
    [b.id],
  );
  assert.deepEqual(service.withKey('AGN-2'), []);
  assert.deepEqual(service.withKey('not a key'), []);
  // Two projects holding one prefix (a removed one kept it) both answer; the caller picks
  projects.set('p2', { keyPrefix: 'AGN', columnLimits: {} });
  assert.deepEqual(service.withKey('AGN-1').map((i) => i.id).sort(), [a.id, b.id].sort());
});
