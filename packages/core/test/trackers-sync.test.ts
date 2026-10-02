import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentryEvent, ProjectTrackerSettings } from '@agentry/shared';
import { Db } from '../src/db.ts';
import type { HostCall, HostResult } from '../src/hosts/code-host.ts';
import type { TrackerAccess } from '../src/trackers/import.ts';
import { PullRequestError } from '../src/pull-requests.ts';
import { TrackerSyncService } from '../src/trackers/sync.ts';
import { WorkItemService } from '../src/work-items.ts';
import { tempConfig } from './helpers.ts';

// The sync against what glab recorded (fixtures/recordings/glab/1.120.0): a fake access answers the
// exact calls the GitLab adapter builds. The closed read is the recorded open one with its state
// turned over, since the recording closed and deleted its issue in between.

const here = dirname(fileURLToPath(import.meta.url));
const recorded = (label: string): string => readFileSync(join(here, 'fixtures/recordings/glab/1.120.0', `${label}.out`), 'utf8');
const OPEN = recorded('issue_view');
const CLOSED = OPEN.replace('"state":"opened"', '"state":"closed"');

const ok = (stdout: string): HostResult => ({ exitCode: 0, stdout, stderrFirstLine: '', http: null, truncated: false, durationMs: 1 });
const failed = (stdout: string, stderrFirstLine = ''): HostResult => ({ exitCode: 1, stdout, stderrFirstLine, http: null, truncated: false, durationMs: 1 });

interface Opts {
  statusMap?: ProjectTrackerSettings['statusMap'];
  /** What a read answers, in order; the last one repeats */
  reads?: HostResult[];
  close?: HostResult;
  accessFails?: boolean;
}

function setup(opts: Opts = {}) {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const items = new WorkItemService({ db, project: (id) => (id === 'p1' ? { keyPrefix: 'AGN', columnLimits: {} } : null) });
  const calls: HostCall[] = [];
  const reads = [...(opts.reads ?? [ok(OPEN)])];
  const tracker: ProjectTrackerSettings = { id: 'gitlab-issues', scope: 'yeyo11/agentry', query: '', statusMap: opts.statusMap ?? { done: 'closed' } };
  const access: TrackerAccess = {
    host: 'gitlab',
    hostname: 'gitlab.com',
    repo: { host: 'gitlab.com', path: 'yeyo11/agentry', owner: 'yeyo11', name: 'agentry' },
    run: async (call) => {
      calls.push(call);
      if (call.args[1] === 'view') return (reads.length > 1 ? reads.shift() : reads[0]) as HostResult;
      if (call.args[1] === 'close') return opts.close ?? ok(recorded('issue_close'));
      throw new Error(`unexpected call: ${call.args.join(' ')}`);
    },
  };
  const service = new TrackerSyncService({
    items,
    project: (id) => (id === 'p1' ? { path: '/p', tracker } : null),
    access: async () => {
      if (opts.accessFails) throw new PullRequestError('signed out', 409, 'signed-out');
      return access;
    },
  });
  const item = items.create('p1', { title: 'Do it' }, undefined, { tracker: 'gitlab-issues', key: '4', externalId: null, title: 'probe', state: 'open', url: null });
  const writes = () => calls.filter((c) => c.kind === 'write');
  const reading = () => calls.filter((c) => c.args[1] === 'view');
  const issue = () => items.get(item.id).issues?.[0];
  return { items, service, item, calls, writes, reading, issue };
}

const moved = (itemId: string, status: 'in_progress' | 'in_review' | 'done', previousStatus: 'backlog' | 'in_progress'): AgentryEvent =>
  ({ type: 'workitem.moved', id: 1, at: '', title: '', projectId: 'p1', itemId, key: 'AGN-1', status, previousStatus, overLimit: false, actor: { kind: 'person' }, cause: null }) as unknown as AgentryEvent;

test('a merge into a non-default base closes the issue once, reading before and after', async () => {
  const s = setup({ reads: [ok(OPEN), ok(CLOSED)] });
  await s.service.merged({ itemId: s.item.id, closingWord: false, host: 'gitlab' });
  assert.equal(s.writes().length, 1);
  assert.deepEqual(s.writes()[0]?.args, ['issue', 'close', '4', '-R', 'https://gitlab.com/yeyo11/agentry']);
  assert.equal(s.reading().length, 2);
  assert.equal(s.issue()?.syncState, 'synced');
  assert.equal(s.issue()?.state, 'closed');
  assert.ok(s.issue()?.syncedAt);
});

test('a merge whose closing word worked closes nothing: an issue the host already closed is only noted', async () => {
  const s = setup({ reads: [ok(CLOSED)] });
  await s.service.merged({ itemId: s.item.id, closingWord: true, host: 'gitlab' });
  assert.equal(s.writes().length, 0);
  assert.equal(s.issue()?.syncState, 'synced');
  assert.equal(s.issue()?.state, 'closed');
});

test('a closing word that has not shown yet is left to the host: the issue reads open, with nothing synced', async () => {
  const s = setup({ reads: [ok(OPEN)] });
  await s.service.merged({ itemId: s.item.id, closingWord: true, host: 'gitlab' });
  assert.equal(s.writes().length, 0);
  assert.equal(s.issue()?.syncState, 'none');
  assert.equal(s.issue()?.syncedAt, null);
  assert.equal(s.issue()?.state, 'open');
});

test('a closing word of another host does not count: the issue is closed by the sync', async () => {
  const s = setup({ reads: [ok(OPEN), ok(CLOSED)] });
  await s.service.merged({ itemId: s.item.id, closingWord: true, host: 'github' });
  assert.equal(s.writes().length, 1);
});

test('nothing is synced for a column the project did not map', async () => {
  const s = setup({ statusMap: {} });
  await s.service.merged({ itemId: s.item.id, closingWord: false, host: 'gitlab' });
  assert.equal(s.calls.length, 0);
  assert.equal(s.issue()?.syncState, 'none');
});

test('a failed write is shown on the issue with its reason, and is not retried', async () => {
  const s = setup({ close: failed('', 'HTTP 403'), reads: [ok(OPEN)] });
  await s.service.merged({ itemId: s.item.id, closingWord: false, host: 'gitlab' });
  assert.equal(s.writes().length, 1, 'one write, never retried');
  assert.equal(s.issue()?.syncState, 'failed');
  assert.equal(s.issue()?.syncReason, 'unreachable');
});

test('a write that exits 0 but leaves the issue open is write-unconfirmed', async () => {
  const s = setup({ reads: [ok(OPEN)] });
  await s.service.merged({ itemId: s.item.id, closingWord: false, host: 'gitlab' });
  assert.equal(s.issue()?.syncState, 'failed');
  assert.equal(s.issue()?.syncReason, 'write-unconfirmed');
});

test('a host that cannot be reached fails the sync with the tracker-signed-out reason', async () => {
  const s = setup({ accessFails: true });
  await s.service.merged({ itemId: s.item.id, closingWord: false, host: 'gitlab' });
  assert.equal(s.issue()?.syncState, 'failed');
  assert.equal(s.issue()?.syncReason, 'tracker-signed-out');
});

test('Sync again tries once more, and refuses an unlinked key, an unmapped column or a column with nothing to sync', async () => {
  const s = setup({ reads: [ok(OPEN), ok(CLOSED)] });
  s.items.move(s.item.id, { status: 'done' });
  const item = await s.service.syncAgain(s.item.id, 'gitlab-issues', '4');
  assert.equal(item.issues?.[0]?.syncState, 'synced');
  assert.equal(s.writes().length, 1);
  await assert.rejects(() => s.service.syncAgain(s.item.id, 'gitlab-issues', '9'), /not linked/);

  const unmapped = setup({ statusMap: {} });
  unmapped.items.move(unmapped.item.id, { status: 'done' });
  await assert.rejects(() => unmapped.service.syncAgain(unmapped.item.id, 'gitlab-issues', '4'), /does not map done/);

  const backlog = setup();
  await assert.rejects(() => backlog.service.syncAgain(backlog.item.id, 'gitlab-issues', '4'), /nothing to sync/);
  assert.equal(backlog.calls.length, 0);
});

test('Sync again after a failure replaces it', async () => {
  const s = setup({ close: failed('', 'x'), reads: [ok(OPEN)] });
  s.items.move(s.item.id, { status: 'done' });
  await s.service.merged({ itemId: s.item.id, closingWord: false, host: 'gitlab' });
  assert.equal(s.issue()?.syncState, 'failed');
  const item = await s.service.syncAgain(s.item.id, 'gitlab-issues', '4');
  assert.equal(item.issues?.[0]?.syncState, 'failed');
  assert.equal(s.writes().length, 2, 'one write per click, none on its own');
});

test('a move to In progress, In review or Done writes nothing on GitLab: one status, and only a merge closes', async () => {
  const s = setup({ statusMap: { done: 'closed' } });
  s.service.observe(moved(s.item.id, 'in_progress', 'backlog'));
  s.service.observe(moved(s.item.id, 'done', 'in_progress'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.calls.length, 0);
});
