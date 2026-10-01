import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { WorkItemPullRequestCi } from '@agentry/shared';
import { classifyCall } from '../src/hosts/classify.ts';
import { HostParseError, type ChangeRequestView, type HostRepo } from '../src/hosts/code-host.ts';
import { spawnHostCall, type HostCall } from '../src/hosts/exec.ts';
import { gitlabAdapter, parseProjectId, pipelineCi } from '../src/hosts/gitlab/adapter.ts';
import { gitlabManifest } from '../src/hosts/gitlab/manifest.ts';
import { runConformance } from './hosts/conformance.ts';

const here = dirname(fileURLToPath(import.meta.url));
const recorded = (name: string): string => readFileSync(join(here, 'fixtures/recordings/glab/1.120.0', name), 'utf8');
const FAKE = join(here, 'fixtures/fake-glab.sh');

const repo: HostRepo = { host: 'gitlab.com', path: 'yeyo11/agentry', owner: 'yeyo11', name: 'agentry', projectId: 87089091 };
const URL_FORM = 'https://gitlab.com/yeyo11/agentry';

const withView = (patch: Record<string, unknown>): string => JSON.stringify({ ...(JSON.parse(recorded('mrview10.out')) as object), ...patch });
const withPipeline = (status: string): string => withView({ head_pipeline: { id: 1, status } });

const view = (state: ChangeRequestView['state'], ci: WorkItemPullRequestCi, number = 10, mergedAt: string | null = null): ChangeRequestView => ({
  number,
  url: `${URL_FORM}/-/merge_requests/${number}`,
  state,
  mergedAt,
  ci,
});

// Every pipeline status of docs/plans/code-hosts.md, "The rolled-up CI, per host"
const CI_TABLE: Array<[string, WorkItemPullRequestCi]> = [
  ['failed', 'failing'],
  ['canceled', 'failing'],
  ['canceling', 'failing'],
  ['created', 'pending'],
  ['waiting_for_resource', 'pending'],
  ['preparing', 'pending'],
  ['waiting_for_callback', 'pending'],
  ['pending', 'pending'],
  ['running', 'pending'],
  ['scheduled', 'pending'],
  ['manual', 'pending'],
  ['a-status-from-a-later-release', 'pending'],
  ['success', 'passing'],
  ['skipped', 'passing'],
];

const mrlist = JSON.parse(recorded('mrlist.out')) as Array<{ iid: number; web_url: string; state: string }>;

runConformance({
  adapter: gitlabAdapter,
  manifest: gitlabManifest,
  repo,
  classify: classifyCall,
  recorded: {
    versions: [
      { name: 'version', stdout: recorded('version.out'), expect: '1.120.0' },
      { name: 'unrelated output', stdout: 'gh version 2.92.0 (2026-04-28)\n', expect: null },
    ],
    views: [
      // recorded: an open one with no pipeline (a project without CI prints null) and one with a failed pipeline
      { name: 'recorded open, no pipeline', stdout: recorded('mrview4.out'), expect: view('open', 'none', 4) },
      { name: 'recorded open, failed pipeline', stdout: recorded('mrview10.out'), expect: view('open', 'failing') },
      { name: 'merged', stdout: withView({ state: 'merged', merged_at: '2026-09-30T18:00:00.000Z' }), expect: view('merged', 'failing', 10, '2026-09-30T18:00:00.000Z') },
      { name: 'closed', stdout: withView({ state: 'closed' }), expect: view('closed', 'failing') },
      { name: 'locked reads as open', stdout: withView({ state: 'locked' }), expect: view('open', 'failing') },
      ...CI_TABLE.map(([status, ci]) => ({ name: `pipeline ${status}`, stdout: withPipeline(status), expect: view('open', ci) })),
    ],
    malformedViews: [
      { name: 'no iid', stdout: withView({ iid: undefined }) },
      { name: 'no web_url', stdout: withView({ web_url: undefined }) },
      { name: 'unknown state', stdout: withView({ state: 'on-hold' }) },
      { name: 'recorded 404 body', stdout: recorded('view404.out') },
    ],
    finds: [
      { name: 'recorded list', stdout: recorded('mrlist.out'), expect: mrlist.map((mr) => ({ number: mr.iid, url: mr.web_url, state: 'open' as const })) },
      { name: 'none', stdout: '[]', expect: [] },
    ],
    defaultBranches: [
      { name: 'recorded repo view', stdout: recorded('repoview.out'), expect: 'main' },
      { name: 'recorded error body', stdout: recorded('view404.out'), expect: null },
      { name: 'not JSON', stdout: 'No project found', expect: null },
    ],
    auth: [
      { name: 'signed in', hostname: 'gitlab.com', result: { exitCode: 0, stdout: recorded('authst.out') }, expect: { signedIn: true, user: null } },
      { name: 'signed out', hostname: 'gitlab.com', result: { exitCode: 1, stdout: '' }, expect: { signedIn: false, user: null } },
      { name: 'killed', hostname: 'gitlab.com', result: { exitCode: null, stdout: '' }, expect: { signedIn: false, user: null } },
    ],
  },
});

test('the recordings the tests lean on are what the fixtures say', () => {
  assert.ok(mrlist.length > 0 && mrlist.every((mr) => mr.state === 'opened'));
  assert.equal(JSON.parse(recorded('mrview10.out')).head_pipeline.status, 'failed');
  assert.equal(JSON.parse(recorded('mrview4.out')).head_pipeline, null);
});

test('pipelineCi reads every status of the table, and a missing or odd one is never passing', () => {
  for (const [status, ci] of CI_TABLE) assert.equal(pipelineCi(status), ci, status);
  assert.equal(pipelineCi(undefined), 'pending');
  assert.equal(pipelineCi(null), 'pending');
});

test('parseProjectId keeps the numeric id of repo view', () => {
  assert.equal(parseProjectId(recorded('repoview.out')), 87089091);
  assert.equal(parseProjectId('not json'), null);
  assert.equal(parseProjectId('{"id":"x"}'), null);
});

test('parseFind drops what it cannot read and maps every state', () => {
  const stdout = JSON.stringify([
    { iid: 1, web_url: 'https://gitlab.com/a/b/-/merge_requests/1', state: 'merged' },
    { iid: 2, web_url: 'https://gitlab.com/a/b/-/merge_requests/2', state: 'closed' },
    { iid: 3, web_url: 'https://gitlab.com/a/b/-/merge_requests/3', state: 'locked' },
    { iid: 4, state: 'opened' },
    { web_url: 'x', state: 'opened' },
    null,
  ]);
  assert.deepEqual(
    gitlabAdapter.parseFind(stdout).map((mr) => [mr.number, mr.state]),
    [
      [1, 'merged'],
      [2, 'closed'],
      [3, 'open'],
    ],
  );
  assert.throws(() => gitlabAdapter.parseFind('{}'), HostParseError);
  assert.throws(() => gitlabAdapter.parseFind('nope'), HostParseError);
});

test('the calls are the recorded arguments, pinned by URL', () => {
  const create = gitlabAdapter.create(repo, { head: 'task/ab12', base: 'main', title: 'T', body: 'B' });
  assert.deepEqual(create.args, ['mr', 'create', '-R', URL_FORM, '--source-branch', 'task/ab12', '--target-branch', 'main', '--title', 'T', '--description-file', '-', '--yes']);
  assert.ok(!create.args.includes('--recover'));
  assert.deepEqual(gitlabAdapter.find(repo, { head: 'task/ab12', base: 'main' }).args, ['mr', 'list', '-R', URL_FORM, '-s', 'task/ab12', '-t', 'main', '-A', '-P', '2', '-F', 'json']);
  assert.deepEqual(gitlabAdapter.view(repo, 4).args, ['mr', 'view', '4', '-R', URL_FORM, '-F', 'json']);
  assert.deepEqual(gitlabAdapter.defaultBranch(repo).args, ['repo', 'view', '-R', URL_FORM, '-F', 'json']);
  assert.deepEqual(gitlabAdapter.authStatus('git.example.com').args, ['auth', 'status', '--hostname', 'git.example.com']);
  assert.deepEqual(gitlabAdapter.version().args, ['version']);
});

// --- the adapter against fake-glab.sh, through the real process runner ---

const root = mkdtempSync(join(tmpdir(), 'agentry-hosts-gitlab-'));
after(() => rmSync(root, { recursive: true, force: true }));
let scenarios = 0;

/** A fresh state directory, so that scenarios do not see each other's switches */
function scenario(switches: Record<string, string> = {}): { state: string; run: (call: HostCall) => ReturnType<typeof spawnHostCall>; calls: () => string[] } {
  const state = join(root, `s${scenarios++}`);
  mkdirSync(state);
  for (const [name, content] of Object.entries(switches)) writeFileSync(join(state, name), content);
  return {
    state,
    run: (call) => spawnHostCall(call, { binaryPath: FAKE, cwd: root, baseEnv: { PATH: process.env.PATH, FAKE_GLAB_STATE: state } }),
    calls: () => (existsSync(join(state, 'calls')) ? readFileSync(join(state, 'calls'), 'utf8').split('\n').filter(Boolean) : []),
  };
}

test('fake-glab answers version, auth, repo view, create, find and view as recorded', async () => {
  const { run, state, calls } = scenario();

  const version = await run(gitlabAdapter.version());
  assert.equal(gitlabAdapter.parseVersion(version.stdout), '1.120.0');

  const auth = await run(gitlabAdapter.authStatus('gitlab.com'));
  assert.deepEqual(gitlabAdapter.parseAuth(auth, 'gitlab.com'), { signedIn: true, user: null });
  assert.equal(auth.stdout, '');

  const repoView = await run(gitlabAdapter.defaultBranch(repo));
  assert.equal(gitlabAdapter.parseDefaultBranch(repoView.stdout), 'main');
  assert.equal(parseProjectId(repoView.stdout), 87089091);

  const body = 'Objective: ship it\n\n- "quoted" and `ticks` and $(subshell)\n';
  const created = await run(gitlabAdapter.create(repo, { head: 'task/ab12', base: 'main', title: 'T', body }));
  assert.equal(created.exitCode, 0);
  assert.equal(created.stdout, `${URL_FORM}/-/merge_requests/4\n`);
  assert.equal(readFileSync(join(state, 'body-4'), 'utf8'), body);

  const found = gitlabAdapter.parseFind((await run(gitlabAdapter.find(repo, { head: 'task/ab12', base: 'main' }))).stdout);
  assert.deepEqual(found, [{ number: 4, url: `${URL_FORM}/-/merge_requests/4`, state: 'open' }]);
  assert.deepEqual(gitlabAdapter.parseFind((await run(gitlabAdapter.find(repo, { head: 'task/other', base: 'main' }))).stdout), []);

  const mr = gitlabAdapter.parseView((await run(gitlabAdapter.view(repo, 4))).stdout);
  assert.deepEqual(mr, view('open', 'none', 4));

  // every call was logged, none was an unknown one
  assert.equal(calls().length, 7);
  assert.ok(calls().every((line) => !line.startsWith('unknown')));
});

test('fake-glab: signed out, a duplicate create, a missing merge request and an unreachable host', async () => {
  const signedOut = scenario({ 'unauth-gitlab.com': '' });
  const auth = await signedOut.run(gitlabAdapter.authStatus('gitlab.com'));
  assert.equal(auth.exitCode, 1);
  assert.deepEqual(gitlabAdapter.parseAuth(auth, 'gitlab.com'), { signedIn: false, user: null });

  // a failed create has no stdout: the lookup by head and base is what finds the merge request
  const dup = scenario({ dup: '' });
  const failed = await dup.run(gitlabAdapter.create(repo, { head: 'task/ab12', base: 'main', title: 'T', body: 'B' }));
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stdout, '');
  assert.deepEqual(
    gitlabAdapter.parseFind((await dup.run(gitlabAdapter.find(repo, { head: 'task/ab12', base: 'main' }))).stdout).map((mr) => mr.number),
    [7],
  );

  const missing = scenario({ notfound: '' });
  const gone = await missing.run(gitlabAdapter.view(repo, 999));
  assert.equal(gone.exitCode, 1);
  assert.throws(() => gitlabAdapter.parseView(gone.stdout), HostParseError);

  const down = scenario({ fail: '' });
  const unreachable = await down.run(gitlabAdapter.view(repo, 4));
  assert.equal(unreachable.exitCode, 1);
  // the recorded {"error"} body on stdout is never taken for a merge request
  assert.throws(() => gitlabAdapter.parseView(unreachable.stdout), HostParseError);
});

test('fake-glab answers a view with the number it was asked for, and an unrecorded call fails', async () => {
  const { run } = scenario();
  const seven = gitlabAdapter.parseView((await run(gitlabAdapter.view(repo, 7))).stdout);
  assert.equal(seven.number, 7);
  assert.equal(seven.url, `${URL_FORM}/-/merge_requests/7`);
  const unknown = await run({ cli: 'glab', args: ['mr', 'merge', '7'], kind: 'write', class: 'write', host: null });
  assert.equal(unknown.exitCode, 1);
});
