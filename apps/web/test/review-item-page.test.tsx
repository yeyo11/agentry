// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import type { ChangeRequestReviewPosts, ChangeRequestReviewers, ChangeRequestThreads, ReviewPost, ReviewThread, WorkItemPullRequest } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@agentry/ui/components/Dialog';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { keys } from '../src/api';
import { setLanguage } from '../src/i18n';
import { AddressReview } from '../src/pages/tasks/item/AddressReview';
import type { LeadingAction } from '../src/pages/tasks/item/model';
import { Review } from '../src/pages/tasks/item/Review';

// The item page's review block and its address strip (docs/plans/code-hosts.md, Phase 3): what a
// reload keeps, how threads are counted, and the one offer to address comments.

beforeEach(() => setLanguage('en'));

const pr = (over: Partial<WorkItemPullRequest> = {}): WorkItemPullRequest => ({
  id: 'cr1', phase: 'open', host: 'gitlab', number: 12, ref: '!12', url: 'https://gitlab.com/acme/shop/-/merge_requests/12', branch: 'task/agn-26', base: 'main', ci: 'passing',
  conflicts: [], error: null, openedAt: '2026-10-01T09:00:00Z', closedAt: null, checkedAt: '2026-10-01T10:00:00Z', ...over,
});

const thread = (over: Partial<ReviewThread>): ReviewThread => ({
  id: 't1', path: 'a.ts', side: 'right', line: 10, startLine: 10, originalLine: 10, diffHunk: null, isResolved: false, isOutdated: false,
  resolvedBy: null, viewerCanReply: true, viewerCanResolve: true, comments: [{ id: 'c1', author: 'marta', body: 'rename this', createdAt: '2026-10-01T10:00:00Z', suggestion: null }], commentsTruncated: false, ...over,
} as ReviewThread);

const threadsOf = (threads: ReviewThread[], headSha = 'h2'): ChangeRequestThreads => ({ headSha, threads, checkedAt: '2026-10-01T10:00:00Z' }) as ChangeRequestThreads;

const post = (over: Partial<ReviewPost>): ReviewPost => ({
  id: 'p1', changeRequestId: 'cr1', marker: 'm', event: 'comment', state: 'partly', remoteId: null, detail: { code: 'review-partly-posted', detail: '', saved: 2, total: 3, draftIds: ['x'] },
  createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', ...over,
});

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

function page(request: WorkItemPullRequest, seed: (qc: QueryClient) => void, element: 'review' | 'address', lead: LeadingAction | null = null) {
  const qc = new QueryClient();
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>{element === 'review' ? <Review pr={request} itemId="item1" changesPath="/tasks/AGN-26/changes" lead={lead} /> : <AddressReview pr={request} lead={lead} />}</ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const reviewers: ChangeRequestReviewers = { decision: null, reviewers: [], unresolvedThreads: 0 } as unknown as ChangeRequestReviewers;

test('a review that stopped half way is still offered Publish saved and Discard saved after a reload', () => {
  const posts: ChangeRequestReviewPosts = { posts: [post({})], savedOnHost: { p1: 2 } };
  const html = page(
    pr(),
    (qc) => {
      qc.setQueryData(keys.changeRequestReviewers('cr1'), reviewers);
      qc.setQueryData(keys.reviewPosts('cr1'), posts);
    },
    'review',
  );
  assert.match(html, /Publish the saved/);
  assert.match(html, /Discard the saved/);
  // host-neutral: the host and its word for the change request
  assert.match(html, /saved as drafts on GitLab/);
  assert.match(html, /sending of the MR stopped/);
  assert.match(html, /2 saved comments still wait on GitLab/);
  assert.doesNotMatch(html, /pull request/);
});

test('a later post that went out leaves nothing to choose, and nothing saved on the host cannot be published', () => {
  const quiet = page(pr(), (qc) => qc.setQueryData(keys.reviewPosts('cr1'), { posts: [post({ id: 'p2', state: 'posted' }), post({})], savedOnHost: {} }), 'review');
  assert.doesNotMatch(quiet, /Publish the saved/);
  const gone = page(pr(), (qc) => qc.setQueryData(keys.reviewPosts('cr1'), { posts: [post({})], savedOnHost: { p1: 0 } }), 'review');
  assert.match(gone, /Nothing saved is left on GitLab/);
  assert.match(gone, /<button[^>]*disabled[^>]*>Publish the saved/);
});

test('the threads row counts as the core does and offers Address with an agent', () => {
  const list = threadsOf([thread({ id: 'a' }), thread({ id: 'b', isOutdated: true, line: null }), thread({ id: 'c', isResolved: true })]);
  const html = page(
    pr(),
    (qc) => {
      qc.setQueryData(keys.changeRequestReviewers('cr1'), reviewers);
      qc.setQueryData(keys.changeRequestThreads('cr1'), list);
    },
    'review',
  );
  assert.match(html, /1 unresolved/);
  assert.match(html, /1 resolved/);
  assert.match(html, /rv-address[^>]*>.*Address with an agent/);
});

test('the strip counts the same threads, offers the same dialog in its own words, and says nothing of the checks', () => {
  const list = threadsOf([thread({ id: 'a' }), thread({ id: 'b', isOutdated: true, line: null })]);
  const html = page(pr(), (qc) => qc.setQueryData(keys.changeRequestThreads('cr1'), list), 'address');
  assert.match(html, /1 review thread waits for an answer/);
  assert.match(html, /workitem-address/);
  assert.match(html, /Choose which to address/);
  assert.doesNotMatch(html, /Address with an agent/);
});

test('a review fix shows one live surface and one push: the address run, worded as comments', () => {
  const running = page(pr({ fixState: 'fixing', fixKind: 'review', fixOrigin: 'person' }), () => undefined, 'address');
  assert.match(running, /An agent is addressing the comments/);
  assert.equal(running.split('live-rail').length - 1, 1);
  const waiting = page(pr({ fixState: 'awaiting-push', fixKind: 'review', fixOrigin: 'decision' }), () => undefined, 'address');
  assert.equal(waiting.split('workitem-push-review').length - 1, 1);
  assert.doesNotMatch(waiting, /workitem-push-fix/);
});

test('Addressed in is offered for the push the core recorded, and not after a card taken over', () => {
  const list = threadsOf([thread({ id: 'a' })], 'h2abcdef');
  const seed = (qc: QueryClient) => qc.setQueryData(keys.changeRequestThreads('cr1'), list);
  const pushed = page(pr({ addressed: { head: 'h2abcdef', threadIds: ['a'] } }), seed, 'address');
  assert.match(pushed, /Addressed in h2abcde/);
  assert.match(pushed, /workitem-reply-resolve/);

  // the head moved with no push by the address: the core recorded none, so nothing is offered
  assert.doesNotMatch(page(pr(), seed, 'address'), /Addressed in/);
  assert.doesNotMatch(page(pr({ addressed: null }), seed, 'address'), /Addressed in/);
});

test("the review block's Address button hides while a fix is under way, as the strip does", () => {
  const list = threadsOf([thread({ id: 'a' })]);
  const seed = (qc: QueryClient) => {
    qc.setQueryData(keys.changeRequestReviewers('cr1'), reviewers);
    qc.setQueryData(keys.changeRequestThreads('cr1'), list);
  };
  assert.match(page(pr(), seed, 'review'), /rv-address/);
  assert.doesNotMatch(page(pr({ fixState: 'fixing', fixKind: 'review', fixOrigin: 'person' }), seed, 'review'), /rv-address/);
});
