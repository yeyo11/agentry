import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlowRun, WorkItemComment, WorkItemHistoryEntry } from '@agentry/shared';
import en from '../src/i18n/locales/en/workItem.json' with { type: 'json' };
import es from '../src/i18n/locales/es/workItem.json' with { type: 'json' };
import { activityOf } from '../src/pages/tasks/item/model.ts';
import { commentRun, failureCommentRun, failureReason, retriesOf, retryOutcome, runStatus, runStep } from '../src/pages/tasks/item/runs.ts';

// Decision 8 of the ecosystem design review: a failed run says so everywhere a run shows, in the
// person's words from its cause, and a person's retry is part of the item's story.

const run = (over: Partial<FlowRun> = {}): FlowRun =>
  ({
    id: 'r1',
    itemId: 'i1',
    role: 'qa',
    stage: 'verify',
    step: 'verify',
    column: 'in_review',
    state: 'ended',
    chatId: 'c1',
    outcome: 'passed',
    error: null,
    cause: null,
    retryOf: null,
    queuedBy: null,
    retriedBy: null,
    retryable: false,
    restarts: 0,
    queuedAt: '2026-09-27T10:00:00.000Z',
    startedAt: '2026-09-27T10:00:01.000Z',
    endedAt: '2026-09-27T10:03:00.000Z',
    ...over,
  }) as FlowRun;

const comment = (over: Partial<WorkItemComment>): WorkItemComment => ({
  id: 'k1',
  itemId: 'i1',
  author: { kind: 'agent', role: 'qa' },
  source: { kind: 'chat', chatId: 'c1', orchestrationId: null, taskId: null },
  body: 'All five criteria hold.',
  createdAt: '2026-09-27T10:03:00.000Z',
  updatedAt: '2026-09-27T10:03:00.000Z',
  ...over,
});

test('a stage is named by the column it ran in: a refine in To do is a check', () => {
  assert.equal(runStep({ stage: 'refine', column: 'backlog' }), 'refine');
  assert.equal(runStep({ stage: 'refine', column: 'todo' }), 'check');
  assert.equal(runStep({ stage: 'verify', column: 'in_review' }), 'verify');
  // The core's own step wins when it sent one
  assert.equal(runStep({ stage: 'refine', column: 'backlog', step: 'check' }), 'check');
});

test('a run stands as one word: at work, queued, or how it ended', () => {
  assert.equal(runStatus({ state: 'running', outcome: null }), 'running');
  assert.equal(runStatus({ state: 'queued', outcome: null }), 'queued');
  assert.equal(runStatus({ state: 'ended', outcome: 'rejected' }), 'rejected');
  assert.equal(runStatus({ state: 'ended', outcome: null }), 'failed', 'an ended run with no outcome did not pass');
});

test("a failed run's reason comes from its cause, with a word for every cause the core sends", () => {
  assert.equal(failureReason(run()), null, 'a run that passed has none');
  assert.equal(failureReason(run({ state: 'running', outcome: null })), null);
  assert.deepEqual(failureReason(run({ outcome: 'failed', cause: 'restarts', restarts: 2 })), { key: 'run.cause.restarts', values: { count: 3, step: 'verify' } });
  assert.equal(failureReason(run({ outcome: 'failed', cause: null, error: 'something' }))?.key, 'run.cause.unknown', 'an old run with no cause');
  // A cancel's cause never words a failure
  assert.equal(failureReason(run({ outcome: 'failed', cause: 'item-moved' }))?.key, 'run.cause.unknown');
  const failures = ['budget', 'no-account', 'rate-limit', 'stopped', 'unreadable', 'no-verdict', 'not-started', 'not-continued', 'chat-ended', 'chat-failed', 'unknown'] as const;
  for (const locale of [en, es]) {
    const causes = locale.run.cause as Record<string, string>;
    for (const cause of failures) assert.ok(causes[cause], `run.cause.${cause} is worded`);
    assert.ok(causes.restarts_one && causes.restarts_other, 'restarts counts its cut-offs');
  }
});

test("the core's English failure comment is found by its run, and only that comment", () => {
  const failed = run({ id: 'r0', chatId: 'c0', outcome: 'failed', cause: 'restarts' });
  const runs = [run(), failed];
  const english = comment({ source: { kind: 'chat', chatId: 'c0', orchestrationId: null, taskId: null }, body: 'This verification run failed and moved nothing: cut off by a restart.' });
  assert.equal(failureCommentRun(english, runs), failed);
  assert.equal(failureCommentRun(comment({}), runs), null, "a run's summary is its own text");
  assert.equal(failureCommentRun({ ...english, author: { kind: 'person' } }, runs), null, 'a person writing the same words');
  assert.equal(failureCommentRun({ ...english, source: null }, runs), null);
  // Any flow comment names the run its chat was for
  assert.equal(commentRun(comment({}), runs)?.id, 'r1');
  assert.equal(commentRun(comment({ author: { kind: 'person' } }), runs), null);
});

test("a person's retries read as history at the moment each was queued, and the failed run says what the retry did", () => {
  const retry = run({ id: 'r2', retryOf: 'r0', chatId: 'c2', queuedAt: '2026-09-27T11:00:00.000Z' });
  const runs = [retry, run({ id: 'r0', outcome: 'failed' })];
  assert.deepEqual(
    retriesOf(runs).map((r) => r.id),
    ['r2'],
  );
  const history: WorkItemHistoryEntry[] = [
    { id: 'h1', itemId: 'i1', change: 'created', from: null, to: null, actor: { kind: 'person' }, cause: null, createdAt: '2026-09-27T09:00:00.000Z' },
    { id: 'h2', itemId: 'i1', change: 'status', from: 'in_progress', to: 'in_review', actor: { kind: 'system' }, cause: null, createdAt: '2026-09-27T10:30:00.000Z' },
  ];
  const ids = (filter: 'all' | 'comments' | 'history') =>
    activityOf(history, [comment({ createdAt: '2026-09-27T11:30:00.000Z' })], filter, retriesOf(runs)).map((e) => (e.kind === 'history' ? e.entry.id : e.kind === 'comment' ? e.comment.id : e.run.id));
  assert.deepEqual(ids('all'), ['h1', 'h2', 'r2', 'k1']);
  assert.deepEqual(ids('history'), ['h1', 'h2', 'r2'], 'a retry is history');
  assert.deepEqual(ids('comments'), ['k1']);

  assert.equal(retryOutcome(run({ outcome: 'failed' })), null, 'not retried yet');
  assert.deepEqual(retryOutcome(run({ outcome: 'failed', retriedBy: { id: 'r2', state: 'ended', outcome: 'passed', chatId: 'c2', queuedAt: 'q', endedAt: 'e' } })), { status: 'passed', at: 'e', chatId: 'c2' });
  assert.deepEqual(retryOutcome(run({ outcome: 'failed', retriedBy: { id: 'r2', state: 'queued', outcome: null, chatId: null, queuedAt: 'q', endedAt: null } })), { status: 'queued', at: null, chatId: null });
});
