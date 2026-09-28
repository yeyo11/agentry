import assert from 'node:assert/strict';
import test from 'node:test';
import type { AcceptanceCriterion, WorkItemLink, WorkItemLinkRole } from '@agentry/shared';
import { byChatRole, chatItemRole, criteriaProgress, movesToReviewOnEnd, withoutKey } from '../src/lib/work-item-links';

const link = (chatId: string | null, role: WorkItemLinkRole, kind: WorkItemLink['kind'] = 'chat'): WorkItemLink => ({
  id: `${chatId}-${role}`,
  itemId: 'item-1',
  kind,
  role,
  chatId,
  orchestrationId: kind === 'orchestration' ? 'orch-1' : null,
  taskId: kind === 'orchestration' ? 'agn-1' : null,
  createdAt: '2026-09-27T10:00:00.000Z',
});

test('a chat that worked on, refined or verified an item works on it', () => {
  for (const role of ['work', 'refine', 'verify'] as const) assert.equal(chatItemRole({ links: [link('c1', role)] }, 'c1'), 'work', role);
});

test('an item made from a chat is its origin, unless the chat also worked on it', () => {
  assert.equal(chatItemRole({ links: [link('c1', 'origin')] }, 'c1'), 'origin');
  assert.equal(chatItemRole({ links: [link('c1', 'origin'), link('c1', 'work')] }, 'c1'), 'work');
});

test("a node's worker chat works on the node's item; another chat's links and a document do not count", () => {
  assert.equal(chatItemRole({ links: [link('c1', 'work', 'orchestration')] }, 'c1'), 'work');
  assert.equal(chatItemRole({ links: [link('c2', 'work')] }, 'c1'), null);
  assert.equal(chatItemRole({ links: [link('c1', 'reference', 'document')] }, 'c1'), null);
  assert.equal(chatItemRole({ links: [] }, 'c1'), null);
});

test('only a chat that works on the item says its turn takes it to In review; a flow run that refines or verifies it does not', () => {
  // A Product Owner refining a Backlog card read "On end: moves to In review if the turn ends well"
  assert.equal(movesToReviewOnEnd({ links: [link('c1', 'refine')], status: 'backlog' }, 'c1'), false);
  assert.equal(movesToReviewOnEnd({ links: [link('c1', 'verify')], status: 'in_review' }, 'c1'), false);
  for (const status of ['backlog', 'todo', 'in_progress'] as const) assert.equal(movesToReviewOnEnd({ links: [link('c1', 'work')], status }, 'c1'), true, status);
  assert.equal(movesToReviewOnEnd({ links: [link('c1', 'work')], status: 'in_review' }, 'c1'), false);
  assert.equal(movesToReviewOnEnd({ links: [link('c1', 'work')], status: 'done' }, 'c1'), false);
  assert.equal(movesToReviewOnEnd({ links: [link('c2', 'work'), link('c1', 'origin')], status: 'todo' }, 'c1'), false);
});

test('the items a chat works on come before the ones made from it', () => {
  const sorted = byChatRole([
    { id: 'a', role: 'origin' as const },
    { id: 'b', role: 'work' as const },
    { id: 'c', role: 'origin' as const },
    { id: 'd', role: 'work' as const },
  ]);
  assert.deepEqual(
    sorted.map((l) => l.id),
    ['b', 'd', 'a', 'c'],
  );
});

test('criteria progress counts the checked entries', () => {
  const c = (checked: boolean): AcceptanceCriterion => ({ id: String(Math.random()), text: 'x', checked, checkedBy: null });
  assert.deepEqual(criteriaProgress({ acceptanceCriteria: [c(true), c(false), c(true)] }), { done: 2, total: 3 });
  assert.deepEqual(criteriaProgress({ acceptanceCriteria: [] }), { done: 0, total: 0 });
});

test("a node's name loses the key its link already shows, and only that", () => {
  assert.equal(withoutKey('AGN-28 Board with fixed columns', 'AGN-28'), 'Board with fixed columns');
  assert.equal(withoutKey('AGN-280 Other', 'AGN-28'), 'AGN-280 Other');
  assert.equal(withoutKey('Renamed by hand', 'AGN-28'), 'Renamed by hand');
  assert.equal(withoutKey('AGN-28 Title', undefined), 'AGN-28 Title');
});
