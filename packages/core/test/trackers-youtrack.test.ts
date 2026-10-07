import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentryEvent, CodeHostStatus, ProjectTrackerSettings } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { classifyCall, reasonOf } from '../src/hosts/classify.ts';
import { HostParseError, type HostCall, type HostRepo } from '../src/hosts/code-host.ts';
import type { HostResult } from '../src/hosts/exec.ts';
import { trackerAdapter } from '../src/trackers/adapters.ts';
import { TrackerDetector, type OwnTrackerRun } from '../src/trackers/detector.ts';
import { issueType, type TrackerAccess } from '../src/trackers/import.ts';
import { TrackerRegistry } from '../src/trackers/registry.ts';
import { TrackerSyncService } from '../src/trackers/sync.ts';
import { TrackerInputError } from '../src/trackers/tracker.ts';
import { youtrackAdapter, youtrackIssueUrl, youtrackKey, youtrackQuery } from '../src/trackers/youtrack/adapter.ts';
import { normalizeYoutrackHost, YoutrackCredentialStore } from '../src/trackers/youtrack/credentials.ts';
import { WorkItemService } from '../src/work-items.ts';
import { tempConfig } from './helpers.ts';

// YouTrack against what youtrack-app 1.0.3 was recorded to take and print on a YouTrack 2026.2
// instance (fixtures/recordings/youtrack-app/1.0.3, NOTES.md there). The adapter's calls are replayed
// through fake-cli.mjs, which answers only an argv it has: a changed argument exits 97 and fails.

const here = dirname(fileURLToPath(import.meta.url));
const recordingDir = join(here, 'fixtures/recordings/youtrack-app/1.0.3');
const out = (label: string): string => readFileSync(join(recordingDir, `${label}.out`), 'utf8');

const scope: HostRepo = { host: 'http://127.0.0.1:8090', path: 'AGP', owner: '', name: 'AGP' };

function replay(call: HostCall, label?: string): HostResult {
  const run = spawnSync(process.execPath, [join(here, 'fixtures/fake-cli.mjs'), ...call.args], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_CLI: 'youtrack-app', ...(label ? { FAKE_CLI_LABELS: label } : {}) },
  });
  assert.notEqual(run.status, 97, `unrecorded call: ${run.stderr}`);
  return { exitCode: run.status, stdout: run.stdout, stderrFirstLine: run.stderr.split('\n')[0] ?? '', http: null, truncated: false, durationMs: 1 };
}

// ---------- the adapter ----------

test('youtrack has an adapter, reached through youtrack-app with no code host of its own', () => {
  assert.equal(trackerAdapter('youtrack'), youtrackAdapter);
  assert.equal(youtrackAdapter.host, null);
  assert.equal(youtrackAdapter.cli, 'youtrack-app');
  assert.equal(youtrackAdapter.namedStatuses, true);
  assert.equal(trackerAdapter('jira'), null);
});

test('an issue id is a short name, a dash and a number, upper cased; anything else is refused before a call', () => {
  assert.equal(youtrackKey('agp-12'), 'AGP-12');
  assert.equal(youtrackKey(' AGP-1 '), 'AGP-1');
  for (const bad of ['', '12', '#12', 'AGP-0', 'AGP-', '-AGP-1', '--path=/api/admin', 'AGP-1 --method DELETE', 'AGP-1/comments', '../AGP-1', 'AGP-1?fields=x', 'AGP 1']) {
    assert.throws(() => youtrackKey(bad), TrackerInputError, bad);
    assert.throws(() => youtrackAdapter.get(scope, bad), TrackerInputError, bad);
    assert.throws(() => youtrackAdapter.setStatus(scope, bad, { column: 'done', name: 'Done' }), TrackerInputError, bad);
  }
});

test('a list asks for the project, unresolved issues by default, in a stable order, one page of 100', () => {
  assert.equal(youtrackQuery(scope, ''), 'project: AGP #Unresolved order by: updated desc');
  assert.equal(youtrackQuery(scope, 'summary: probe'), 'project: AGP summary: probe order by: updated desc');
  assert.equal(youtrackQuery(scope, 'Type: Bug sort by: created asc'), 'project: AGP Type: Bug sort by: created asc');
  const call = youtrackAdapter.list(scope, { query: '', page: 3 });
  const path = new URL(`http://x${call.args[3] ?? ''}`);
  assert.deepEqual(call.args.slice(0, 3), ['rest', 'request', '--path']);
  assert.equal(path.searchParams.get('$top'), '100');
  assert.equal(path.searchParams.get('$skip'), '200');
  assert.throws(() => youtrackAdapter.list(scope, { query: '', page: 0 }), TrackerInputError);
  assert.throws(() => youtrackAdapter.list({ ...scope, path: 'A/B' }, { query: '', page: 1 }), TrackerInputError);
});

test('a hostile query stays inside the encoded path: one argv word, never a flag, a method or a body', () => {
  for (const query of ['--method DELETE', '&$top=1&fields=x', 'State: Done\n--body {}', '$(rm -rf ~)', '#Unresolved tag: x']) {
    const call = youtrackAdapter.list(scope, { query, page: 1 });
    assert.equal(call.args.length, 4, query);
    assert.ok(!call.args.includes('--method') && !call.args.includes('--body'), query);
    assert.equal(new URL(`http://x${call.args[3] ?? ''}`).searchParams.get('query'), `project: AGP ${query.trim()} order by: updated desc`);
  }
});

test('every call is pinned to the instance and classified as it declares: reads read, a status is a write', () => {
  const calls: HostCall[] = [youtrackAdapter.list(scope, { query: 'x', page: 1 }), youtrackAdapter.get(scope, 'AGP-1')];
  for (const call of calls) {
    assert.equal(call.host, scope.host);
    assert.equal(call.kind, 'read');
    assert.equal(classifyCall(call), 'read');
  }
  const write = youtrackAdapter.setStatus(scope, 'AGP-1', { column: 'in_progress', name: 'In Progress' });
  assert.ok(write);
  assert.equal(write.kind, 'write');
  assert.equal(classifyCall(write), 'write');
  assert.equal(write.input, undefined);
});

test('a status is the State field set to the mapped name, carried as JSON so a name cannot add a command', () => {
  assert.equal(youtrackAdapter.setStatus(scope, 'AGP-1', { column: 'done', name: null }), null);
  assert.equal(youtrackAdapter.setStatus(scope, 'AGP-1', { column: 'done', name: '  ' }), null);
  for (const column of ['in_progress', 'in_review', 'done'] as const) assert.equal(youtrackAdapter.writes(column), true);
  const call = youtrackAdapter.setStatus(scope, 'AGP-1', { column: 'done', name: 'Done tag evil' });
  assert.ok(call);
  const body = JSON.parse(call.args[call.args.indexOf('--body') + 1] ?? '') as { customFields: Array<{ name: string; value: { name: string } }> };
  assert.deepEqual(body.customFields, [{ name: 'State', $type: 'StateIssueCustomField', value: { name: 'Done tag evil' } }]);
});

// ---------- replayed from the recordings ----------

test('the recorded list reads the project issues, with State, Type and tags', () => {
  const result = replay(youtrackAdapter.list(scope, { query: '', page: 1 }), 'yt_list');
  assert.equal(result.exitCode, 0);
  const page = youtrackAdapter.parseList(result.stdout, { query: '', page: 1 });
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.issues.map((i) => i.key).sort(), ['AGP-1', 'AGP-2']);
  for (const issue of page.issues) {
    assert.equal(issue.state, 'open');
    assert.equal(issue.status, 'Open');
    assert.match(issue.updatedAt ?? '', /^2026-/);
    assert.equal(issue.url, null);
  }
  const bug = page.issues.find((i) => i.key === 'AGP-2');
  assert.equal(bug?.kind, 'Bug');
  assert.equal(issueType(bug?.labels ?? [], bug?.kind ?? null), 'bug');
});

test('a page past the end is empty, and a query YouTrack cannot parse exits 2', () => {
  const empty = replay(youtrackAdapter.list(scope, { query: '', page: 2 }));
  assert.deepEqual(youtrackAdapter.parseList(empty.stdout, { query: '', page: 2 }).issues, []);
  const bad = replay(youtrackAdapter.list(scope, { query: 'project: (((', page: 1 }));
  assert.equal(bad.exitCode, 2);
  assert.equal(bad.stdout, '');
});

test('the recorded issue reads with its body, its id and its state; a missing one is exit 4, not found', () => {
  const issue = youtrackAdapter.parseGet(replay(youtrackAdapter.get(scope, 'agp-1'), 'yt_get').stdout);
  assert.equal(issue.key, 'AGP-1');
  assert.equal(issue.title, 'Probe issue one (edited)');
  assert.equal(issue.body, 'Edited body');
  assert.match(issue.externalId ?? '', /^\d+-\d+$/);
  const missing = replay(youtrackAdapter.get(scope, 'AGP-999'));
  assert.equal(missing.exitCode, 4);
  assert.equal(reasonOf({ ...missing, reason: undefined }, 'youtrack-app'), 'not-found');
});

test('a status write answers with the issue as it is after it: resolved only for a resolved State', () => {
  const progress = youtrackAdapter.parseGet(replay(youtrackAdapter.setStatus(scope, 'AGP-1', { column: 'in_progress', name: 'In Progress' }) as HostCall).stdout);
  assert.equal(progress.status, 'In Progress');
  assert.equal(progress.state, 'open');
  const done = youtrackAdapter.parseGet(replay(youtrackAdapter.setStatus(scope, 'AGP-1', { column: 'done', name: 'Done' }) as HostCall).stdout);
  assert.equal(done.status, 'Done');
  assert.equal(done.state, 'closed');
  const invalid = replay(youtrackAdapter.setStatus(scope, 'AGP-1', { column: 'done', name: 'Nonsense' }) as HostCall);
  assert.equal(invalid.exitCode, 4);
});

test('the parsers refuse what is not an issue', () => {
  for (const stdout of ['', 'not json', 'null', '42', '{}', '[{}]', '{"idReadable":"AGP-1"}', '{"idReadable":"x","summary":"s"}', '{"idReadable":"AGP-1","summary":"s","resolved":"yes"}']) {
    assert.throws(() => youtrackAdapter.parseGet(stdout), HostParseError, stdout);
  }
  for (const stdout of ['', '{}', '"x"', '[{"summary":"s"}]']) assert.throws(() => youtrackAdapter.parseList(stdout, { query: '', page: 1 }), HostParseError, stdout);
});

test('an issue address is the instance address, its path kept, and /issue/<id>', () => {
  assert.equal(youtrackIssueUrl('https://acme.youtrack.cloud/', 'AGP-1'), 'https://acme.youtrack.cloud/issue/AGP-1');
  assert.equal(youtrackIssueUrl('https://example.com/youtrack', 'AGP-1'), 'https://example.com/youtrack/issue/AGP-1');
});

// ---------- the credentials ----------

test('the address is kept with its path and without a trailing slash; anything that is not an address is refused', () => {
  assert.equal(normalizeYoutrackHost(' https://example.com/youtrack/ '), 'https://example.com/youtrack');
  assert.equal(normalizeYoutrackHost('https://acme.youtrack.cloud'), 'https://acme.youtrack.cloud');
  for (const bad of ['', 'acme.youtrack.cloud', 'ftp://x', 'https://u:p@x.com', 'https://x.com/?a=1', 'https://x.com/#a']) assert.throws(() => normalizeYoutrackHost(bad), Error, bad);
});

test('the token is saved 0600, sealed with the desktop key when there is one, and never told back', async () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const key = 'ab'.repeat(32);
  const store = new YoutrackCredentialStore({ ...config, secretKey: key });
  assert.deepEqual(store.status(), { host: null, tokenSet: false, encrypted: true });
  await assert.rejects(store.set({ host: 'https://x.youtrack.cloud' }), /token is required/);
  await assert.rejects(store.set({ host: 'https://x.youtrack.cloud', token: 'perm a b' }), (err: Error) => !err.message.includes('perm a b'));
  const status = await store.set({ host: 'https://x.youtrack.cloud/', token: 'perm-secret' });
  assert.deepEqual(status, { host: 'https://x.youtrack.cloud', tokenSet: true, encrypted: true });
  const file = join(config.dataDir, 'youtrack-credentials.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, 'utf8').includes('perm-secret'));
  // Another start with the same key opens it; without the key the token is as good as absent
  assert.deepEqual(new YoutrackCredentialStore({ ...config, secretKey: key }).get(), { host: 'https://x.youtrack.cloud', token: 'perm-secret' });
  assert.equal(new YoutrackCredentialStore({ dataDir: config.dataDir }).get(), null);
  // Changing only the address keeps the token
  await store.set({ host: 'https://y.youtrack.cloud' });
  assert.deepEqual(store.get(), { host: 'https://y.youtrack.cloud', token: 'perm-secret' });
  assert.deepEqual(store.clear(), { host: null, tokenSet: false, encrypted: true });
  assert.equal(new YoutrackCredentialStore({ ...config, secretKey: key }).get(), null);
});

test('on a server the token is a plain 0600 file, and the status says it is not encrypted', async () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const store = new YoutrackCredentialStore({ dataDir: config.dataDir });
  const status = await store.set({ host: 'https://x.youtrack.cloud', token: 'perm-plain' });
  assert.equal(status.encrypted, false);
  assert.ok(readFileSync(join(config.dataDir, 'youtrack-credentials.json'), 'utf8').includes('perm-plain'));
});

// ---------- detection ----------

const result = (exitCode: number | null, stdout = '', reason?: HostResult['reason']): HostResult => ({ exitCode, stdout, stderrFirstLine: '', http: null, truncated: false, durationMs: 1, ...(reason ? { reason } : {}) });

/** A program the detector can find; what it answers is the stub's */
const program = join(tmpdir(), `agentry-youtrack-app-${String(process.pid)}`);
writeFileSync(program, '#!/bin/sh\nexit 0\n');
chmodSync(program, 0o755);
after(() => rmSync(program, { force: true }));

function detector(opts: { binary?: boolean; credentials?: boolean; version?: HostResult; me?: HostResult }) {
  const calls: Array<{ args: string[]; secrets: Record<string, string> }> = [];
  const ownRun: OwnTrackerRun = async (call, _where, secrets) => {
    calls.push({ args: call.args, secrets });
    if (call.args[0] === '--version') return opts.version ?? result(0, out('version'));
    return opts.me ?? result(0, out('yt_me'));
  };
  const hosts: CodeHostStatus[] = [];
  const d = new TrackerDetector({
    registry: new TrackerRegistry(),
    hosts: { statuses: async () => hosts, refresh: async () => hosts },
    adapter: () => undefined,
    resolvePath: async () => (opts.binary === false ? '/nowhere' : join(here, 'fixtures')),
    settings: () => (opts.binary === false ? null : { trackers: { 'github-issues': { enabled: true, binaryPath: null }, 'gitlab-issues': { enabled: true, binaryPath: null }, jira: { enabled: true, binaryPath: null }, youtrack: { enabled: true, binaryPath: program } } }),
    youtrackCredentials: () => (opts.credentials === false ? null : { host: 'https://x.youtrack.cloud', token: 'perm-t' }),
    ownRun,
  });
  return { d, calls };
}

test('youtrack is ready when the binary is at least the recorded release and the instance takes the token', async () => {
  const { d, calls } = detector({});
  const status = await d.status('youtrack');
  assert.equal(status?.state, 'ready');
  assert.equal(status?.reason, null);
  assert.equal(status?.version, '1.0.3');
  assert.equal(status?.minimum, '1.0.3');
  assert.deepEqual(status?.recorded, ['1.0.3']);
  assert.equal(status?.user, 'admin');
  // The token travels in the environment of the sign-in probe only, never in argv
  const me = calls.find((c) => c.args[0] === 'rest');
  assert.deepEqual(me?.secrets, { YOUTRACK_HOST: 'https://x.youtrack.cloud', YOUTRACK_TOKEN: 'perm-t' });
  assert.ok(calls.every((c) => !c.args.some((a) => a.includes('perm-t'))));
  assert.deepEqual(calls.find((c) => c.args[0] === '--version')?.secrets, {});
});

test('youtrack says what is missing: the program, the credentials, a refused token, an instance that does not answer', async () => {
  assert.equal((await detector({ binary: false }).d.status('youtrack'))?.state, 'not-installed');
  assert.deepEqual(pick(await detector({ credentials: false }).d.status('youtrack')), { state: 'signed-out', reason: 'no-credentials' });
  assert.deepEqual(pick(await detector({ me: result(3) }).d.status('youtrack')), { state: 'signed-out', reason: 'token-rejected' });
  // `fetch failed`, exit 5 (recorded with the instance stopped)
  assert.deepEqual(pick(await detector({ me: result(5) }).d.status('youtrack')), { state: 'unknown', reason: 'host-unreachable' });
  assert.deepEqual(pick(await detector({ me: result(null, '', 'timeout') }).d.status('youtrack')), { state: 'unknown', reason: 'timeout' });
  assert.deepEqual(pick(await detector({ version: result(0, '1.0.2\n') }).d.status('youtrack')), { state: 'incompatible', reason: 'below-minimum' });
  assert.deepEqual(pick(await detector({ version: result(0, 'nonsense') }).d.status('youtrack')), { state: 'unknown', reason: 'probe-failed' });
  // Jira stays as it was: listed, not recorded, never probed
  assert.deepEqual(pick(await detector({}).d.status('jira')), { state: 'unknown', reason: 'not-recorded' });
});

test('a status read spawns nothing after the first; a refresh or new credentials probe again', async () => {
  const { d, calls } = detector({});
  await d.statuses();
  await d.statuses();
  assert.equal(calls.length, 2);
  await d.credentialsChanged('youtrack');
  assert.equal(calls.length, 4);
  await d.refresh();
  assert.equal(calls.length, 6);
});

function pick(status: { state: string; reason: string | null } | null) {
  return status ? { state: status.state, reason: status.reason } : null;
}

// ---------- the sync, with named statuses ----------

function syncSetup(reads: HostResult[], write: HostResult, statusMap: ProjectTrackerSettings['statusMap'] = { in_progress: 'In Progress', in_review: 'To Verify', done: 'Done' }) {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const items = new WorkItemService({ db, project: (id) => (id === 'p1' ? { keyPrefix: 'AGN', columnLimits: {} } : null) });
  const calls: HostCall[] = [];
  const queue = [...reads];
  const tracker: ProjectTrackerSettings = { id: 'youtrack', scope: 'AGP', query: '', statusMap };
  const access: TrackerAccess = {
    host: null,
    hostname: 'https://x.youtrack.cloud',
    repo: null,
    run: async (call) => {
      calls.push(call);
      if (call.kind === 'write') return write;
      return (queue.length > 1 ? queue.shift() : queue[0]) as HostResult;
    },
    issueUrl: (key) => youtrackIssueUrl('https://x.youtrack.cloud', key),
  };
  const service = new TrackerSyncService({ items, project: (id) => (id === 'p1' ? { path: '/p', tracker } : null), access: async () => access });
  const item = items.create('p1', { title: 'Do it' }, undefined, { tracker: 'youtrack', scope: 'AGP', key: 'AGP-1', externalId: null, title: 'probe', state: 'Open', url: null });
  return { items, service, item, calls, issue: () => items.get(item.id).issues?.[0] };
}

const moved = (itemId: string, status: 'in_progress' | 'in_review'): AgentryEvent =>
  ({ type: 'workitem.moved', id: 1, at: '', title: '', projectId: 'p1', itemId, key: 'AGN-1', status, previousStatus: 'todo', overLimit: false, actor: { kind: 'person' }, cause: null }) as unknown as AgentryEvent;

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

test('moving to In progress sets the mapped State once and confirms it by name', async () => {
  const s = syncSetup([result(0, out('yt_get_bug').replace('"AGP-2"', '"AGP-1"')), result(0, out('yt_set_progress'))], result(0, out('yt_set_progress')));
  s.service.observe(moved(s.item.id, 'in_progress'));
  await settled();
  const writes = s.calls.filter((c) => c.kind === 'write');
  assert.equal(writes.length, 1);
  assert.ok(writes[0]?.args.includes('/api/issues/AGP-1?fields=idReadable,id,summary,description,resolved,updated,project(shortName),tags(name),customFields(name,value(name))'));
  assert.equal(s.issue()?.syncState, 'synced');
  assert.equal(s.issue()?.state, 'In Progress');
});

test('an issue already in the mapped State is not written again', async () => {
  const s = syncSetup([result(0, out('yt_set_progress'))], result(0, ''));
  s.service.observe(moved(s.item.id, 'in_progress'));
  await settled();
  assert.equal(s.calls.filter((c) => c.kind === 'write').length, 0);
  assert.equal(s.issue()?.syncState, 'synced');
});

test('a State the project does not have is transition-unknown, and a read that does not show the name is unconfirmed', async () => {
  const open = result(0, out('yt_get_bug').replace('"AGP-2"', '"AGP-1"'));
  const refused = syncSetup([open], result(4));
  refused.service.observe(moved(refused.item.id, 'in_review'));
  await settled();
  assert.deepEqual([refused.issue()?.syncState, refused.issue()?.syncReason], ['failed', 'transition-unknown']);
  const unconfirmed = syncSetup([open, open], result(0, ''));
  unconfirmed.service.observe(moved(unconfirmed.item.id, 'in_review'));
  await settled();
  assert.deepEqual([unconfirmed.issue()?.syncState, unconfirmed.issue()?.syncReason], ['failed', 'write-unconfirmed']);
});

test('a merge moves the issue to the State mapped to done, and a token refused on the write says so', async () => {
  const s = syncSetup([result(0, out('yt_set_review')), result(0, out('yt_set_done'))], result(0, out('yt_set_done')));
  await s.service.merged({ itemId: s.item.id, host: 'github', closed: [] });
  assert.equal(s.issue()?.syncState, 'synced');
  assert.equal(s.issue()?.state, 'Done');
  const denied = syncSetup([result(0, out('yt_set_review'))], result(3));
  await denied.service.merged({ itemId: denied.item.id, host: 'github', closed: [] });
  assert.deepEqual([denied.issue()?.syncState, denied.issue()?.syncReason], ['failed', 'auth-failed']);
});
