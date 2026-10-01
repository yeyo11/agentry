import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import test, { after } from 'node:test';
import type { ChangeRequestThreads, ReviewThread, WorkItem } from '@agentry/shared';
import { ChangeRequestService } from '../src/change-requests.ts';
import { Db } from '../src/db.ts';
import { ReviewTriage, TRIAGE_THREADS_MAX } from '../src/decisions/review-triage.ts';
import type { ReviewsService } from '../src/hosts/reviews-service.ts';
import type { OrchestrationPullRequestService } from '../src/orchestration-pull-requests.ts';
import type { PullRequestService } from '../src/pull-requests.ts';
import { choiceOf, decisionRig } from './decision-rig.ts';
import { tempConfig } from './helpers.ts';

// `review.triage` over the real engine and store, with a scripted provider: asked when the threads
// are read, once per set of open threads, at most 40, and the answer is in the history under the
// change request's id, where the Address dialog reads it.

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const thread = (id: string, over: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  path: 'cart.ts',
  side: 'right',
  line: 3,
  startLine: 3,
  originalLine: 3,
  diffHunk: null,
  isResolved: false,
  isOutdated: false,
  resolvedBy: null,
  viewerCanReply: true,
  viewerCanResolve: true,
  commentsTruncated: false,
  comments: [{ id: `${id}-c`, author: 'rev', body: 'Please round the total.', suggestion: null, createdAt: null, url: null }],
  ...over,
});

const listOf = (threads: ReviewThread[]): ChangeRequestThreads => ({ headSha: 'aaa', threads, truncated: false, checkedAt: '2026-10-01T00:00:00.000Z' });

function setup() {
  const config = tempConfig();
  roots.push(dirname(config.dataDir));
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const rig = decisionRig(db, config);
  return { db, rig, triage: new ReviewTriage({ decisions: rig.engine }) };
}

test('review.triage off: nothing is asked', async () => {
  const s = setup();
  s.rig.provider.script = () => ({ T1: choiceOf('agent') });
  s.triage.onThreads('cr1', 'p1', 'Round totals', listOf([thread('T1')]));
  await s.triage.idle();
  assert.equal(s.rig.provider.calls.length, 0);
  assert.equal(s.rig.rows('review.triage').length, 0);
});

test('review.triage shadow: the unresolved threads are asked once, each answer is kept by thread id under the change request', async () => {
  const s = setup();
  s.rig.provider.script = () => ({ T1: choiceOf('agent'), T2: choiceOf('person') });
  await s.rig.configure('review.triage', 'shadow');
  const list = listOf([thread('T1'), thread('T2', { path: null }), thread('T3', { isResolved: true })]);
  s.triage.onThreads('cr1', 'p1', 'Round totals', list);
  s.triage.onThreads('cr1', 'p1', 'Round totals', list);
  await s.triage.idle();
  assert.equal(s.rig.provider.calls.length, 1, 'the same open threads are asked once');
  const state = s.rig.provider.calls[0]?.state as { title: string; threads: Array<{ id: string; path: string | null; body: string; author: string | null; outdated: boolean }> };
  assert.equal(state.title, 'Round totals');
  assert.deepEqual(state.threads.map((t) => t.id), ['T1', 'T2'], 'a resolved thread is not asked about');
  assert.ok(state.threads[0]?.body.includes('Please round the total.'));
  const rows = s.rig.rows('review.triage');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.subjectId, 'cr1');
  assert.deepEqual(Object.keys(rows[0]?.answers ?? {}).sort(), ['T1', 'T2']);

  // A new open thread is a new question
  s.triage.onThreads('cr1', 'p1', 'Round totals', listOf([thread('T1'), thread('T2'), thread('T4')]));
  await s.triage.idle();
  assert.equal(s.rig.provider.calls.length, 2);
});

test('review.triage reads at most 40 threads, each body cut to 1 KiB', async () => {
  const s = setup();
  s.rig.provider.script = () => ({});
  await s.rig.configure('review.triage', 'shadow');
  const many = Array.from({ length: TRIAGE_THREADS_MAX + 10 }, (_, i) => thread(`T${String(i)}`, { comments: [{ id: 'c', author: 'rev', body: 'x'.repeat(5000), suggestion: null, createdAt: null, url: null }] }));
  s.triage.onThreads('cr1', 'p1', 'Many', listOf(many));
  await s.triage.idle();
  const state = s.rig.provider.calls[0]?.state as { threads: Array<{ body: string }> };
  assert.equal(state.threads.length, TRIAGE_THREADS_MAX);
  assert.ok(Buffer.byteLength(state.threads[0]?.body ?? '') <= 1024);
});

test('reading a change request\'s threads asks review.triage: the point is reachable from the route\'s service', async () => {
  const s = setup();
  s.rig.provider.script = () => ({});
  await s.rig.configure('review.triage', 'shadow');
  const row = { id: 'cr1', item_id: 'i1' };
  const sql = { prepare: (text: string) => ({ get: () => (text.includes('FROM work_item_pull_requests') ? row : undefined) }) };
  const item = { id: 'i1', projectId: 'p1', title: 'Round totals' } as WorkItem;
  const service = new ChangeRequestService({
    db: { connection: sql } as unknown as Db,
    checks: {} as never,
    reviews: { threads: () => Promise.resolve(listOf([thread('T1')])) } as unknown as ReviewsService,
    pullRequests: {} as PullRequestService,
    orchestrationPullRequests: {} as OrchestrationPullRequestService,
    orchestration: () => null,
    itemAccess: () => Promise.resolve(item),
    triage: s.triage,
  });
  const list = await service.threads('cr1', false);
  assert.equal(list.threads.length, 1, 'the threads are returned without waiting for the question');
  await s.triage.idle();
  const rows = s.rig.rows('review.triage');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.subjectId, 'cr1');
  assert.equal((s.rig.provider.calls[0]?.state as { title: string }).title, 'Round totals');
});
