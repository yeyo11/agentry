import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Db } from '../src/db.ts';
import type { AgentryEventInput } from '../src/events.ts';
import { ChecksError, ChecksService, SNAPSHOT_TTL, type ChecksTarget } from '../src/hosts/checks-service.ts';
import type { HostCall, HostRepo } from '../src/hosts/code-host.ts';
import type { HostResult } from '../src/hosts/exec.ts';
import { githubAdapter } from '../src/hosts/github/adapter.ts';
import { gitlabAdapter } from '../src/hosts/gitlab/adapter.ts';
import { tempConfig } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const gl = (file: string): string => readFileSync(join(here, 'fixtures/recordings/glab/1.120.0', file), 'utf8');
const GOLDEN = join(here, 'fixtures/golden/phase2');

const glRepo: HostRepo = { host: 'gitlab.com', path: 'yeyo11/agentry', owner: 'yeyo11', name: 'agentry', projectId: 87089091 };
const ghRepo: HostRepo = { host: 'github.com', path: 'acme/shop', owner: 'acme', name: 'shop' };

const ok = (stdout: string): HostResult => ({ exitCode: 0, stdout, stderrFirstLine: '', http: null, truncated: false, durationMs: 1 });
const failed = (exitCode: number, stderr = 'boom', reason?: HostResult['reason']): HostResult => ({ exitCode, stdout: '', stderrFirstLine: stderr, http: null, truncated: false, durationMs: 1, ...(reason ? { reason } : {}) });

const roots: string[] = [];
function database(): Db {
  const config = tempConfig();
  roots.push(dirname(config.dataDir));
  return new Db(config);
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  service: ChecksService;
  calls: string[];
  events: AgentryEventInput[];
  clock: { now: number };
  /** Answers by the end of a call's argv; the first rule whose pattern matches, most recent first */
  answer: (pattern: RegExp, result: HostResult | (() => HostResult | Promise<HostResult>)) => void;
}

function harness(adapter: ChecksTarget['adapter'], repo: HostRepo, version: string | null = null): Harness {
  const db = database();
  const rules: Array<{ pattern: RegExp; result: HostResult | (() => HostResult | Promise<HostResult>) }> = [];
  const calls: string[] = [];
  const events: AgentryEventInput[] = [];
  const clock = { now: Date.parse('2026-10-01T12:00:00Z') };
  const run = async (call: HostCall): Promise<HostResult> => {
    const line = `${call.cli} ${call.args.join(' ')}`;
    calls.push(line);
    const rule = rules.find((r) => r.pattern.test(line));
    if (!rule) return failed(97, `unrecorded call: ${line}`);
    return typeof rule.result === 'function' ? rule.result() : rule.result;
  };
  const target: ChecksTarget = { id: 'cr-1', kind: 'work-item', adapter, repo, number: 12, branch: 'probe/k0', base: 'main', cliVersion: version, run };
  const service = new ChecksService({ db: db.connection, resolve: async (id) => (id === 'cr-1' ? target : null), emit: (e) => events.push(e), now: () => clock.now });
  return { service, calls, events, clock, answer: (pattern, result) => rules.unshift({ pattern, result }) };
}

/** The GitLab project as k0 recorded it: a head pipeline with a failing, an allowed, a manual and a running job and a child pipeline */
function gitlab(): Harness {
  const h = harness(gitlabAdapter, glRepo);
  h.answer(/mr view 12/, ok(gl('mrview_after_post.out')));
  h.answer(/projects\/87089091\/pipelines\/2900799542\/jobs/, ok(gl('jobs_ndjson.out')));
  h.answer(/projects\/87089091\/pipelines\/2900799542\/bridges/, ok(gl('bridges_child.out')));
  h.answer(/projects\/87089091\/pipelines\/2900783186\/jobs/, ok(gl('child_jobs.out')));
  return h;
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

// ---------- the list and its snapshot ----------

test('the list reads the change request, the jobs and the child pipelines, and the golden log holds the argv', async () => {
  const h = gitlab();
  const list = await h.service.list('cr-1');
  assert.equal(list.headSha, '6e0dab83d5074227e4d2827ebb745edf1aa2c943');
  assert.equal(list.rollup, 'pending');
  assert.deepEqual(
    list.checks.slice(0, 5).map((c) => [c.name, c.state]),
    [['probe-manual', 'manual'], ['probe-allowed', 'failed'], ['probe-fail', 'failed'], ['probe-sleep', 'running'], ['probe-child', 'failed']],
  );
  assert.ok(list.checks.some((c) => c.group === 'probe-child › test'), 'the child pipeline is read in a second round');
  assert.equal(list.truncated, false);
  golden('checks-service-gitlab-list', h.calls);
});

test('a second read inside 30 s is the snapshot; after it, or on refresh, the host is asked again', async () => {
  const h = gitlab();
  const first = await h.service.list('cr-1');
  const used = h.calls.length;
  assert.deepEqual(await h.service.list('cr-1'), first);
  assert.equal(h.calls.length, used);
  h.clock.now += SNAPSHOT_TTL + 1;
  await h.service.list('cr-1');
  assert.ok(h.calls.length > used);
  const again = h.calls.length;
  await h.service.list('cr-1', { refresh: true });
  assert.ok(h.calls.length > again);
});

test('readers at the same moment share one read', async () => {
  const h = gitlab();
  const [a, b] = await Promise.all([h.service.list('cr-1'), h.service.list('cr-1')]);
  assert.deepEqual(a, b);
  assert.equal(h.calls.filter((c) => c.includes('mr view')).length, 1);
});

test('the rollup moving, or a new head, is announced once; the same list again is not', async () => {
  const h = gitlab();
  await h.service.list('cr-1');
  await h.service.list('cr-1', { refresh: true });
  assert.equal(h.events.length, 1);
  assert.deepEqual(h.events[0], { type: 'change-request.checks', title: 'Checks pending', changeRequestId: 'cr-1', rollup: 'pending', headSha: '6e0dab83d5074227e4d2827ebb745edf1aa2c943' });
});

test('a rate-limited read serves the last list with the time to read again; with no list it fails with the reason', async () => {
  const h = gitlab();
  await assert.rejects(
    () => gitlab().service.list('other'),
    (e: unknown) => e instanceof ChecksError && e.reason === 'not-found',
  );
  const first = await h.service.list('cr-1');
  h.answer(/mr view 12/, failed(1, 'HTTP 429', 'slowed-down'));
  const limited = await h.service.list('cr-1', { refresh: true });
  assert.deepEqual(limited.checks, first.checks);
  assert.equal(limited.limitedUntil, new Date(h.clock.now + 60_000).toISOString());

  const fresh = gitlab();
  fresh.answer(/mr view 12/, failed(1, 'HTTP 429', 'slowed-down'));
  await assert.rejects(
    () => fresh.service.list('cr-1'),
    (e: unknown) => e instanceof ChecksError && e.reason === 'slowed-down' && e.detail === 'HTTP 429',
  );
});

test('GitHub: the required checks of the base branch mark the list; a failed rules read marks none', async () => {
  const graph = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number: 12, url: 'https://github.com/acme/shop/pull/12', state: 'OPEN', mergedAt: null, isDraft: false, headRefOid: 'abc123', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: null, autoMergeRequest: null,
          commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null }] } } } }] },
        },
      },
      rateLimit: { cost: 1, remaining: 4990, resetAt: '2026-10-01T13:00:00Z' },
    },
  });
  const runs = JSON.stringify([{ total_count: 1, check_runs: [{ id: 7, name: 'build', status: 'in_progress', conclusion: null, started_at: '2026-10-01T11:59:00Z', completed_at: null, html_url: 'https://github.com/acme/shop/actions/runs/9/job/7', app: { slug: 'github-actions' } }] }]);
  const statuses = JSON.stringify([{ state: 'pending', statuses: [] }]);
  const h = harness(githubAdapter, ghRepo, '2.92.0');
  h.answer(/graphql/, { ...ok(graph), http: { status: 200, headers: {} } });
  h.answer(/check-runs/, ok(runs));
  h.answer(/commits\/abc123\/status/, ok(statuses));
  h.answer(/rules\/branches\/main/, ok(JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }])));
  h.answer(/shop\/branches\/main$/, ok(JSON.stringify({ protection: { required_status_checks: { contexts: [] } } })));
  const list = await h.service.list('cr-1');
  assert.deepEqual(list.checks.map((c) => [c.name, c.required]), [['build', true]]);

  const none = harness(githubAdapter, ghRepo, '2.92.0');
  none.answer(/graphql/, { ...ok(graph), http: { status: 200, headers: {} } });
  none.answer(/check-runs/, ok(runs));
  none.answer(/commits\/abc123\/status/, ok(statuses));
  none.answer(/branches\/main$/, failed(1, 'HTTP 404', 'not-found'));
  assert.deepEqual((await none.service.list('cr-1')).checks.map((c) => c.required), [false]);
  golden('checks-service-github-list', h.calls);
});

// ---------- logs ----------

test('a log is the cleaned tail; a bridge has none; a 404 is log-unavailable; a manual job has no output yet', async () => {
  const h = gitlab();
  h.answer(/jobs\/16862617992\/trace/, ok(gl('trace_fail.out')));
  const log = await h.service.log('cr-1', '16862617992');
  assert.equal(log.noOutputYet, false);
  assert.ok(log.lines.length > 0);
  assert.ok(log.lines.every((line) => !line.includes('\x1b') && !line.includes('section_start')));
  assert.deepEqual(log.annotations, []);

  await assert.rejects(
    () => h.service.log('cr-1', '16862617995'),
    (e: unknown) => e instanceof ChecksError && e.reason === 'log-unavailable',
  );
  h.answer(/jobs\/16862617993\/trace/, { ...failed(1, 'HTTP 404'), http: { status: 404, headers: {} } });
  await assert.rejects(
    () => h.service.log('cr-1', '16862617993'),
    (e: unknown) => e instanceof ChecksError && e.reason === 'log-unavailable' && e.detail === 'HTTP 404',
  );
  h.answer(/jobs\/16862617994\/trace/, ok(''));
  assert.deepEqual(await h.service.log('cr-1', '16862617994'), { lines: [], truncated: false, noOutputYet: true, annotations: [] });
  await assert.rejects(
    () => h.service.log('cr-1', 'missing'),
    (e: unknown) => e instanceof ChecksError && e.reason === 'not-found',
  );
});

test('a running job whose trace is only the runner preamble has no output yet', async () => {
  const h = gitlab();
  h.answer(/jobs\/16862617991\/trace/, ok(gl('trace_running1.out')));
  const log = await h.service.log('cr-1', '16862617991');
  assert.equal(log.noOutputYet, true);
  assert.deepEqual(log.lines, []);
});

// ---------- writes ----------

test('re-run failed retries each failed job once, then reads the list again', async () => {
  const h = gitlab();
  await h.service.list('cr-1');
  h.calls.length = 0;
  h.answer(/ci retry|jobs\/\d+\/retry/, ok(''));
  await h.service.rerun('cr-1', { scope: 'failed' });
  const retries = h.calls.filter((c) => /ci retry|\/retry/.test(c));
  assert.ok(retries.length >= 1);
  const lastRetry = h.calls.findLastIndex((c) => /ci retry|\/retry/.test(c));
  assert.ok(h.calls.slice(lastRetry + 1).some((c) => c.includes('mr view')), 'it re-read after the write');
  golden('checks-service-gitlab-rerun-failed', h.calls);
});

test('a write is never retried: a refusal is rerun-refused after a re-read, a timeout is write-unconfirmed', async () => {
  const h = gitlab();
  await h.service.list('cr-1');
  h.answer(/ci retry|jobs\/\d+\/retry/, failed(1, 'job is not retryable'));
  h.calls.length = 0;
  await assert.rejects(
    () => h.service.rerun('cr-1', { scope: 'failed' }),
    (e: unknown) => e instanceof ChecksError && e.reason === 'rerun-refused' && e.detail === 'job is not retryable',
  );
  assert.equal(h.calls.filter((c) => /ci retry|\/retry/.test(c)).length, 1, 'stopped at the first failing call');
  assert.ok(h.calls.some((c) => c.includes('mr view')));

  h.answer(/ci retry|jobs\/\d+\/retry/, failed(0, '', 'timeout'));
  await assert.rejects(
    () => h.service.rerun('cr-1', { scope: 'failed' }),
    (e: unknown) => e instanceof ChecksError && e.reason === 'write-unconfirmed',
  );
});

test('a scope the host cannot honour is refused before any call', async () => {
  const h = gitlab();
  await h.service.list('cr-1');
  h.calls.length = 0;
  await assert.rejects(
    () => h.service.rerun('cr-1', { scope: 'check', checkId: '16862617991' }),
    (e: unknown) => e instanceof ChecksError && e.reason === 'check-not-rerunnable',
  );
  await assert.rejects(
    () => h.service.rerun('cr-1', { scope: 'check' }),
    (e: unknown) => e instanceof ChecksError && e.reason === 'check-not-rerunnable',
  );
  assert.deepEqual(h.calls, []);
});

test('cancel re-reads and does not wait for canceled; a cancel that fails on a finished run is a success', async () => {
  const h = gitlab();
  await h.service.list('cr-1');
  h.answer(/pipelines\/2900799542\/cancel/, ok(gl('pipeline_cancel.out')));
  h.calls.length = 0;
  await h.service.cancel('cr-1');
  assert.ok(h.calls[0]?.includes('/cancel'));
  assert.ok(h.calls.some((c) => c.includes('mr view')));

  const done = gitlab();
  await done.service.list('cr-1');
  done.answer(/pipelines\/2900799542\/cancel/, failed(1, 'already finished'));
  const finished = JSON.stringify({ id: 1, name: 'x', stage: 's', status: 'success' });
  done.answer(/pipelines\/2900799542\/jobs/, ok(finished));
  done.answer(/pipelines\/2900799542\/bridges/, ok('[]'));
  assert.deepEqual((await done.service.cancel('cr-1')).checks.map((c) => c.state), ['passed']);

  const still = gitlab();
  await still.service.list('cr-1');
  still.answer(/pipelines\/2900799542\/cancel/, failed(1, 'denied', 'forbidden'));
  await assert.rejects(
    () => still.service.cancel('cr-1'),
    (e: unknown) => e instanceof ChecksError && e.reason === 'forbidden',
  );
});

test('playing a manual job keeps its id: the re-read says whether it moved on', async () => {
  const h = gitlab();
  await h.service.list('cr-1');
  h.answer(/ci trigger 16862617994|jobs\/16862617994\/play/, ok(gl('job_play.out')));
  h.calls.length = 0;
  await h.service.run('cr-1', '16862617994');
  assert.ok(h.calls[0] !== undefined && /trigger|play/.test(h.calls[0]));

  // Still manual after a failure: the host refused
  const refused = gitlab();
  await refused.service.list('cr-1');
  refused.answer(/ci trigger 16862617994|jobs\/16862617994\/play/, failed(1, 'unplayable'));
  await assert.rejects(
    () => refused.service.run('cr-1', '16862617994'),
    (e: unknown) => e instanceof ChecksError,
  );
  await assert.rejects(
    () => refused.service.run('cr-1', '16862617992'),
    (e: unknown) => e instanceof ChecksError && e.reason === 'check-not-rerunnable',
  );
});

test('two writes to one change request run one after the other', async () => {
  const h = gitlab();
  await h.service.list('cr-1');
  let active = 0;
  let overlap = 0;
  h.answer(/pipelines\/2900799542\/cancel/, async () => {
    active += 1;
    overlap = Math.max(overlap, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return ok('{}');
  });
  await Promise.all([h.service.cancel('cr-1'), h.service.cancel('cr-1')]);
  assert.equal(overlap, 1);
});

test('the watcher’s read has a reason when it fails and the parsed read when it works', async () => {
  const target = (run: ChecksTarget['run']): ChecksTarget => ({ id: 'cr-1', kind: 'work-item', adapter: gitlabAdapter, repo: glRepo, number: 12, branch: 'probe/k0', base: 'main', cliVersion: null, run });
  const service = new ChecksService({ db: database().connection, resolve: async () => null });
  const read = await service.readChangeRequest(target(async () => ok(gl('mrview_after_post.out'))));
  assert.equal(read.view.number, 12);
  assert.equal(read.headPipeline?.id, 2900799542);
  await assert.rejects(
    () => service.readChangeRequest(target(async () => failed(1, 'HTTP 502', 'server-error'))),
    (e: unknown) => e instanceof ChecksError && e.reason === 'server-error',
  );
});
