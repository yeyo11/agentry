import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoardColumn, WorkItem, WorkItemStatus } from '@agentry/shared';
import { BOARD_DONE_PAGE } from '@agentry/shared';
import { boardTotal, childProgress, DONE_SHOWN, doneLimitFor, foldColumn, holdsPart, nextDoneShown } from '../src/pages/tasks/board/model.ts';
import { listGroups, listMore } from '../src/pages/tasks/list-model.ts';

// The Done column and the lists are paged (gap 20 of orchestration 6): the board holds the newest
// Done items and "and N more" draws the next page; the list reads its rows 100 at a time.

const item = (id: string, status: WorkItemStatus, extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  projectId: 'p1',
  number: 1,
  key: `AGN-${id}`,
  type: 'task',
  title: id,
  description: '',
  hasDescription: false,
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

const column = (status: WorkItemStatus, items: WorkItem[], more?: number): BoardColumn => ({
  status,
  limit: null,
  count: items.length + (more ?? 0),
  overLimit: false,
  items,
  ...(more === undefined ? {} : { more }),
});

const many = (n: number, status: WorkItemStatus, prefix: string) => Array.from({ length: n }, (_, i) => item(`${prefix}${i}`, status));

test('"and N more" draws the page the board holds, then asks the server for a page more each time', () => {
  assert.equal(nextDoneShown(DONE_SHOWN), BOARD_DONE_PAGE);
  assert.equal(nextDoneShown(BOARD_DONE_PAGE), 2 * BOARD_DONE_PAGE);
  assert.equal(nextDoneShown(2 * BOARD_DONE_PAGE), 3 * BOARD_DONE_PAGE);
  // The default page keeps the board's key, which the sidebar's count shares
  assert.equal(doneLimitFor(DONE_SHOWN), undefined);
  assert.equal(doneLimitFor(BOARD_DONE_PAGE), undefined);
  assert.equal(doneLimitFor(2 * BOARD_DONE_PAGE), 2 * BOARD_DONE_PAGE);
  assert.equal(doneLimitFor(BOARD_DONE_PAGE + 1), 2 * BOARD_DONE_PAGE);
});

test('Done counts what it folds and what the server left out; the other columns draw everything', () => {
  const done = column('done', many(20, 'done', 'd'), 12);
  assert.deepEqual(
    (({ shown, hidden }) => ({ shown: shown.length, hidden }))(foldColumn(done, DONE_SHOWN)),
    { shown: 3, hidden: 17 + 12 },
  );
  assert.equal(foldColumn(done, 20).hidden, 12);
  const todo = column('todo', many(40, 'todo', 't'));
  assert.deepEqual(
    (({ shown, hidden }) => ({ shown: shown.length, hidden }))(foldColumn(todo, DONE_SHOWN)),
    { shown: 40, hidden: 0 },
  );
});

test('the header counts the whole board, and knows when its cards alone cannot say how far an epic is', () => {
  const board = { columns: [column('backlog', many(2, 'backlog', 'b')), column('done', many(20, 'done', 'd'), 5)] };
  assert.equal(boardTotal(board), 27);
  assert.equal(holdsPart(board), true);
  assert.equal(holdsPart({ columns: [column('done', many(3, 'done', 'd'))] }), false);
  assert.equal(boardTotal(undefined), 0);
  assert.deepEqual(
    childProgress([
      { type: 'task', status: 'done' },
      { type: 'bug', status: 'done' },
      { type: 'story', status: 'todo' },
    ]),
    { done: 2, total: 3 },
  );
});

test("the list's groups take their figures from the board, whatever has been read so far", () => {
  const columns = [column('backlog', many(150, 'backlog', 'b')), column('done', many(20, 'done', 'd'), 30)];
  // The first page is 100 backlog rows: one group, counting all 150
  const first = listGroups(columns, many(100, 'backlog', 'b'));
  assert.deepEqual(
    first.map((g) => ({ status: g.column.status, rows: g.items.length, counted: g.counted, held: g.held })),
    [{ status: 'backlog', rows: 100, counted: 150, held: 150 }],
  );
  const later = listGroups(columns, [...many(150, 'backlog', 'b'), ...many(50, 'done', 'd')]);
  assert.deepEqual(
    later.map((g) => ({ status: g.column.status, counted: g.counted, held: g.held })),
    [
      { status: 'backlog', counted: 150, held: 150 },
      { status: 'done', counted: 50, held: 50 },
    ],
  );
  // An epic takes no place in a column's count
  const withEpic = listGroups([column('todo', [item('e', 'todo', { type: 'epic' }), item('t', 'todo')])], [item('e', 'todo', { type: 'epic' }), item('t', 'todo')]);
  assert.equal(withEpic[0]?.counted, 1);
});

test('the next page is asked for while open rows are missing, and for Done only once it is unfolded', () => {
  const columns = [column('backlog', many(150, 'backlog', 'b')), column('done', many(20, 'done', 'd'), 30)];
  assert.equal(listMore({ columns, loaded: many(100, 'backlog', 'b'), total: 200, hasNext: true, allDone: false }), 100);
  // Every open row is read: Done's own button says how many are left
  const open = [...many(150, 'backlog', 'b'), ...many(50, 'done', 'x')].slice(0, 200);
  assert.equal(listMore({ columns, loaded: open.slice(0, 150), total: 200, hasNext: true, allDone: false }), 0);
  assert.equal(listMore({ columns, loaded: open.slice(0, 150), total: 200, hasNext: true, allDone: true }), 50);
  assert.equal(listMore({ columns, loaded: open, total: 200, hasNext: false, allDone: true }), 0);
});
