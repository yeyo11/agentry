import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Db } from '../src/db.ts';
import type { AgentryEventInput } from '../src/events.ts';
import { HostActionNotOffered, type HostCall, type HostRepo } from '../src/hosts/code-host.ts';
import type { HostResult } from '../src/hosts/exec.ts';
import { githubAdapter } from '../src/hosts/github/adapter.ts';
import { gitlabAdapter } from '../src/hosts/gitlab/adapter.ts';
import type { ReviewDraft } from '@agentry/shared';
import { diffLines, ReviewInputError, ReviewsError, ReviewsService, THREADS_TTL, wentOut, type ReviewsTarget } from '../src/hosts/reviews-service.ts';
import { tempConfig } from './helpers.ts';

// The service against the replay of what r0 recorded: calls are answered by the end of their argv,
// anything else is exit 97 and fails the test, so a changed argv shows up as a failure.

const here = dirname(fileURLToPath(import.meta.url));
const gl = (file: string): string => readFileSync(join(here, 'fixtures/recordings/glab/1.120.0', `${file}.out`), 'utf8');
const gh = (file: string): string => readFileSync(join(here, 'fixtures/recordings/gh/2.102.0', `${file}.out`), 'utf8');
const GOLDEN = join(here, 'fixtures/golden/phase3');

const glRepo: HostRepo = { host: 'gitlab.com', path: 'yeyo11/agentry', owner: 'yeyo11', name: 'agentry', projectId: 87089091 };
const ghRepo: HostRepo = { host: 'github.com', path: 'yeyo11/agentry-probe', owner: 'yeyo11', name: 'agentry-probe' };

const GL_HEAD = '6e0dab83d5074227e4d2827ebb745edf1aa2c943';
const GH_HEAD = '1edb6cba70c6420d6e75a44963ca93fed97ec760';
const UUID = '11111111-2222-3333-4444-555555555555';
const MARKER = `<!-- agentry:${UUID} -->`;

const ok = (stdout: string): HostResult => ({ exitCode: 0, stdout, stderrFirstLine: '', http: null, truncated: false, durationMs: 1 });
const failed = (exitCode: number, stderr = 'boom', extra: Partial<HostResult> = {}): HostResult => ({ exitCode, stdout: '', stderrFirstLine: stderr, http: null, truncated: false, durationMs: 1, ...extra });

const roots: string[] = [];
function database(): Db {
  const config = tempConfig();
  roots.push(dirname(config.dataDir));
  return new Db(config);
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Answer = HostResult | (() => HostResult);

interface Harness {
  service: ReviewsService;
  /** Every call: argv, and the body of a write */
  calls: string[];
  events: AgentryEventInput[];
  clock: { now: number };
  /** The most recent rule whose pattern matches the call's line wins */
  answer: (pattern: RegExp, result: Answer) => void;
  /** Answers in order, the last one repeating */
  sequence: (pattern: RegExp, results: HostResult[]) => void;
}

function harness(adapter: ReviewsTarget['adapter'], repo: HostRepo, diff?: string): Harness {
  const db = database();
  const rules: Array<{ pattern: RegExp; result: Answer }> = [];
  const calls: string[] = [];
  const events: AgentryEventInput[] = [];
  const clock = { now: Date.parse('2026-10-01T12:00:00Z') };
  const run = async (call: HostCall): Promise<HostResult> => {
    const line = `${call.cli} ${call.args.join(' ')}`;
    calls.push(call.input ? `${line} <<< ${call.input}` : line);
    const rule = rules.find((r) => r.pattern.test(line));
    if (!rule) return failed(97, `unrecorded call: ${line}`);
    return typeof rule.result === 'function' ? rule.result() : rule.result;
  };
  const target: ReviewsTarget = { id: 'cr-1', kind: 'work-item', adapter, repo, number: 12, run, ...(diff ? { diff: async () => diff } : {}) };
  const service = new ReviewsService({ db: db.connection, resolve: async (id) => (id === 'cr-1' ? target : null), emit: (e) => events.push(e), now: () => clock.now, uuid: () => UUID });
  return {
    service,
    calls,
    events,
    clock,
    answer: (pattern, result) => rules.unshift({ pattern, result }),
    sequence: (pattern, results) => {
      let at = 0;
      rules.unshift({ pattern, result: () => results[Math.min(at++, results.length - 1)] as HostResult });
    },
  };
}

function golden(name: string, calls: string[]): void {
  const file = join(GOLDEN, `${name}.log`);
  const actual = `# ${name}\n${calls.join('\n')}\n`;
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
  }
  assert.equal(actual, readFileSync(file, 'utf8'));
}

const reasonOfError = (error: unknown): string | null => (error instanceof ReviewsError ? error.reason : null);

/** The merge request the checks recording holds: head 6e0dab83, with its diff_refs */
function gitlab(diff?: string): Harness {
  const h = harness(gitlabAdapter, glRepo, diff);
  h.answer(/mr view 12/, ok(gl('mrview_after_post')));
  h.answer(/discussions\?per_page=100$/, ok(gl('d1_discussions_after_publish')));
  h.answer(/draft_notes$/, ok('[]'));
  return h;
}

const ghPull = JSON.stringify({ data: { repository: { pullRequest: { number: 12, url: 'https://github.com/yeyo11/agentry-probe/pull/12', state: 'OPEN', headRefOid: GH_HEAD, baseRefName: 'main', commits: { nodes: [] } } } } });

function github(): Harness {
  const h = harness(githubAdapter, ghRepo);
  h.answer(/statusCheckRollup/, { ...ok(ghPull), http: { status: 200, headers: {} } });
  h.answer(/reviewThreads\(/, ok(gh('d1_threads_big')));
  // The thread of 101 comments: the remainder, from the cursor the first read ended at
  h.answer(/-F endCursor=/, ok(gh('d1_followup_after')));
  h.answer(/pulls\/12\/reviews\?per_page=100$/, ok('[]'));
  return h;
}

// ---------- the diff ----------

test('the diff gives the new-side lines, the old line of a context line, and a rename', () => {
  const files = diffLines(
    ['diff --git a/old.txt b/new.txt', 'similarity index 90%', 'rename from old.txt', 'rename to new.txt', '--- a/old.txt', '+++ b/new.txt', '@@ -3,3 +3,4 @@', ' keep', '-gone', '+added', '+added too', ' tail'].join('\n'),
  );
  const file = files.get('new.txt');
  assert.equal(file?.oldPath, 'old.txt');
  assert.equal(file?.right.get(3), 3);
  assert.equal(file?.right.get(4), null);
  assert.equal(file?.right.get(6), 5);
  assert.deepEqual([...(file?.left ?? [])], [3, 4, 5]);
});

// ---------- threads ----------

test('GitLab threads read the head first, then the discussions, and the golden log holds the argv', async () => {
  const h = gitlab();
  const list = await h.service.threads('cr-1');
  assert.equal(list.headSha, GL_HEAD);
  assert.ok(list.threads.length >= 5);
  assert.equal(list.truncated, false);
  golden('reviews-gitlab-threads', h.calls);
});

test('a merge request nobody commented on has no threads', async () => {
  const h = gitlab();
  h.answer(/discussions\?per_page=100$/, ok(''));
  assert.deepEqual((await h.service.threads('cr-1')).threads, []);
});

test('GitHub threads: one read, the long thread gets its follow-up, and the cache serves 30 s', async () => {
  const h = github();
  const list = await h.service.threads('cr-1');
  assert.equal(list.headSha, GH_HEAD);
  const long = list.threads.find((t) => t.comments.length > 100);
  assert.ok(long, 'the 101-comment thread was completed');
  assert.equal(long.commentsTruncated, false);
  const used = h.calls.length;
  await h.service.threads('cr-1');
  assert.equal(h.calls.length, used);
  h.clock.now += THREADS_TTL + 1;
  await h.service.threads('cr-1');
  assert.ok(h.calls.length > used);
  golden('reviews-github-threads', h.calls.slice(0, used));
});

test('a rate-limited read serves the last list', async () => {
  const h = gitlab();
  const first = await h.service.threads('cr-1');
  h.answer(/discussions\?per_page=100$/, failed(1, 'HTTP 429', { http: { status: 429, headers: {} } }));
  const again = await h.service.threads('cr-1', { refresh: true });
  assert.deepEqual(again, first);
});

test('a change request that is not there is not-found', async () => {
  const h = gitlab();
  await assert.rejects(h.service.threads('nope'), (e) => reasonOfError(e) === 'not-found');
});

// ---------- drafts ----------

test('drafts are rows: added, edited, listed in order and deleted', async () => {
  const h = gitlab();
  const a = await h.service.addDraft('cr-1', { path: 'a.ts', line: 3, body: 'one' });
  const general = await h.service.addDraft('cr-1', { body: 'overall' });
  const range = await h.service.addDraft('cr-1', { path: 'a.ts', line: 9, startLine: 7, body: 'two', suggestion: true });
  assert.deepEqual(h.service.listDrafts('cr-1').map((d) => d.id), [a.id, general.id, range.id]);
  assert.equal(a.side, 'right');
  assert.equal(general.path, null);
  assert.equal(range.startLine, 7);
  const edited = await h.service.updateDraft('cr-1', a.id, { path: 'a.ts', line: 4, body: 'one, better' });
  assert.equal(edited.line, 4);
  assert.equal(h.service.listDrafts('cr-1')[0]?.body, 'one, better');
  h.service.deleteDraft('cr-1', general.id);
  assert.equal(h.service.listDrafts('cr-1').length, 2);
  assert.throws(() => h.service.deleteDraft('cr-1', general.id), (e) => reasonOfError(e) === 'not-found');
});

test('a draft with no text, a range backwards, or a suggestion off a line is refused', async () => {
  const h = gitlab();
  await assert.rejects(h.service.addDraft('cr-1', { body: '  ' }), ReviewInputError);
  await assert.rejects(h.service.addDraft('cr-1', { path: 'a', line: 3, startLine: 5, body: 'x' }), ReviewInputError);
  await assert.rejects(h.service.addDraft('cr-1', { path: 'a', body: 'x' }), ReviewInputError);
  await assert.rejects(h.service.addDraft('cr-1', { body: 'x', suggestion: true }), ReviewInputError);
  await assert.rejects(h.service.addDraft('cr-1', { path: 'a', line: 2, side: 'left', body: 'x', suggestion: true }), ReviewInputError);
});

// ---------- submitting a review: GitLab ----------

async function twoDrafts(h: Harness): Promise<void> {
  await h.service.addDraft('cr-1', { path: 'probe-r0.txt', line: 7, body: 'a line note' });
  await h.service.addDraft('cr-1', { body: 'a general note' });
}

test('GitLab: the review body first, a draft per note, then publish; drafts are done with and the golden log holds the bodies', async () => {
  const h = gitlab();
  h.sequence(/draft_notes -H/, [ok(gl('d8_draft_general')), ok(gl('d8_draft_line'))]);
  h.answer(/mr note publish 12/, ok('Published 2'));
  // The first discussions read is the "before" one, the second is after the publish
  h.sequence(/discussions\?per_page=100$/, [ok(''), ok(gl('d1_discussions_after_publish'))]);
  await twoDrafts(h);
  const post = await h.service.submit('cr-1', { event: 'comment', body: 'looks fine' });
  assert.equal(post.state, 'posted');
  assert.equal(post.marker, MARKER);
  assert.equal(h.service.listDrafts('cr-1').length, 0);
  const writes = h.calls.filter((c) => c.includes('<<<'));
  assert.equal(writes.length, 2);
  assert.ok(writes[0]?.includes('looks fine') && writes[0].includes('a general note') && writes[0].includes(MARKER), 'the body carries the text, the general note and the marker');
  assert.ok(writes[1]?.includes('"new_path":"probe-r0.txt"') && writes[1].includes('"head_sha":"6e0dab83d5074227e4d2827ebb745edf1aa2c943"'));
  assert.ok(h.events.some((e) => e.type === 'change-request.review'));
  golden('reviews-gitlab-submit', h.calls);
});

test('GitLab: a note on a line outside the diff is taken back before anything is published', async () => {
  const h = gitlab();
  h.sequence(/draft_notes -H/, [ok(gl('d8_draft_general')), ok(gl('d8_draft_badline'))]);
  h.answer(/DELETE|draft_notes\/\d+/, ok(''));
  await twoDrafts(h);
  await assert.rejects(h.service.submit('cr-1', { event: 'comment', body: '' }), (e) => reasonOfError(e) === 'line-not-in-diff' && e instanceof ReviewsError && e.detail === 'probe-r0.txt:7');
  assert.ok(!h.calls.some((c) => c.includes('note publish')), 'nothing was published');
  assert.equal(h.calls.filter((c) => c.includes('-X DELETE')).length, 2, 'both saved drafts were deleted');
  assert.equal(h.service.listDrafts('cr-1').length, 2, 'the person keeps the notes');
  assert.equal(h.service.posts('cr-1')[0]?.state, 'failed');
});

test('GitLab: a note that fails after others were saved is partly posted, and the person publishes or discards what was saved', async () => {
  const h = gitlab();
  h.sequence(/draft_notes -H/, [ok(gl('d8_draft_general')), failed(1, 'HTTP 500', { http: { status: 500, headers: {} } })]);
  await twoDrafts(h);
  const error = await h.service.submit('cr-1', { event: 'comment', body: 'x' }).catch((e: unknown) => e);
  assert.ok(error instanceof ReviewsError);
  assert.equal(error.reason, 'review-partly-posted');
  const partly = h.service.posts('cr-1')[0];
  assert.equal(partly?.state, 'partly');
  assert.deepEqual([partly?.detail?.saved, partly?.detail?.total], [1, 2]);
  assert.equal(error.postId, partly?.id);
  assert.equal(h.service.listDrafts('cr-1').length, 2, 'the drafts stay until the saved ones are settled');

  // Discard: every pending draft note is deleted, the person's rows stay for another post
  h.answer(/draft_notes$/, ok(gl('d12_draft_list')));
  h.answer(/-X DELETE/, ok(''));
  const discarded = await h.service.discardSaved('cr-1', partly?.id ?? '');
  assert.equal(discarded.state, 'failed');
  assert.ok(h.calls.some((c) => c.includes('-X DELETE')));
  assert.equal(h.service.listDrafts('cr-1').length, 2);

  // Publish: the saved notes go out and the rows are dropped
  const again = h.service.posts('cr-1')[0];
  assert.equal(again?.state, 'failed');
  await assert.rejects(h.service.publishSaved('cr-1', partly?.id ?? ''), HostActionNotOffered);
});

test('GitLab: publish-saved publishes a partly posted review and drops the drafts', async () => {
  const h = gitlab();
  h.sequence(/draft_notes -H/, [ok(gl('d8_draft_general')), failed(1, 'HTTP 500', { http: { status: 500, headers: {} } })]);
  await twoDrafts(h);
  await h.service.submit('cr-1', { event: 'comment', body: 'x' }).catch(() => undefined);
  const partly = h.service.posts('cr-1')[0];
  // Only the saved general note is on the host: the line note never was, so its row stays to be posted
  const saved = partly?.detail?.draftIds ?? [];
  h.answer(/draft_notes$/, ok(JSON.stringify([{ id: saved[0], note: `x\n\na general note\n\n${MARKER}` }])));
  h.answer(/mr note publish 12/, ok('Published 1'));
  const post = await h.service.publishSaved('cr-1', partly?.id ?? '');
  assert.equal(post.state, 'posted');
  assert.deepEqual(h.service.listDrafts('cr-1').map((d) => d.body), ['a line note']);
});

test('GitLab: publish-saved is refused while a draft note Agentry did not save is waiting, since glab publishes them all', async () => {
  const h = gitlab();
  h.sequence(/draft_notes -H/, [ok(gl('d8_draft_general')), failed(1, 'HTTP 500', { http: { status: 500, headers: {} } })]);
  await twoDrafts(h);
  await h.service.submit('cr-1', { event: 'comment', body: 'x' }).catch(() => undefined);
  const partly = h.service.posts('cr-1')[0];
  const saved = partly?.detail?.draftIds ?? [];
  h.answer(/draft_notes$/, ok(JSON.stringify([{ id: saved[0], note: `x ${MARKER}` }, { id: '999', note: 'a draft of the person' }])));
  await assert.rejects(h.service.publishSaved('cr-1', partly?.id ?? ''), (e) => reasonOfError(e) === 'pending-review-exists' && e instanceof ReviewsError && e.detail === '1 draft note of yours on GitLab');
  assert.ok(!h.calls.some((c) => c.includes('note publish')), 'nothing was published');
  assert.equal(h.service.posts('cr-1')[0]?.state, 'partly');
});

test('GitLab: a draft note already waiting stops a post, so it is never published with ours', async () => {
  const h = gitlab();
  h.answer(/draft_notes$/, ok(gl('d12_draft_list')));
  await twoDrafts(h);
  await assert.rejects(h.service.submit('cr-1', { event: 'comment', body: 'x' }), (e) => reasonOfError(e) === 'pending-review-exists');
  assert.ok(!h.calls.some((c) => c.includes('<<<')), 'no write was made');
});

test('GitLab: publish that reports fewer discussions than saved is partly posted', async () => {
  const h = gitlab();
  h.sequence(/draft_notes -H/, [ok(gl('d8_draft_general')), ok(gl('d8_draft_line'))]);
  h.answer(/mr note publish 12/, ok('Published 1'));
  // After the publish, one discussion only: a note was dropped
  // The one that is there carries the general review text (and its marker), so the line note is the one dropped
  const one = (gl('d1_discussions_after_publish').split('\n').filter((l) => l.startsWith('{'))[0] ?? '').replace('probe r0: D3 line discussion on new line 2', `x\\n\\na general note\\n\\n${MARKER}`);
  h.sequence(/discussions\?per_page=100$/, [ok(''), ok(one)]);
  await twoDrafts(h);
  await assert.rejects(h.service.submit('cr-1', { event: 'comment', body: 'x' }), (e) => reasonOfError(e) === 'review-partly-posted');
  assert.equal(h.service.posts('cr-1')[0]?.state, 'partly');
  // What went out has no row any more; what did not stays, so Discard then Submit cannot post a note twice
  const left = h.service.listDrafts('cr-1').map((d) => d.body);
  assert.deepEqual(left, ['a line note']);
});

test('GitLab: wentOut drops only the drafts whose text reached the host', () => {
  const draft = (id: string, body: string, line: number | null): ReviewDraft => ({ id, changeRequestId: 'cr-1', path: line === null ? null : 'a.ts', line, startLine: null, side: null, body, suggestion: false, createdAt: '', updatedAt: '' });
  const drafts = [draft('1', 'on a line', 3), draft('2', 'dropped one', 4), draft('3', 'general', null)];
  assert.deepEqual(wentOut(drafts, ['review text <!-- agentry:m -->', 'on a line'], '<!-- agentry:m -->').map((d) => d.id), ['1', '3']);
  assert.deepEqual(wentOut(drafts, ['unrelated'], '<!-- agentry:m -->'), []);
});

test('GitLab: wentOut counts a note on the host once, and an empty suggestion only by its fence', () => {
  const draft = (id: string, body: string, suggestion = false): ReviewDraft => ({ id, changeRequestId: 'cr-1', path: 'a.ts', line: 3, startLine: null, side: 'right', body, suggestion, createdAt: '', updatedAt: '' });
  // The longer note went out; the short one it contains did not
  assert.deepEqual(wentOut([draft('1', 'typo'), draft('2', 'typo here too')], ['typo here too'], 'm').map((d) => d.id), ['2']);
  // Both went out: two notes on the host
  assert.deepEqual(wentOut([draft('1', 'typo'), draft('2', 'typo here too')], ['typo here too', 'typo'], 'm').map((d) => d.id), ['1', '2']);
  // A suggestion with no text is not "contained" in any note
  assert.deepEqual(wentOut([draft('1', '', true)], ['some other note'], 'm'), []);
  assert.deepEqual(wentOut([draft('1', '', true)], ['```suggestion\nx\n```'], 'm').map((d) => d.id), ['1']);
});

test('GitLab: a write that times out with no marker on the host is unconfirmed, and one that landed is posted', async () => {
  const h = gitlab();
  h.answer(/draft_notes -H/, failed(0, 'timeout', { exitCode: null, reason: 'timeout' }));
  await h.service.addDraft('cr-1', { body: 'general only' });
  await assert.rejects(h.service.submit('cr-1', { event: 'comment', body: 'x' }), (e) => reasonOfError(e) === 'write-unconfirmed');
  assert.equal(h.service.posts('cr-1')[0]?.detail?.code, 'write-unconfirmed');
});

test('an empty review is refused, and request changes is not offered', async () => {
  const h = gitlab();
  await assert.rejects(h.service.submit('cr-1', { event: 'comment', body: '  ' }), ReviewInputError);
  await assert.rejects(h.service.submit('cr-1', { event: 'request-changes', body: 'x' }), HostActionNotOffered);
  assert.equal(h.service.posts('cr-1').length, 0);
});

// ---------- submitting a review: GitHub ----------

test('GitHub: one request with the commit, the notes and the marker; the review id is kept', async () => {
  const h = github();
  h.answer(/pulls\/12\/reviews --input -$/, ok(gh('d8_review_comment')));
  await h.service.addDraft('cr-1', { path: 'probe-r0.txt', line: 2, body: 'a line note' });
  await h.service.addDraft('cr-1', { body: 'general' });
  const post = await h.service.submit('cr-1', { event: 'comment', body: 'hello' });
  assert.equal(post.state, 'posted');
  assert.equal(post.remoteId, '5380332359');
  const write = h.calls.find((c) => c.includes('<<<')) ?? '';
  const sent = JSON.parse(write.slice(write.indexOf('<<<') + 4)) as { commit_id: string; event: string; body: string; comments: unknown[] };
  assert.equal(sent.commit_id, GH_HEAD);
  assert.equal(sent.event, 'COMMENT');
  assert.ok(sent.body.includes('hello') && sent.body.includes('general') && sent.body.endsWith(MARKER));
  assert.equal(sent.comments.length, 1);
  golden('reviews-github-submit', h.calls);
});

test('GitHub: a line the host cannot resolve is line-not-in-diff, read from stdout, and the post is failed', async () => {
  const h = github();
  h.answer(/pulls\/12\/reviews --input -$/, { ...ok(gh('d8_review_badline')), exitCode: 1 });
  await h.service.addDraft('cr-1', { path: 'probe-r0.txt', line: 99, body: 'x' });
  await assert.rejects(h.service.submit('cr-1', { event: 'comment', body: '' }), (e) => reasonOfError(e) === 'line-not-in-diff');
  assert.equal(h.service.posts('cr-1')[0]?.state, 'failed');
  assert.equal(h.service.listDrafts('cr-1').length, 1);
});

test('GitHub: a timeout is settled by looking for the marker in the reviews', async () => {
  const h = github();
  h.answer(/pulls\/12\/reviews --input -$/, failed(0, 'timeout', { exitCode: null, reason: 'timeout' }));
  // The review landed: its body holds the marker
  h.sequence(/pulls\/12\/reviews\?per_page=100$/, [ok('[]'), ok(JSON.stringify([{ id: 77, state: 'COMMENTED', body: `hello\n\n${MARKER}`, user: { login: 'me' } }]))]);
  await h.service.addDraft('cr-1', { path: 'probe-r0.txt', line: 2, body: 'x' });
  const post = await h.service.submit('cr-1', { event: 'comment', body: 'hello' });
  assert.equal(post.state, 'posted');
  assert.equal(post.remoteId, '77');

  // And one that did not is unconfirmed, never retried
  const lost = github();
  lost.answer(/pulls\/12\/reviews --input -$/, failed(0, 'timeout', { exitCode: null, reason: 'timeout' }));
  await lost.service.addDraft('cr-1', { path: 'probe-r0.txt', line: 2, body: 'x' });
  await assert.rejects(lost.service.submit('cr-1', { event: 'comment', body: 'hello' }), (e) => reasonOfError(e) === 'write-unconfirmed');
  assert.equal(lost.calls.filter((c) => c.includes('-X POST') && c.includes('/reviews ')).length, 1);
});

test('GitHub: a pending review of the person is in the way and is never deleted', async () => {
  const h = github();
  h.answer(/pulls\/12\/reviews\?per_page=100$/, ok(JSON.stringify([{ id: 5, state: 'PENDING', body: '', user: { login: 'me' } }])));
  await h.service.addDraft('cr-1', { body: 'x' });
  await assert.rejects(h.service.submit('cr-1', { event: 'comment', body: '' }), (e) => reasonOfError(e) === 'pending-review-exists');
});

test('GitHub does not approve or request changes', async () => {
  const h = github();
  await assert.rejects(h.service.submit('cr-1', { event: 'approve', body: 'x' }), HostActionNotOffered);
  await assert.rejects(h.service.approve('cr-1', GH_HEAD), HostActionNotOffered);
  await assert.rejects(h.service.revoke('cr-1'), HostActionNotOffered);
});

// ---------- replies, resolve, unresolve ----------

test('GitHub reply: the root comment id, a marker in the body, and the thread re-read', async () => {
  const h = github();
  h.answer(/comments\/\d+\/replies/, ok(gh('d4_reply_input')));
  const thread = (await h.service.threads('cr-1')).threads[0];
  assert.ok(thread);
  const out = await h.service.reply('cr-1', thread.id, 'thanks');
  assert.equal(out.id, thread.id);
  const write = h.calls.find((c) => c.includes('/replies')) ?? '';
  assert.ok(write.includes(`"body":"thanks\\n\\n${MARKER}"`));
  assert.ok(!out.comments.some((c) => c.body.includes('agentry:')), 'the marker is not shown');
});

test('reply: a timeout that landed is a success, and one that did not is unconfirmed', async () => {
  const h = github();
  const thread = (await h.service.threads('cr-1')).threads[0];
  assert.ok(thread);
  h.answer(/comments\/\d+\/replies/, failed(0, 'timeout', { exitCode: null, reason: 'timeout' }));
  await assert.rejects(h.service.reply('cr-1', thread.id, 'thanks'), (e) => reasonOfError(e) === 'write-unconfirmed');
  h.answer(/comments\/\d+\/replies/, failed(1, 'HTTP 422', { stdout: '{"status":"422"}' }));
  await assert.rejects(h.service.reply('cr-1', thread.id, 'thanks'), (e) => reasonOfError(e) === 'pending-review-exists');
});

test('reply: empty text and an unknown thread are refused', async () => {
  const h = github();
  await assert.rejects(h.service.reply('cr-1', 'PRRT_x', ' '), ReviewInputError);
  await assert.rejects(h.service.reply('cr-1', 'PRRT_nothere', 'hi'), (e) => reasonOfError(e) === 'not-found');
});

test('GitHub resolve: the mutation, then the thread as the host now says; resolving again is the state wanted', async () => {
  const h = github();
  const open = (await h.service.threads('cr-1')).threads.find((t) => !t.isResolved && t.viewerCanResolve);
  assert.ok(open);
  h.answer(/resolveReviewThread/, ok(gh('d5_resolve')));
  // The re-read shows it resolved
  const resolvedList = gh('d1_threads_big')
    .split('\n')
    .map((line) => {
      if (!line.startsWith('{')) return line;
      const page = JSON.parse(line) as { data: { repository: { pullRequest: { reviewThreads: { nodes: Array<{ id: string; isResolved: boolean }> } } } } };
      for (const node of page.data.repository.pullRequest.reviewThreads.nodes) if (node.id === open.id) node.isResolved = true;
      return JSON.stringify(page);
    })
    .join('\n');
  h.sequence(/reviewThreads\(/, [ok(gh('d1_threads_big')), ok(resolvedList)]);
  const out = await h.service.resolve('cr-1', open.id, true);
  assert.equal(out.isResolved, true);
  const used = h.calls.length;
  await h.service.resolve('cr-1', open.id, true);
  assert.equal(h.calls.filter((c) => c.includes('resolveReviewThread')).length, 1, 'already resolved: no second write');
  assert.ok(h.calls.length >= used);
});

test('GitLab resolve that exits 1 on a thread the viewer cannot resolve is not-resolvable', async () => {
  const h = gitlab();
  const thread = (await h.service.threads('cr-1')).threads.find((t) => !t.isResolved && t.viewerCanResolve);
  assert.ok(thread);
  h.answer(/mr note resolve/, failed(1, 'HTTP 403'));
  await assert.rejects(h.service.resolve('cr-1', thread.id, true), (e) => reasonOfError(e) === 'unreachable');
  // The same discussion read as not resolvable
  const list = gl('d1_discussions_after_publish').replaceAll('"resolvable":true', '"resolvable":false');
  const locked = gitlab();
  locked.answer(/discussions\?per_page=100$/, ok(list));
  const first = (await locked.service.threads('cr-1')).threads[0];
  assert.ok(first);
  await assert.rejects(locked.service.resolve('cr-1', first.id, true), (e) => reasonOfError(e) === 'not-resolvable');
});

// ---------- approval ----------

const approvals = (viewer: boolean): string => JSON.stringify({ approved: viewer, approvals_required: 1, approvals_left: viewer ? 0 : 1, user_has_approved: viewer, approved_by: viewer ? [{ user: { username: 'me' } }] : [] });

test('GitLab approve: --sha is the head the person looked at, and the approvals are re-read', async () => {
  const h = gitlab();
  h.answer(/mr approve 12/, ok(gl('d9_approve')));
  h.answer(/merge_requests\/12\/approvals$/, ok(approvals(true)));
  const state = await h.service.approve('cr-1', GL_HEAD);
  assert.equal(state.viewerHasApproved, true);
  assert.ok(h.calls.some((c) => /^glab mr approve 12 .*--sha 6e0dab83/.test(c)));
  golden('reviews-gitlab-approve', h.calls);
});

test('GitLab approve: a head that moved is head-moved before any call; twice is the state wanted', async () => {
  const h = gitlab();
  await assert.rejects(h.service.approve('cr-1', 'a'.repeat(40)), (e) => reasonOfError(e) === 'head-moved');
  assert.ok(!h.calls.some((c) => c.includes('mr approve')));
  // The 401 of approving twice: stderr is not read, the re-read says the viewer approved
  h.answer(/mr approve 12/, failed(1, 'HTTP 401'));
  h.answer(/merge_requests\/12\/approvals$/, ok(approvals(true)));
  assert.equal((await h.service.approve('cr-1', GL_HEAD)).viewerHasApproved, true);
});

test('GitLab approve: a refusal while the viewer has not approved keeps its reason', async () => {
  const h = gitlab();
  h.answer(/mr approve 12/, failed(1, 'HTTP 403'));
  h.answer(/merge_requests\/12\/approvals$/, ok(approvals(false)));
  await assert.rejects(h.service.approve('cr-1', GL_HEAD), (e) => reasonOfError(e) === 'unreachable');
});

test('GitLab revoke, and approve as a review event after the comment', async () => {
  const h = gitlab();
  h.answer(/mr revoke 12/, ok('✓ Approval revoked'));
  h.answer(/merge_requests\/12\/approvals$/, ok(approvals(false)));
  assert.equal((await h.service.revoke('cr-1')).viewerHasApproved, false);

  // Approve with nothing to post is the approval alone
  h.answer(/mr approve 12/, ok(gl('d9_approve')));
  h.answer(/merge_requests\/12\/approvals$/, ok(approvals(true)));
  const post = await h.service.submit('cr-1', { event: 'approve', body: '' });
  assert.equal(post.state, 'posted');
  assert.equal(post.event, 'approve');
});

// ---------- reviewers ----------

test('GitHub reviewers: the request, then the re-read; an unknown login that added nobody is not-found', async () => {
  const h = github();
  h.answer(/pulls\/12\/requested_reviewers/, ok(gh('d11_request_nouser')));
  h.answer(/pr view 12/, ok(gh('d11_reread')));
  await assert.rejects(h.service.requestReviewers('cr-1', { add: ['nobody-at-all'] }), (e) => reasonOfError(e) === 'not-found' && e instanceof ReviewsError && e.detail === 'nobody-at-all');
  assert.ok(h.calls.some((c) => c.includes('requested_reviewers') && c.includes('{"reviewers":["nobody-at-all"]}')));
  const read = await h.service.reviewers('cr-1');
  assert.equal(read.reviewers[0]?.login, 'yeyo11');
  await assert.rejects(h.service.requestReviewers('cr-1', { add: ['x'], remove: ['y'] }), HostActionNotOffered);
  await assert.rejects(h.service.requestReviewers('cr-1', { add: ['-bad'] }), ReviewInputError);
  await assert.rejects(h.service.requestReviewers('cr-1', { add: [] }), ReviewInputError);
});

test('GitLab reviewers: `+user` adds one name; the list is read back and the decision joins the approvals', async () => {
  const h = gitlab();
  h.answer(/mr update 12/, ok(''));
  h.answer(/merge_requests\/12\/reviewers$/, ok(gl('d11_reviewers_endpoint')));
  h.answer(/merge_requests\/12\/approvals$/, ok(approvals(false)));
  const read = await h.service.requestReviewers('cr-1', { add: ['yeyo11'] });
  assert.equal(read.reviewers[0]?.login, 'yeyo11');
  assert.equal(read.decision, 'review-required');
  assert.ok(h.calls.some((c) => c.includes('--reviewer=+yeyo11')));
  golden('reviews-gitlab-reviewers', h.calls);
});

// ---------- the audit's findings: the head the person looked at, what a discard deletes, the posts after a reload ----------

const STALE = 'a'.repeat(40);

test('submit: a head that moved since the person looked is head-moved, and nothing is posted or recorded', async () => {
  for (const [name, h] of [['gitlab', gitlab()], ['github', github()]] as const) {
    await h.service.addDraft('cr-1', { body: 'a general note' });
    await assert.rejects(h.service.submit('cr-1', { event: 'comment', body: 'x', headSha: STALE }), (e) => reasonOfError(e) === 'head-moved', name);
    assert.ok(!h.calls.some((c) => c.includes('<<<') || c.includes('note publish') || c.includes('mr approve')), `${name}: no write was made`);
    assert.equal(h.service.posts('cr-1').length, 0, `${name}: a refusal leaves no post behind`);
    assert.equal(h.service.listDrafts('cr-1').length, 1, `${name}: the person keeps the note`);
  }
});

test('submit: the approval and the GitHub commit_id are the head the person looked at, not the one read later', async () => {
  const gl1 = gitlab();
  gl1.answer(/mr approve 12/, ok(gl('d9_approve')));
  gl1.answer(/merge_requests\/12\/approvals$/, ok(approvals(true)));
  const post = await gl1.service.submit('cr-1', { event: 'approve', body: '', headSha: GL_HEAD });
  assert.equal(post.state, 'posted');
  assert.ok(gl1.calls.some((c) => new RegExp(`^glab mr approve 12 .*--sha ${GL_HEAD}`).test(c)));
  golden('reviews-gitlab-submit-approve-head', gl1.calls);

  // The branch moves between the person's look and the approval: no approve call is made on the new head
  const moved = gitlab();
  let reads = 0;
  moved.answer(/mr view 12/, () => ok(gl('mrview_after_post').replaceAll(GL_HEAD, reads++ === 0 ? GL_HEAD : STALE)));
  moved.answer(/mr approve 12/, ok(gl('d9_approve')));
  await assert.rejects(moved.service.submit('cr-1', { event: 'approve', body: '', headSha: GL_HEAD }), (e) => reasonOfError(e) === 'head-moved');
  assert.ok(!moved.calls.some((c) => c.includes('mr approve')), 'the approval was refused before it was sent');

  const gh1 = github();
  gh1.answer(/pulls\/12\/reviews --input -$/, ok(gh('d8_review_comment')));
  await gh1.service.addDraft('cr-1', { body: 'general' });
  await gh1.service.submit('cr-1', { event: 'comment', body: 'hello', headSha: GH_HEAD });
  const write = gh1.calls.find((c) => c.includes('<<<')) ?? '';
  assert.equal((JSON.parse(write.slice(write.indexOf('<<<') + 4)) as { commit_id: string }).commit_id, GH_HEAD);
});

/** A draft note as the host lists it */
const draftNote = (id: number, note: string): Record<string, unknown> => ({ id, author_id: 1, merge_request_id: 9, note, commit_id: null, line_code: null, position: null });

test('GitLab discard saved deletes only the draft notes Agentry saved, never the persons others', async () => {
  const h = gitlab();
  h.sequence(/draft_notes -H/, [ok(gl('d8_draft_general')), failed(1, 'HTTP 500', { http: { status: 500, headers: {} } })]);
  await twoDrafts(h);
  await h.service.submit('cr-1', { event: 'comment', body: 'x' }).catch(() => undefined);
  const partly = h.service.posts('cr-1')[0];
  assert.deepEqual(partly?.detail?.draftIds, ['83394153'], 'the id of the note saved is recorded with the post');

  // The viewer also has a draft note of their own, written on GitLab in the meantime
  h.answer(/draft_notes$/, ok(JSON.stringify([draftNote(83394153, 'saved by agentry'), draftNote(777, 'my own thought')])));
  h.answer(/-X DELETE/, ok(''));
  const discarded = await h.service.discardSaved('cr-1', partly?.id ?? '');
  assert.equal(discarded.state, 'failed');
  const deletes = h.calls.filter((c) => c.includes('-X DELETE'));
  assert.equal(deletes.length, 1);
  assert.ok(deletes[0]?.endsWith('draft_notes/83394153'));
  assert.ok(!h.calls.some((c) => c.endsWith('draft_notes/777')), 'the persons own draft note was left alone');
  golden('reviews-gitlab-discard-own-only', h.calls);
});

test('review posts: a partly posted review is read back from the store, with what is still saved on the host', async () => {
  const h = gitlab();
  h.sequence(/draft_notes -H/, [ok(gl('d8_draft_general')), failed(1, 'HTTP 500', { http: { status: 500, headers: {} } })]);
  await twoDrafts(h);
  await h.service.submit('cr-1', { event: 'comment', body: 'x' }).catch(() => undefined);
  const id = h.service.posts('cr-1')[0]?.id ?? '';

  h.answer(/draft_notes$/, ok(JSON.stringify([draftNote(83394153, 'saved by agentry'), draftNote(777, 'not ours')])));
  const read = await h.service.reviewPosts('cr-1');
  assert.equal(read.posts[0]?.state, 'partly');
  assert.deepEqual(read.savedOnHost, { [id]: 1 });

  // A host that does not answer leaves the stored post and says it could not look
  h.answer(/draft_notes$/, failed(1, 'HTTP 500', { http: { status: 500, headers: {} } }));
  const blind = await h.service.reviewPosts('cr-1');
  assert.equal(blind.posts[0]?.state, 'partly');
  assert.equal(blind.savedOnHost, null);

  // Nothing partly posted: nothing is read from the host
  const clean = gitlab();
  assert.deepEqual(await clean.service.reviewPosts('cr-1'), { posts: [], savedOnHost: {} });
  assert.equal(clean.calls.length, 0);
});
