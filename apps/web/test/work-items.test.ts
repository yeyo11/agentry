import assert from 'node:assert/strict';
import test from 'node:test';
import type { Board, WorkItem, WorkItemLink } from '@agentry/shared';
import {
  NEW_TASK_PATH,
  WORK_ITEM_COLUMNS,
  WORK_ITEM_PRIORITY_META,
  WORK_ITEM_TYPE_META,
  apiFilter,
  boardColumns,
  filterKey,
  filtersFromSearch,
  filtersToSearch,
  groupByStatus,
  hasFilters,
  inProjects,
  isLive,
  normalizeKey,
  openCount,
  taskPath,
  viewFromSearch,
  workItemLiveState,
} from '../src/lib/work-items';

const link = (over: Partial<WorkItemLink>): WorkItemLink => ({
  id: 'l1',
  itemId: 'i1',
  kind: 'chat',
  role: 'work',
  chatId: 'c1',
  orchestrationId: null,
  taskId: null,
  createdAt: '2026-09-27T10:00:00Z',
  ...over,
});

test('the columns are the five fixed ones, left to right, and only Done carries a tone', () => {
  assert.deepEqual(
    WORK_ITEM_COLUMNS.map((c) => c.status),
    ['backlog', 'todo', 'in_progress', 'in_review', 'done'],
  );
  assert.deepEqual(
    WORK_ITEM_COLUMNS.filter((c) => c.tone).map((c) => [c.status, c.tone]),
    [['done', 'ok']],
  );
  assert.equal(WORK_ITEM_COLUMNS[2]?.label, 'status.in_progress');
  assert.deepEqual(
    WORK_ITEM_TYPE_META.map((t) => t.type),
    ['epic', 'story', 'task', 'bug'],
  );
});

test('priority is drawn as bars, and urgent is the one mark with a colour instead', () => {
  assert.deepEqual(
    WORK_ITEM_PRIORITY_META.map((p) => [p.priority, p.bars, p.urgent]),
    [
      ['low', 1, false],
      ['medium', 2, false],
      ['high', 3, false],
      ['urgent', 0, true],
    ],
  );
  assert.equal(WORK_ITEM_PRIORITY_META[2]?.aria, 'priorityMark.high');
});

test('a key is found whatever case it was typed in, and anything else is not a key', () => {
  assert.equal(normalizeKey('agn-12'), 'AGN-12');
  assert.equal(normalizeKey(' AGN-12 '), 'AGN-12');
  assert.equal(normalizeKey('milestones'), null);
  assert.equal(normalizeKey('AGN-0'), null);
  assert.equal(taskPath('AGN-12'), '/tasks/AGN-12');
  assert.equal(NEW_TASK_PATH, '/tasks?new=1');
});

test('filters survive a round trip through the address, and leave the scope and the view alone', () => {
  const base = new URLSearchParams('project=p1&view=list&type=epic');
  const next = filtersToSearch({ q: 'tablero', type: ['bug', 'story'], labels: ['web'], epicId: 'e1', projects: ['p1', 'p2'] }, base);
  assert.equal(next.get('project'), 'p1');
  assert.equal(next.get('view'), 'list');
  assert.equal(next.get('type'), 'bug,story');
  assert.equal(next.get('label'), 'web');
  assert.equal(next.get('epic'), 'e1');
  assert.deepEqual(filtersFromSearch(next), { q: 'tablero', type: ['bug', 'story'], labels: ['web'], epicId: 'e1', projects: ['p1', 'p2'] });
  // Clearing a filter removes its parameter instead of leaving it empty
  const cleared = filtersToSearch({}, next);
  assert.equal(cleared.toString(), 'project=p1&view=list');
});

test('a stale link loses the values the API would refuse, not the whole filter', () => {
  const filters = filtersFromSearch(new URLSearchParams('status=todo,doing&priority=urgent,huge&type=,,&q=%20%20'));
  assert.deepEqual(filters, { status: ['todo'], priority: ['urgent'] });
});

test('the API is asked without the projects filter, which the All projects view applies itself', () => {
  assert.deepEqual(apiFilter({ q: 'x', projects: ['p1'] }), { q: 'x' });
  const items = [{ projectId: 'p1' }, { projectId: 'p2' }, { projectId: 'p3' }];
  assert.deepEqual(inProjects(items, ['p1', 'p3']), [{ projectId: 'p1' }, { projectId: 'p3' }]);
  assert.equal(inProjects(items, undefined).length, 3);
  assert.equal(hasFilters({}), false);
  assert.equal(hasFilters({ type: [] }), false);
  assert.equal(hasFilters({ projects: ['p1'] }), true);
});

test('the same filter picked in another order shares one cache key', () => {
  assert.equal(filterKey({ type: ['story', 'bug'], q: 'a' }), filterKey({ q: 'a', type: ['bug', 'story'] }));
  assert.equal(filterKey({}), '');
});

test('the view is the board unless the address asks for the list', () => {
  assert.equal(viewFromSearch(new URLSearchParams('')), 'board');
  assert.equal(viewFromSearch(new URLSearchParams('view=list')), 'list');
  assert.equal(viewFromSearch(new URLSearchParams('view=gantt')), 'board');
});

test('a board always has its five columns, and the open count leaves Done out whatever the filter', () => {
  const board: Board = {
    projectId: 'p1',
    columns: [
      { status: 'in_progress', limit: 3, count: 5, overLimit: true, items: [] },
      { status: 'backlog', limit: null, count: 4, overLimit: false, items: [] },
      { status: 'done', limit: null, count: 12, overLimit: false, items: [] },
    ],
  };
  assert.deepEqual(
    boardColumns(board).map((c) => [c.status, c.count]),
    [
      ['backlog', 4],
      ['todo', 0],
      ['in_progress', 5],
      ['in_review', 0],
      ['done', 12],
    ],
  );
  assert.equal(openCount(board), 9);
  assert.equal(openCount(undefined), undefined);
});

test('grouping keeps the board order inside each column', () => {
  const items = [
    { id: 'a', status: 'todo' },
    { id: 'b', status: 'backlog' },
    { id: 'c', status: 'todo' },
  ] as const satisfies ReadonlyArray<Pick<WorkItem, 'status'> & { id: string }>;
  const groups = groupByStatus(items);
  assert.deepEqual(
    groups.map((g) => [g.status, g.items.map((i) => i.id)]),
    [
      ['backlog', ['b']],
      ['todo', ['a', 'c']],
      ['in_progress', []],
      ['in_review', []],
      ['done', []],
    ],
  );
});

test('an item is live only while its chat works or its node runs; a waiting chat waits, still', () => {
  assert.equal(workItemLiveState({ activeLink: null }), null);
  assert.equal(workItemLiveState({}), null);
  assert.equal(workItemLiveState({ activeLink: link({ chatState: 'working' }) }), 'working');
  assert.equal(workItemLiveState({ activeLink: link({ chatState: 'waiting' }) }), 'waiting');
  assert.equal(workItemLiveState({ activeLink: link({ chatState: 'idle' }) }), null);
  assert.equal(workItemLiveState({ activeLink: link({ kind: 'orchestration', taskStatus: 'running', chatState: null }) }), 'working');
  assert.equal(workItemLiveState({ activeLink: link({ kind: 'orchestration', taskStatus: 'completed' }) }), null);
  assert.equal(isLive({ activeLink: link({ chatState: 'waiting' }) }), false);
  assert.equal(isLive({ activeLink: link({ chatState: 'working' }) }), true);
});
