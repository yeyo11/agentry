import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentryEvent, MergeBlockerCode, MergeState } from '@agentry/shared';
import { keys } from '../src/api';
import { targetMatches, targetsFor } from '../src/lib/events';
import {
  armBody, blockerActionKind, blockerMark, blockerParams, blockersOf, chosenMethod, hasMergeWarning, isArmed, mergeBody, mergeFailure, mergeRefetchMs, methodHasMessage, needsReread,
} from '../src/lib/merge';

const state = (over: Partial<MergeState> = {}): MergeState => ({
  changeRequestId: 'cr-1', host: 'github', headSha: 'a'.repeat(40), methods: ['squash', 'merge'], defaultMethod: 'squash', deleteBranchDefault: true,
  canMerge: true, blocker: null, others: [], warning: null,
  autoMerge: { available: false, reason: null, armed: false, method: null, armedBy: null, armedAt: null },
  autoMergeOff: null, waitingForPipeline: false, canRebaseOnHost: false, rebaseOnHostWhy: null, readAt: '2026-10-01T10:00:00Z', ...over,
});

const CODES: MergeBlockerCode[] = [
  'not-open', 'computing', 'draft', 'conflicts', 'nothing-to-merge', 'behind', 'checks-running', 'checks-failing', 'checks-missing', 'external-checks', 'review-required',
  'changes-requested', 'threads-unresolved', 'tracker-key-missing', 'title-rejected', 'blocked-by-dependency', 'not-yet', 'locked-files', 'merge-queue', 'blocked-by-policy',
];

test('every blocker has a word and a sentence, and the tones follow the status rules', () => {
  for (const code of CODES) {
    const mark = blockerMark(code);
    assert.equal(mark.word, `blocker.${code}.word`);
    assert.equal(mark.text, `blocker.${code}.text`);
  }
  assert.equal(blockerMark('conflicts').tone, 'bad');
  assert.equal(blockerMark('checks-failing').tone, 'bad');
  assert.equal(blockerMark('draft').tone, 'idle');
  assert.deepEqual(CODES.filter((c) => blockerMark(c).tone === 'live'), ['computing', 'checks-running']);
});

test('a blocker this version does not know reads as the policy block', () => {
  assert.deepEqual(blockerMark('something-new'), blockerMark('blocked-by-policy'));
});

test('a remedy is an Agentry call, a link to the host or a move in the page, never a command', () => {
  assert.equal(blockerActionKind('open-on-host'), 'link');
  assert.equal(blockerActionKind('update-from-base'), 'call');
  assert.equal(blockerActionKind('edit-title'), 'page');
});

test('the sentence is written with the host, the branches and the host-sent name as plain text', () => {
  const params = blockerParams({ detail: '<b>unit</b>' }, { host: 'gitlab', branch: 'task/agn-26', base: 'main', phase: 'open' }, 'MR');
  assert.deepEqual(params, { noun: 'MR', host: 'GitLab', head: 'task/agn-26', base: 'main', name: '<b>unit</b>', state: 'open' });
  assert.equal(blockerParams({ detail: null }, { host: 'github', branch: 'b', base: 'main', phase: 'open' }, 'PR').name, '');
});

test('the first blocker leads and the rest follow in order', () => {
  const blocker = { code: 'conflicts', detail: null, action: 'update-from-base' } as const;
  const other = { code: 'review-required', detail: null, action: 'request-reviewers' } as const;
  assert.deepEqual(blockersOf(state({ canMerge: false, blocker, others: [other] })).map((b) => b.code), ['conflicts', 'review-required']);
  assert.deepEqual(blockersOf(state()), []);
});

test('the preselected method is the person\'s while it is allowed, else the repository\'s', () => {
  assert.equal(chosenMethod(state(), null), 'squash');
  assert.equal(chosenMethod(state(), 'merge'), 'merge');
  assert.equal(chosenMethod(state(), 'rebase'), 'squash');
  assert.equal(chosenMethod(state({ methods: [], defaultMethod: null }), 'merge'), null);
  assert.ok(methodHasMessage('squash') && methodHasMessage('merge') && !methodHasMessage('rebase'));
});

test('the merge click carries the head seen, and a blank message is left to the host', () => {
  const choice = { method: null, deleteBranch: false, subject: '  feat: x  ', body: '   ' };
  assert.deepEqual(mergeBody(state(), choice), { method: 'squash', expectedHead: 'a'.repeat(40), deleteBranch: false, subject: 'feat: x' });
  assert.equal('subject' in (mergeBody(state({ methods: ['rebase'], defaultMethod: 'rebase' }), choice) ?? {}), false);
  assert.equal(mergeBody(state({ canMerge: false }), choice), null);
  assert.equal(mergeBody(state({ headSha: null }), choice), null);
});

test('auto-merge is armed only when offered, not yet armed and with the head seen', () => {
  const offered = { available: true, reason: null, armed: false, method: null, armedBy: null, armedAt: null } as const;
  assert.deepEqual(armBody(state({ autoMerge: offered }), 'merge'), { method: 'merge', expectedHead: 'a'.repeat(40) });
  assert.equal(armBody(state(), null), null);
  assert.equal(armBody(state({ autoMerge: { ...offered, armed: true } }), null), null);
  assert.ok(isArmed(state({ autoMerge: { ...offered, armed: true } })));
  assert.ok(!isArmed(undefined));
});

test('a merge with a notice is still a merge', () => {
  assert.ok(hasMergeWarning(state({ warning: 'optional-checks-failing' })));
  assert.ok(!hasMergeWarning(state({ canMerge: false, warning: 'optional-checks-failing' })));
});

test('the state is read again only for what no event announces', () => {
  assert.equal(mergeRefetchMs(undefined), false);
  assert.equal(mergeRefetchMs(state()), false);
  assert.equal(mergeRefetchMs(state({ waitingForPipeline: true })), 10_000);
  assert.equal(mergeRefetchMs(state({ canMerge: false, blocker: { code: 'computing', detail: null, action: 'refresh' } })), 5_000);
});

test('a refusal is worded by its reason, and any other is a failed merge that keeps the host\'s text', () => {
  assert.equal(mergeFailure('head-moved'), 'head-moved');
  assert.equal(mergeFailure('timeout'), 'merge-failed');
  assert.equal(mergeFailure(undefined), 'merge-failed');
  assert.ok(needsReread('head-moved') && !needsReread('forbidden'));
});

test('the checks and review events refresh the merge state, an orchestration\'s pull request too, and no other request\'s', () => {
  const checks = { id: 1, type: 'change-request.checks', title: 'x', changeRequestId: 'cr-1', rollup: 'failing', headSha: 'a' } as unknown as AgentryEvent;
  const target = targetsFor(checks)[0]!;
  assert.ok(targetMatches(target, keys.changeRequestMerge('cr-1')));
  assert.ok(!targetMatches(target, keys.changeRequestMerge('cr-2')));
  const pr = { id: 2, type: 'orchestration.pull-request', title: 'x', orchestrationId: 'o-1', pullRequest: { id: 'cr-9' } } as unknown as AgentryEvent;
  assert.ok(targetsFor(pr).some((t) => targetMatches(t, keys.changeRequestMerge('cr-9'))));
});
