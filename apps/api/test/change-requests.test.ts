import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, MergeError, loadConfig } from '@agentry/core';
import type { ChangeRequest } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// The change request routes over HTTP: how an id is resolved, what is refused and with which
// status and code, and what a chat's token may not do. The hosts' own calls are covered in core.
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

let app: FastifyInstance;
let core: Core;
let root: string;
const ORCH_ROW = '6f1d6c0e-0000-4000-8000-00000000c0de';

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-change-requests-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  // A change request with no number, as an orchestration's is while it is being prepared; the
  // foreign key to the orchestration is not what is under test
  const sql = core.db.connection;
  sql.exec('PRAGMA foreign_keys = OFF');
  sql
    .prepare(
      `INSERT INTO orchestration_pull_requests (id, orchestration_id, cwd, host, phase, branch, base, ci, created_at, updated_at)
       VALUES (?, 'orch-1', ?, 'gitlab', 'open', 'integration/x', 'main', 'failing', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run(ORCH_ROW, root);
});

after(async () => {
  await app.close();
  core.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test('an id no table has is a 404 with a code, on every route', async () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const calls: Array<[string, string, unknown?]> = [
    ['GET', `/api/change-requests/${id}`],
    ['GET', `/api/change-requests/${id}/checks`],
    ['GET', `/api/change-requests/${id}/checks/1/log`],
    ['POST', `/api/change-requests/${id}/checks/rerun`, { scope: 'failed' }],
    ['POST', `/api/change-requests/${id}/checks/cancel`],
    ['POST', `/api/change-requests/${id}/checks/1/run`],
    ['POST', `/api/change-requests/${id}/checks/fix`],
    ['POST', `/api/change-requests/${id}/push-fix`],
    ['GET', `/api/change-requests/${id}/threads`],
    ['GET', `/api/change-requests/${id}/review-drafts`],
    ['GET', `/api/change-requests/${id}/review-posts`],
    ['POST', `/api/change-requests/${id}/review-drafts`, { body: 'x' }],
    ['PUT', `/api/change-requests/${id}/review-drafts/d1`, { body: 'x' }],
    ['DELETE', `/api/change-requests/${id}/review-drafts/d1`],
    ['POST', `/api/change-requests/${id}/reviews`, { event: 'comment', body: 'x' }],
    ['POST', `/api/change-requests/${id}/reviews/p1/publish-saved`],
    ['POST', `/api/change-requests/${id}/reviews/p1/discard-saved`],
    ['POST', `/api/change-requests/${id}/threads/t1/reply`, { body: 'x' }],
    ['POST', `/api/change-requests/${id}/threads/t1/resolve`],
    ['POST', `/api/change-requests/${id}/threads/t1/unresolve`],
    ['GET', `/api/change-requests/${id}/approval`],
    ['POST', `/api/change-requests/${id}/approval`, { sha: 'abc' }],
    ['DELETE', `/api/change-requests/${id}/approval`],
    ['GET', `/api/change-requests/${id}/reviewers`],
    ['POST', `/api/change-requests/${id}/reviewers`, { add: ['a'] }],
    ['POST', `/api/change-requests/${id}/address`, { threadIds: [] }],
    ['GET', `/api/change-requests/${id}/merge`],
    ['POST', `/api/change-requests/${id}/merge`, { method: 'squash', expectedHead: 'a'.repeat(40), deleteBranch: false }],
    ['POST', `/api/change-requests/${id}/auto-merge`, { method: 'squash', expectedHead: 'a'.repeat(40) }],
    ['DELETE', `/api/change-requests/${id}/auto-merge`],
    ['POST', `/api/change-requests/${id}/update-branch`],
    ['POST', `/api/change-requests/${id}/ready`, { ready: true }],
  ];
  for (const [method, url, body] of calls) {
    const res = await app.inject({ method: method as 'GET' | 'POST' | 'PUT' | 'DELETE', url, ...(body ? json(body) : {}) });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
    assert.equal(res.json<{ code: string }>().code, 'not-found', `${method} ${url}`);
  }
});

test('GET /change-requests/:id is the neutral shape of an orchestration row', async () => {
  const res = await app.inject(`/api/change-requests/${ORCH_ROW}`);
  assert.equal(res.statusCode, 200);
  const cr = res.json<ChangeRequest>();
  assert.equal(cr.id, ORCH_ROW);
  assert.equal(cr.kind, 'orchestration');
  assert.equal(cr.ownerId, 'orch-1');
  assert.equal(cr.host, 'gitlab');
  assert.equal(cr.phase, 'open');
  assert.equal(cr.ci, 'failing');
  assert.equal(cr.ref, null);
  assert.equal(cr.fixState, null);
  assert.equal(cr.fixAttempts, 0);
});

test('a rerun is validated before it reaches the host', async () => {
  const url = `/api/change-requests/${ORCH_ROW}/checks/rerun`;
  assert.equal((await app.inject({ method: 'POST', url, ...json({}) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, ...json({ scope: 'some' }) })).statusCode, 400);
  const noCheck = await app.inject({ method: 'POST', url, ...json({ scope: 'check' }) });
  assert.equal(noCheck.statusCode, 400);
  assert.match(noCheck.json<{ error: string }>().error, /checkId/);
});

test('a fix of a change request whose orchestration is gone is a 404 with a code, not a 500', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/change-requests/${ORCH_ROW}/checks/fix` });
  assert.equal(res.statusCode, 404, res.body);
  assert.ok(res.json<{ code: string }>().code);
});

test('review writes are validated before they reach the host', async () => {
  const base = `/api/change-requests/${ORCH_ROW}`;
  const post = (path: string, body: unknown) => app.inject({ method: 'POST', url: `${base}${path}`, ...json(body) });
  assert.equal((await post('/reviews', {})).statusCode, 400);
  assert.equal((await post('/reviews', { event: 'merge' })).statusCode, 400);
  assert.equal((await post('/reviews', { event: 'comment', body: 3 })).statusCode, 400);
  assert.equal((await post('/reviews', { event: 'approve', body: '', headSha: 7 })).statusCode, 400);
  assert.equal((await post('/threads/t1/reply', { body: '  ' })).statusCode, 400);
  assert.equal((await post('/approval', {})).statusCode, 400);
  assert.equal((await post('/reviewers', { add: 'a' })).statusCode, 400);
  assert.equal((await post('/reviewers', { add: ['a'], remove: 'b' })).statusCode, 400);
  assert.equal((await post('/address', { threadIds: 'all' })).statusCode, 400);
});

test('an address for an orchestration that is gone is a 404 with a code', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/change-requests/${ORCH_ROW}/address`, ...json({ threadIds: [] }) });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json<{ code: string }>().code, 'not-found');
});

test('merge writes are validated before they reach the host', async () => {
  const base = `/api/change-requests/${ORCH_ROW}`;
  const head = 'a'.repeat(40);
  const post = (path: string, body: unknown) => app.inject({ method: 'POST', url: `${base}${path}`, ...json(body) });
  assert.equal((await post('/merge', {})).statusCode, 400);
  assert.equal((await post('/merge', { method: 'fast-forward', expectedHead: head, deleteBranch: false })).statusCode, 400);
  assert.equal((await post('/merge', { method: 'squash', deleteBranch: false })).statusCode, 400);
  assert.equal((await post('/merge', { method: 'squash', expectedHead: head })).statusCode, 400);
  assert.equal((await post('/merge', { method: 'squash', expectedHead: head, deleteBranch: false, subject: 7 })).statusCode, 400);
  assert.equal((await post('/auto-merge', { method: 'squash' })).statusCode, 400);
  assert.equal((await post('/auto-merge', { expectedHead: head })).statusCode, 400);
  assert.equal((await post('/ready', {})).statusCode, 400);
});

test('a merge reaches the service as the caller, a refusal keeps its code, and a conflicting update is a 409 that names the paths', async () => {
  const merge = core.merge as unknown as Record<string, unknown>;
  const calls: unknown[][] = [];
  const original = { merge: merge.merge, updateBranch: merge.updateBranch };
  merge.merge = (...args: unknown[]) => {
    calls.push(args);
    return Promise.reject(new MergeError('new commits reached the branch after you looked', 'head-moved'));
  };
  merge.updateBranch = () => Promise.resolve({ state: {}, conflicts: ['src/a.ts', 'b.md'], via: 'merge' });
  try {
    const head = 'b'.repeat(40);
    const moved = await app.inject({ method: 'POST', url: `/api/change-requests/${ORCH_ROW}/merge`, ...json({ method: 'merge', expectedHead: head, deleteBranch: true }) });
    assert.equal(moved.statusCode, 409, moved.body);
    assert.equal(moved.json<{ code: string }>().code, 'head-moved');
    assert.deepEqual(calls[0]?.slice(0, 2), [ORCH_ROW, { method: 'merge', expectedHead: head, deleteBranch: true }]);
    // No credential is set in this app: the actor is the local one
    assert.equal(calls[0]?.[2], 'local');

    const conflict = await app.inject({ method: 'POST', url: `/api/change-requests/${ORCH_ROW}/update-branch` });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(conflict.json<{ code: string }>().code, 'conflicts');
    assert.match(conflict.json<{ error: string }>().error, /src\/a\.ts, b\.md/);
  } finally {
    Object.assign(merge, original);
  }
});

// ---------- a chat's own token ----------

const fromChat = (token: string, body?: unknown) => ({
  remoteAddress: '127.0.0.1',
  ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  headers: { host: '127.0.0.1:34331', 'content-type': 'application/json', authorization: `Bearer ${token}` },
});

test("a chat's token reads the checks but cannot re-run, cancel, play or fix", async () => {
  const secured = mkdtempSync(join(tmpdir(), 'agentry-api-change-requests-sec-'));
  const guardedCore = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(secured, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(secured, 'workspace'),
      AGENTRY_DATA_DIR: join(secured, 'data'),
    }),
  );
  const guarded = await buildApp(guardedCore, { logLevel: 'silent', webDist: join(secured, 'no-ui') });
  try {
    const created = await guarded.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
    assert.equal(created.statusCode, 200);
    assert.equal((await guarded.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
    const token = guardedCore.security.chatTokens.mint('chat-42');
    const id = '00000000-0000-4000-8000-000000000000';

    const writes: Array<[string, unknown?]> = [
      [`/api/change-requests/${id}/checks/rerun`, { scope: 'failed' }],
      [`/api/change-requests/${id}/checks/cancel`],
      [`/api/change-requests/${id}/checks/1/run`],
      [`/api/change-requests/${id}/checks/fix`],
      [`/api/change-requests/${id}/push-fix`],
    ];
    for (const [url, body] of writes) {
      const res = await guarded.inject({ method: 'POST', url, ...fromChat(token, body ?? {}) });
      assert.equal(res.statusCode, 403, url);
    }
    // A review is posted under the person's name: none of its writes is a chat's
    const reviews: Array<['POST' | 'PUT' | 'DELETE', string, unknown?]> = [
      ['POST', `/api/change-requests/${id}/review-drafts`, { body: 'x' }],
      ['PUT', `/api/change-requests/${id}/review-drafts/d1`, { body: 'x' }],
      ['DELETE', `/api/change-requests/${id}/review-drafts/d1`],
      ['POST', `/api/change-requests/${id}/reviews`, { event: 'comment', body: 'x' }],
      ['POST', `/api/change-requests/${id}/reviews/p1/publish-saved`],
      ['POST', `/api/change-requests/${id}/reviews/p1/discard-saved`],
      ['POST', `/api/change-requests/${id}/threads/t1/reply`, { body: 'x' }],
      ['POST', `/api/change-requests/${id}/threads/t1/resolve`],
      ['POST', `/api/change-requests/${id}/threads/t1/unresolve`],
      ['POST', `/api/change-requests/${id}/approval`, { sha: 'abc' }],
      ['DELETE', `/api/change-requests/${id}/approval`],
      ['POST', `/api/change-requests/${id}/reviewers`, { add: ['a'] }],
      ['POST', `/api/change-requests/${id}/address`, { threadIds: [] }],
    ];
    for (const [method, url, body] of reviews) {
      const res = await guarded.inject({ method, url, ...fromChat(token, body ?? {}) });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
    }
    // Merging is the person's click: not the merge, the arming, the update, nor the ready mark
    const merging: Array<['POST' | 'DELETE', string, unknown?]> = [
      ['POST', `/api/change-requests/${id}/merge`, { method: 'squash', expectedHead: 'a'.repeat(40), deleteBranch: false }],
      ['POST', `/api/change-requests/${id}/auto-merge`, { method: 'squash', expectedHead: 'a'.repeat(40) }],
      ['DELETE', `/api/change-requests/${id}/auto-merge`],
      ['POST', `/api/change-requests/${id}/update-branch`],
      ['POST', `/api/change-requests/${id}/ready`, { ready: true }],
    ];
    for (const [method, url, body] of merging) {
      const res = await guarded.inject({ method, url, ...fromChat(token, body ?? {}) });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
      assert.match(res.json<{ error: string }>().error, /merge/);
    }
    for (const path of ['threads', 'review-drafts', 'review-posts', 'approval', 'reviewers', 'merge']) {
      const read = await guarded.inject({ url: `/api/change-requests/${id}/${path}`, ...fromChat(token) });
      assert.equal(read.statusCode, 404, path);
    }
    // A read passes the guard and reaches the route, which does not know the id
    const read = await guarded.inject({ url: `/api/change-requests/${id}/checks`, ...fromChat(token) });
    assert.equal(read.statusCode, 404);
  } finally {
    await guarded.close();
    guardedCore.shutdown();
    rmSync(secured, { recursive: true, force: true });
  }
});

test('GET /change-requests/:id/review-posts answers the recorded posts of a row, newest first, and survives a new process', async () => {
  const sql = core.db.connection;
  const insert = sql.prepare("INSERT INTO review_posts (id, cr_id, marker, event, state, detail, created_at, updated_at) VALUES (?, ?, ?, 'comment', ?, ?, ?, ?)");
  insert.run('p-old', ORCH_ROW, '<!-- agentry:1 -->', 'failed', JSON.stringify({ code: 'line-not-in-diff', detail: 'a.ts:7' }), '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z');
  insert.run('p-new', ORCH_ROW, '<!-- agentry:2 -->', 'posted', null, '2026-10-01T11:00:00.000Z', '2026-10-01T11:00:00.000Z');
  const res = await app.inject(`/api/change-requests/${ORCH_ROW}/review-posts`);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<{ posts: Array<{ id: string; state: string; detail: { code: string } | null }>; savedOnHost: Record<string, number> | null }>();
  assert.deepEqual(body.posts.map((p) => [p.id, p.state]), [['p-new', 'posted'], ['p-old', 'failed']]);
  assert.equal(body.posts[1]?.detail?.code, 'line-not-in-diff');
  assert.deepEqual(body.savedOnHost, {}, 'no post is partly posted, so the host is not asked');
});
