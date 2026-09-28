import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkItemComment, WorkItemHistoryEntry, WorkItemLink } from '@agentry/shared';
import en from '../src/i18n/locales/en/workItem.json' with { type: 'json' };
import {
  activityOf,
  addLabel,
  causeLine,
  cleanCriteria,
  criteriaProgress,
  diffstat,
  historyLine,
  linkEffect,
  pathParts,
  personName,
  shortId,
  workOnBlocker,
} from '../src/pages/tasks/item/model.ts';

// A work item's page tells its history in sentences, interleaves it with the comments, and says
// before anyone presses "Work on it" why it cannot start. None of it needs a browser.

const entry = (
  change: WorkItemHistoryEntry['change'],
  from: WorkItemHistoryEntry['from'],
  to: WorkItemHistoryEntry['to'],
  extra: Partial<WorkItemHistoryEntry> = {},
): WorkItemHistoryEntry => ({
  id: `${change}-${Math.random()}`,
  itemId: 'i1',
  change,
  from,
  to,
  actor: { kind: 'person' },
  cause: null,
  createdAt: '2026-09-27T10:00:00.000Z',
  ...extra,
});

const lookup = (key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), en);

test('every change is told by a key the English file has, ending on the value it names', () => {
  const ref = { id: 'e1', label: 'Ecosystem', key: 'AGN-3' };
  const criterion = (checked: boolean) => ({ id: 'c1', text: 'Imported projects keep modules off', checked });
  const other = { id: 'o', key: 'AGN-33', title: 'Link tasks', type: 'task' as const, status: 'todo' as const };
  const cases: Array<[WorkItemHistoryEntry, string, string | undefined]> = [
    [entry('created', null, 'Title'), 'history.created', undefined],
    [entry('status', 'todo', 'in_progress'), 'history.status', 'in_progress'],
    [entry('type', 'task', 'bug'), 'history.type', 'bug'],
    [entry('title', 'Old', 'New'), 'history.title', 'New'],
    [entry('description', 'a', 'b'), 'history.description', undefined],
    [entry('priority', 'low', 'urgent'), 'history.priority', 'urgent'],
    [entry('labels', ['a'], ['a', 'b']), 'history.labels', 'a, b'],
    [entry('labels', ['a'], []), 'history.labelsCleared', undefined],
    [entry('assignee', null, { kind: 'person' }), 'history.assignedPerson', undefined],
    [entry('assignee', null, { kind: 'role', role: 'qa' }), 'history.assignedRole', 'qa'],
    [entry('assignee', { kind: 'person' }, null), 'history.unassigned', undefined],
    [entry('epic', null, ref), 'history.epic', 'Ecosystem'],
    [entry('epic', ref, null), 'history.epicRemoved', 'Ecosystem'],
    [entry('milestone', null, { id: 'm', label: 'v0.20' }), 'history.milestone', 'v0.20'],
    [entry('criterion', null, criterion(false)), 'history.criterionAdded', criterion(false).text],
    [entry('criterion', criterion(false), criterion(true)), 'history.criterionChecked', criterion(true).text],
    [entry('criterion', criterion(true), criterion(false)), 'history.criterionUnchecked', criterion(true).text],
    [entry('criterion', criterion(false), null), 'history.criterionRemoved', criterion(false).text],
    [entry('relation', null, { type: 'blocks', item: other }), 'history.blocks', 'AGN-33'],
    [entry('relation', { type: 'blocked_by', item: other }, null), 'history.unblockedBy', 'AGN-33'],
    [entry('link', null, { id: 'l', label: 'chat 4c1d0e' }), 'history.linked', 'chat 4c1d0e'],
    [entry('waiting', null, 'approval'), 'history.waitingApproval', undefined],
    [entry('waiting', 'approval', null), 'history.waitingEnded', undefined],
  ];
  for (const [e, key, strong] of cases) {
    const line = historyLine(e);
    assert.equal(line.key, key, `${e.change} ${JSON.stringify(e.to)}`);
    assert.equal(typeof lookup(line.key), 'string', `${line.key} is in en/workItem.json`);
    assert.equal(line.strong ? line.values[line.strong] : undefined, strong, key);
  }
  // A person's assignment ends on the person's name, which the page fills in
  assert.equal(historyLine(entry('assignee', null, { kind: 'person' })).strong, 'person');
});

test('an automatic move names its cause; a code this version does not know still reads as automatic', () => {
  const cause = { kind: 'chat' as const, chatId: '4c1d0e99-aaaa', orchestrationId: null, taskId: null };
  assert.deepEqual(causeLine({ ...cause, event: 'chat.started' }), { key: 'cause.chatStarted', values: { chat: '4c1d0e' } });
  assert.equal(causeLine({ ...cause, event: 'chat.turn-completed' })?.key, 'cause.turnCompleted');
  assert.equal(causeLine({ ...cause, event: 'orchestration.task.completed' })?.key, 'cause.taskCompleted');
  assert.equal(causeLine({ ...cause, event: 'something.new' })?.key, 'cause.other');
  assert.equal(causeLine(null), null);
  for (const key of ['cause.chatStarted', 'cause.turnCompleted', 'cause.message', 'cause.taskStarted', 'cause.taskCompleted', 'cause.other']) {
    assert.equal(typeof lookup(key), 'string', key);
  }
});

test('comments and history interleave oldest first, and each filter keeps only its own', () => {
  const at = (minute: number) => `2026-09-27T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const history = [entry('created', null, 'T', { id: 'h1', createdAt: at(0) }), entry('status', 'todo', 'in_review', { id: 'h2', createdAt: at(5) })];
  const comment = (id: string, minute: number): WorkItemComment => ({
    id,
    itemId: 'i1',
    author: { kind: 'person' },
    source: null,
    body: id,
    createdAt: at(minute),
    updatedAt: at(minute),
  });
  const comments = [comment('c1', 3), comment('c2', 5)];
  const ids = (list: ReturnType<typeof activityOf>) => list.map((e) => (e.kind === 'history' ? e.entry.id : e.kind === 'comment' ? e.comment.id : e.run.id));
  // At the same instant the change comes first: the comment usually explains it
  assert.deepEqual(ids(activityOf(history, comments)), ['h1', 'c1', 'h2', 'c2']);
  assert.deepEqual(ids(activityOf(history, comments, 'comments')), ['c1', 'c2']);
  assert.deepEqual(ids(activityOf(history, comments, 'history')), ['h1', 'h2']);
});

test('a link says what it did to the item, from the history it caused', () => {
  const link = (extra: Partial<WorkItemLink>): WorkItemLink => ({
    id: 'l',
    itemId: 'i1',
    kind: 'chat',
    role: 'work',
    chatId: 'chat-a',
    orchestrationId: null,
    taskId: null,
    createdAt: '',
    ...extra,
  });
  const moved = (chatId: string | null, to: string, extra: Partial<WorkItemHistoryEntry['cause'] & object> = {}) =>
    entry('status', 'todo', to, { actor: { kind: 'system' }, cause: { kind: 'chat', chatId, orchestrationId: null, taskId: null, event: 'chat.started', ...extra } });
  const history = [moved('chat-a', 'in_progress'), moved('chat-a', 'in_review'), moved('chat-b', 'in_progress')];
  assert.deepEqual(linkEffect(link({}), history), { key: 'link.moved', values: { to: 'in_review' } });
  assert.deepEqual(linkEffect(link({ chatId: 'chat-c' }), history), { key: 'link.noMove', values: {} });
  assert.equal(linkEffect(link({ role: 'origin' }), history).key, 'link.origin');
  const node = link({ kind: 'orchestration', chatId: null, orchestrationId: 'o1', taskId: 't1' });
  assert.equal(linkEffect(node, [moved(null, 'in_review', { kind: 'orchestration', orchestrationId: 'o1', taskId: 't1' })]).key, 'link.moved');
  assert.equal(linkEffect(node, [moved(null, 'in_review', { kind: 'orchestration', orchestrationId: 'o1', taskId: 't2' })]).key, 'link.noMove');
});

test('"Work on it" says why it cannot start before anyone presses it, as the API would refuse', () => {
  const live = (extra: Partial<WorkItemLink>): WorkItemLink => ({
    id: 'l',
    itemId: 'i',
    kind: 'chat',
    role: 'work',
    chatId: 'c',
    orchestrationId: null,
    taskId: null,
    createdAt: '',
    ...extra,
  });
  assert.equal(workOnBlocker({ type: 'epic', status: 'todo', activeLink: null }), 'epic');
  assert.equal(workOnBlocker({ type: 'task', status: 'done', activeLink: null }), 'done');
  assert.equal(workOnBlocker({ type: 'task', status: 'in_progress', activeLink: live({ chatState: 'working' }) }), 'busy');
  assert.equal(workOnBlocker({ type: 'bug', status: 'todo', activeLink: live({ kind: 'orchestration', taskStatus: 'running' }) }), 'busy');
  // A chat that ended leaves the item free to be worked on again
  assert.equal(workOnBlocker({ type: 'story', status: 'in_review', activeLink: live({ chatState: 'idle' }) }), null);
  assert.equal(workOnBlocker({ type: 'story', status: 'backlog', activeLink: null }), null);
});

test('a diffstat has five dots, more of them for a bigger change, split by what was added and removed', () => {
  assert.deepEqual(diffstat({ additions: 142, deletions: 0 }), ['add', 'add', 'add', 'add', 'add']);
  assert.deepEqual(diffstat({ additions: 38, deletions: 12 }), ['add', 'add', 'add', 'del', 'none']);
  assert.deepEqual(diffstat({ additions: 21, deletions: 19 }), ['add', 'add', 'del', 'del', 'none']);
  assert.deepEqual(diffstat({ additions: 13, deletions: 6 }), ['add', 'add', 'del', 'none', 'none']);
  assert.deepEqual(diffstat({ additions: 0, deletions: 0 }), ['none', 'none', 'none', 'none', 'none']);
  assert.deepEqual(diffstat({ additions: 0, deletions: 1 }), ['del', 'none', 'none', 'none', 'none']);
});

test('small helpers: paths cut at their slashes, labels kept once, blank criteria left out, the person named', () => {
  assert.deepEqual(pathParts('core/src/project-templates.ts'), { dirs: ['core/', 'src/'], name: 'project-templates.ts' });
  assert.deepEqual(pathParts('README.md'), { dirs: [], name: 'README.md' });
  assert.deepEqual(addLabel(['core'], ' API '), ['core', 'API']);
  assert.deepEqual(addLabel(['core', 'API'], 'api'), ['core', 'API']);
  assert.deepEqual(addLabel(['core'], 'web,'), ['core', 'web']);
  assert.deepEqual(addLabel(['core'], '   '), ['core']);
  assert.deepEqual(cleanCriteria(['  one ', '', '   ', 'two']), [{ text: 'one' }, { text: 'two' }]);
  assert.deepEqual(criteriaProgress([{ checked: true }, { checked: false }, { checked: true }]), { done: 2, total: 3 });
  assert.equal(personName('yeyo@inmoseo.net'), 'yeyo');
  assert.equal(personName(null), null);
  assert.equal(personName(''), null);
  assert.equal(shortId('4c1d0e2f-1111'), '4c1d0e');
  assert.equal(shortId(null), '');
});
