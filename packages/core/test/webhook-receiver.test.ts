import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db.ts';
import {
  BODY_REPLAY_WINDOW_MS,
  DELIVERIES_PER_MINUTE,
  WebhookReceiver,
  changeRequestsOf,
  githubTarget,
  gitlabTarget,
  verifyGithubSignature,
  verifyGitlabSignature,
  verifyGitlabToken,
} from '../src/hosts/webhook-receiver.ts';
import { signingTokenOf } from '../src/hosts/gitlab/hooks.ts';
import { newWebhookSecret, WebhookSecrets } from '../src/hosts/webhook-secrets.ts';
import { WebhookStore } from '../src/webhook-store.ts';
import { loadConfig } from '../src/paths.ts';

// The recorded GitHub deliveries carry their payload and headers but not the signature (it was
// redacted), so each test signs the recorded payload again with a secret of its own.
const DELIVERIES = join(import.meta.dirname, 'fixtures/recordings/gh/deliveries');
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const REPO = 'yeyo11/agentry-probe';

interface Recorded {
  event: string;
  request: { headers: Record<string, string>; payload: unknown };
}
const recorded = (name: string): Recorded => JSON.parse(readFileSync(join(DELIVERIES, `${name}.json`), 'utf8')) as Recorded;
const sign = (raw: Buffer, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const lower = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

/** A recorded delivery as it would arrive: the raw bytes and the headers, signed with `secret`. */
function delivery(name: string, secret = SECRET) {
  const { request } = recorded(name);
  const raw = Buffer.from(JSON.stringify(request.payload));
  return { raw, headers: { ...lower(request.headers), 'x-hub-signature-256': sign(raw, secret) } };
}

test('the signature is HMAC-SHA256 over the raw bytes, and anything else is refused', () => {
  const { raw, headers } = delivery('ping.None');
  const signature = headers['x-hub-signature-256'];
  assert.equal(verifyGithubSignature(SECRET, raw, signature), true);
  assert.equal(verifyGithubSignature('another-secret', raw, signature), false);
  assert.equal(verifyGithubSignature(SECRET, Buffer.concat([raw, Buffer.from(' ')]), signature), false, 'one byte more is another body');
  assert.equal(verifyGithubSignature(SECRET, raw, undefined), false);
  assert.equal(verifyGithubSignature(SECRET, raw, signature.replace('sha256=', 'sha1=')), false);
  assert.equal(verifyGithubSignature(SECRET, raw, 'sha256='), false);
  assert.equal(verifyGithubSignature(SECRET, raw, signature.slice(0, -2)), false);
});

test('GitLab’s token is compared whole', () => {
  assert.equal(verifyGitlabToken(SECRET, SECRET), true);
  assert.equal(verifyGitlabToken(SECRET, `${SECRET}x`), false);
  assert.equal(verifyGitlabToken(SECRET, SECRET.slice(1)), false);
  assert.equal(verifyGitlabToken(SECRET, ''), false);
  assert.equal(verifyGitlabToken(SECRET, undefined), false);
});

test('every recorded GitHub delivery names its repository, and the pull request ones their number', () => {
  const names = readdirSync(DELIVERIES).map((f) => f.replace(/\.json$/, ''));
  for (const name of names) {
    const { headers } = delivery(name);
    const target = githubTarget(headers, recorded(name).request.payload);
    assert.equal(target.repoPath, REPO, name);
    assert.ok(target.deliveryId, name);
  }
  const named = (name: string) => githubTarget(delivery(name).headers, recorded(name).request.payload);
  assert.deepEqual(named('pull_request.synchronize').numbers, [27]);
  assert.deepEqual(named('pull_request_review.submitted').numbers, [27]);
  assert.deepEqual(named('pull_request_review_thread.resolved').numbers, [27]);
  // A comment on a pull request is an issue comment on its number; a plain issue is no change request
  assert.deepEqual(named('issue_comment.created').numbers, [1]);
  assert.deepEqual(named('issues.opened').numbers, []);
  // Recorded: the pull request list of a check suite is empty, so the branch is what names it
  assert.deepEqual(named('check_suite.completed').numbers, []);
  assert.deepEqual(named('check_suite.completed').branches, ['main']);
  assert.deepEqual(named('workflow_run.completed').branches, ['main']);
  assert.deepEqual(named('check_run.completed').branches, ['main']);
  assert.equal(named('ping.None').event, 'ping');
});

test('a payload that is not what it should be names nothing and throws nothing', () => {
  for (const body of [null, 'x', 7, [], { repository: 'no', pull_request: [] }, { pull_request: { number: '27' } }, { check_suite: { pull_requests: [null, { number: -1 }] } }]) {
    const target = githubTarget({ 'x-github-event': 'pull_request' }, body);
    assert.deepEqual(target.numbers, []);
    assert.equal(target.repoPath, null);
  }
});

test('GitLab names the merge request by iid and a pipeline by its branch', () => {
  const headers = { 'x-gitlab-event': 'Merge Request Hook', 'idempotency-key': 'abc' };
  const mr = gitlabTarget(headers, { object_kind: 'merge_request', project: { path_with_namespace: 'grp/sub/app' }, object_attributes: { iid: 9 } });
  assert.deepEqual({ repo: mr.repoPath, n: mr.numbers, id: mr.deliveryId }, { repo: 'grp/sub/app', n: [9], id: 'abc' });
  assert.deepEqual(gitlabTarget({}, { object_kind: 'note', project: { path_with_namespace: 'g/a' }, merge_request: { iid: 4 } }).numbers, [4]);
  const pipeline = gitlabTarget({}, { object_kind: 'pipeline', project: { path_with_namespace: 'g/a' }, object_attributes: { ref: 'feat/x' } });
  assert.deepEqual(pipeline.branches, ['feat/x']);
});

// ---- the receiver, against a real migrated database

interface Harness {
  raw: DatabaseSync;
  store: WebhookStore;
  receiver: WebhookReceiver;
  nudged: string[][];
  emitted: string[];
  clock: { now: number };
  dir: string;
  secrets: WebhookSecrets;
}

async function harness(): Promise<Harness> {
  const raw = new DatabaseSync(':memory:');
  migrate(raw);
  raw.exec('PRAGMA foreign_keys = OFF');
  const dir = mkdtempSync(join(tmpdir(), 'agentry-webhook-receiver-'));
  const secrets = new WebhookSecrets(loadConfig({ AGENTRY_DATA_DIR: dir }));
  const store = new WebhookStore(raw);
  store.create({ id: 'r1', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: REPO, remoteHookId: '1', url: 'https://x.lhr.life/api/webhooks/github/r1', events: ['pull_request'] });
  await secrets.set('r1', SECRET);
  const nudged: string[][] = [];
  const emitted: string[] = [];
  const clock = { now: Date.parse('2026-10-02T12:00:00Z') };
  const receiver = new WebhookReceiver({ store, secrets, sql: raw, nudge: (ids) => nudged.push([...ids]), emit: (event) => emitted.push(event.type), now: () => clock.now });
  const pr = (id: string, table: string, number: number, branch: string, url: string, extra = '') =>
    raw.prepare(`INSERT INTO ${table} (id, ${table === 'work_item_pull_requests' ? 'item_id, project_id, approved_at,' : 'orchestration_id, cwd,'} host, phase, number, url, branch, base, created_at, updated_at${extra})
      VALUES (?, ${table === 'work_item_pull_requests' ? "'i', 'p1', 'x'," : "'o', '/w',"} 'github', 'open', ?, ?, ?, 'main', 'x', 'x'${extra ? ", ''" : ''})`).run(id, number, url, branch);
  pr('wi27', 'work_item_pull_requests', 27, 'feat/a', `https://github.com/${REPO}/pull/27`);
  pr('or1', 'orchestration_pull_requests', 1, 'main', `https://github.com/${REPO}/pull/1`);
  pr('other-repo', 'work_item_pull_requests', 27, 'feat/a', 'https://github.com/someone/else/pull/27');
  return { raw, store, receiver, nudged, emitted, clock, dir, secrets };
}

const done = (h: Harness) => {
  h.raw.close();
  rmSync(h.dir, { recursive: true, force: true });
};

test('a genuine delivery nudges the rows it names, in both tables, and nothing of another repository', async () => {
  const h = await harness();
  try {
    const d = delivery('pull_request.synchronize');
    assert.equal(h.receiver.handle('github', 'r1', d.headers, d.raw), 'accepted');
    assert.deepEqual(h.nudged, [['wi27']]);
    // The check suite names no pull request (recorded), so the branch finds the orchestration's
    const c = delivery('check_suite.completed');
    assert.equal(h.receiver.handle('github', 'r1', c.headers, c.raw), 'accepted');
    assert.deepEqual(h.nudged.at(-1), ['or1']);
    // Bookkeeping only: the registration remembers the delivery
    assert.equal(h.store.get('r1')?.lastDeliveryAt, new Date(h.clock.now).toISOString());
  } finally {
    done(h);
  }
});

test('an unverified delivery is refused before it is read, and nothing is recorded or nudged', async () => {
  const h = await harness();
  try {
    const d = delivery('pull_request.synchronize', 'the wrong secret');
    assert.equal(h.receiver.handle('github', 'r1', d.headers, d.raw), 'unauthorized');
    assert.equal(h.receiver.handle('github', 'nope', d.headers, d.raw), 'unauthorized');
    // The hook of the other host answers the same way, and so does a missing secret
    const good = delivery('pull_request.synchronize');
    assert.equal(h.receiver.handle('gitlab', 'r1', { 'x-gitlab-token': SECRET }, good.raw), 'unauthorized');
    await h.secrets.delete('r1');
    assert.equal(h.receiver.handle('github', 'r1', good.headers, good.raw), 'unauthorized');
    assert.deepEqual(h.nudged, []);
    assert.deepEqual(h.store.deliveries('r1'), []);
    assert.equal(h.store.get('r1')?.lastDeliveryAt, null);
  } finally {
    done(h);
  }
});

test('a removed registration no longer believes anyone', async () => {
  const h = await harness();
  try {
    h.store.update('r1', { state: 'removed' });
    const d = delivery('ping.None');
    assert.equal(h.receiver.handle('github', 'r1', d.headers, d.raw), 'unauthorized');
  } finally {
    done(h);
  }
});

test('a replayed delivery id is acknowledged and does the work once', async () => {
  const h = await harness();
  try {
    const d = delivery('pull_request.opened');
    assert.equal(h.receiver.handle('github', 'r1', d.headers, d.raw), 'accepted');
    assert.equal(h.receiver.handle('github', 'r1', d.headers, d.raw), 'duplicate');
    assert.equal(h.nudged.length, 1);
    assert.equal(h.store.deliveries('r1').length, 1);
  } finally {
    done(h);
  }
});

test('a captured body replayed under a new id, or none, is a duplicate and cannot make a failing hook look healthy', async () => {
  const h = await harness();
  try {
    const d = delivery('pull_request.opened');
    assert.equal(h.receiver.handle('github', 'r1', d.headers, d.raw), 'accepted');
    h.store.update('r1', { state: 'failing', lastDeliveryAt: null });

    const fresh = { ...d.headers, 'x-github-delivery': 'a-brand-new-id' };
    assert.equal(h.receiver.handle('github', 'r1', fresh, d.raw), 'duplicate');
    const noId: Record<string, string> = Object.fromEntries(Object.entries(d.headers as Record<string, string>).filter(([name]) => name !== 'x-github-delivery'));
    assert.equal(h.receiver.handle('github', 'r1', noId, d.raw), 'duplicate');
    assert.equal(h.nudged.length, 1);
    assert.equal(h.store.get('r1')?.state, 'failing');
    assert.equal(h.store.get('r1')?.lastDeliveryAt, null);

    // The window ends: the same bytes count again, with an id
    h.clock.now += BODY_REPLAY_WINDOW_MS + 1;
    assert.equal(h.receiver.handle('github', 'r1', { ...d.headers, 'x-github-delivery': 'after-the-window' }, d.raw), 'accepted');
    assert.equal(h.store.get('r1')?.state, 'active');
  } finally {
    done(h);
  }
});

test('a signed delivery with no id nudges but cannot clear a failure, stamp the hook or count as a ping', async () => {
  const h = await harness();
  try {
    h.store.update('r1', { state: 'failing' });
    const d = delivery('ping.None');
    const noId: Record<string, string> = Object.fromEntries(Object.entries(d.headers as Record<string, string>).filter(([name]) => name !== 'x-github-delivery'));
    assert.equal(h.receiver.handle('github', 'r1', noId, d.raw), 'accepted');
    const after = h.store.get('r1');
    assert.equal(after?.state, 'failing');
    assert.equal(after?.lastDeliveryAt, null);
    assert.equal(after?.lastPingAt, null);
    assert.deepEqual(h.emitted, []);
    assert.deepEqual(h.nudged, [[]]);
  } finally {
    done(h);
  }
});

test('a ping is remembered as one, announced, and a delivery clears a failing hook', async () => {
  const h = await harness();
  try {
    h.store.update('r1', { state: 'failing' });
    const d = delivery('ping.None');
    assert.equal(h.receiver.handle('github', 'r1', d.headers, d.raw), 'accepted');
    const after = h.store.get('r1');
    assert.equal(after?.lastPingAt, new Date(h.clock.now).toISOString());
    assert.equal(after?.state, 'active');
    assert.deepEqual(h.emitted, ['webhook.changed']);
    assert.deepEqual(h.nudged, [[]]);
  } finally {
    done(h);
  }
});

test('a delivery for a repository other than the registration’s nudges nothing', async () => {
  const h = await harness();
  try {
    const { request } = recorded('pull_request.synchronize');
    const payload = { ...(request.payload as object), repository: { full_name: 'someone/else' } };
    const raw = Buffer.from(JSON.stringify(payload));
    assert.equal(h.receiver.handle('github', 'r1', { ...lower(request.headers), 'x-hub-signature-256': sign(raw) }, raw), 'accepted');
    assert.deepEqual(h.nudged, []);
  } finally {
    done(h);
  }
});

test('signed bytes that are not JSON are accepted and name nothing', async () => {
  const h = await harness();
  try {
    const raw = Buffer.from('not json at all');
    assert.equal(h.receiver.handle('github', 'r1', { 'x-hub-signature-256': sign(raw), 'x-github-delivery': 'd1', 'x-github-event': 'push' }, raw), 'accepted');
    assert.deepEqual(h.nudged, []);
  } finally {
    done(h);
  }
});

test('the 61st verified delivery in a minute is refused, a bad one never counts, and the window slides', async () => {
  const h = await harness();
  try {
    const bad = delivery('ping.None', 'wrong');
    for (let i = 0; i < DELIVERIES_PER_MINUTE + 5; i++) assert.equal(h.receiver.handle('github', 'r1', bad.headers, bad.raw), 'unauthorized');
    const send = (n: number) => {
      const raw = Buffer.from(JSON.stringify({ n }));
      return h.receiver.handle('github', 'r1', { 'x-hub-signature-256': sign(raw), 'x-github-delivery': `d${n}`, 'x-github-event': 'push' }, raw);
    };
    for (let i = 0; i < DELIVERIES_PER_MINUTE; i++) assert.equal(send(i), 'accepted');
    assert.equal(send(1000), 'rate-limited');
    h.clock.now += 61_000;
    assert.equal(send(1001), 'accepted');
  } finally {
    done(h);
  }
});

test('rows are placed by the address of their own pull request, and closed ones are left alone', async () => {
  const h = await harness();
  try {
    const registration = { host: 'github', hostname: 'github.com', repoPath: REPO } as const;
    assert.deepEqual(changeRequestsOf(h.raw, registration, { numbers: [27], branches: [] }), ['wi27']);
    assert.deepEqual(changeRequestsOf(h.raw, registration, { numbers: [], branches: ['feat/a'] }), ['wi27']);
    assert.deepEqual(changeRequestsOf(h.raw, registration, { numbers: [], branches: [] }), []);
    assert.deepEqual(changeRequestsOf(h.raw, { ...registration, hostname: 'ghe.example.com' }, { numbers: [27], branches: [] }), []);
    h.raw.prepare("UPDATE work_item_pull_requests SET closed_at = 'x' WHERE id = 'wi27'").run();
    assert.deepEqual(changeRequestsOf(h.raw, registration, { numbers: [27], branches: [] }), []);
    // GitLab rows are found by their merge request address
    h.raw.prepare("INSERT INTO orchestration_pull_requests (id, orchestration_id, cwd, host, phase, number, url, branch, base, created_at, updated_at) VALUES ('gl', 'o2', '/w', 'gitlab', 'open', 9, 'https://gitlab.com/g/sub/app/-/merge_requests/9', 'b', 'main', 'x', 'x')").run();
    assert.deepEqual(changeRequestsOf(h.raw, { host: 'gitlab', hostname: 'gitlab.com', repoPath: 'g/sub/app' }, { numbers: [9], branches: [] }), ['gl']);
  } finally {
    done(h);
  }
});

test('the secret is 32 random bytes in a 0600 file', async () => {
  const h = await harness();
  try {
    const a = newWebhookSecret();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, newWebhookSecret());
    assert.equal(statSync(join(h.dir, 'webhook-secrets.json')).mode & 0o777, 0o600);
    assert.equal(h.secrets.get('r1'), SECRET);
    assert.equal(h.secrets.get('unknown'), null);
    await h.secrets.delete('r1');
    assert.equal(h.secrets.get('r1'), null);
  } finally {
    done(h);
  }
});

// ---------- GitLab's signing token ----------

const glSign = (raw: Buffer, id: string, timestamp: string, secret = SECRET): string => {
  const key = Buffer.from(signingTokenOf(secret).slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest('base64')}`;
};

test('GitLab’s signature is HMAC-SHA256 over id.timestamp.body, inside five minutes, and anything else is refused', () => {
  const raw = Buffer.from('{"object_kind":"push"}');
  const now = Date.parse('2026-10-02T12:00:00Z');
  const ts = String(now / 1000);
  const signature = glSign(raw, 'abc', ts);
  const check = (over: Partial<{ id: string | null; timestamp: string | null; signature: string | null }> = {}, body = raw, at = now) =>
    verifyGitlabSignature(SECRET, body, { id: 'abc', timestamp: ts, signature, ...over }, at);
  assert.equal(check(), true);
  assert.equal(check({ signature: `v1,other ${signature}` }), true, 'any one of several signatures may match');
  assert.equal(check({}, Buffer.concat([raw, Buffer.from(' ')])), false);
  assert.equal(check({ id: 'abd' }), false, 'the id is signed');
  assert.equal(check({ timestamp: String(now / 1000 + 1) }), false, 'the timestamp is signed');
  assert.equal(check({}, raw, now + 5 * 60_000 + 1000), false, 'older than five minutes');
  assert.equal(check({}, raw, now - 5 * 60_000 - 1000), false, 'from the future');
  assert.equal(check({ signature: null }), false);
  assert.equal(check({ id: null }), false);
  assert.equal(check({ timestamp: 'x' }), false);
  assert.equal(verifyGitlabSignature('another-secret', raw, { id: 'abc', timestamp: ts, signature }, now), false);
});

test('a GitLab delivery needs the token, and a signature when it carries one', async () => {
  const h = await harness();
  try {
    h.store.create({ id: 'g1', projectId: 'p1', host: 'gitlab', hostname: 'gitlab.com', repoPath: 'g/p', remoteHookId: '2', url: 'https://x.lhr.life/api/webhooks/gitlab/g1', events: [] });
    await h.secrets.set('g1', SECRET);
    const raw = Buffer.from(JSON.stringify({ object_kind: 'merge_request', project: { path_with_namespace: 'g/p' }, object_attributes: { iid: 3 } }));
    const stamp = String(h.clock.now / 1000);
    const base = { 'x-gitlab-event': 'Merge Request Hook', 'idempotency-key': 'k1', 'webhook-id': 'k1', 'webhook-timestamp': stamp };
    // the token alone, as a hook made without a signing token delivers
    assert.equal(h.receiver.handle('gitlab', 'g1', { ...base, 'x-gitlab-token': 'nope' }, raw), 'unauthorized');
    // a wrong signature is refused even with the right token
    assert.equal(h.receiver.handle('gitlab', 'g1', { ...base, 'x-gitlab-token': SECRET, 'webhook-signature': glSign(raw, 'k1', stamp, 'wrong') }, raw), 'unauthorized');
    // a right signature with the wrong token is refused too
    assert.equal(h.receiver.handle('gitlab', 'g1', { ...base, 'x-gitlab-token': 'nope', 'webhook-signature': glSign(raw, 'k1', stamp) }, raw), 'unauthorized');
    assert.equal(h.receiver.handle('gitlab', 'g1', { ...base, 'x-gitlab-token': SECRET, 'webhook-signature': glSign(raw, 'k1', stamp) }, raw), 'accepted');
    const plain = Buffer.from(JSON.stringify({ object_kind: 'merge_request', project: { path_with_namespace: 'g/p' }, object_attributes: { iid: 4 } }));
    assert.equal(h.receiver.handle('gitlab', 'g1', { 'x-gitlab-event': 'Merge Request Hook', 'idempotency-key': 'k2', 'x-gitlab-token': SECRET }, plain), 'accepted');
  } finally {
    done(h);
  }
});
