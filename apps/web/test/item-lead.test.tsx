// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { afterEach, beforeEach } from 'node:test';
import type { ChangeRequestChecks, ChangeRequestReviewPosts, ChangeRequestThreads, Check, MergeState, ReviewDraft, ReviewPost, ReviewThread, WorkItemDetail, WorkItemPullRequest } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@agentry/ui/components/Dialog';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { keys } from '../src/api';
import { setLanguage } from '../src/i18n';
import { useLeadingAction, workOnItNeutral } from '../src/pages/tasks/item/lead';
import { leadingAction, type LeadingFacts } from '../src/pages/tasks/item/model';
import { PullRequestState } from '../src/pages/tasks/item/PullRequest';

// One gradient action per zone on the item page (docs/plans/code-hosts.md, phase 4): a push or a
// publish that waits leads, then the reply to the threads a pushed fix answered, Submit review, Fix
// failing checks and Merge; everything else, the header's Work on it included, is neutral.

beforeEach(() => setLanguage('en'));

const stored = new Map<string, string>();
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
beforeEach(() => {
  stored.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) },
  });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

const none: LeadingFacts = { pushWaiting: false, publishWaiting: false, replyWaiting: false, drafts: 0, fixOffered: false, mergeOffered: false };

test('the oldest thing that waits leads, and nothing leads when nothing is offered', () => {
  assert.equal(leadingAction(none), null);
  assert.equal(leadingAction({ ...none, mergeOffered: true }), 'merge');
  assert.equal(leadingAction({ ...none, mergeOffered: true, fixOffered: true }), 'fix');
  assert.equal(leadingAction({ ...none, mergeOffered: true, fixOffered: true, drafts: 2 }), 'submit');
  assert.equal(leadingAction({ ...none, mergeOffered: true, fixOffered: true, drafts: 2, replyWaiting: true }), 'reply');
  assert.equal(leadingAction({ ...none, mergeOffered: true, fixOffered: true, drafts: 2, replyWaiting: true, publishWaiting: true }), 'publish');
  assert.equal(leadingAction({ pushWaiting: true, publishWaiting: true, replyWaiting: true, drafts: 2, fixOffered: true, mergeOffered: true }), 'push');
});

const pr = (over: Partial<WorkItemPullRequest> = {}): WorkItemPullRequest => ({
  id: 'cr1', phase: 'open', host: 'github', number: 12, ref: '#12', url: 'https://github.com/acme/shop/pull/12', branch: 'task/agn-26', base: 'main', ci: 'passing',
  conflicts: [], error: null, openedAt: '2026-10-01T09:00:00Z', closedAt: null, checkedAt: '2026-10-01T10:00:00Z', ...over,
});

const mergeState = (over: Partial<MergeState> = {}): MergeState => ({
  changeRequestId: 'cr1', host: 'github', headSha: 'a81d3f0b2c4d5e6f708192a3b4c5d6e7f8091a2b', methods: ['squash'], defaultMethod: 'squash', deleteBranchDefault: true,
  canMerge: true, blocker: null, others: [], warning: null,
  autoMerge: { available: false, reason: null, armed: false, method: null, armedBy: null, armedAt: null },
  autoMergeOff: null, waitingForPipeline: false, canRebaseOnHost: false, rebaseOnHostWhy: null, readAt: '2026-10-01T10:00:00Z', ...over,
});

const failing: ChangeRequestChecks = {
  headSha: 'a1b2c3d', rollup: 'failing', truncated: false, checkedAt: '2026-10-01T10:42:00Z',
  checks: [{ id: '1', name: 'unit-tests', group: 'test', state: 'failed', allowedToFail: false, required: true, startedAt: null, finishedAt: null, url: null, rerunnable: true, hasLog: false, source: 'job' } as Check],
};

const draft = { id: 'd1', changeRequestId: 'cr1', path: 'a.ts', side: 'right', line: 4, startLine: null, body: 'rename', suggestion: false, createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z' } as ReviewDraft;
const partly = { id: 'p1', changeRequestId: 'cr1', marker: 'm', event: 'comment', state: 'partly', remoteId: null, detail: { code: 'review-partly-posted', detail: '', saved: 2, total: 3, draftIds: ['x'] }, createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z' } as ReviewPost;
const thread = { id: 't1', path: 'a.ts', side: 'right', line: 10, startLine: 10, originalLine: 10, diffHunk: null, isResolved: false, isOutdated: false, resolvedBy: null, viewerCanReply: true, viewerCanResolve: true, comments: [{ id: 'c1', author: 'marta', body: 'rename this', createdAt: '2026-10-01T10:00:00Z', suggestion: null }], commentsTruncated: false } as ReviewThread;

const item = (request: WorkItemPullRequest): WorkItemDetail =>
  ({ id: 'item1', key: 'AGN-26', type: 'task', pullRequest: request, pullRequestReadiness: null, waiting: 'merge', status: 'in_review', activeLink: null, acceptanceCriteria: [], children: [], links: [], comments: [], history: [] }) as unknown as WorkItemDetail;

/** The header's Work on it, drawn by the rule ViewHead applies, and the pull request zone, as the item page lays them out. */
function Zone({ detail }: { detail: WorkItemDetail }) {
  const neutral = workOnItNeutral(useLeadingAction(detail.pullRequest));
  return (
    <>
      <div className="head">
        <button type="button" className={`btn workitem-work ${neutral ? '' : 'btn-primary'}`.trim()}>
          Work on it
        </button>
      </div>
      <PullRequestState item={detail} />
    </>
  );
}

interface Scene {
  request?: WorkItemPullRequest;
  merge?: MergeState;
  drafts?: ReviewDraft[];
  posts?: ChangeRequestReviewPosts;
  threads?: ReviewThread[];
  checks?: ChangeRequestChecks;
}

function render({ request = pr(), merge, drafts, posts, threads, checks }: Scene): string {
  const qc = new QueryClient();
  if (merge) qc.setQueryData(keys.changeRequestMerge('cr1'), merge);
  if (drafts) qc.setQueryData(keys.reviewDrafts('cr1'), drafts);
  if (posts) qc.setQueryData(keys.reviewPosts('cr1'), posts);
  if (threads) qc.setQueryData(keys.changeRequestThreads('cr1'), { headSha: 'h2', threads, checkedAt: '2026-10-01T10:00:00Z' } as ChangeRequestThreads);
  if (checks) qc.setQueryData(keys.changeRequestChecks('cr1'), checks);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>
          <ConfirmProvider>
            <ToastProvider>
              <Zone detail={item(request)} />
            </ToastProvider>
          </ConfirmProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The labels of every gradient button the page draws. */
const gradient = (html: string): string[] => [...html.matchAll(/<button[^>]*class="[^"]*btn-primary[^"]*"[^>]*>(.*?)<\/button>/g)].map((m) => (m[1] ?? '').replace(/<[^>]+>/g, '').trim());

const scenes: Array<[string, Scene, string]> = [
  ['nothing on offer: Work on it leads', { merge: mergeState({ canMerge: false, blocker: { code: 'conflicts', detail: null, action: 'update-from-base' } }) }, 'Work on it'],
  ['Merge leads, Work on it is neutral', { merge: mergeState() }, 'Merge'],
  ['arming while the checks run leads', { merge: mergeState({ canMerge: false, blocker: { code: 'checks-running', detail: null, action: 'auto-merge' }, autoMerge: { available: true, reason: null, armed: false, method: null, armedBy: null, armedAt: null } }) }, 'Turn on auto-merge'],
  ['arming behind a required review is a plain button, so Work on it keeps the gradient', { merge: mergeState({ canMerge: false, blocker: { code: 'review-required', detail: null, action: 'request-reviewers' }, autoMerge: { available: true, reason: null, armed: false, method: null, armedBy: null, armedAt: null } }) }, 'Work on it'],
  ['a draft review: Submit review leads over Merge', { merge: mergeState(), drafts: [draft] }, 'Submit review'],
  ['failing checks: Fix failing checks leads over Merge', { merge: mergeState(), checks: failing }, 'Fix failing checks'],
  ['a review that stopped half way: Publish leads over Submit review and Merge', { merge: mergeState(), drafts: [draft], posts: { posts: [partly], savedOnHost: { p1: 2 } } }, 'Publish the saved'],
  ['a fix that waits for the push leads over everything', { request: pr({ fixState: 'awaiting-push', fixKind: 'checks', fixOrigin: 'person' }), merge: mergeState(), drafts: [draft], checks: failing }, 'Push the fix'],
  ['a review fix that waits for the push leads over everything', { request: pr({ fixState: 'awaiting-push', fixKind: 'review', fixOrigin: 'person' }), merge: mergeState(), drafts: [draft] }, 'Push the fix'],
  ['replying to the threads a push answered leads over Submit review and Merge', { request: pr({ addressed: { head: 'h2abcdef', threadIds: ['t1'] } }), merge: mergeState(), drafts: [draft], threads: [thread] }, 'Reply and resolve'],
];

for (const [name, scene, label] of scenes) {
  test(`one gradient button on the page: ${name}`, () => {
    const found = gradient(render(scene));
    assert.equal(found.length, 1, found.join(' | '));
    assert.match(found[0] ?? '', new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

test('a dismissed follow-up gives the gradient back to the next action', () => {
  const html = render({ request: pr({ addressed: { head: 'h2abcdef', threadIds: ['t1'] } }), merge: mergeState(), threads: [{ ...thread, isResolved: true }] });
  assert.deepEqual(gradient(html).map((label) => label.replace(/\s+/g, ' ')), ['Merge']);
});

test('the page mounts one lead for its blocks and its header', () => {
  const read = (file: string) => readFileSync(new URL(`../src/pages/tasks/item/${file}`, import.meta.url), 'utf8');
  const state = read('PullRequest.tsx');
  assert.match(state, /useLeadingAction\(item\.pullRequest\)/);
  for (const block of ['Review', 'AddressReview', 'Merge', 'Checks']) assert.match(state, new RegExp(`<${block}\\b[^>]*lead=\\{lead\\}`), block);
  const head = read('ViewHead.tsx');
  assert.match(head, /workOnItNeutral\(useLeadingAction\(item\.pullRequest\)\)/);
});
