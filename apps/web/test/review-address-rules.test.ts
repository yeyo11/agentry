import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewThread } from '@agentry/shared';
import { addressable, answeredWith, countThreads, followUp, isReviewFix, noteHeadOf, partlyPost, pinNoteHead, reviewedHead } from '../src/lib/reviews';

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

test('a follow-up shown again does not post its reply twice: the host holds the last word', () => {
  const reply = 'Addressed in abc1234.';
  const comment = (body: string) => ({ id: 'c', author: 'monalisa', body, createdAt: '', url: null }) as unknown as ReviewThread['comments'][number];
  assert.equal(answeredWith(thread({ comments: [comment('Please round'), comment(reply)] }), reply), true);
  assert.equal(answeredWith(thread({ comments: [comment(reply), comment('Thanks, one more thing')] }), reply), false, 'a later comment is the last word');
  assert.equal(answeredWith(thread({ comments: [] }), reply), false);
  assert.equal(answeredWith(thread({ comments: [comment(`  ${reply}\n`)] }), reply), true, 'a host may trim or pad the text');
});

test('after a head-moved refusal the notes are pinned to the head the person was told about', () => {
  const pinned = new Map<string, string>([['n1', 'A']]);
  const read = (id: string) => pinned.get(id) ?? null;
  assert.equal(reviewedHead([{ id: 'n1' }], read, 'A', 'B'), 'A', 'before: the note is on A and the head is B, so the server refuses');
  pinNoteHead('n1', 'B');
  assert.equal(reviewedHead([{ id: 'n1' }], noteHeadOf, 'B', 'B'), 'B', 'after: it is pinned to B and the next send goes on B');
});
