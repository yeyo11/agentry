import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewThread } from '@agentry/shared';
import { addressable, countThreads, followUpDue, isReviewFix, partlyPost, settleAddress, type AddressMemory } from '../src/lib/reviews';

// The rules the item page's review block and its address follow-up stand on (docs/plans/code-hosts.md,
// Phase 3 audit): what counts as unresolved, which fix is a review's, and when "Addressed in" may be said.

const thread = (over: Partial<ReviewThread>): ReviewThread => ({
  id: 't1', path: 'a.ts', side: 'right', line: 10, startLine: 10, originalLine: 10, diffHunk: null, isResolved: false, isOutdated: false,
  resolvedBy: null, viewerCanReply: true, viewerCanResolve: true, comments: [], commentsTruncated: false, ...over,
});

test('an outdated thread waits for no answer: block, strip and dialog count as the core does', () => {
  const threads = [thread({ id: 'a' }), thread({ id: 'b', isOutdated: true, line: null }), thread({ id: 'c', isResolved: true }), thread({ id: 'd', isResolved: true, isOutdated: true })];
  assert.deepEqual(countThreads(threads), { unresolved: 1, resolved: 2 });
  assert.deepEqual(addressable(threads).map((t) => t.id), ['a']);
});

test('a review fix is told from a checks fix by its kind, and only while it runs', () => {
  assert.equal(isReviewFix({ fixKind: 'review', fixState: 'fixing' }), true);
  assert.equal(isReviewFix({ fixKind: 'review', fixState: null }), false);
  assert.equal(isReviewFix({ fixKind: 'checks', fixState: 'fixing' }), false);
  assert.equal(isReviewFix({ fixState: 'fixing' }), false);
  assert.equal(isReviewFix(null), false);
});

test('only the newest review post that stopped half way is still to be settled', () => {
  assert.equal(partlyPost(undefined), null);
  assert.equal(partlyPost([]), null);
  assert.equal(partlyPost([{ state: 'posted' }, { state: 'partly' }]), null);
  const partly = { state: 'partly' as const, id: 'p2' };
  assert.equal(partlyPost([partly, { state: 'failed' }]), partly);
});

const memory = (over: Partial<AddressMemory> = {}): AddressMemory => ({ ids: ['a'], head: 'h1', stage: 'handed', pushedHead: null, ...over });

test('Addressed in is due only for the push the address made', () => {
  // handed over, the fix is seen, ends with the head moved: that is the address's push
  const running = settleAddress(memory(), { fixRunning: true, headNow: 'h1' });
  assert.equal(running?.stage, 'running');
  const pushed = settleAddress(running!, { fixRunning: false, headNow: 'h2' });
  assert.equal(pushed?.stage, 'pushed');
  assert.equal(followUpDue(pushed, 'h2'), true);
  // somebody pushes on top of it: not the address's any more
  assert.equal(settleAddress(pushed!, { fixRunning: false, headNow: 'h3' }), null);
  assert.equal(followUpDue(pushed, 'h3'), false);
});

test('a card taken over, or a fix nobody watched end, is never followed by Addressed in', () => {
  // the fix ended and the head did not move: dropped, and a later unrelated push offers nothing
  const running = memory({ stage: 'running' });
  assert.equal(settleAddress(running, { fixRunning: false, headNow: 'h1' }), null);
  assert.equal(settleAddress(running, { fixRunning: false, headNow: null }), null);
  // handed over and no fix seen yet (or ever): the head moving alone proves nothing
  const handed = memory();
  assert.equal(followUpDue(handed, 'h2'), false);
  assert.equal(settleAddress(handed, { fixRunning: false, headNow: 'h2' }), handed);
});
