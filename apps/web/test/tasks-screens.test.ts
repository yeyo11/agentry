import assert from 'node:assert/strict';
import test from 'node:test';
import type { AcceptanceCriterion, WorkItemLink } from '@agentry/shared';
import { queryView } from '../src/lib/query-view';
import { isApple, shortcut } from '../src/lib/shortcut';
import { listRowStep, newTaskProject, renamedKey, returnPath, returnState, staleFilters, TASKS_PATH } from '../src/lib/work-items';
import { deleteWarning, uncheckedCriteria } from '../src/pages/tasks/item/model';
import { NO_MILESTONE } from '../src/pages/tasks/board/model';

// The Tasks, work item and Documents screens as the review of the whole feature found them: what
// each screen decides, kept pure so it is checked without a browser.

test('a failed refetch keeps what was shown: only a query that never answered is an error', () => {
  const blip = new Error('fetch failed');
  // The fallback poll failing while an editor is open: data and error side by side
  assert.equal(queryView({ data: { id: 'i1' }, error: blip, isLoading: false }), 'shown');
  assert.equal(queryView({ data: undefined, error: null, isLoading: true }), 'loading');
  assert.equal(queryView({ data: undefined, error: blip, isLoading: false }), 'failed');
  assert.equal(queryView({ data: null, error: null, isLoading: false }), 'missing');
});

test('the save shortcut is named as the keyboard names it', () => {
  assert.equal(shortcut('S', 'Linux x86_64'), 'Ctrl+S');
  assert.equal(shortcut('S', 'Win32'), 'Ctrl+S');
  assert.equal(shortcut('S', 'MacIntel'), '⌘S');
  assert.equal(shortcut('S', 'iPhone'), '⌘S');
  assert.equal(isApple(''), false);
});

test('an open item whose prefix changed is renamed in the address, and the same key in another case is not', () => {
  assert.equal(renamedKey('AGN-12', 'AG-12'), 'AG-12');
  assert.equal(renamedKey('agn-12', 'AGN-12'), null);
  assert.equal(renamedKey('AGN-12', 'AGN-12'), null);
  assert.equal(renamedKey('AGN-12', undefined), null);
});

test("an item's page goes back to the board it was opened from, never out of the app", () => {
  const from = '/?project=p1&view=board&type=bug';
  assert.equal(returnPath(returnState(from)), from);
  assert.equal(returnPath(returnState('/tasks?view=list&epic=e1')), '/tasks?view=list&epic=e1');
  assert.equal(returnPath(null), TASKS_PATH);
  assert.equal(returnPath({ from: 'https://elsewhere.example' }), TASKS_PATH);
  assert.equal(returnPath({ from: '//elsewhere.example/x' }), TASKS_PATH);
  assert.equal(returnPath({ from: 42 }), TASKS_PATH);
});

test('New task on a project whose Board is off asks for a project with one instead of a dead end', () => {
  const boards = [{ id: 'with-board' }];
  assert.equal(newTaskProject('with-board', boards, true), 'with-board');
  assert.equal(newTaskProject('board-off', boards, true), null, 'the picker, with the projects that have a board');
  assert.equal(newTaskProject('board-off', boards, false), undefined, 'nothing to decide before the projects arrive');
  assert.equal(newTaskProject(null, boards, true), null);
});

test('filters the scope cannot show are stale: projects outside All projects, an epic or a milestone it lacks', () => {
  const scope = { allProjects: false, epics: new Set(['e1']), milestones: new Set(['m1']), noMilestone: NO_MILESTONE };
  assert.deepEqual(staleFilters({ projects: ['p2'], epicId: 'e9', milestoneId: 'm9' }, scope), ['projects', 'epicId', 'milestoneId']);
  assert.deepEqual(staleFilters({ epicId: 'e1', milestoneId: 'm1', type: ['bug'] }, scope), []);
  assert.deepEqual(staleFilters({ milestoneId: NO_MILESTONE }, scope), [], '"no milestone" is always there');
  assert.deepEqual(staleFilters({ projects: ['p2'] }, { ...scope, allProjects: true }), [], 'All projects has a chip for it');
  // While the scope's epics and milestones load, nothing is judged
  assert.deepEqual(staleFilters({ epicId: 'e9', milestoneId: 'm9' }, { ...scope, epics: null, milestones: null }), []);
});

test('J and K step through the rows and stop at either end; from nothing, J starts at the top and K at the bottom', () => {
  assert.equal(listRowStep(3, 0, 1), 1);
  assert.equal(listRowStep(3, 2, 1), null);
  assert.equal(listRowStep(3, 0, -1), null);
  assert.equal(listRowStep(3, -1, 1), 0);
  assert.equal(listRowStep(3, -1, -1), 2);
  assert.equal(listRowStep(0, -1, 1), null);
});

let criteria = 0;
const criterion = (checked: boolean): AcceptanceCriterion => ({ id: `c${++criteria}`, text: 'x', checked, checkedBy: checked ? { kind: 'person' } : null });

test('moving to Done asks while a criterion is unchecked; deleting says when a chat works on the item', () => {
  assert.deepEqual(uncheckedCriteria({ acceptanceCriteria: [criterion(true), criterion(false), criterion(false)] }), { unchecked: 2, total: 3 });
  assert.deepEqual(uncheckedCriteria({ acceptanceCriteria: [] }), { unchecked: 0, total: 0 });
  const link = (over: Partial<WorkItemLink>) => ({ id: 'l', itemId: 'i', kind: 'chat', chatState: null, taskStatus: null, ...over }) as WorkItemLink;
  assert.equal(deleteWarning({ activeLink: link({ chatState: 'working' }) }), 'working');
  assert.equal(deleteWarning({ activeLink: link({ kind: 'orchestration', taskStatus: 'running' }) }), 'working');
  assert.equal(deleteWarning({ activeLink: link({ chatState: 'idle' }) }), null);
  assert.equal(deleteWarning({ activeLink: null }), null);
});
