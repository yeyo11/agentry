import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyCall } from '../src/hosts/classify.ts';
import { HostParseError, type HostRepo, type HostResult } from '../src/hosts/code-host.ts';
import { envOf } from '../src/hosts/env.ts';
import { spawnHostCall } from '../src/hosts/exec.ts';
import { githubAdapter } from '../src/hosts/github/adapter.ts';
import { githubManifest } from '../src/hosts/github/manifest.ts';
import { ciOf } from '../src/pull-requests.ts';
import { runConformance, type RecordedOutputs } from './hosts/conformance.ts';

const here = dirname(fileURLToPath(import.meta.url));
const recorded = (version: '2.92.0' | '2.102.0', label: string): string => readFileSync(join(here, 'fixtures/recordings/gh', version, `${label}.out`), 'utf8');
const VERSIONS = ['2.92.0', '2.102.0'] as const;

const repo: HostRepo = { host: 'github.com', path: 'acme/shop', owner: 'acme', name: 'shop' };

/** Check runs and commit statuses as `statusCheckRollup` prints them (recordings/gh `rollup-mixed`). */
const run = (conclusion: string, status = 'COMPLETED') => ({ __typename: 'CheckRun', name: 'ok', status, conclusion });
const view = (state: string, rollup: unknown[] = [], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ number: 12, url: 'https://github.com/acme/shop/pull/12', state, mergedAt: null, statusCheckRollup: rollup, ...extra });
const open = (ci: 'none' | 'pending' | 'passing' | 'failing', rollup: unknown[]) => ({
  name: `open, ${ci}`,
  stdout: view('OPEN', rollup),
  expect: { number: 12, url: 'https://github.com/acme/shop/pull/12', state: 'open' as const, mergedAt: null, ci },
});

// Each recorded output is read from both releases: they printed the same thing for everything phase 1 uses.
const recordedOutputs: RecordedOutputs = {
  versions: VERSIONS.map((v) => ({ name: v, stdout: recorded(v, 'version'), expect: v })),
  auth: VERSIONS.flatMap((v) => [
    {
      name: `${v} signed in`,
      hostname: 'github.com',
      result: { exitCode: 0, stdout: recorded(v, 'auth-status-json') },
      expect: { signedIn: true, user: 'yeyo11' },
    },
    {
      name: `${v} bad token on the active account`,
      hostname: 'github.com',
      result: { exitCode: 0, stdout: recorded(v, 'auth-status-json-invalid') },
      expect: { signedIn: false, user: null },
    },
    {
      name: `${v} bad token only`,
      hostname: 'github.com',
      result: { exitCode: 0, stdout: recorded(v, 'auth-status-json-invalid-only') },
      expect: { signedIn: false, user: null },
    },
    {
      name: `${v} no accounts`,
      hostname: 'github.com',
      result: { exitCode: 0, stdout: recorded(v, 'auth-status-json-none') },
      expect: { signedIn: false, user: null },
    },
    {
      name: `${v} a host gh does not list`,
      hostname: 'github.example.com',
      result: { exitCode: 0, stdout: recorded(v, 'auth-status-json') },
      expect: { signedIn: false, user: null },
    },
  ]),
  defaultBranches: [
    { name: '2.102.0 repository object', stdout: recorded('2.102.0', 'probe-repo'), expect: 'main' },
    { name: 'no default_branch', stdout: '{"private":true}', expect: null },
    { name: 'not JSON', stdout: 'oops', expect: null },
  ],
  finds: [
    { name: 'none', stdout: '[]', expect: [] },
    {
      name: 'one open',
      stdout: '[{"number":7,"url":"https://github.com/acme/shop/pull/7","state":"OPEN","headRefName":"task/ab","baseRefName":"main","isCrossRepository":false}]',
      expect: [{ number: 7, url: 'https://github.com/acme/shop/pull/7', state: 'open' }],
    },
    {
      name: 'a merged one and a closed one',
      stdout:
        '[{"number":7,"url":"u7","state":"MERGED","headRefName":"b","baseRefName":"main","isCrossRepository":false},{"number":5,"url":"u5","state":"CLOSED","headRefName":"b","baseRefName":"main","isCrossRepository":false}]',
      expect: [
        { number: 7, url: 'u7', state: 'merged' },
        { number: 5, url: 'u5', state: 'closed' },
      ],
    },
    {
      name: 'a fork’s pull request is never adopted',
      stdout: '[{"number":9,"url":"u9","state":"OPEN","headRefName":"b","baseRefName":"main","isCrossRepository":true}]',
      expect: [],
    },
  ],
  views: [
    ...VERSIONS.map((v) => ({
      name: `${v} merged (recorded)`,
      stdout: recorded(v, 'pr-view-branch-merged'),
      expect: { number: 150, url: 'https://github.com/yeyo11/agentry/pull/150', state: 'merged' as const, mergedAt: null, ci: 'none' as const },
    })),
    open('none', []),
    open('pending', [run('', 'IN_PROGRESS')]),
    open('passing', [run('SUCCESS'), run('SKIPPED')]),
    open('failing', [run('FAILURE'), run('', 'QUEUED')]),
    {
      name: 'merged with its time',
      stdout: view('MERGED', [], { mergedAt: '2026-09-30T19:11:31Z' }),
      expect: { number: 12, url: 'https://github.com/acme/shop/pull/12', state: 'merged' as const, mergedAt: '2026-09-30T19:11:31Z', ci: 'none' as const },
    },
    {
      name: 'closed',
      stdout: view('CLOSED'),
      expect: { number: 12, url: 'https://github.com/acme/shop/pull/12', state: 'closed' as const, mergedAt: null, ci: 'none' as const },
    },
  ],
  checks: [
    {
      // recorded: three pages of check runs of one commit (`--paginate --slurp`), plus an empty status list
      name: 'recorded check runs, slurped',
      ref: { headSha: '41c7063bc02b17a76a069d47c9a718245e6c2843', pipelineId: null },
      results: [recorded('2.92.0', 'api-slurp-obj2'), '[{"state":"pending","total_count":0,"statuses":[]}]'],
      expect: {
        checks: [
          { id: '109950177801', name: 'test', state: 'passed', source: 'actions', hasLog: true, rerunnable: true },
          { id: '109947414499', name: 'e2e (3/4)', state: 'passed' },
          { id: '109947414481', name: 'e2e (1/4)' },
          { id: '109947414378' },
          { id: '109947414284' },
          { id: '109947353497' },
          { id: '109947353476' },
          { id: '109947352997', name: 'changes' },
        ],
        truncated: false,
        next: 0,
      },
    },
  ],
  malformedChecks: [{ name: 'a check run page without check_runs', results: ['[{"total_count":1}]', '[{"statuses":[]}]'] }],
  malformedViews: [
    // 2.92 answers this, with exit 0, for a pull request that does not exist
    ...VERSIONS.map((v) => ({ name: `${v} {"number":N} alone`, stdout: recorded(v, 'pr-view-150-number') })),
    { name: 'a state gh does not print', stdout: '{"state":"DRAFT"}' },
    { name: 'a list', stdout: '[{"state":"OPEN"}]' },
  ],
};

runConformance({ adapter: githubAdapter, manifest: githubManifest, repo, classify: classifyCall, recorded: recordedOutputs });

test('github adapter: today’s ciOf table is unchanged and the view uses it', () => {
  assert.equal(ciOf([]), 'none');
  assert.equal(ciOf(null), 'none');
  assert.equal(ciOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
  assert.equal(ciOf([{ state: 'PENDING' }]), 'pending');
  assert.equal(ciOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }, { state: 'SUCCESS' }]), 'passing');
  assert.equal(ciOf([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'QUEUED' }]), 'failing');
  for (const conclusion of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']) {
    assert.equal(githubAdapter.parseView(view('OPEN', [run(conclusion)])).ci, 'failing', conclusion);
  }
  for (const state of ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS']) {
    assert.equal(githubAdapter.parseView(view('OPEN', [{ __typename: 'StatusContext', state }])).ci, 'pending', state);
  }
  // The two checks of the recorded `rollup-mixed`: a passing run and a pending status read as pending
  assert.equal(githubAdapter.parseView(view('OPEN', [run('SUCCESS'), { __typename: 'StatusContext', state: 'PENDING' }])).ci, 'pending');
});

test('github adapter: the calls are today’s arguments, pinned', () => {
  assert.deepEqual(githubAdapter.version().args, ['--version']);
  assert.deepEqual(githubAdapter.authStatus('github.com').args, ['auth', 'status', '--json', 'hosts']);
  assert.deepEqual(githubAdapter.defaultBranch(repo).args, ['api', '--hostname', 'github.com', 'repos/acme/shop']);
  assert.deepEqual(githubAdapter.create(repo, { head: 'task/ab', base: 'main', title: 'T', body: 'B' }).args, [
    'pr', 'create', '-R', 'github.com/acme/shop', '--head', 'task/ab', '--base', 'main', '--title', 'T', '--body-file', '-',
  ]);
  assert.deepEqual(githubAdapter.find(repo, { head: 'task/ab', base: 'main' }).args, [
    'pr', 'list', '-R', 'github.com/acme/shop', '--head', 'task/ab', '--base', 'main', '--state', 'all', '--limit', '2',
    '--json', 'number,url,state,headRefName,baseRefName,isCrossRepository',
  ]);
  assert.deepEqual(githubAdapter.view({ ...repo, host: 'github.example.com' }, 12).args, [
    'pr', 'view', '12', '-R', 'github.example.com/acme/shop', '--json', 'state,mergedAt,statusCheckRollup,url',
  ]);
  assert.deepEqual(githubAdapter.env(), envOf('gh'));
});

test('github adapter: parseAuth treats a failed gh as a parse error, never as signed out', () => {
  const failed: HostResult = { exitCode: 1, stdout: '', stderrFirstLine: 'boom', http: null, truncated: false, durationMs: 1 };
  assert.throws(() => githubAdapter.parseAuth(failed, 'github.com'), HostParseError);
  assert.throws(() => githubAdapter.parseAuth({ ...failed, exitCode: 0, stdout: '{"hosts":[]}' }, 'github.com'), HostParseError);
  assert.throws(() => githubAdapter.parseAuth({ ...failed, exitCode: 0, stdout: 'x' }, 'github.com'), HostParseError);
});

test('github adapter: parseAuth never carries a token source or scope into its answer', () => {
  const result: HostResult = { exitCode: 0, stdout: recorded('2.92.0', 'auth-status-json'), stderrFirstLine: '', http: null, truncated: false, durationMs: 1 };
  assert.deepEqual(Object.keys(githubAdapter.parseAuth(result, 'github.com')).sort(), ['signedIn', 'user']);
});

// The fake gh answers the calls the adapter builds, through the execution layer's own spawn.
const scratch = mkdtempSync(join(tmpdir(), 'agentry-hosts-github-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const fakeGh = join(here, 'fixtures/fake-gh.sh');

const runFake = (call: Parameters<typeof spawnHostCall>[0], state: string) =>
  spawnHostCall(call, { binaryPath: fakeGh, cwd: scratch, baseEnv: { PATH: process.env.PATH, FAKE_GH_STATE: state } });

test('github adapter: the fake gh answers version, auth per host, the default branch, create and find', async () => {
  const state = mkdtempSync(join(scratch, 'state-'));
  const version = await runFake(githubAdapter.version(), state);
  assert.equal(githubAdapter.parseVersion(version.stdout), '2.92.0');

  writeFileSync(join(state, 'hosts'), 'github.com github.example.com\n');
  writeFileSync(join(state, 'unauth-github.example.com'), '');
  const auth = await runFake(githubAdapter.authStatus('github.com'), state);
  assert.deepEqual(githubAdapter.parseAuth(auth, 'github.com'), { signedIn: true, user: 'octocat' });
  assert.deepEqual(githubAdapter.parseAuth(auth, 'github.example.com'), { signedIn: false, user: null });

  const branch = await runFake(githubAdapter.defaultBranch(repo), state);
  assert.equal(githubAdapter.parseDefaultBranch(branch.stdout), 'main');

  assert.deepEqual(githubAdapter.parseFind((await runFake(githubAdapter.find(repo, { head: 'task/cw-1', base: 'main' }), state)).stdout), []);
  const created = await runFake(githubAdapter.create(repo, { head: 'task/cw-1', base: 'main', title: 'T', body: 'the body\n' }), state);
  assert.equal(created.exitCode, 0);
  assert.equal(readFileSync(join(state, 'body-7'), 'utf8'), 'the body\n');
  assert.deepEqual(githubAdapter.parseFind((await runFake(githubAdapter.find(repo, { head: 'task/cw-1', base: 'main' }), state)).stdout), [
    { number: 7, url: 'https://github.com/acme/shop/pull/7', state: 'open' },
  ]);
});
