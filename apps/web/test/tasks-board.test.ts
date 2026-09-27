import assert from 'node:assert/strict';
import test from 'node:test';
import type { Board, WorkItem, WorkItemStatus } from '@agentry/shared';
import {
  afterIdFor,
  blocksWithin,
  byRank,
  epicProgress,
  isSamePlace,
  keyboardDrop,
  labelsInUse,
  moveOnBoard,
  neighbourStatus,
  notSelectable,
  openBlockers,
} from '../src/pages/tasks/board/model.ts';

// The board's own rules: where a card lands and which neighbour the API is told, the board drawn
// before the server answers, the keyboard's moves, and what "Orchestrate" may take.

const item = (id: string, status: WorkItemStatus, extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  projectId: 'p1',
  number: Number(id.replace(/\D/g, '')) || 1,
  key: `AGN-${id.replace(/\D/g, '') || 1}`,
  type: 'task',
  title: `item ${id}`,
  description: '',
  status,
  priority: 'medium',
  labels: [],
  assignee: null,
  epicId: null,
  milestoneId: null,
  acceptanceCriteria: [],
  relations: [],
  rank: id,
  worktree: null,
  branch: null,
  createdAt: '2026-09-27T10:00:00Z',
  updatedAt: '2026-09-27T10:00:00Z',
  closedAt: null,
  ...extra,
});

const board = (): Board => ({
  projectId: 'p1',
  columns: [
    { status: 'backlog', limit: null, count: 2, overLimit: false, items: [item('a1', 'backlog'), item('a2', 'backlog')] },
    { status: 'todo', limit: null, count: 1, overLimit: false, items: [item('b1', 'todo')] },
    { status: 'in_progress', limit: 2, count: 2, overLimit: false, items: [item('c1', 'in_progress'), item('c2', 'in_progress')] },
    { status: 'in_review', limit: null, count: 0, overLimit: false, items: [] },
    { status: 'done', limit: null, count: 0, overLimit: false, items: [] },
  ],
});

test('a drop names the card drawn above it, or null at the top', () => {
  const column = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
  assert.equal(afterIdFor(column, 'new', 0), null);
  assert.equal(afterIdFor(column, 'new', 1), 'x');
  assert.equal(afterIdFor(column, 'new', 3), 'z');
  // The card itself is left out: moving y below z names z
  assert.equal(afterIdFor(column, 'y', 2), 'z');
  assert.equal(afterIdFor(column, 'y', 0), null);
  // An index past the end is the end
  assert.equal(afterIdFor(column, 'new', 9), 'z');
});

test('a card dropped where it is asks the server for nothing', () => {
  assert.equal(isSamePlace(board(), 'a2', { status: 'backlog', index: 1 }), true);
  assert.equal(isSamePlace(board(), 'a2', { status: 'backlog', index: 0 }), false);
  assert.equal(isSamePlace(board(), 'a2', { status: 'todo', index: 1 }), false);
});

test('the board is redrawn with the card in its new place, counts and limits following it', () => {
  const moved = moveOnBoard(board(), 'b1', { status: 'in_progress', index: 1 });
  const byStatus = new Map(moved.columns.map((c) => [c.status, c]));
  assert.deepEqual(
    byStatus.get('in_progress')?.items.map((i) => i.id),
    ['c1', 'b1', 'c2'],
  );
  assert.equal(byStatus.get('in_progress')?.items[1]?.status, 'in_progress');
  assert.equal(byStatus.get('in_progress')?.count, 3);
  assert.equal(byStatus.get('in_progress')?.overLimit, true, 'going over the limit shows, it does not refuse');
  assert.equal(byStatus.get('todo')?.count, 0);
  assert.deepEqual(byStatus.get('todo')?.items, []);

  const within = moveOnBoard(board(), 'a1', { status: 'backlog', index: 1 });
  assert.deepEqual(
    within.columns[0]?.items.map((i) => i.id),
    ['a2', 'a1'],
  );
  assert.equal(within.columns[0]?.count, 2, 'a move inside a column keeps its count');

  const untouched = board();
  assert.equal(moveOnBoard(untouched, 'missing', { status: 'done', index: 0 }), untouched, 'a board without the card is left alone');
});

test("an epic moved on the board takes no place in either column's count, nor pushes one over its limit", () => {
  const start = board();
  const backlog = start.columns[0];
  if (!backlog) throw new Error('no backlog');
  // The server counts backlog as 2: the epic beside the two tasks is not one of them
  backlog.items = [...backlog.items, item('e9', 'backlog', { type: 'epic' })];
  const moved = moveOnBoard(start, 'e9', { status: 'in_progress', index: 0 });
  const byStatus = new Map(moved.columns.map((c) => [c.status, c]));
  assert.deepEqual(byStatus.get('in_progress')?.items.map((i) => i.id), ['e9', 'c1', 'c2'], 'the epic stays on the board');
  assert.equal(byStatus.get('in_progress')?.count, 2);
  assert.equal(byStatus.get('in_progress')?.overLimit, false, '2 of 2 with an epic inside is not over');
  assert.equal(byStatus.get('backlog')?.count, 2);
});

test('the arrows carry a picked-up card along its column and across the board', () => {
  const counts = { backlog: 1, todo: 1, in_progress: 2, in_review: 0, done: 0 };
  assert.deepEqual(keyboardDrop({ status: 'backlog', index: 0 }, 'ArrowDown', counts), { status: 'backlog', index: 1 });
  assert.equal(keyboardDrop({ status: 'backlog', index: 1 }, 'ArrowDown', counts), null, 'the bottom of a column is an edge');
  assert.equal(keyboardDrop({ status: 'backlog', index: 0 }, 'ArrowUp', counts), null);
  assert.equal(keyboardDrop({ status: 'backlog', index: 0 }, 'ArrowLeft', counts), null, 'Backlog is the first column');
  assert.deepEqual(keyboardDrop({ status: 'todo', index: 1 }, 'ArrowRight', counts), { status: 'in_progress', index: 1 }, 'the same height');
  assert.deepEqual(keyboardDrop({ status: 'in_progress', index: 2 }, 'ArrowRight', counts), { status: 'in_review', index: 0 }, 'or the end of a shorter column');
  assert.equal(keyboardDrop({ status: 'done', index: 0 }, 'ArrowRight', counts), null);
  assert.equal(neighbourStatus('todo', 1), 'in_progress');
  assert.equal(neighbourStatus('backlog', -1), null);
});

test('an epic, a done item and another project cannot be orchestrated, and say which', () => {
  assert.equal(notSelectable(item('e1', 'todo', { type: 'epic' }), null), 'epic');
  assert.equal(notSelectable(item('d1', 'done'), null), 'done');
  assert.equal(notSelectable(item('t1', 'todo', { projectId: 'p2' }), 'p1'), 'project');
  assert.equal(notSelectable(item('t1', 'todo'), 'p1'), null);
  assert.equal(notSelectable(item('t1', 'todo', { projectId: 'p2' }), null), null, 'the first pick sets the project');
});

test('the blocks among the picked items are said in the order they were picked', () => {
  const ref = (id: string, status: WorkItemStatus = 'todo') => ({ id, key: `AGN-${id.replace(/\D/g, '')}`, title: id, type: 'task' as const, status });
  const a = item('i36', 'todo', { relations: [{ type: 'blocks', item: ref('i33') }] });
  const b = item('i33', 'todo', { relations: [{ type: 'blocked_by', item: ref('i36') }, { type: 'blocked_by', item: ref('i40', 'done') }] });
  const c = item('i50', 'todo', { relations: [{ type: 'blocks', item: ref('i99') }] });
  assert.deepEqual(blocksWithin([b, a, c]), [{ blocker: 'AGN-36', blocked: 'AGN-33' }]);
  assert.deepEqual(
    openBlockers(b).map((r) => r.key),
    ['AGN-36'],
    'a blocker already done no longer blocks',
  );
});

test('an epic counts the items it groups, itself and other epics left out', () => {
  const progress = epicProgress([
    item('e1', 'todo', { type: 'epic' }),
    item('t1', 'done', { epicId: 'e1' }),
    item('t2', 'in_progress', { epicId: 'e1' }),
    item('t3', 'todo', { epicId: 'e2' }),
    item('t4', 'todo'),
  ]);
  assert.deepEqual(progress.get('e1'), { done: 1, total: 2 });
  assert.deepEqual(progress.get('e2'), { done: 0, total: 1 });
  assert.equal(progress.size, 2);
});

test('labels are offered once whatever their case, and the list keeps the board order', () => {
  assert.deepEqual(labelsInUse([item('a', 'todo', { labels: ['web', 'Core'] }), item('b', 'todo', { labels: ['WEB', 'api'] })]), ['api', 'Core', 'web']);
  assert.deepEqual(
    byRank([item('x', 'todo', { rank: 'b' }), item('y', 'todo', { rank: 'a' }), item('z', 'todo', { rank: 'a' })]).map((i) => i.id),
    ['y', 'z', 'x'],
  );
});
