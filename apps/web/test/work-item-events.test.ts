import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryKey } from '@tanstack/react-query';
import type {
  AgentryEvent,
  MilestoneChangedEvent,
  ProjectUpdatedEvent,
  WorkItemMovedEvent,
  WorkItemRemovedEvent,
  WorkItemUpdatedEvent,
} from '@agentry/shared';
import { keys } from '../src/api';
import { targetMatches, targetsFor } from '../src/lib/events';

// An open board shows what an agent moved without a reload, and nothing else is read for it: each
// work item event reaches exactly the cached queries that show what it changed, by key prefix.

/** Every read the Tasks screens, the shell and a chat keep, across two projects. */
const CACHE: Record<string, QueryKey> = {
  boardP1: keys.workItemBoard('p1'),
  boardP1Filtered: keys.workItemBoard('p1', { type: ['bug'] }),
  boardP2: keys.workItemBoard('p2'),
  boardAll: keys.workItemBoard(null),
  listP1: keys.workItemList('p1', { q: 'x' }),
  listP2: keys.workItemList('p2'),
  listAll: keys.workItemList(null),
  byKey: keys.workItemByKey('AGN-12'),
  chatItems: keys.chatWorkItems('c1'),
  item1: keys.workItem('i1'),
  item1Changes: keys.workItemChanges('i1'),
  item2: keys.workItem('i2'),
  milestonesP1: keys.milestones('p1'),
  milestonesP2: keys.milestones('p2'),
  milestone: keys.milestone('m1'),
  settingsP1: keys.projectSettings('p1'),
  settingsP2: keys.projectSettings('p2'),
  templates: keys.projectTemplates,
  projects: keys.projects,
  chats: keys.chats,
};

/** The names of the cached reads an event refetches */
function refetched(event: AgentryEvent): string[] {
  const targets = targetsFor(event);
  return Object.entries(CACHE)
    .filter(([, key]) => targets.some((target) => targetMatches(target, key)))
    .map(([name]) => name)
    .sort();
}

const base = { id: 1, at: '2026-09-27T10:00:00Z', title: 'AGN-12', projectId: 'p1', itemId: 'i1', key: 'AGN-12' };
const actor = { kind: 'agent' as const };

const P1_VIEWS = ['boardAll', 'boardP1', 'boardP1Filtered', 'chatItems', 'listAll', 'listP1', 'milestone', 'milestonesP1'];

test('a card moved by an agent refreshes every board and list of its project and of All projects, not the other project', () => {
  const moved: WorkItemMovedEvent = { ...base, type: 'workitem.moved', status: 'in_review', previousStatus: 'in_progress', overLimit: false, actor, cause: null };
  // The status shows on every chip naming the item, so open item pages read again too
  assert.deepEqual(refetched(moved), [...P1_VIEWS, 'item1', 'item1Changes', 'item2'].sort());
});

test('a comment refreshes the item and the cards that count it, and no other item', () => {
  const commented: WorkItemUpdatedEvent = { ...base, type: 'workitem.updated', changes: ['comment'], actor, cause: null };
  assert.deepEqual(refetched(commented), [...P1_VIEWS, 'item1', 'item1Changes'].sort());
});

test('a new relation refreshes both ends, since the other item shows it too', () => {
  const related: WorkItemUpdatedEvent = { ...base, type: 'workitem.updated', changes: ['relation'], actor, cause: null };
  assert.ok(refetched(related).includes('item2'));
});

test('a removed item also forgets which item its key named', () => {
  const removed: WorkItemRemovedEvent = { ...base, type: 'workitem.removed' };
  assert.ok(refetched(removed).includes('byKey'));
  assert.ok(!refetched(removed).includes('boardP2'));
});

test('a milestone renamed refreshes the milestones only; one deleted also the items it is taken off', () => {
  const renamed: MilestoneChangedEvent = { id: 2, at: base.at, title: 'v0.20', type: 'milestone.changed', projectId: 'p1', milestoneId: 'm1', milestoneName: 'v0.20', action: 'updated' };
  assert.deepEqual(refetched(renamed), ['milestone', 'milestonesP1']);
  const deleted: MilestoneChangedEvent = { ...renamed, action: 'deleted' };
  assert.ok(refetched(deleted).includes('boardP1'));
  assert.ok(refetched(deleted).includes('item1'));
});

test('a project renamed reads its settings again; a new key prefix renames every key of its items', () => {
  const project = (changes: ProjectUpdatedEvent['changes']): ProjectUpdatedEvent => ({
    id: 3,
    at: base.at,
    title: 'claude-wrapper',
    type: 'project.updated',
    projectId: 'p1',
    projectName: 'claude-wrapper',
    changes,
    modules: ['board'],
  });
  assert.deepEqual(refetched(project(['name'])), ['projects', 'settingsP1']);
  const rekeyed = refetched(project(['key']));
  for (const name of ['boardP1', 'listAll', 'item2', 'byKey', 'settingsP1']) assert.ok(rekeyed.includes(name), name);
  assert.ok(!rekeyed.includes('boardP2'));
  // Limits and modules change what the board draws and counts, not the items
  assert.deepEqual(refetched(project(['settings'])), ['boardAll', 'boardP1', 'boardP1Filtered', 'projects', 'settingsP1']);
});

test('a chat that stops refreshes the boards, where its card was live', () => {
  const ended = { id: 4, at: base.at, type: 'run.ended', runId: 'c1', sessionId: 'c1', status: 'failed' } as AgentryEvent;
  const names = refetched(ended);
  for (const name of ['boardP1', 'boardP2', 'boardAll', 'item1']) assert.ok(names.includes(name), name);
});
