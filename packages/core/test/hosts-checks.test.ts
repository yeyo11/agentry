import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Check } from '@agentry/shared';
import { classifyCall } from '../src/hosts/classify.ts';
import { HostParseError, HostRequestError, type HostCall, type HostRepo, type HostResult } from '../src/hosts/code-host.ts';
import { githubAdapter } from '../src/hosts/github/adapter.ts';
import { atLeast, runIdOf } from '../src/hosts/github/checks.ts';
import { CHANGE_REQUEST_QUERY } from '../src/hosts/github/queries/change-request.ts';
import { gitlabAdapter } from '../src/hosts/gitlab/adapter.ts';
import { githubManifest } from '../src/hosts/github/manifest.ts';
import { checkConformance } from './hosts/conformance.ts';

const here = dirname(fileURLToPath(import.meta.url));
const gh = (file: string, version = '2.92.0'): string => readFileSync(join(here, 'fixtures/recordings/gh', version, file), 'utf8');
const gl = (file: string): string => readFileSync(join(here, 'fixtures/recordings/glab/1.120.0', file), 'utf8');

const ghRepo: HostRepo = { host: 'github.com', path: 'acme/shop', owner: 'acme', name: 'shop' };
const glRepo: HostRepo = { host: 'gitlab.com', path: 'yeyo11/agentry', owner: 'yeyo11', name: 'agentry', projectId: 87089091 };

const result = (stdout: string, exitCode = 0): HostResult => ({ exitCode, stdout, stderrFirstLine: '', http: null, truncated: false, durationMs: 1 });

const check = (patch: Partial<Check>): Check => ({
  id: '1', name: 'build', group: null, state: 'failed', allowedToFail: false, required: false, startedAt: null, finishedAt: null,
  url: null, rerunnable: true, hasLog: true, source: 'actions', ...patch,
});
const job = (id: string, run: string, patch: Partial<Check> = {}): Check =>
  check({ id, url: `https://github.com/acme/shop/actions/runs/${run}/job/${id}`, ...patch });

const argv = (call: HostCall | null | undefined): string => (call ? call.args.join(' ') : 'none');

// ---------- GitHub ----------

test('github checks: every state a check run or a status can be in maps to one of ours', () => {
  const page = (runs: unknown[]) => JSON.stringify([{ total_count: runs.length, check_runs: runs }]);
  const run = (id: number, status: string, conclusion: string | null, slug = 'github-actions') => ({
    id, name: `r${String(id)}`, status, conclusion, started_at: '2026-10-01T10:00:00Z', completed_at: conclusion ? '2026-10-01T10:01:00Z' : null,
    html_url: `https://github.com/acme/shop/actions/runs/9/job/${String(id)}`, app: { slug },
  });
  const statuses = JSON.stringify([{ state: 'pending', statuses: [{ id: 5, context: 'ci/x', state: 'pending', target_url: null, created_at: 'a', updated_at: 'b' }, { id: 6, context: 'ci/y', state: 'error', target_url: 'https://ci/y', created_at: 'a', updated_at: 'b' }] }]);
  const runs = [
    run(1, 'queued', null), run(2, 'in_progress', null), run(3, 'waiting', null), run(4, 'completed', 'success'),
    run(5, 'completed', 'failure'), run(6, 'completed', 'timed_out'), run(7, 'completed', 'cancelled'), run(8, 'completed', 'skipped'),
    run(9, 'completed', 'neutral'), run(10, 'completed', 'action_required'), run(11, 'completed', 'success', 'codecov'),
  ];
  const parsed = githubAdapter.parseChecks(ghRepo, { headSha: 'abc', pipelineId: null }, [result(page(runs)), result(statuses)]);
  assert.deepEqual(parsed.checks.map((c) => c.state), [
    'queued', 'running', 'queued', 'passed', 'failed', 'failed', 'cancelled', 'skipped', 'neutral', 'failed', 'passed', 'queued', 'failed',
  ]);
  const app = parsed.checks[10];
  assert.deepEqual([app?.source, app?.rerunnable, app?.hasLog], ['app', false, false]);
  const running = parsed.checks[1];
  assert.deepEqual([running?.source, running?.rerunnable, running?.hasLog], ['actions', false, true]);
  const status = parsed.checks[12];
  assert.deepEqual([status?.source, status?.id, status?.url, status?.rerunnable, status?.hasLog, status?.finishedAt], ['status', '6', 'https://ci/y', false, false, 'b']);
  assert.equal(parsed.checks[11]?.finishedAt, null);
});

test('github checks: a list longer than the ceiling is cut and says so', () => {
  const runs = Array.from({ length: 1001 }, (_, at) => ({ id: at + 1, name: 'n', status: 'completed', conclusion: 'success', app: { slug: 'x' } }));
  const parsed = githubAdapter.parseChecks(ghRepo, { headSha: 'abc', pipelineId: null }, [result(JSON.stringify([{ total_count: 1001, check_runs: runs }])), result('[]')]);
  assert.equal(parsed.checks.length, 1000);
  assert.equal(parsed.truncated, true);
});

test('github checks: the list is two reads of the head commit, and none without one', () => {
  const calls = githubAdapter.checks(ghRepo, { headSha: 'abc123', pipelineId: null });
  assert.deepEqual(calls.map(argv), [
    'api --hostname github.com --paginate --slurp repos/acme/shop/commits/abc123/check-runs?per_page=100',
    'api --hostname github.com --paginate --slurp repos/acme/shop/commits/abc123/status?per_page=100',
  ]);
  assert.deepEqual(githubAdapter.checks(ghRepo, { headSha: null, pipelineId: null }), []);
});

test('github checks: the log takes --allow-escape-sequences from 2.97.0 and never before', () => {
  const build = job('1001', '555');
  const flag = (version: string | null): boolean => githubAdapter.jobLog(ghRepo, build, version)?.args.includes('--allow-escape-sequences') ?? false;
  assert.deepEqual(['2.92.0', '2.96.9', '2.97.0', '2.102.0', '3.0.0', null].map(flag), [false, false, true, true, true, false]);
  assert.equal(argv(githubAdapter.jobLog(ghRepo, build, '2.92.0')), 'api --hostname github.com repos/acme/shop/actions/jobs/1001/logs');
  assert.equal(atLeast('2.97.0', [2, 97, 0]), true);
  assert.equal(atLeast('2.9.0', [2, 97, 0]), false);
  assert.equal(githubAdapter.jobLog(ghRepo, build, '2.102.0')?.class, 'log');
  assert.equal(githubAdapter.jobLog(ghRepo, check({ source: 'app', hasLog: false }), '2.102.0'), null);
});

test('github checks: a log with nothing in it is "no output yet", the text is passed on untouched', () => {
  assert.deepEqual(githubAdapter.parseJobLog(result('')), { text: '', noOutputYet: true });
  const log = gh('probe-joblog.out');
  assert.deepEqual(githubAdapter.parseJobLog(result(log)), { text: log, noOutputYet: false });
});

test('github checks: annotations read the recorded list; the runner’s own are about the run, not a file', () => {
  const notes = githubAdapter.parseAnnotations(gh('annotations.out'));
  assert.ok(notes.length >= 3);
  const runner = notes.filter((n) => n.path === null);
  assert.ok(runner.length > 0, 'the .github annotations lose their path');
  assert.ok(runner.every((n) => n.startLine === null && n.endLine === null));
  assert.ok(notes.some((n) => n.level === 'warning'));
  assert.ok(notes.every((n) => n.message !== ''));
  assert.equal(argv(githubAdapter.annotations(ghRepo, job('77', '1'))), 'api --hostname github.com repos/acme/shop/check-runs/77/annotations?per_page=100');
  assert.equal(githubAdapter.annotations(ghRepo, check({ source: 'status' })), null);
  assert.throws(() => githubAdapter.parseAnnotations('{}'), HostParseError);
  assert.deepEqual(githubAdapter.parseAnnotations('[{"path":"a.ts","start_line":3,"end_line":4,"annotation_level":"failure","title":"","message":"boom"}]'), [
    { path: 'a.ts', startLine: 3, endLine: 4, level: 'failure', title: null, message: 'boom' },
  ]);
});

test('github checks: re-running resolves a scope to runs, one --failed call per workflow run', () => {
  const checks = [job('1', '10'), job('2', '10'), job('3', '11'), job('4', '12', { state: 'passed' }), check({ id: '9', source: 'app', url: null, rerunnable: false })];
  const rerun = (scope: 'failed' | 'check' | 'all', checkId?: string) => githubAdapter.rerun(ghRepo, { scope, checkId, checks, number: 7, branch: 'b', headPipeline: null }).map(argv);
  assert.deepEqual(rerun('failed'), ['run rerun 10 -R github.com/acme/shop --failed', 'run rerun 11 -R github.com/acme/shop --failed']);
  assert.deepEqual(rerun('all'), ['run rerun 10 -R github.com/acme/shop', 'run rerun 11 -R github.com/acme/shop', 'run rerun 12 -R github.com/acme/shop']);
  assert.deepEqual(rerun('check', '3'), ['run rerun -R github.com/acme/shop --job 3']);
  assert.throws(() => rerun('check', '9'), (e) => e instanceof HostRequestError && e.reason === 'check-not-rerunnable');
  assert.throws(() => rerun('check', 'nope'), (e) => e instanceof HostRequestError && e.reason === 'check-not-rerunnable');
  assert.throws(
    () => githubAdapter.rerun(ghRepo, { scope: 'failed', checks: [job('4', '12', { state: 'passed' })], number: 7, branch: 'b', headPipeline: null }),
    (e) => e instanceof HostRequestError && e.reason === 'rerun-refused',
  );
  for (const call of githubAdapter.rerun(ghRepo, { scope: 'all', checks, number: 7, branch: 'b', headPipeline: null })) assert.equal(classifyCall(call), 'write');
});

test('github checks: cancel stops the runs that still have a live job, and nothing else', () => {
  const checks = [job('1', '10', { state: 'running', rerunnable: false }), job('2', '10', { state: 'queued' }), job('3', '11'), job('5', '12', { state: 'running', source: 'app' })];
  assert.deepEqual(githubAdapter.cancel(ghRepo, { checks, pipelineId: null }).map(argv), ['run cancel 10 -R github.com/acme/shop']);
  assert.deepEqual(githubAdapter.cancel(ghRepo, { checks: [job('3', '11')], pipelineId: null }), []);
  assert.equal(runIdOf(check({ url: 'https://github.com/acme/shop/runs/1' })), null);
});

test('github checks: no manual jobs per pull request', () => {
  assert.equal(githubAdapter.playManual(ghRepo, check({ state: 'manual' })), null);
});

test('github checks: required names come from rulesets and from classic protection, and only when both reads worked', () => {
  const calls = githubAdapter.required(ghRepo, 'release/2026.10');
  assert.deepEqual(calls.map(argv), [
    'api --hostname github.com repos/acme/shop/rules/branches/release/2026.10',
    'api --hostname github.com repos/acme/shop/branches/release/2026.10',
  ]);
  assert.deepEqual(githubAdapter.parseRequired([result(gh('rules-branch-ruleset.out', '2.102.0')), result(gh('branch-main-nonadmin-view.out', '2.102.0'))]), ['ok']);
  assert.deepEqual(githubAdapter.parseRequired([result('[]'), result('{"protected":false}')]), []);
  assert.deepEqual(githubAdapter.parseRequired([result('[]'), result('{"protected":true,"protection":{"required_status_checks":{"contexts":["a","b"]}}}')]), ['a', 'b']);
  assert.equal(githubAdapter.parseRequired([result('', 1), result('{}')]), null);
  assert.equal(githubAdapter.parseRequired([result('not json'), result('{}')]), null);
  assert.equal(githubAdapter.parseRequired([result('{}'), result('{}')]), null);
});

const pullRequest = (patch: Record<string, unknown> = {}, rollup: unknown = { state: 'SUCCESS', contexts: { nodes: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }], pageInfo: { hasNextPage: false } } }) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number: 12, url: 'https://github.com/acme/shop/pull/12', state: 'OPEN', mergedAt: null, isDraft: false, headRefOid: 'abc123', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', autoMergeRequest: null,
          commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] }, ...patch,
        },
      },
      rateLimit: { cost: 1, remaining: 4990, resetAt: '2026-10-01T12:00:00Z' },
    },
  });

test('github change request: one GraphQL query through api -i, inline so the classifier reads it, classified as a read', () => {
  const call = githubAdapter.readChangeRequest(ghRepo, 12);
  assert.deepEqual(call.args.slice(0, 5), ['api', '-i', '--hostname', 'github.com', 'graphql']);
  assert.ok(call.args.includes(`query=${CHANGE_REQUEST_QUERY}`));
  assert.deepEqual(call.args.slice(-6), ['-f', 'owner=acme', '-f', 'repo=shop', '-F', 'number=12']);
  assert.equal(call.kind, 'read');
  assert.equal(classifyCall(call), 'read');
  assert.equal(call.bucket, 'graphql');
  assert.match(CHANGE_REQUEST_QUERY, /^query\(/);
  for (const field of ['state', 'mergedAt', 'isDraft', 'headRefOid', 'baseRefName', 'mergeable', 'mergeStateStatus', 'reviewDecision', 'autoMergeRequest', 'statusCheckRollup', 'rateLimit']) {
    assert.ok(CHANGE_REQUEST_QUERY.includes(field), field);
  }
});

test('github change request: the answer carries the head, the merge facts and the rollup', () => {
  const read = githubAdapter.parseChangeRequest(result(pullRequest()));
  assert.deepEqual(read.view, { number: 12, url: 'https://github.com/acme/shop/pull/12', state: 'open', mergedAt: null, ci: 'passing' });
  assert.deepEqual(
    [read.headSha, read.baseRef, read.isDraft, read.mergeable, read.mergeStateStatus, read.reviewDecision, read.autoMerge, read.truncated],
    ['abc123', 'main', false, 'MERGEABLE', 'CLEAN', 'APPROVED', false, false],
  );
  assert.deepEqual(read.rateLimit, { cost: 1, remaining: 4990, resetAt: '2026-10-01T12:00:00Z' });
  assert.equal(githubAdapter.parseChangeRequest(result(pullRequest({ autoMergeRequest: { enabledAt: 'x' } }))).autoMerge, true);
  assert.equal(githubAdapter.parseChangeRequest(result(pullRequest({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }))).view.ci, 'none');
});

test('github change request: contexts go through today’s ciOf, and past the first 100 GitHub’s own state decides', () => {
  const ctx = (nodes: unknown[], hasNextPage = false, state = 'PENDING') => ({ state, contexts: { nodes, pageInfo: { hasNextPage } } });
  const ci = (rollup: unknown) => githubAdapter.parseChangeRequest(result(pullRequest({}, rollup))).view.ci;
  assert.equal(ci(ctx([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }])), 'passing');
  assert.equal(ci(ctx([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }])), 'failing');
  assert.equal(ci(ctx([{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }])), 'pending');
  assert.equal(ci(ctx([{ __typename: 'StatusContext', state: 'ERROR' }])), 'failing');
  assert.equal(ci(ctx([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }], true, 'FAILURE')), 'failing');
  assert.equal(ci(ctx([], true, 'SUCCESS')), 'passing');
  assert.equal(githubAdapter.parseChangeRequest(result(pullRequest({}, ctx([], true)))).truncated, true);
});

test('github change request: a not-found is a 200 with errors and exit 1, and is read as such', () => {
  const body = '{"data":{"repository":{"pullRequest":null}},"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a PullRequest with the number of 999999."}]}';
  assert.throws(() => githubAdapter.parseChangeRequest({ ...result(body, 1), http: { status: 200, headers: {} } }), (e) => e instanceof HostParseError && /NOT_FOUND/.test(e.message));
  assert.throws(() => githubAdapter.parseChangeRequest(result(gh('api-404-i-gql.out'))), HostParseError);
  for (const bad of ['', 'x', '[]', '{}', pullRequest({ state: 'DRAFT' })]) {
    assert.throws(() => githubAdapter.parseChangeRequest(result(bad)), HostParseError, bad.slice(0, 30));
  }
});

// ---------- GitLab ----------

const MR = 'https://gitlab.com/yeyo11/agentry';

test('gitlab checks: the list is the jobs and the bridges of the head pipeline, pinned on the project id', () => {
  const calls = gitlabAdapter.checks(glRepo, { headSha: null, pipelineId: 2900783081 });
  assert.deepEqual(calls.map(argv), [
    'api --hostname gitlab.com --paginate --output ndjson projects/87089091/pipelines/2900783081/jobs?per_page=100',
    'api --hostname gitlab.com projects/87089091/pipelines/2900783081/bridges?per_page=100',
  ]);
  assert.deepEqual(gitlabAdapter.checks(glRepo, { headSha: null, pipelineId: null }), []);
  assert.throws(() => gitlabAdapter.checks({ ...glRepo, projectId: undefined }, { headSha: null, pipelineId: 1 }), HostParseError);
});

test('gitlab checks: a bridge’s child pipeline is read in a second round, its jobs grouped under the bridge', () => {
  const ref = { headSha: null, pipelineId: 2900783081 };
  const first = gitlabAdapter.parseChecks(glRepo, ref, [result(gl('jobs_ndjson.out')), result(gl('bridges_child.out'))]);
  assert.equal(first.next.length, 1);
  assert.equal(first.next[0]?.group, 'probe-child');
  assert.equal(argv(first.next[0]?.call), 'api --hostname gitlab.com --paginate --output ndjson projects/87089091/pipelines/2900783186/jobs?per_page=100');
  const more = gitlabAdapter.parseChecksMore(glRepo, first.next, [result(gl('child_jobs.out'))]);
  assert.deepEqual(more.checks.map((c) => [c.id, c.group, c.state, c.source]), [
    ['16862618697', 'probe-child › test', 'failed', 'job'],
    ['16862618696', 'probe-child › test', 'passed', 'job'],
  ]);
  assert.deepEqual(more.next, []);
});

test('gitlab checks: a bridge whose child could not be created is a failed check with nothing to follow', () => {
  const parsed = gitlabAdapter.parseChecks(glRepo, { headSha: null, pipelineId: 2900771578 }, [result(''), result(gl('bridges_running.out'))]);
  assert.deepEqual(parsed.checks.map((c) => [c.name, c.source, c.state, c.hasLog, c.rerunnable]), [['probe-child', 'bridge', 'failed', false, true]]);
  assert.deepEqual(parsed.next, []);
});

test('gitlab checks: more than 20 child pipelines are not followed, and the list says so', () => {
  const bridges = Array.from({ length: 21 }, (_, at) => ({ id: at + 1, name: `b${String(at)}`, stage: 's', status: 'success', downstream_pipeline: { id: 100 + at } }));
  const parsed = gitlabAdapter.parseChecks(glRepo, { headSha: null, pipelineId: 1 }, [result(''), result(JSON.stringify(bridges))]);
  assert.equal(parsed.checks.length, 21);
  assert.equal(parsed.next.length, 20);
  assert.equal(parsed.truncated, true);
});

test('gitlab checks: job statuses map to ours; an unknown one waits instead of passing', () => {
  const statuses = ['created', 'waiting_for_resource', 'preparing', 'pending', 'scheduled', 'running', 'canceling', 'success', 'failed', 'canceled', 'skipped', 'manual', 'something-new'];
  const jobs = statuses.map((status, at) => ({ id: at + 1, name: status, stage: 'test', status, allow_failure: status === 'failed' }));
  const parsed = gitlabAdapter.parseChecks(glRepo, { headSha: null, pipelineId: 1 }, [result(JSON.stringify(jobs)), result('[]')]);
  assert.deepEqual(parsed.checks.map((c) => c.state), [
    'queued', 'queued', 'queued', 'queued', 'queued', 'running', 'running', 'passed', 'failed', 'cancelled', 'skipped', 'manual', 'queued',
  ]);
  assert.deepEqual(parsed.checks.map((c) => c.rerunnable), [false, false, false, false, false, false, false, true, true, true, false, false, false]);
  assert.equal(parsed.checks[8]?.allowedToFail, true);
  assert.equal(parsed.checks[11]?.allowedToFail, false);
  // runner and user objects of the recorded jobs never reach a check
  const recorded = gitlabAdapter.parseChecks(glRepo, { headSha: null, pipelineId: 1 }, [result(gl('jobs_ndjson.out')), result('[]')]);
  assert.ok(!JSON.stringify(recorded.checks).includes('avatar'));
  assert.ok(!JSON.stringify(recorded.checks).includes('@'));
});

test('gitlab checks: a bridge has no log, a job’s trace is one read, an empty trace is "no output yet"', () => {
  assert.equal(gitlabAdapter.jobLog(glRepo, check({ source: 'bridge', hasLog: false }), null), null);
  const call = gitlabAdapter.jobLog(glRepo, check({ id: '16862533387', source: 'job' }), '1.120.0');
  assert.equal(argv(call), 'api --hostname gitlab.com projects/87089091/jobs/16862533387/trace');
  assert.equal(call?.class, 'log');
  assert.deepEqual(gitlabAdapter.parseJobLog(result(gl('trace_manual.out'))), { text: '', noOutputYet: true });
  const preamble = gl('trace_running1.out');
  assert.deepEqual(gitlabAdapter.parseJobLog(result(preamble)), { text: preamble, noOutputYet: false });
});

test('gitlab checks: no annotations', () => {
  assert.equal(gitlabAdapter.annotations(glRepo, check({ source: 'job' })), null);
  assert.deepEqual(gitlabAdapter.parseAnnotations(''), []);
});

test('gitlab checks: re-running failed retries each failed job, a failed bridge through the jobs endpoint', () => {
  const checks = [
    check({ id: '11', source: 'job' }),
    check({ id: '12', source: 'job', allowedToFail: true }),
    check({ id: '13', source: 'bridge', hasLog: false }),
    check({ id: '14', source: 'job', state: 'passed' }),
    check({ id: '15', source: 'job', state: 'running', rerunnable: false }),
  ];
  const rerun = (scope: 'failed' | 'check' | 'all', extra: Record<string, unknown> = {}) =>
    gitlabAdapter.rerun(glRepo, { scope, checks, number: 12, branch: 'probe/k0', headPipeline: null, ...extra });
  assert.deepEqual(rerun('failed').map(argv), [
    `ci retry 11 -R ${MR}`,
    'api --hostname gitlab.com -X POST projects/87089091/jobs/13/retry',
  ]);
  assert.deepEqual(rerun('check', { checkId: '14' }).map(argv), [`ci retry 14 -R ${MR}`]);
  assert.deepEqual(rerun('check', { checkId: '13' }).map(argv), ['api --hostname gitlab.com -X POST projects/87089091/jobs/13/retry']);
  assert.throws(() => rerun('check', { checkId: '15' }), (e) => e instanceof HostRequestError && e.reason === 'check-not-rerunnable');
  assert.throws(
    () => gitlabAdapter.rerun(glRepo, { scope: 'failed', checks: [check({ id: '12', allowedToFail: true })], number: 12, branch: 'b', headPipeline: null }),
    (e) => e instanceof HostRequestError && e.reason === 'rerun-refused',
  );
});

test('gitlab checks: running everything again posts the merge request’s pipelines when that is what ran, else a branch pipeline', () => {
  const run = (source: string | null) =>
    gitlabAdapter.rerun(glRepo, { scope: 'all', checks: [], number: 12, branch: 'probe/k0', headPipeline: source === null ? null : { id: 9, status: 'failed', sha: null, source } }).map(argv);
  assert.deepEqual(run('merge_request_event'), ['api --hostname gitlab.com -X POST projects/87089091/merge_requests/12/pipelines']);
  assert.deepEqual(run('push'), [`ci run -R ${MR} -b probe/k0`]);
  assert.deepEqual(run(null), [`ci run -R ${MR} -b probe/k0`]);
});

test('gitlab checks: cancel is one call on the pipeline, none without one; only a manual job can be played', () => {
  assert.deepEqual(gitlabAdapter.cancel(glRepo, { checks: [], pipelineId: 2900799542 }).map(argv), ['api --hostname gitlab.com -X POST projects/87089091/pipelines/2900799542/cancel']);
  assert.deepEqual(gitlabAdapter.cancel(glRepo, { checks: [], pipelineId: null }), []);
  assert.equal(argv(gitlabAdapter.playManual(glRepo, check({ id: '16862617994', state: 'manual', source: 'job' }))), `ci trigger 16862617994 -R ${MR}`);
  assert.equal(gitlabAdapter.playManual(glRepo, check({ state: 'failed', source: 'job' })), null);
  assert.equal(gitlabAdapter.playManual(glRepo, check({ state: 'manual', source: 'bridge' })), null);
  assert.deepEqual(gitlabAdapter.required(glRepo, 'main'), []);
  assert.equal(gitlabAdapter.parseRequired([]), null);
});

test('gitlab change request: mr view carries the head pipeline and its source', () => {
  const read = gitlabAdapter.parseChangeRequest(result(gl('mrview_after_post.out')));
  assert.deepEqual(read.headPipeline, { id: 2900799542, status: 'running', sha: '6e0dab83d5074227e4d2827ebb745edf1aa2c943', source: 'merge_request_event' });
  assert.deepEqual([read.headSha, read.baseRef, read.isDraft, read.mergeable, read.autoMerge], ['6e0dab83d5074227e4d2827ebb745edf1aa2c943', 'main', false, 'mergeable', false]);
  assert.equal(read.view.state, 'open');
  assert.equal(gitlabAdapter.parseChangeRequest(result(gl('mrview4.out'))).headPipeline, null);
  assert.equal(argv(gitlabAdapter.readChangeRequest(glRepo, 12)), argv(gitlabAdapter.view(glRepo, 12)));
  assert.throws(() => gitlabAdapter.parseChangeRequest(result('{"error":{"message":"x"}}')), HostParseError);
});

// ---------- the suite itself ----------

test('the checks rules fail an adapter that declares a rerun as a read, follows a log, or trusts an id', () => {
  const ok = checkConformance({ adapter: githubAdapter, manifest: githubManifest, repo: ghRepo, classify: classifyCall });
  assert.deepEqual(Object.values(ok).flat(), []);

  const liar = {
    ...githubAdapter,
    rerun: (...args: Parameters<typeof githubAdapter.rerun>) => githubAdapter.rerun(...args).map((call): HostCall => ({ ...call, kind: 'read' })),
  };
  const bad = checkConformance({ adapter: liar, manifest: githubManifest, repo: ghRepo, classify: classifyCall });
  assert.ok((bad['only the calls that change a check are writes, and they are class write'] ?? []).length > 0);
  assert.ok((bad['every call’s kind agrees with the classifier'] ?? []).length > 0);

  const follower = { ...githubAdapter, jobLog: (...args: Parameters<typeof githubAdapter.jobLog>) => { const c = githubAdapter.jobLog(...args); return c ? { ...c, class: 'read' as const, args: [...c.args, '--paginate'] } : c; } };
  const paged = checkConformance({ adapter: follower, manifest: githubManifest, repo: ghRepo, classify: classifyCall });
  assert.ok((paged['a log is one read of class log, never followed or paged'] ?? []).length > 0);

  const trusting = { ...githubAdapter, jobLog: (_repo: HostRepo, c: Check) => ({ ...githubAdapter.checks(ghRepo, { headSha: 'x', pipelineId: null })[0] as HostCall, args: ['api', '--hostname', 'github.com', `repos/acme/shop/actions/jobs/${c.id}/logs`], class: 'log' as const }) };
  const unsafe = checkConformance({ adapter: trusting, manifest: githubManifest, repo: ghRepo, classify: classifyCall });
  assert.ok((unsafe['a check without a log, or that cannot be run again, builds no call, and an id is digits only'] ?? []).length > 0);
});
