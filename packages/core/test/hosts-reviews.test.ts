import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyCall } from '../src/hosts/classify.ts';
import { HostActionNotOffered, HostParseError, MAX_THREADS, type HostCall, type HostRepo, type HostResult } from '../src/hosts/code-host.ts';
import { githubAdapter } from '../src/hosts/github/adapter.ts';
import { githubManifest } from '../src/hosts/github/manifest.ts';
import { gitlabAdapter } from '../src/hosts/gitlab/adapter.ts';
import { gitlabManifest } from '../src/hosts/gitlab/manifest.ts';
import { suggestionFence, suggestionOf } from '../src/hosts/reviews-shape.ts';
import { checkConformance, runConformance, type RecordedOutputs } from './hosts/conformance.ts';

// Tests against what r0 recorded (fixtures/recordings, r0-NOTES.md): the adapters read the real
// outputs and build the argv that was run.

const here = dirname(fileURLToPath(import.meta.url));
const gh = (file: string): string => readFileSync(join(here, 'fixtures/recordings/gh/2.102.0', `${file}.out`), 'utf8');
const gl = (file: string): string => readFileSync(join(here, 'fixtures/recordings/glab/1.120.0', `${file}.out`), 'utf8');

const ghRepo: HostRepo = { host: 'github.com', path: 'yeyo11/agentry-probe', owner: 'yeyo11', name: 'agentry-probe' };
const glRepo: HostRepo = { host: 'gitlab.com', path: 'yeyo11/agentry', owner: 'yeyo11', name: 'agentry', projectId: 87089091 };

const result = (stdout: string, exitCode = 0): HostResult => ({ exitCode, stdout, stderrFirstLine: '', http: null, truncated: false, durationMs: 1 });
const argv = (call: HostCall | null | undefined): string => (call ? call.args.join(' ') : 'none');

const GH_HEAD = '1edb6cba70c6420d6e75a44963ca93fed97ec760';
const GL_HEAD = '38ff2ab8b0e31ee069cb9f9556605ae9c90cc21e';

// ---------- conformance, with the recorded threads ----------

const githubRecorded: RecordedOutputs = {
  threads: [
    {
      name: 'recorded four threads (single line, range, suggestion, a thread of 101 comments)',
      stdout: gh('d1_threads_big'),
      headSha: null,
      expect: {
        headSha: GH_HEAD,
        threads: [
          { id: 'PRRT_kwDOU1zIIM6n-Zjq', path: 'probe-r0.txt', side: 'right', line: 2, startLine: 2, originalLine: 2, isResolved: false, isOutdated: false, viewerCanResolve: true },
          { id: 'PRRT_kwDOU1zIIM6n-Zjx', line: 5, startLine: 4 },
          { id: 'PRRT_kwDOU1zIIM6n-Zj8', line: 3, startLine: 3 },
          { id: 'PRRT_kwDOU1zIIM6n-Zov', line: 7, commentsTruncated: true },
        ],
        truncated: false,
        followUps: 1,
      },
    },
  ],
  malformedThreads: [{ name: 'a pull request that does not exist', stdout: '{"data":{"repository":{"pullRequest":null}},"errors":[{"type":"NOT_FOUND"}]}' }],
};

const gitlabRecorded: RecordedOutputs = {
  threads: [
    {
      name: 'recorded discussions: lines, suggestions, drafts published, events skipped',
      stdout: gl('d1_discussions_after_publish'),
      headSha: GL_HEAD,
      expect: {
        headSha: GL_HEAD,
        threads: [
          { id: 'fa6571a09985f36099fe7832fd2e8937f6f1de90', path: 'probe-r0.txt', side: 'right', line: 2, isOutdated: false, isResolved: false },
          { line: 3 },
          { line: 5 },
          { path: null, side: null, line: null },
          { line: 7 },
          { path: null },
          { line: 8 },
        ],
        truncated: false,
        followUps: 0,
      },
    },
  ],
  malformedThreads: [{ name: 'a failed read printed as text', stdout: 'glab: 404 Not found (HTTP 404)' }],
};

runConformance({ adapter: githubAdapter, manifest: githubManifest, repo: ghRepo, classify: classifyCall, recorded: githubRecorded });
runConformance({ adapter: gitlabAdapter, manifest: gitlabManifest, repo: glRepo, classify: classifyCall, recorded: gitlabRecorded });

test('the reviews rules are part of the suite, and a rule can fail', () => {
  const report = checkConformance({ adapter: githubAdapter, manifest: githubManifest, repo: ghRepo, classify: classifyCall });
  assert.ok(Object.keys(report).some((rule) => rule.startsWith('reviews:')));
  // An adapter that replaces the whole reviewer list is caught
  const replacing = {
    ...gitlabAdapter,
    requestReviewers: (repo: HostRepo, number: number, req: { add: string[] }) =>
      req.add.map((name) => ({ ...gitlabAdapter.reviewers(repo, number), kind: 'write' as const, args: ['mr', 'update', String(number), '-R', `https://${repo.host}/${repo.path}`, '--reviewer', name] })),
  };
  const bad = checkConformance({ adapter: replacing, manifest: gitlabManifest, repo: glRepo, classify: classifyCall });
  assert.ok((bad['reviews: the reviewer list is never replaced'] ?? []).length > 0);
});

// ---------- GitHub ----------

test('github reviews: the threads read pages on $endCursor, with the headers of every page', () => {
  const call = githubAdapter.threads(ghRepo, 31);
  assert.equal(call.kind, 'read');
  assert.equal(classifyCall(call), 'read');
  assert.deepEqual(call.args.slice(0, 7), ['api', '-i', '--hostname', 'github.com', 'graphql', '--paginate', '-f']);
  assert.deepEqual(call.args.slice(-6), ['-f', 'repo=agentry-probe', '-F', 'number=31', '-F', 'first=100']);
  // gh printed one status block and one document per page (d1_threads_i_first2): both pages are read
  const read = githubAdapter.parseThreads(result(gh('d1_threads_i_first2')), { headSha: null });
  assert.equal(read.threads.length, 4);
  assert.equal(read.headSha, GH_HEAD);
});

test('github reviews: a suggestion is read from the body, and a reply is its own comment of the thread', () => {
  const read = githubAdapter.parseThreads(result(gh('d1_threads')), { headSha: null });
  const thread = read.threads.find((t) => t.id === 'PRRT_kwDOU1zIIM6n-Zj8');
  assert.deepEqual(thread?.comments[0]?.suggestion, { fromLine: 3, toLine: 3, fromContent: null, toContent: 'line THREE of the r0 probe\n' });
  assert.equal(thread?.diffHunk?.startsWith('@@ -0,0 +1,10 @@'), true);
  assert.match(thread?.comments[0]?.id ?? '', /^\d+$/);
  const range = read.threads.find((t) => t.id === 'PRRT_kwDOU1zIIM6n-Zjx');
  assert.deepEqual([range?.startLine, range?.line, range?.side], [4, 5, 'right']);
});

test('github reviews: a thread past 100 comments is read on from the cursor the first read ended at', () => {
  const read = githubAdapter.parseThreads(result(gh('d1_threads_big')), { headSha: null });
  const [follow] = read.followUps;
  assert.equal(follow?.threadId, 'PRRT_kwDOU1zIIM6n-Zov');
  assert.equal(follow?.after, 'Y3Vyc29yOnYyOpK0MjAyNi0xMC0wMVQxNDowNzozMlrO97xvxQ==');
  const big = read.threads.find((t) => t.id === 'PRRT_kwDOU1zIIM6n-Zov');
  assert.equal(big?.comments.length, 100);
  assert.equal(big?.commentsTruncated, true);
  assert.ok(follow);
  const call = githubAdapter.threadComments(ghRepo, follow);
  assert.equal(classifyCall(call as HostCall), 'read');
  assert.equal(call?.args.includes('--paginate'), false);
  assert.ok(call?.args.includes(`endCursor=${follow.after}`));
  // d1_followup_after: only the 101st comment is left, and there is no next page
  const rest = githubAdapter.parseThreadComments(result(gh('d1_followup_after')));
  assert.equal(rest.comments.length, 1);
  assert.equal(rest.after, null);
  assert.equal(rest.comments[0]?.body, 'probe r0: reply 101');
});

test('github reviews: the threads list stops at its ceiling and says so', () => {
  const node = (n: number) => ({
    id: `PRRT_${String(n).padStart(8, '0')}`, isResolved: false, isOutdated: false, path: 'a.ts', line: 1, startLine: 1, originalLine: 1, diffSide: 'RIGHT',
    viewerCanResolve: true, viewerCanReply: true, comments: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'PRRC_x1', databaseId: n, body: 'x', author: { login: 'a' }, createdAt: 'c', diffHunk: '@@' }] },
  });
  const page = (from: number, count: number) =>
    JSON.stringify({ data: { repository: { pullRequest: { headRefOid: 'abc', reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: Array.from({ length: count }, (_, i) => node(from + i)) } } } } });
  const read = githubAdapter.parseThreads(result(`${page(0, MAX_THREADS)}\n${page(MAX_THREADS, 5)}`), { headSha: null });
  assert.equal(read.threads.length, MAX_THREADS);
  assert.equal(read.truncated, true);
});

test('github reviews: an outdated thread has no line, only where it was left', () => {
  const doc = JSON.stringify({
    data: { repository: { pullRequest: { headRefOid: 'abc', reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
      id: 'PRRT_old00001', isResolved: true, isOutdated: true, path: 'a.ts', line: null, startLine: null, originalLine: 9, diffSide: 'RIGHT',
      resolvedBy: { login: 'mona' }, viewerCanResolve: true, viewerCanReply: true,
      comments: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'PRRC_x1', databaseId: 7, body: 'gone', author: null, createdAt: 'c', diffHunk: '@@ -1 +1 @@' }] },
    }] } } } },
  });
  const [thread] = githubAdapter.parseThreads(result(doc), { headSha: null }).threads;
  assert.deepEqual([thread?.line, thread?.startLine, thread?.originalLine, thread?.isOutdated, thread?.isResolved, thread?.resolvedBy], [null, null, 9, true, true, 'mona']);
  assert.equal(thread?.comments[0]?.author, null);
});

test('github reviews: a comment review is one request with the head, an event and every note', () => {
  const plan = githubAdapter.submit(ghRepo, 31, {
    headSha: GH_HEAD,
    body: 'a review [agentry-review:abc]',
    notes: [
      { path: 'probe-r0.txt', side: 'right', line: 2, suggestion: false, body: 'one' },
      { path: 'probe-r0.txt', side: 'right', line: 5, startLine: 4, suggestion: false, body: 'two' },
      { path: 'probe-r0.txt', side: 'right', line: 3, suggestion: true, body: 'line THREE of the r0 probe' },
    ],
  });
  assert.equal(plan.publish, null);
  assert.equal(plan.calls.length, 1);
  const [call] = plan.calls;
  assert.equal(argv(call), 'api --hostname github.com -X POST repos/yeyo11/agentry-probe/pulls/31/reviews --input -');
  assert.equal(classifyCall(call as HostCall), 'write');
  assert.deepEqual(JSON.parse(call?.input ?? ''), {
    commit_id: GH_HEAD,
    event: 'COMMENT',
    body: 'a review [agentry-review:abc]',
    comments: [
      { path: 'probe-r0.txt', line: 2, side: 'RIGHT', body: 'one' },
      { path: 'probe-r0.txt', start_line: 4, start_side: 'RIGHT', line: 5, side: 'RIGHT', body: 'two' },
      { path: 'probe-r0.txt', line: 3, side: 'RIGHT', body: '```suggestion\nline THREE of the r0 probe\n```' },
    ],
  });
  assert.deepEqual(githubAdapter.parseSubmitted(result(gh('d8_review_comment'))), { remoteId: '5380332359' });
  assert.throws(() => githubAdapter.submit(ghRepo, 31, { headSha: GH_HEAD, body: 'x', notes: [] }, 'approve'), HostActionNotOffered);
});

test('github reviews: the refusals of the recordings have their reasons', () => {
  assert.equal(githubAdapter.reasonOf('submit', result(gh('d8_review_badline'), 1)), 'line-not-in-diff');
  assert.equal(githubAdapter.reasonOf('reviewers', result(gh('d11_request_self'), 1)), 'own-change-request');
  assert.equal(githubAdapter.reasonOf('resolve', result(gh('d5_resolve_badid'), 1)), 'not-found');
  assert.equal(githubAdapter.reasonOf('resolve', result(gh('d5_resolve'))), null);
  assert.equal(githubAdapter.reasonOf('submit', result('not json', 1)), null);
});

test('github reviews: reply, resolve and unresolve are the recorded calls', () => {
  const thread = { id: 'PRRT_kwDOU1zIIM6n-Zjq', comments: [{ id: '4156242983' }] } as unknown as Parameters<typeof githubAdapter.reply>[2];
  const reply = githubAdapter.reply(ghRepo, 31, thread, 'thanks');
  assert.equal(argv(reply), 'api --hostname github.com -X POST repos/yeyo11/agentry-probe/pulls/31/comments/4156242983/replies --input -');
  assert.equal(reply.input, '{"body":"thanks"}');
  const resolve = githubAdapter.resolve(ghRepo, 31, thread.id, true);
  assert.equal(classifyCall(resolve), 'write');
  assert.ok(resolve.args.includes('query=mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }'));
  assert.ok(resolve.args.includes('id=PRRT_kwDOU1zIIM6n-Zjq'));
  assert.ok(githubAdapter.resolve(ghRepo, 31, thread.id, false).args.some((word) => word.includes('unresolveReviewThread')));
});

test('github reviews: pending reviews are paged and only PENDING ones are pending', () => {
  const call = githubAdapter.pendingReviews(ghRepo, 31);
  assert.equal(argv(call), 'api --hostname github.com --paginate --slurp repos/yeyo11/agentry-probe/pulls/31/reviews?per_page=100');
  const page = gh('d12_reviews_list');
  const entries = githubAdapter.parsePendingReviews(result(`[${page}]`));
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => !e.pending));
  assert.equal(entries[0]?.author, 'yeyo11');
  assert.equal(entries[0]?.body.includes('[agentry-review:r0probe]'), true);
  const pending = githubAdapter.parsePendingReviews(result('[[{"id":9,"state":"PENDING","body":"","user":{"login":"me"}}]]'));
  assert.deepEqual(pending, [{ id: '9', pending: true, body: '', author: 'me' }]);
});

test('github reviews: reviewers come from the re-read, an unknown login adds nobody, and Agentry never approves', () => {
  const read = githubAdapter.reviewers(ghRepo, 31);
  assert.equal(argv(read), 'pr view 31 -R github.com/yeyo11/agentry-probe --json reviewRequests,reviewDecision,reviews');
  const parsed = githubAdapter.parseReviewers(result(gh('d11_reread')), 2);
  assert.deepEqual(parsed, { decision: null, reviewers: [{ login: 'yeyo11', state: 'commented' }], unresolvedThreads: 2 });
  const asked = githubAdapter.parseReviewers(
    result('{"reviewDecision":"CHANGES_REQUESTED","reviewRequests":[{"__typename":"User","login":"mona"}],"reviews":[{"author":{"login":"mona"},"state":"APPROVED"},{"author":{"login":"hubot"},"state":"CHANGES_REQUESTED"}]}'),
    0,
  );
  assert.deepEqual(asked.reviewers, [{ login: 'mona', state: 'requested' }, { login: 'hubot', state: 'changes-requested' }]);
  assert.equal(asked.decision, 'changes-requested');
  const [request] = githubAdapter.requestReviewers(ghRepo, 31, { add: ['mona'] });
  assert.equal(argv(request), 'api --hostname github.com -X POST repos/yeyo11/agentry-probe/pulls/31/requested_reviewers --input -');
  assert.equal(request?.input, '{"reviewers":["mona"]}');
  assert.equal(githubAdapter.approve(ghRepo, 31, GH_HEAD), null);
  assert.equal(githubAdapter.revoke(ghRepo, 31), null);
  assert.equal(githubAdapter.approvals(ghRepo, 31), null);
});

// ---------- GitLab ----------

test('gitlab reviews: discussions become threads, drafts published become threads, events are skipped', () => {
  const read = gitlabAdapter.parseThreads(result(gl('d1_discussions_after_publish')), { headSha: GL_HEAD });
  assert.equal(read.threads.length, 7);
  const suggestion = read.threads.find((t) => t.line === 3);
  assert.deepEqual(suggestion?.comments[0]?.suggestion, {
    fromLine: 3, toLine: 3, fromContent: 'line three of the r0 probe\n', toContent: 'line THREE of the r0 probe\n', appliable: true, applied: false,
  });
  // A line note without a suggestion has `[]`, a note off the diff has `null`: neither is one
  assert.equal(read.threads[0]?.comments[0]?.suggestion, null);
  assert.equal(read.threads[3]?.comments[0]?.suggestion, null);
  assert.equal(read.threads[0]?.comments.length, 1);
  assert.equal(read.threads[3]?.viewerCanResolve, true);
  assert.equal(read.threads[3]?.side, null);
});

test('gitlab reviews: a position left on another commit is outdated, with its line kept as where it was', () => {
  const read = gitlabAdapter.parseThreads(result(gl('d1_discussions_after_publish')), { headSha: 'f'.repeat(40) });
  const line2 = read.threads[0];
  assert.deepEqual([line2?.isOutdated, line2?.line, line2?.startLine, line2?.originalLine], [true, null, null, 2]);
  // a discussion without a position is never outdated
  assert.equal(read.threads[3]?.isOutdated, false);
});

test('gitlab reviews: a discussion of 102 notes is read whole, and nothing follows it', () => {
  const read = gitlabAdapter.parseThreads(result(gl('big_discussions_paginate')), { headSha: GL_HEAD });
  assert.equal(read.threads.at(-1)?.comments.length, 102);
  assert.equal(read.threads.at(-1)?.commentsTruncated, false);
  assert.deepEqual(read.followUps, []);
  assert.equal(gitlabAdapter.threadComments(glRepo, { threadId: 'x', after: 'y' }), null);
  assert.equal(argv(gitlabAdapter.threads(glRepo, 13)), 'api --hostname gitlab.com --paginate --output ndjson projects/87089091/merge_requests/13/discussions?per_page=100');
});

test('gitlab reviews: a resolved discussion says who resolved it', () => {
  const doc = JSON.stringify({
    id: 'a'.repeat(40), individual_note: false, resolvable: true, resolved: true,
    notes: [{ id: 5, type: 'DiffNote', body: 'b', author: { username: 'mona' }, system: false, created_at: 't', resolvable: true, resolved: true, resolved_by: { username: 'hubot' }, suggestions: [], position: { head_sha: GL_HEAD, new_path: 'a', old_path: 'a', new_line: 4, old_line: null, line_range: { start: { new_line: 3, old_line: null }, end: { new_line: 4, old_line: null } } } }],
  });
  const [thread] = gitlabAdapter.parseThreads(result(doc), { headSha: GL_HEAD }).threads;
  assert.deepEqual([thread?.isResolved, thread?.resolvedBy, thread?.startLine, thread?.line], [true, 'hubot', 3, 4]);
});

test('gitlab reviews: a review is a draft per note with the content type, then one publish', () => {
  const refs = { baseSha: '1af4427008da39d223f59e4ce18dc137940b966c', startSha: '1af4427008da39d223f59e4ce18dc137940b966c', headSha: GL_HEAD };
  const plan = gitlabAdapter.submit(glRepo, 13, {
    headSha: GL_HEAD,
    body: 'a review [agentry-review:abc]',
    diffRefs: refs,
    notes: [
      { path: 'probe-r0.txt', side: 'right', line: 7, suggestion: false, body: 'seven' },
      { path: 'probe-r0.txt', side: 'right', line: 5, startLine: 4, suggestion: true, body: 'a\nb' },
    ],
  });
  assert.equal(plan.calls.length, 3);
  for (const call of plan.calls) {
    assert.equal(argv(call), 'api --hostname gitlab.com -X POST projects/87089091/merge_requests/13/draft_notes -H Content-Type: application/json --input -');
    assert.equal(classifyCall(call), 'write');
  }
  assert.deepEqual(JSON.parse(plan.calls[0]?.input ?? ''), { note: 'a review [agentry-review:abc]' });
  assert.deepEqual(JSON.parse(plan.calls[1]?.input ?? ''), {
    note: 'seven',
    position: { position_type: 'text', base_sha: refs.baseSha, start_sha: refs.startSha, head_sha: GL_HEAD, old_path: 'probe-r0.txt', new_path: 'probe-r0.txt', new_line: 7 },
  });
  // the block replaces line 4 and line 5: one line above the note's own
  assert.equal((JSON.parse(plan.calls[2]?.input ?? '') as { note: string }).note, '```suggestion:-1+0\na\nb\n```');
  assert.equal(argv(plan.publish), 'mr note publish 13 -y -R https://gitlab.com/yeyo11/agentry');
  assert.equal(classifyCall(plan.publish as HostCall), 'write');
  assert.throws(() => gitlabAdapter.submit(glRepo, 13, { headSha: GL_HEAD, body: 'x', notes: [{ path: 'a', side: 'right', line: 1, suggestion: false, body: 'n' }] }), HostParseError);
  assert.throws(() => gitlabAdapter.submit(glRepo, 13, { headSha: GL_HEAD, body: 'x', notes: [], diffRefs: refs }, 'approve'), HostActionNotOffered);
});

test('gitlab reviews: a draft on a line outside the diff is not placed, and the host does not say so itself', () => {
  assert.deepEqual(gitlabAdapter.parseDraftNote(result(gl('d8_draft_line'))), { id: '83394151', placed: true });
  assert.equal(gitlabAdapter.parseDraftNote(result(gl('d8_draft_general')))?.placed, true);
  // exit 0, `line_code: null`, `position.new_line: 99` (d8_draft_badline)
  assert.equal(gitlabAdapter.parseDraftNote(result(gl('d8_draft_badline')))?.placed, false);
  assert.throws(() => gitlabAdapter.parseDraftNote(result(gl('d8_draft_noct'), 1)), HostParseError);
});

test('gitlab reviews: leftovers are the draft notes, and discarding is a delete of one of them', () => {
  assert.equal(argv(gitlabAdapter.pendingReviews(glRepo, 13)), 'api --hostname gitlab.com projects/87089091/merge_requests/13/draft_notes');
  const entries = gitlabAdapter.parsePendingReviews(result(gl('d12_draft_list')));
  assert.ok(entries.length >= 4);
  assert.ok(entries.every((e) => e.pending));
  assert.equal(entries[0]?.id, '83394160');
  assert.equal(entries[0]?.body, 'probe r0: D8 draft bad line');
  assert.deepEqual(gitlabAdapter.parsePendingReviews(result('[]')), []);
  const discard = gitlabAdapter.discardDraft(glRepo, 13, '83394157');
  assert.equal(argv(discard), 'api --hostname gitlab.com -X DELETE projects/87089091/merge_requests/13/draft_notes/83394157');
  assert.equal(classifyCall(discard as HostCall), 'write');
  assert.equal(argv(gitlabAdapter.publishSaved(glRepo, 13)), 'mr note publish 13 -y -R https://gitlab.com/yeyo11/agentry');
});

test('gitlab reviews: reply, resolve and reopen are the recorded calls', () => {
  const thread = { id: 'fa6571a09985f36099fe7832fd2e8937f6f1de90', comments: [] };
  const reply = gitlabAdapter.reply(glRepo, 13, thread, 'thanks');
  assert.equal(argv(reply), `api --hostname gitlab.com -X POST projects/87089091/merge_requests/13/discussions/${thread.id}/notes -H Content-Type: application/json --input -`);
  assert.equal(reply.input, '{"body":"thanks"}');
  // the order is iid then id (the usage line of glab's help is wrong, recorded)
  assert.equal(argv(gitlabAdapter.resolve(glRepo, 13, thread.id, true)), `mr note resolve 13 ${thread.id} -R https://gitlab.com/yeyo11/agentry`);
  assert.equal(argv(gitlabAdapter.resolve(glRepo, 13, thread.id, false)), `mr note reopen 13 ${thread.id} -R https://gitlab.com/yeyo11/agentry`);
  assert.equal(gitlabAdapter.reasonOf('draft', result(gl('d3_discussion_badline'), 1)), 'line-not-in-diff');
  assert.equal(gitlabAdapter.reasonOf('reply', result(gl('d4_reply_baddisc'), 1)), null);
});

test('gitlab reviews: approvals are read from the endpoint, and canApprove is not the host’s user_can_approve', () => {
  assert.equal(argv(gitlabAdapter.approve(glRepo, 13, GL_HEAD)), `mr approve 13 --sha ${GL_HEAD} -R https://gitlab.com/yeyo11/agentry`);
  assert.equal(argv(gitlabAdapter.revoke(glRepo, 13)), 'mr revoke 13 -R https://gitlab.com/yeyo11/agentry');
  assert.equal(argv(gitlabAdapter.approvals(glRepo, 13)), 'api --hostname gitlab.com projects/87089091/merge_requests/13/approvals');
  const before = gitlabAdapter.parseApprovals(result(gl('d9_approvals_before')), GL_HEAD);
  // the host says user_can_approve false for the author, whose approval succeeds: Agentry offers it
  assert.deepEqual(before, { approved: true, approvalsRequired: 0, approvalsLeft: 0, viewerHasApproved: false, canApprove: true, canRevoke: false, approvedBy: [], headSha: GL_HEAD });
  const after = gitlabAdapter.parseApprovals(result(gl('d9_approvals_after_approve')), GL_HEAD);
  assert.deepEqual([after.viewerHasApproved, after.canApprove, after.canRevoke, after.approvedBy], [true, false, true, ['yeyo11']]);
  assert.throws(() => gitlabAdapter.parseApprovals(result('{}'), null), HostParseError);
  assert.throws(() => gitlabAdapter.approve(glRepo, 13, '--help'), HostParseError);
});

test('gitlab reviews: reviewers are added and removed by name, never replaced', () => {
  const calls = gitlabAdapter.requestReviewers(glRepo, 13, { add: ['yeyo11', 'mona'], remove: ['hubot'] });
  assert.deepEqual(calls.map(argv), [
    'mr update 13 --reviewer=+yeyo11 -R https://gitlab.com/yeyo11/agentry',
    'mr update 13 --reviewer=+mona -R https://gitlab.com/yeyo11/agentry',
    'mr update 13 --reviewer=-hubot -R https://gitlab.com/yeyo11/agentry',
  ]);
  assert.ok(calls.every((call) => classifyCall(call) === 'write'));
  const parsed = gitlabAdapter.parseReviewers(result(gl('d11_reviewers_endpoint')), 1);
  assert.deepEqual(parsed, { decision: null, reviewers: [{ login: 'yeyo11', state: 'requested' }], unresolvedThreads: 1 });
  const blocked = gitlabAdapter.parseReviewers(result('[{"user":{"username":"mona"},"state":"requested_changes"},{"user":{"username":"x"},"state":"approved"}]'), 0);
  assert.equal(blocked.decision, 'changes-requested');
  assert.deepEqual(blocked.reviewers.map((r) => r.state), ['changes-requested', 'approved']);
});

// ---------- suggestions ----------

test('suggestion fences: a longer fence when the replacement holds backticks, and the block reads back', () => {
  assert.equal(suggestionFence('x', ''), '```suggestion\nx\n```');
  assert.equal(suggestionFence('x\n', ':-1+0'), '```suggestion:-1+0\nx\n```');
  const fenced = suggestionFence('a\n```\nb', '');
  assert.equal(fenced.startsWith('````suggestion\n'), true);
  assert.equal(suggestionOf(`note\n\n${fenced}\nafter`, 3, 4)?.toContent, 'a\n```\nb\n');
  assert.equal(suggestionOf('no block here', 3, 4), null);
  assert.equal(suggestionOf('```suggestion\nx\n```', null, null), null);
});
