import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentryEvent, ReviewDraft, ReviewThread } from '@agentry/shared';
import { keys } from '../src/api';
import { targetMatches, targetsFor } from '../src/lib/events';
import {
  approvalsProgress, canSubmit, countThreads, decisionMark, followUpThreads, groupThreads, lineLabel, parseLogins, preselected,
  reviewerMark, sortDrafts, submitOffer, summarizeDrafts, threadPlace, triageMark, workOnItNeutral,
} from '../src/lib/reviews';

const thread = (over: Partial<ReviewThread>): ReviewThread => ({
  id: 't1', path: 'a.ts', side: 'right', line: 10, startLine: 10, originalLine: 10, diffHunk: null, isResolved: false, isOutdated: false,
  resolvedBy: null, viewerCanReply: true, viewerCanResolve: true, comments: [], commentsTruncated: false, ...over,
});

const draft = (over: Partial<ReviewDraft>): ReviewDraft => ({
  id: 'd1', changeRequestId: 'cr-1', path: 'a.ts', side: 'right', line: 10, startLine: null, body: 'x', suggestion: false,
  createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', ...over,
});

test('a thread is drawn on its line, folded as outdated, on its file, or as a general one', () => {
  assert.equal(threadPlace(thread({})), 'line');
  assert.equal(threadPlace(thread({ isOutdated: true, line: null })), 'outdated');
  assert.equal(threadPlace(thread({ line: null })), 'file');
  assert.equal(threadPlace(thread({ path: null, line: null })), 'general');
});

test('threads are grouped by file and line, and a resolved one stays apart from the open ones', () => {
  const { files, general } = groupThreads([
    thread({ id: 'a' }), thread({ id: 'b', isResolved: true }), thread({ id: 'c', isOutdated: true, line: null }),
    thread({ id: 'd', path: null, line: null }), thread({ id: 'e', path: 'b.ts', side: 'left', line: 3 }),
  ]);
  const a = files.get('a.ts')!;
  assert.deepEqual(a.byLine.get('right:10')?.map((t) => t.id), ['a']);
  assert.deepEqual(a.resolvedByLine.get('right:10')?.map((t) => t.id), ['b']);
  assert.deepEqual(a.outdated.map((t) => t.id), ['c']);
  assert.deepEqual(files.get('b.ts')?.byLine.get('left:3')?.map((t) => t.id), ['e']);
  assert.deepEqual(general.map((t) => t.id), ['d']);
  assert.deepEqual(countThreads([thread({}), thread({ isResolved: true }), thread({ isResolved: true })]), { unresolved: 1, resolved: 2 });
});

test('a line locator reads :n or :from–to', () => {
  assert.equal(lineLabel(142, 142), ':142');
  assert.equal(lineLabel(60, 57), ':57–60');
  assert.equal(lineLabel(null, null), null);
});

test('the decision and the reviewers carry a colour and a word, and nothing here is live', () => {
  assert.equal(decisionMark('approved').tone, 'ok');
  assert.equal(decisionMark('changes-requested').tone, 'bad');
  assert.equal(decisionMark('review-required').label, 'decision.review-required');
  assert.equal(decisionMark(null).label, 'decision.none');
  assert.equal(reviewerMark('approved').tone, 'ok');
  assert.equal(reviewerMark('requested').tone, 'idle');
  assert.deepEqual(approvalsProgress({ approvalsRequired: 2, approvalsLeft: 1 }), { given: 1, required: 2 });
  assert.equal(approvalsProgress({ approvalsRequired: null, approvalsLeft: null }), null);
});

test('reviewers are read from free text without repeats, @ or the ones already asked', () => {
  assert.deepEqual(parseLogins('@dani, marta  dani Marta', ['MARTA']), ['dani']);
});

test('drafts are counted, with a suggestion apart from a comment, and ordered as the diff', () => {
  assert.deepEqual(summarizeDrafts([draft({}), draft({ suggestion: true }), draft({})]), { total: 3, comments: 2, suggestions: 1 });
  const sorted = sortDrafts([draft({ id: 'g', path: null, line: null }), draft({ id: 'b', path: 'b.ts' }), draft({ id: 'a2', line: 20 }), draft({ id: 'a1' })]);
  assert.deepEqual(sorted.map((d) => d.id), ['a1', 'a2', 'b', 'g']);
});

test('the submit sheet offers Approve on GitLab only when the viewer can, and links it on GitHub', () => {
  assert.deepEqual(submitOffer('gitlab', { canApprove: true }), { events: ['comment', 'approve'], openOnHost: false, own: false });
  assert.deepEqual(submitOffer('gitlab', { canApprove: false }).events, ['comment']);
  assert.deepEqual(submitOffer('github', { canApprove: false }), { events: ['comment'], openOnHost: true, own: false });
  assert.deepEqual(submitOffer('github', undefined, true), { events: ['comment'], openOnHost: false, own: true });
  assert.ok(canSubmit([draft({})], 'comment', ''));
  assert.ok(!canSubmit([], 'comment', '  '));
  assert.ok(canSubmit([], 'approve', ''));
});

test('Submit review takes the zone from Work on it while there is a draft, and Fix failing checks does too', () => {
  assert.equal(workOnItNeutral({ drafts: 0, checksFixShowing: false }), false);
  assert.equal(workOnItNeutral({ drafts: 2, checksFixShowing: false }), true);
  assert.equal(workOnItNeutral({ drafts: 0, checksFixShowing: true }), true);
});

test('a triage mark only preselects the threads marked agent', () => {
  const threads = [thread({ id: 'a' }), thread({ id: 'b' }), thread({ id: 'c' })];
  assert.deepEqual([...preselected(threads, { a: 'agent', b: 'person', c: 'no-action' })], ['a']);
  assert.equal(preselected(threads, undefined).size, 0);
  assert.equal(triageMark('agent').tone, 'ok');
  assert.deepEqual(followUpThreads([thread({ id: 'a' }), thread({ id: 'b', isResolved: true }), thread({ id: 'c' })], ['a', 'b']).map((t) => t.id), ['a']);
});

test('change-request.review refreshes the threads, drafts, reviewers and approval of that request only', () => {
  const event = { id: 1, type: 'change-request.review', title: 'Review', changeRequestId: 'cr-1', unresolvedThreads: 2, decision: null } as unknown as AgentryEvent;
  const target = targetsFor(event)[0]!;
  for (const key of [keys.changeRequestThreads('cr-1'), keys.reviewDrafts('cr-1'), keys.changeRequestReviewers('cr-1'), keys.changeRequestApproval('cr-1')]) {
    assert.ok(targetMatches(target, key));
  }
  assert.ok(!targetMatches(target, keys.changeRequestThreads('cr-2')));
});
