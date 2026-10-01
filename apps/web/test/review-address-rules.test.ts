import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewThread } from '@agentry/shared';
import { addressable, countThreads, followUp, isReviewFix, noteHeadOf, partlyPost, pinNoteHead, reviewedHead } from '../src/lib/reviews';

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

test("Addressed in follows the core's record of the address's own push, never a head the browser saw move", () => {
  // the address pushed h2 for these threads
  assert.deepEqual(followUp({ addressed: { head: 'h2abcdef', threadIds: ['a'] }, fixState: null }), { sha: 'h2abcdef', threadIds: ['a'] });
  // the head moved with no push by the address (card taken over, somebody else pushed): the core has no record
  assert.equal(followUp({ addressed: null, fixState: null }), null);
  assert.equal(followUp({ fixState: null }), null);
  assert.equal(followUp(null), null);
  // another fix under way, or a record that names no thread, says nothing
  assert.equal(followUp({ addressed: { head: 'h2', threadIds: ['a'] }, fixState: 'fixing' }), null);
  assert.equal(followUp({ addressed: { head: 'h2', threadIds: [] }, fixState: null }), null);
});

test('a submit is posted on the head of the first note written on another commit, so a moved head is refused', () => {
  const pins: Record<string, string> = { n1: 'A', n2: 'B' };
  const pinned = (id: string) => pins[id] ?? null;
  // notes at A, the head is now B: the review goes out on A and the server refuses it
  assert.equal(reviewedHead([{ id: 'n1' }], pinned, 'B', 'B'), 'A');
  // notes written on the current head go out on it
  assert.equal(reviewedHead([{ id: 'n2' }], pinned, 'A', 'B'), 'B');
  // a mix is refused too: one of the notes was not written on the head now
  assert.equal(reviewedHead([{ id: 'n1' }, { id: 'n2' }], pinned, 'B', 'B'), 'A');
  // a note this tab does not know is read on the head the page looked at
  assert.equal(reviewedHead([{ id: 'old' }], pinned, 'A', 'B'), 'A');
  assert.equal(reviewedHead([], pinned, 'B', 'B'), 'B');
});

test('the head a note was written on is kept for the draft, and only when the head is known', () => {
  pinNoteHead('d-x', 'A');
  pinNoteHead('d-y', null);
  assert.equal(noteHeadOf('d-x'), 'A');
  assert.equal(noteHeadOf('d-y'), null);
});
