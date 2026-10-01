import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
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
  ];
  for (const [method, url, body] of calls) {
    const res = await app.inject({ method: method as 'GET' | 'POST', url, ...(body ? json(body) : {}) });
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
    // A read passes the guard and reaches the route, which does not know the id
    const read = await guarded.inject({ url: `/api/change-requests/${id}/checks`, ...fromChat(token) });
    assert.equal(read.statusCode, 404);
  } finally {
    await guarded.close();
    guardedCore.shutdown();
    rmSync(secured, { recursive: true, force: true });
  }
});
