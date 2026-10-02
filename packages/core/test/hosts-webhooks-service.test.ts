import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { AgentryEvent, TunnelStatus } from '@agentry/shared';
import { Core } from '../src/index.ts';
import { migrate } from '../src/db.ts';
import type { HostCall } from '../src/hosts/code-host.ts';
import type { HostResult } from '../src/hosts/exec.ts';
import { classifyCall } from '../src/hosts/classify.ts';
import { GITHUB_HOOK_EVENTS, githubHooks, lastResponseFailed } from '../src/hosts/github/hooks.ts';
import { WebhookSecrets } from '../src/hosts/webhook-secrets.ts';
import { receiverUrl, WebhooksError, WebhooksService, type WebhookAccess, type WebhookTarget } from '../src/hosts/webhooks-service.ts';
import { WebhookStore } from '../src/webhook-store.ts';
import { tempConfig } from './helpers.ts';

// The registration service against what w0 recorded (the `hook_*` captures of gh 2.102.0): calls are
// answered by their argv, and an argv nobody planned for fails the test.

const here = dirname(fileURLToPath(import.meta.url));
const REC = join(here, 'fixtures/recordings/gh/2.102.0');
const recorded = (label: string): { stdout: string; stderr: string; exitCode: number } => ({
  stdout: readFileSync(join(REC, `${label}.out`), 'utf8'),
  stderr: readFileSync(join(REC, `${label}.err`), 'utf8').split('\n')[0] ?? '',
  exitCode: Number(readFileSync(join(REC, `${label}.rc`), 'utf8').trim()),
});

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const ORIGIN = 'https://abc123.lhr.life';
const REPO = { host: 'github.com', path: 'yeyo11/app', owner: 'yeyo11', name: 'app' };
const HOOK = '690965105';
const HOOKS = `repos/${REPO.owner}/${REPO.name}/hooks`;

const result = (r: { stdout: string; stderr: string; exitCode: number }): HostResult => ({ exitCode: r.exitCode, stdout: r.stdout, stderrFirstLine: r.stderr, http: null, truncated: false, durationMs: 1 });
const ok = (stdout = ''): HostResult => ({ exitCode: 0, stdout, stderrFirstLine: '', http: null, truncated: false, durationMs: 1 });

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  service: WebhooksService;
  store: WebhookStore;
  secrets: WebhookSecrets;
  dataDir: string;
  calls: HostCall[];
  events: AgentryEvent[];
  state: { origin: string | null; target: WebhookTarget | null; clock: number };
  answer: (handler: (call: HostCall) => HostResult | undefined) => void;
}

function fixture(): Fixture {
  const config = tempConfig();
  roots.push(dirname(config.dataDir));
  const raw = new DatabaseSync(':memory:');
  migrate(raw);
  const store = new WebhookStore(raw);
  const secrets = new WebhookSecrets(config);
  const calls: HostCall[] = [];
  const events: AgentryEvent[] = [];
  const state = { origin: ORIGIN as string | null, target: { host: 'github', hostname: 'github.com', repoPath: REPO.path } as WebhookTarget | null, clock: NOW };
  let handler: (call: HostCall) => HostResult | undefined = () => undefined;
  const access: WebhookAccess = {
    host: 'github',
    hostname: 'github.com',
    repo: REPO,
    run: async (call) => {
      calls.push(call);
      const answer = handler(call);
      if (!answer) throw new Error(`no answer planned for: ${call.args.join(' ')}`);
      return answer;
    },
  };
  const service = new WebhooksService({
    store,
    secrets,
    target: async () => state.target,
    access: async () => access,
    publicUrl: () => state.origin,
    emit: (event) => events.push({ ...event, id: events.length + 1, at: new Date(NOW).toISOString() } as AgentryEvent),
    now: () => state.clock,
    sleep: async () => undefined,
  });
  return { service, store, secrets, dataDir: config.dataDir, calls, events, state, answer: (h) => void (handler = h) };
}

const argv = (call: HostCall): string => call.args.join(' ');
const isCreate = (call: HostCall): boolean => argv(call) === `api --hostname github.com -X POST ${HOOKS} --input -`;
const isList = (call: HostCall): boolean => argv(call) === `api --hostname github.com --paginate --slurp ${HOOKS}?per_page=100`;
/** The listing as `--paginate --slurp` prints it: an array of pages */
const pages = (...hooks: string[][]): HostResult => ok(`[${hooks.map((page) => `[${page.join(',')}]`).join(',')}]`);
const isRepoint = (call: HostCall, id = HOOK): boolean => argv(call) === `api --hostname github.com -X PATCH ${HOOKS}/${id}/config --input -`;
const isGet = (call: HostCall): boolean => argv(call) === `api --hostname github.com ${HOOKS}/${HOOK}`;
const isPing = (call: HostCall): boolean => argv(call) === `api --hostname github.com -X POST ${HOOKS}/${HOOK}/pings`;
const isDelete = (call: HostCall): boolean => argv(call) === `api --hostname github.com -X DELETE ${HOOKS}/${HOOK}`;

/** A read of any hook answers with the address of the registration that owns it: the hook is this install's */
const mineGet = (call: HostCall): HostResult | undefined => {
  const match = /hooks\/(\d+)$/.exec(argv(call));
  if (!match) return undefined;
  const id = match[1] === HOOK ? 'r1' : match[1] === '7' ? 'r2' : 'r3';
  return ok(hookJson(receiverUrl(ORIGIN, 'github', id), { code: 204, status: 'active' }, match[1]));
};

const hookJson = (url: string, last: { code: number | null; status: string; message?: string | null }, id = HOOK): string =>
  JSON.stringify({ type: 'Repository', id: Number(id), name: 'web', active: true, events: [...GITHUB_HOOK_EVENTS], config: { url, content_type: 'json', insecure_ssl: '0', secret: '********' }, last_response: { message: null, ...last } });

// ---------- the calls ----------

test('the hook calls are the recorded ones, with the secret on stdin and never in argv', () => {
  const create = githubHooks.create(REPO, { url: 'https://x.lhr.life/api/webhooks/github/r1', secret: 's3cret' });
  assert.deepEqual(create.args, ['api', '--hostname', 'github.com', '-X', 'POST', HOOKS, '--input', '-']);
  assert.equal(create.kind, 'write');
  assert.ok(!create.args.join(' ').includes('s3cret'));
  const body = JSON.parse(create.input ?? '') as { name: string; events: string[]; config: Record<string, string> };
  assert.equal(body.name, 'web');
  assert.deepEqual(body.events, [...GITHUB_HOOK_EVENTS]);
  assert.deepEqual(body.config, { url: 'https://x.lhr.life/api/webhooks/github/r1', content_type: 'json', secret: 's3cret', insecure_ssl: '0' });

  const repoint = githubHooks.repoint(REPO, HOOK, { url: 'https://y.lhr.life/api/webhooks/github/r1', secret: 's3cret' });
  assert.deepEqual(repoint.args, ['api', '--hostname', 'github.com', '-X', 'PATCH', `${HOOKS}/${HOOK}/config`, '--input', '-']);
  assert.ok(!repoint.args.join(' ').includes('s3cret'));
  for (const call of [create, repoint, githubHooks.ping(REPO, HOOK), githubHooks.remove(REPO, HOOK)]) assert.equal(call.kind, 'write');
  for (const call of [githubHooks.list(REPO), githubHooks.get(REPO, HOOK)]) assert.equal(call.kind, 'read');
  // The classifier and the builder agree on every hook call, so a write is never retried
  for (const call of [create, repoint, githubHooks.ping(REPO, HOOK), githubHooks.remove(REPO, HOOK), githubHooks.list(REPO), githubHooks.get(REPO, HOOK)]) assert.equal(classifyCall(call), call.kind, argv(call));
});

test('the recorded hook answers parse, and a failing last response is told from a good one', () => {
  const created = githubHooks.parseHook(recorded('hook_create').stdout);
  assert.equal(created.id, HOOK);
  assert.equal(created.url, 'https://agentry.example.net/github/1');
  assert.deepEqual(created.lastResponse, { code: null, status: 'unused' });
  const after = githubHooks.parseHook(recorded('hook_get_after').stdout);
  assert.deepEqual(after.lastResponse, { code: 204, status: 'active' });
  assert.equal(githubHooks.parseHooks(recorded('hooks_after').stdout).length, 0);
  assert.equal(lastResponseFailed(created.lastResponse), false);
  assert.equal(lastResponseFailed(after.lastResponse), false);
  assert.equal(lastResponseFailed({ code: 502, status: 'connection_error' }), true);
});

// ---------- register ----------

test('registering creates the hook with a fresh address and secret, keeps the secret in a 0600 file and says so on the feed', async () => {
  const f = fixture();
  f.answer((call) => (isList(call) ? pages([]) : isCreate(call) ? result(recorded('hook_create')) : undefined));

  const registration = await f.service.register('p1');
  assert.equal(registration.remoteHookId, HOOK);
  assert.equal(registration.state, 'active');
  assert.equal(registration.url, receiverUrl(ORIGIN, 'github', registration.id));
  assert.match(registration.url, /^https:\/\/abc123\.lhr\.life\/api\/webhooks\/github\/[0-9a-f-]{36}$/);
  assert.deepEqual(registration.events, [...GITHUB_HOOK_EVENTS]);

  const secret = f.service.secretOf(registration.id);
  assert.match(secret ?? '', /^[0-9a-f]{64}$/);
  const create = f.calls.find(isCreate);
  assert.equal((JSON.parse(create?.input ?? '') as { config: { secret: string; url: string } }).config.secret, secret);
  assert.equal((JSON.parse(create?.input ?? '') as { config: { url: string } }).config.url, registration.url);
  assert.ok(f.calls.every((c) => !argv(c).includes(secret ?? 'x')));
  assert.equal(statSync(join(f.dataDir, 'webhook-secrets.json')).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(registration).includes(secret ?? 'x'), 'the API document never holds the secret');
  assert.ok(!JSON.stringify(f.store.list('p1')).includes(secret ?? 'x'));
  assert.equal(f.events.at(-1)?.type, 'webhook.changed');
});

test('registering twice is refused, and registering after a removal replaces the removed row', async () => {
  const f = fixture();
  f.answer((call) => (isList(call) ? pages([]) : isCreate(call) ? result(recorded('hook_create')) : isGet(call) ? ok(hookJson(f.store.list('p1')[0]?.url ?? '', { code: 204, status: 'active' })) : isDelete(call) ? ok() : undefined));
  const first = await f.service.register('p1');
  await assert.rejects(f.service.register('p1'), (e: unknown) => e instanceof WebhooksError && e.code === 'already-registered' && e.status === 409);
  await f.service.remove('p1', first.id);
  assert.equal(f.service.secretOf(first.id), null);
  const second = await f.service.register('p1');
  assert.notEqual(second.id, first.id);
  assert.deepEqual(f.store.list('p1').map((r) => r.id), [second.id]);
});

const OTHER = 'https://other777.lhr.life/api/webhooks/github/11111111-2222-3333-4444-555555555555';

test("another install's Agentry hook is not adopted: it is left alone, its own is created, and the person is told", async () => {
  const f = fixture();
  f.answer((call) => (isList(call) ? pages([hookJson(OTHER, { code: 204, status: 'active' }, '42')]) : isCreate(call) ? result(recorded('hook_create')) : undefined));

  const registration = await f.service.register('p1');
  assert.equal(registration.remoteHookId, HOOK, 'its own hook, not the one found');
  assert.ok(f.calls.some(isCreate));
  assert.ok(!f.calls.some((c) => argv(c).includes('/42')), 'the other hook is never read, patched or deleted');
  assert.match(registration.notice ?? '', /another Agentry install .*other777\.lhr\.life.*left it alone/);
  assert.equal(f.store.get(registration.id) && 'notice' in (f.store.get(registration.id) ?? {}), false, 'the notice is not kept');
});

test("a hook this install's own removed registration left behind is adopted, with the new address and secret", async () => {
  const f = fixture();
  f.store.create({ id: '11111111-2222-3333-4444-555555555555', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: REPO.path, remoteHookId: HOOK, url: OTHER, events: [] });
  f.store.update('11111111-2222-3333-4444-555555555555', { state: 'removed' });
  f.answer((call) => (isList(call) ? pages([hookJson(OTHER, { code: 502, status: 'connection_error' })]) : isRepoint(call) ? ok(hookJson('x', { code: 204, status: 'active' })) : undefined));

  const registration = await f.service.register('p1');
  assert.equal(registration.remoteHookId, HOOK);
  assert.equal(registration.notice, undefined);
  assert.ok(!f.calls.some(isCreate), 'nothing is created next to it');
  const patch = JSON.parse(f.calls.find((c) => isRepoint(c))?.input ?? '') as { url: string; secret: string };
  assert.equal(patch.url, registration.url);
  assert.equal(patch.secret, f.service.secretOf(registration.id));
  assert.deepEqual(f.store.list('p1').map((r) => r.id), [registration.id], 'the removed row is replaced');
});

test('a hook another install pointed at itself is neither re-pointed nor removed by this one', async () => {
  const f = fixture();
  f.store.create({ id: 'r1', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: REPO.path, remoteHookId: HOOK, url: receiverUrl(ORIGIN, 'github', 'r1'), events: [] });
  await f.secrets.set('r1', 'mine');
  // The hook on the host carries another install's address
  f.answer((call) => (isGet(call) ? ok(hookJson(OTHER, { code: 204, status: 'active' })) : undefined));

  await f.service.follow('https://new456.lhr.life');
  assert.ok(!f.calls.some((c) => c.args.includes('PATCH')), 'not re-pointed');
  assert.equal(f.store.get('r1')?.state, 'stale');

  const removed = await f.service.remove('p1', 'r1');
  assert.equal(removed.state, 'removed');
  assert.ok(!f.calls.some((c) => c.args.includes('DELETE')), 'the shared hook is not deleted');
  assert.equal(f.service.secretOf('r1'), null);
});

test('two registrations of one repository at once share one hook and one answer', async () => {
  const f = fixture();
  f.answer((call) => (isList(call) ? pages([]) : isCreate(call) ? result(recorded('hook_create')) : undefined));
  const [a, b] = await Promise.all([f.service.register('p1'), f.service.register('p1')]);
  assert.equal(a.id, b.id);
  assert.equal(f.calls.filter(isCreate).length, 1);
  assert.equal(f.store.list('p1').length, 1);
  // Once settled, the next click is the ordinary refusal
  await assert.rejects(f.service.register('p1'), (e: unknown) => e instanceof WebhooksError && e.code === 'already-registered');
});

test('the listing reads every page, so a hook after the first thirty is found', async () => {
  const call = githubHooks.list(REPO);
  assert.deepEqual(call.args, ['api', '--hostname', 'github.com', '--paginate', '--slurp', `${HOOKS}?per_page=100`]);
  assert.equal(classifyCall(call), 'read');
  const page = (from: number, n: number): string[] => Array.from({ length: n }, (_, i) => hookJson('https://ci.example.com/h', { code: 200, status: 'active' }, String(from + i)));
  const hooks = githubHooks.parseHooks(pages(page(1, 30), page(31, 5)).stdout);
  assert.equal(hooks.length, 35);
  assert.equal(hooks.at(-1)?.id, '35');

  const f = fixture();
  f.answer((c) => (isList(c) ? pages(page(1, 30), [hookJson(OTHER, { code: 204, status: 'active' }, '77')]) : isCreate(c) ? result(recorded('hook_create')) : undefined));
  const registration = await f.service.register('p1');
  assert.match(registration.notice ?? '', /another Agentry install/, 'the hook on the second page was seen');
});

test("someone else's hook is never touched", async () => {
  const f = fixture();
  f.answer((call) =>
    isList(call) ? ok(`[${hookJson('https://ci.example.com/hooks/build', { code: 200, status: 'active' }, '42')}]`) : isCreate(call) ? result(recorded('hook_create')) : undefined,
  );
  const registration = await f.service.register('p1');
  assert.equal(registration.remoteHookId, HOOK);
  assert.ok(!f.calls.some((c) => argv(c).includes('/42')));
});

test('GitHub saying the hook exists adopts the one with this very address', async () => {
  const f = fixture();
  let lists = 0;
  f.answer((call) => {
    if (isList(call)) {
      lists += 1;
      if (lists === 1) return pages([]);
      const create = f.calls.find(isCreate);
      const url = (JSON.parse(create?.input ?? '') as { config: { url: string } }).config.url;
      return ok(`[${hookJson(url, { code: null, status: 'unused' })}]`);
    }
    if (isCreate(call)) return result(recorded('hook-create-dup'));
    if (isRepoint(call)) return ok(hookJson('x', { code: null, status: 'unused' }));
    return undefined;
  });
  const registration = await f.service.register('p1');
  assert.equal(registration.remoteHookId, HOOK);
  assert.equal(lists, 2);
});

test('registering is refused, with nothing run, for GitLab and for a missing public address or remote', async () => {
  const f = fixture();
  f.answer(() => undefined);
  f.state.target = { host: 'gitlab', hostname: 'gitlab.com', repoPath: 'g/p' };
  await assert.rejects(f.service.register('p1'), (e: unknown) => e instanceof WebhooksError && e.code === 'host-not-recorded');
  f.state.target = null;
  await assert.rejects(f.service.register('p1'), (e: unknown) => e instanceof WebhooksError && e.code === 'no-remote');
  f.state.target = { host: 'github', hostname: 'github.com', repoPath: REPO.path };
  f.state.origin = null;
  await assert.rejects(f.service.register('p1'), (e: unknown) => e instanceof WebhooksError && e.code === 'no-public-url');
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.list('p1').length, 0);
});

test('a refused or unseen repository becomes "no permission", and the secret kept for it goes', async () => {
  const f = fixture();
  f.answer((call) => (isList(call) ? pages([]) : isCreate(call) ? { ...result(recorded('hook_delete_again')) } : undefined));
  await assert.rejects(f.service.register('p1'), (e: unknown) => e instanceof WebhooksError && e.code === 'hook-no-permission' && e.status === 403);
  assert.equal(f.store.list('p1').length, 0);
  assert.equal(readFileSync(join(f.dataDir, 'webhook-secrets.json'), 'utf8'), '{}');
});

// ---------- the overview ----------

test('the overview says why a project has no hooks, and offers no GitLab action', async () => {
  const f = fixture();
  f.answer(() => undefined);
  f.state.target = { host: 'gitlab', hostname: 'gitlab.com', repoPath: 'g/p' };
  const gitlab = await f.service.overview('p1');
  assert.deepEqual([gitlab.available, gitlab.reason, gitlab.events, gitlab.canRedeliver], [false, 'host-not-recorded', [], false]);
  f.state.target = { host: 'github', hostname: 'github.com', repoPath: REPO.path };
  f.state.origin = null;
  assert.equal((await f.service.overview('p1')).reason, 'no-public-url');
  f.state.origin = ORIGIN;
  const ready = await f.service.overview('p1');
  assert.deepEqual([ready.available, ready.reason, ready.publicUrl], [true, null, ORIGIN]);
  assert.deepEqual(ready.events, [...GITHUB_HOOK_EVENTS]);
  assert.equal(f.calls.length, 0);
});

test('a hook gone quiet is read when the page is opened, at most every five minutes, and a failing one is said', async () => {
  const f = fixture();
  const reg = f.store.create({ id: 'r1', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: REPO.path, remoteHookId: HOOK, url: receiverUrl(ORIGIN, 'github', 'r1'), events: [] }, new Date(NOW - 3_600_000).toISOString());
  f.answer((call) => (isGet(call) ? ok(hookJson(reg.url, { code: 502, status: 'connection_error' })) : undefined));

  const first = await f.service.overview('p1');
  assert.equal(first.registrations[0]?.state, 'failing');
  assert.deepEqual(first.registrations[0]?.lastResponse, { code: 502, status: 'connection_error' });
  assert.equal(f.events.at(-1)?.type, 'webhook.changed');
  f.state.clock += 60_000;
  await f.service.overview('p1');
  assert.equal(f.calls.filter(isGet).length, 1, 'read once, not on every visit');
  f.state.clock += 5 * 60_000;
  await f.service.overview('p1');
  assert.equal(f.calls.filter(isGet).length, 2);
});

test('a hook that delivered a moment ago is not read at all', async () => {
  const f = fixture();
  f.store.create({ id: 'r1', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: REPO.path, remoteHookId: HOOK, url: 'https://x/', events: [] });
  f.store.update('r1', { lastDeliveryAt: new Date(NOW - 60_000).toISOString() });
  f.answer(() => undefined);
  await f.service.overview('p1');
  assert.equal(f.calls.length, 0);
});

// ---------- test ----------

test('a ping that GitHub reports answered makes the hook healthy for the pacer', async () => {
  const f = fixture();
  const reg = f.store.create({ id: 'r1', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: REPO.path, remoteHookId: HOOK, url: 'https://x/', events: [] });
  const url = 'https://github.com/yeyo11/app/pull/7';
  assert.equal(f.service.covers(url), false);
  let pinged = false;
  f.answer((call) => {
    if (isPing(call)) {
      pinged = true;
      return ok();
    }
    if (isGet(call)) return ok(hookJson(reg.url, pinged ? { code: 204, status: 'active', message: 'OK' } : { code: null, status: 'unused' }));
    return undefined;
  });
  const tested = await f.service.test('p1', 'r1');
  assert.equal(tested.state, 'active');
  assert.equal(tested.lastPingAt, new Date(NOW).toISOString());
  assert.equal(f.service.covers(url), true);
  assert.equal(f.service.covers('https://github.com/yeyo11/other/pull/7'), false);
  assert.equal(f.service.covers('https://gitlab.com/yeyo11/app/-/merge_requests/7'), false);
  f.state.clock += 31 * 60_000;
  assert.equal(f.service.covers(url), false, 'after 30 minutes without a delivery the hook no longer counts');
});

test('a ping that fails marks the hook failing and says why', async () => {
  const f = fixture();
  const reg = f.store.create({ id: 'r1', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: REPO.path, remoteHookId: HOOK, url: 'https://x/', events: [] });
  f.answer((call) => (isPing(call) ? ok() : isGet(call) ? ok(hookJson(reg.url, { code: 502, status: 'connection_error' })) : undefined));
  await assert.rejects(f.service.test('p1', 'r1'), (e: unknown) => e instanceof WebhooksError && e.code === 'hook-unreachable' && e.detail === '502 connection_error');
  assert.equal(f.store.get('r1')?.state, 'failing');
  assert.equal(f.service.covers('https://github.com/yeyo11/app/pull/7'), false);
});

test("testing another project's or an unknown registration is a 404", async () => {
  const f = fixture();
  f.store.create({ id: 'r1', projectId: 'p2', host: 'github', hostname: 'github.com', repoPath: REPO.path, remoteHookId: HOOK, url: 'https://x/', events: [] });
  f.answer(() => undefined);
  for (const id of ['r1', 'nope']) await assert.rejects(f.service.test('p1', id), (e: unknown) => e instanceof WebhooksError && e.status === 404);
  assert.equal(f.calls.length, 0);
});

// ---------- remove ----------

test('removing deletes the hook and the secret; a hook already gone on the host is not an error', async () => {
  const f = fixture();
  f.answer((call) => (isList(call) ? pages([]) : isCreate(call) ? result(recorded('hook_create')) : isGet(call) ? ok(hookJson(f.store.list('p1')[0]?.url ?? '', { code: 204, status: 'active' })) : isDelete(call) ? result(recorded('hook_delete_again')) : undefined));
  const registration = await f.service.register('p1');
  const removed = await f.service.remove('p1', registration.id);
  assert.equal(removed.state, 'removed');
  assert.equal(f.service.secretOf(registration.id), null, 'a removed registration verifies nothing');
  assert.equal(f.events.at(-1)?.type, 'webhook.changed');
});

test('a refused removal keeps the registration and its secret', async () => {
  const f = fixture();
  f.answer((call) => (isGet(call) ? ok(hookJson(receiverUrl(ORIGIN, 'github', 'r1'), { code: 204, status: 'active' })) : isDelete(call) ? { ...ok(), exitCode: 1, stdout: '{"message":"Forbidden","status":"403"}', stderrFirstLine: 'gh: Forbidden (HTTP 403)' } : undefined));
  const reg = f.store.create({ id: 'r1', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: REPO.path, remoteHookId: HOOK, url: 'https://x/', events: [] });
  await f.secrets.set(reg.id, 'keep');
  await assert.rejects(f.service.remove('p1', 'r1'), (e: unknown) => e instanceof WebhooksError && e.code === 'hook-no-permission');
  assert.equal(f.store.get('r1')?.state, 'active');
  assert.equal(f.service.secretOf('r1'), 'keep');
});

// ---------- a new public address ----------

test("a new public address re-points the hooks Agentry registered, by id, with the stored secret on stdin", async () => {
  const f = fixture();
  const a = f.store.create({ id: 'r1', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: REPO.path, remoteHookId: HOOK, url: receiverUrl(ORIGIN, 'github', 'r1'), events: [] });
  f.store.create({ id: 'r2', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: 'yeyo11/gone', remoteHookId: '7', url: receiverUrl(ORIGIN, 'github', 'r2'), events: [] });
  f.store.create({ id: 'r3', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: 'yeyo11/old', remoteHookId: '8', url: receiverUrl(ORIGIN, 'github', 'r3'), events: [] });
  f.store.update('r3', { state: 'removed' });
  await f.secrets.set('r1', 'secret-one');
  f.answer((call) => (call.args.includes('PATCH') ? result(recorded('hook_repoint')) : mineGet(call)));

  await f.service.follow('https://new456.lhr.life/');
  const patches = f.calls.filter((c) => c.args.includes('PATCH'));
  assert.equal(patches.length, 2, 'the removed registration is left alone');
  const first = patches.find((c) => isRepoint(c));
  assert.deepEqual(JSON.parse(first?.input ?? ''), { url: receiverUrl('https://new456.lhr.life', 'github', 'r1'), content_type: 'json', secret: 'secret-one', insecure_ssl: '0' });
  assert.ok(!argv(first as HostCall).includes('secret-one'));
  assert.equal(f.store.get('r1')?.url, receiverUrl('https://new456.lhr.life', 'github', 'r1'));
  assert.equal(f.store.get('r1')?.state, 'active');
  assert.ok(f.events.some((e) => e.type === 'webhook.changed'), 'Integrations can say when it did');
  assert.ok(a.updatedAt <= (f.store.get('r1')?.updatedAt ?? ''));

  // The same address again changes nothing
  const before = f.calls.length;
  await f.service.follow('https://new456.lhr.life');
  assert.equal(f.calls.length, before);
});

test('a hook that cannot be moved is marked stale, and is tried again when the address comes up again', async () => {
  const f = fixture();
  f.store.create({ id: 'r1', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: REPO.path, remoteHookId: HOOK, url: receiverUrl(ORIGIN, 'github', 'r1'), events: [] });
  let refuse = true;
  f.answer((call) => (!call.args.includes('PATCH') ? mineGet(call) : (refuse ? { ...ok(), exitCode: 1, stdout: '{"message":"Not Found","status":"404"}' } : result(recorded('hook_repoint')))));
  await f.service.follow('https://new456.lhr.life');
  assert.equal(f.store.get('r1')?.state, 'stale');
  assert.equal(f.store.get('r1')?.url, receiverUrl(ORIGIN, 'github', 'r1'), 'the old address is kept');
  refuse = false;
  await f.service.follow('https://new456.lhr.life');
  assert.equal(f.store.get('r1')?.state, 'active');
});

test('addresses that arrive while hooks are being moved collapse into one more batch for the latest', async () => {
  const f = fixture();
  f.store.create({ id: 'r1', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: REPO.path, remoteHookId: HOOK, url: receiverUrl(ORIGIN, 'github', 'r1'), events: [] });
  f.answer((call) => (call.args.includes('PATCH') ? result(recorded('hook_repoint')) : mineGet(call)));
  await Promise.all([f.service.follow('https://one.lhr.life'), f.service.follow('https://two.lhr.life'), f.service.follow('https://three.lhr.life')]);
  assert.equal(f.store.get('r1')?.url, receiverUrl('https://three.lhr.life', 'github', 'r1'));
  assert.ok(f.calls.filter((c) => c.args.includes('PATCH')).length <= 2);
});

test("only an active tunnel's address is followed", async () => {
  const f = fixture();
  f.store.create({ id: 'r1', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: REPO.path, remoteHookId: HOOK, url: receiverUrl(ORIGIN, 'github', 'r1'), events: [] });
  f.answer(() => undefined);
  const tunnel = (state: TunnelStatus['state'], url: string | null): AgentryEvent => ({ id: 1, at: '', type: 'tunnel.changed', title: '', tunnel: { state, url } as TunnelStatus }) as AgentryEvent;
  f.service.observe(tunnel('starting', null));
  f.service.observe(tunnel('verifying', 'https://new.lhr.life'));
  await f.service.follow('not a url');
  assert.equal(f.calls.length, 0);
});

// ---------- reachable ----------

test('the core hands the tunnel\'s events to the service, and its secret to the receiver', async (t) => {
  const config = tempConfig();
  roots.push(dirname(config.dataDir));
  const core = new Core(config);
  t.after(() => core.shutdown());
  assert.ok(core.webhookService instanceof WebhooksService);
  const reg = core.webhooks.create({ id: 'r1', projectId: 'no-such-project', host: 'github', hostname: 'github.com', repoPath: 'a/b', remoteHookId: '1', url: receiverUrl(ORIGIN, 'github', 'r1'), events: [] });
  assert.equal(core.webhookService.secretOf(reg.id), null, 'no secret was ever stored for it');
  const seen: AgentryEvent[] = [];
  core.events.subscribe((event) => seen.push(event));

  // The project is gone, so the hook cannot be reached: the registration is told so, through the bus
  core.events.emit({ type: 'tunnel.changed', title: 'Tunnel active', tunnel: { state: 'active', url: 'https://new789.lhr.life', since: null, reason: null, enabled: true, sshAvailable: true } as TunnelStatus });
  await core.webhookService.follow('https://new789.lhr.life');
  assert.equal(core.webhooks.get('r1')?.state, 'stale');
  assert.ok(seen.some((e) => e.type === 'webhook.changed'));
});

// ---------- golden: the order of the calls ----------

test('golden: the calls of registering, re-pointing and removing, in order', async () => {
  const f = fixture();
  f.answer((call) => (isList(call) ? pages([]) : isCreate(call) ? result(recorded('hook_create')) : undefined));
  const registration = await f.service.register('p1');
  // The hook on the host answers with the registration's own address
  f.answer((call) => (call.args.includes('PATCH') ? result(recorded('hook_repoint')) : isDelete(call) ? ok() : isGet(call) ? ok(hookJson(registration.url, { code: 204, status: 'active' })) : undefined));
  await f.service.follow('https://new456.lhr.life');
  await f.service.remove('p1', registration.id);
  assert.deepEqual(f.calls.map(argv), [
    `api --hostname github.com --paginate --slurp ${HOOKS}?per_page=100`,
    `api --hostname github.com -X POST ${HOOKS} --input -`,
    `api --hostname github.com ${HOOKS}/${HOOK}`,
    `api --hostname github.com -X PATCH ${HOOKS}/${HOOK}/config --input -`,
    `api --hostname github.com ${HOOKS}/${HOOK}`,
    `api --hostname github.com -X DELETE ${HOOKS}/${HOOK}`,
  ]);
});
