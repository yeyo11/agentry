import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyCall } from '../src/hosts/classify.ts';
import { HostParseError, type HostCall, type HostRepo, type HostResult } from '../src/hosts/code-host.ts';
import { githubManifest } from '../src/hosts/github/manifest.ts';
import { gitlabManifest } from '../src/hosts/gitlab/manifest.ts';
import { trackerAdapter, trackerAdapters } from '../src/trackers/adapters.ts';
import { githubIssuesAdapter } from '../src/trackers/github-issues/adapter.ts';
import { gitlabIssuesAdapter } from '../src/trackers/gitlab-issues/adapter.ts';
import { IssueIsPullRequest, ISSUES_CEILING, ISSUES_PAGE_SIZE } from '../src/trackers/tracker.ts';
import { checkTrackerConformance, runTrackerConformance } from './trackers/conformance.ts';

// The tracker adapters against what was recorded (fixtures/recordings: gh 2.92.0 and 2.102.0, glab
// 1.120.0 with `t0a`). A call whose argv was recorded is replayed through fake-cli.mjs, which
// answers only an argv it has: a changed argument exits 97 and fails the test instead of being
// guessed. Output that was recorded under another argv is parsed from its capture file.

const here = dirname(fileURLToPath(import.meta.url));
const recordings = join(here, 'fixtures/recordings');
const out = (dir: string, label: string): string => readFileSync(join(recordings, dir, `${label}.out`), 'utf8');

const ghRepo: HostRepo = { host: 'github.com', path: 'yeyo11/agentry-probe', owner: 'yeyo11', name: 'agentry-probe' };
const glRepo: HostRepo = { host: 'gitlab.com', path: 'yeyo11/agentry', owner: 'yeyo11', name: 'agentry', projectId: 87089091 };

/** The recordings were made with `-R owner/repo`; Agentry pins the host, so the pin is taken off to find the recorded argv. */
function unpin(call: HostCall, repo: HostRepo): string[] {
  const at = call.args.indexOf('-R');
  if (at === -1) return call.args;
  const args = [...call.args];
  args[at + 1] = `${repo.owner}/${repo.name}`;
  return args;
}

function replay(call: HostCall, repo: HostRepo, env: Record<string, string> = {}): HostResult {
  const fake = join(here, 'fixtures/fake-cli.mjs');
  const run = spawnSync(process.execPath, [fake, ...unpin(call, repo)], {
    input: call.input ?? '',
    encoding: 'utf8',
    env: { ...process.env, FAKE_CLI: call.cli, ...env },
  });
  assert.notEqual(run.status, 97, `unrecorded call: ${run.stderr}`);
  return { exitCode: run.status, stdout: run.stdout, stderrFirstLine: '', http: null, truncated: false, durationMs: 1 };
}

const GH_VERSION = { FAKE_CLI_VERSION: '2.102.0' };

// ---------- conformance ----------

runTrackerConformance({ adapter: githubIssuesAdapter, hostManifest: githubManifest, repo: ghRepo, classify: classifyCall, bodyIn: 'stdin' });
runTrackerConformance({ adapter: gitlabIssuesAdapter, hostManifest: gitlabManifest, repo: glRepo, classify: classifyCall, bodyIn: 'argv', malformedIssues: [{ name: 'a pull request', stdout: out('gh/2.92.0', 'issue-view-pr') }] });

test('the conformance suite fails on purpose for an adapter that breaks a rule', () => {
  const leaky = { ...githubIssuesAdapter, list: (repo: HostRepo, req: Parameters<typeof githubIssuesAdapter.list>[1]): HostCall => ({ ...githubIssuesAdapter.list(repo, req), args: ['issue', 'list', '--search', req.query], host: null }) };
  const report = checkTrackerConformance({ adapter: leaky, hostManifest: githubManifest, repo: ghRepo, classify: classifyCall, bodyIn: 'stdin' });
  assert.ok((report['every call is pinned to its host and repository'] ?? []).length > 0);
  const lax = { ...githubIssuesAdapter, get: (repo: HostRepo, key: string): HostCall => ({ ...githubIssuesAdapter.get(repo, '1'), args: ['issue', 'view', key] }) };
  assert.ok((checkTrackerConformance({ adapter: lax, hostManifest: githubManifest, repo: ghRepo, classify: classifyCall, bodyIn: 'stdin' })['a key that is not an issue number never reaches argv'] ?? []).length > 0);
});

test('an issue search that reads like a verb is a read, not a write', () => {
  for (const adapter of trackerAdapters()) {
    const repo = adapter.id === 'github-issues' ? ghRepo : glRepo;
    for (const query of ['close', 'update', 'merge', 'create']) assert.equal(classifyCall(adapter.list(repo, { query, page: 1 })), 'read', `${adapter.id} ${query}`);
  }
});

// ---------- the registry: Jira and YouTrack have no adapter ----------

test('only the recorded trackers have an adapter; jira and youtrack have none until their CLIs are recorded', () => {
  assert.equal(trackerAdapter('github-issues'), githubIssuesAdapter);
  assert.equal(trackerAdapter('gitlab-issues'), gitlabIssuesAdapter);
  assert.equal(trackerAdapter('jira'), null);
  assert.equal(trackerAdapter('youtrack'), null);
  assert.deepEqual(trackerAdapters().map((a) => a.id).sort(), ['github-issues', 'gitlab-issues']);
});

// ---------- GitLab, replayed from glab 1.120.0 ----------

test('glab: view reads the recorded issue, with its labels and work_items url', () => {
  const result = replay(gitlabIssuesAdapter.get(glRepo, '4'), glRepo, { FAKE_CLI_LABELS: 'issue_view' });
  assert.equal(result.exitCode, 0);
  const issue = gitlabIssuesAdapter.parseGet(result.stdout);
  assert.equal(issue.key, '4');
  assert.equal(issue.externalId, '205176319');
  assert.equal(issue.title, 't0a probe issue');
  assert.equal(issue.body, 'scratch issue for recording; deleted afterwards');
  assert.equal(issue.state, 'open');
  assert.deepEqual(issue.labels, []);
  assert.equal(issue.url, 'https://gitlab.com/yeyo11/agentry/-/work_items/4');
  assert.equal(issue.updatedAt, '2026-10-02T05:42:49.874Z');
});

test('glab: an issue that is gone exits 1 and its {"error"} body is never read as data', () => {
  const result = replay(gitlabIssuesAdapter.get(glRepo, '4'), glRepo, { FAKE_CLI_LABELS: 'issue_gone' });
  assert.equal(result.exitCode, 1);
  assert.throws(() => gitlabIssuesAdapter.parseGet(result.stdout), HostParseError);
});

test('glab: create prints the work_items url and the key is the iid', () => {
  const call = gitlabIssuesAdapter.create(glRepo, { title: 't0a probe issue', body: 'scratch issue for recording; deleted afterwards', labels: ['t0a-scratch'] });
  const result = replay(call, glRepo, { FAKE_CLI_LABELS: 'issue_create' });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(gitlabIssuesAdapter.parseCreated(result.stdout), { key: '4', url: 'https://gitlab.com/yeyo11/agentry/-/work_items/4' });
});

test('glab: update adds and removes labels with the recorded flags', () => {
  const add = replay(gitlabIssuesAdapter.update(glRepo, '4', { addLabels: ['t0a-two'] }), glRepo);
  assert.equal(add.exitCode, 0);
  assert.match(add.stdout, /added labels t0a-two/);
  const remove = replay(gitlabIssuesAdapter.update(glRepo, '4', { removeLabels: ['t0a-scratch'] }), glRepo);
  assert.equal(remove.exitCode, 0);
  assert.match(remove.stdout, /removed labels t0a-scratch/);
  // title, label and description together, in the recorded order
  const all = gitlabIssuesAdapter.update(glRepo, '2', { title: 'probe issue two (renamed)', addLabels: ['probe-extra'], body: 'probe new body' });
  assert.equal(replay(all, glRepo).exitCode, 0);
});

test('glab: a note prints the note url and the id is read from its fragment', () => {
  const result = replay(gitlabIssuesAdapter.comment(glRepo, '4', 't0a note'), glRepo);
  assert.deepEqual(gitlabIssuesAdapter.parseCommented(result.stdout), { id: '3942895762', url: 'https://gitlab.com/yeyo11/agentry/-/work_items/4#note_3942895762' });
});

test('glab: close and reopen are idempotent writes with no output to parse', () => {
  for (const call of [gitlabIssuesAdapter.close(glRepo, '4', 'completed'), gitlabIssuesAdapter.setStatus(glRepo, '4', { column: 'done', name: null }), gitlabIssuesAdapter.reopen(glRepo, '4')]) {
    assert.ok(call);
    assert.equal(call.kind, 'write');
    assert.equal(replay(call, glRepo).exitCode, 0);
  }
  // a reason GitLab does not have is ignored, not passed
  assert.deepEqual(gitlabIssuesAdapter.close(glRepo, '4', 'not-planned').args, gitlabIssuesAdapter.close(glRepo, '4', 'completed').args);
});

test('glab: the labels are read through api on the numeric project id; none is empty', () => {
  const none = replay(gitlabIssuesAdapter.labels(glRepo), glRepo, { FAKE_CLI_LABELS: 'labels_list' });
  assert.equal(none.exitCode, 0);
  assert.deepEqual(gitlabIssuesAdapter.parseLabels(none.stdout), []);
  const one = replay(gitlabIssuesAdapter.labels(glRepo), glRepo, { FAKE_CLI_LABELS: 'labels_during' });
  assert.deepEqual(gitlabIssuesAdapter.parseLabels(one.stdout), [{ name: 't0a-two', color: '#ad4363', description: '' }]);
});

test('glab: the labels need the numeric project id', () => {
  assert.throws(() => gitlabIssuesAdapter.labels({ ...glRepo, projectId: undefined }));
});

test('glab: a list page is read from the recorded output; a full page says there is more', () => {
  const stdout = out('glab/1.120.0', 'issue_list');
  const page = gitlabIssuesAdapter.parseList(stdout, { query: 't0a probe', page: 1 });
  assert.equal(page.issues.length, 1);
  assert.deepEqual(page.issues[0]?.labels, ['t0a-scratch']);
  assert.equal(page.issues[0]?.key, '4');
  assert.equal(page.hasMore, false);
  const entry: unknown = JSON.parse(stdout)[0];
  const full = JSON.stringify(Array.from({ length: ISSUES_PAGE_SIZE }, () => entry));
  assert.equal(gitlabIssuesAdapter.parseList(full, { query: '', page: 2 }).hasMore, true);
  assert.deepEqual(gitlabIssuesAdapter.list(glRepo, { query: 'login', page: 2 }).args.slice(-6), ['-P', String(ISSUES_PAGE_SIZE), '-p', '2', '--search', 'login']);
});

test('glab: an unknown state or a missing iid is refused, not guessed', () => {
  const issue = JSON.parse(out('glab/1.120.0', 'issue_view')) as Record<string, unknown>;
  assert.throws(() => gitlabIssuesAdapter.parseGet(JSON.stringify({ ...issue, state: 'locked' })), HostParseError);
  assert.throws(() => gitlabIssuesAdapter.parseGet(JSON.stringify({ ...issue, iid: undefined })), HostParseError);
  assert.throws(() => gitlabIssuesAdapter.parseGet(JSON.stringify({ ...issue, labels: [{ name: 'x' }] })), HostParseError);
  // a closed issue reads as closed
  assert.equal(gitlabIssuesAdapter.parseGet(JSON.stringify({ ...issue, state: 'closed' })).state, 'closed');
});

// ---------- GitHub, replayed from gh 2.92.0 / 2.102.0 ----------

test('gh: create sends the body on stdin and prints the issue url', () => {
  const result = replay(githubIssuesAdapter.create(ghRepo, { title: 'Probe issue B', body: 'body' }), ghRepo, GH_VERSION);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(githubIssuesAdapter.parseCreated(result.stdout), { key: '21', url: 'https://github.com/yeyo11/agentry-probe/issues/21' });
  const labelled = replay(githubIssuesAdapter.create(ghRepo, { title: 'Probe issue A', body: 'body', labels: ['probe-label'] }), ghRepo, { FAKE_CLI_VERSION: '2.92.0' });
  assert.equal(githubIssuesAdapter.parseCreated(labelled.stdout).key, '20');
});

test('gh: close with a reason, and close again, exit 0; reopen too', () => {
  const completed = replay(githubIssuesAdapter.close(ghRepo, '21', 'completed'), ghRepo, GH_VERSION);
  assert.equal(completed.exitCode, 0);
  assert.equal(replay(githubIssuesAdapter.reopen(ghRepo, '21'), ghRepo).exitCode, 0);
  // "not planned" is one argv word, the form gh takes
  assert.ok(githubIssuesAdapter.close(ghRepo, '21', 'not-planned').args.includes('not planned'));
});

test('gh: gh issue view on a pull request number is refused as a pull request', () => {
  assert.throws(() => githubIssuesAdapter.parseGet(out('gh/2.92.0', 'issue-view-pr')), IssueIsPullRequest);
  assert.throws(() => githubIssuesAdapter.parseGet(out('gh/2.102.0', 'issue-view-pr')), IssueIsPullRequest);
});

test('gh: a view that lacks the fields Agentry asked for is refused, not read as an empty issue', () => {
  assert.throws(() => githubIssuesAdapter.parseGet(out('gh/2.92.0', 'issue-view-sr')), HostParseError);
});

test('gh: an issue is read with its state reason and the pull requests that close it', () => {
  // The recorded closing reference and state, with the fields the full view adds (the field list is recorded; no capture holds all of them at once)
  const recorded = JSON.parse(out('gh/2.92.0', 'issue-view-sr')) as Record<string, unknown>;
  const stdout = JSON.stringify({ ...recorded, number: 22, title: 'Probe', body: 'a body', labels: [{ id: 'LA_1', name: 'bug', description: '', color: 'd73a4a' }], url: 'https://github.com/yeyo11/agentry-probe/issues/22', updatedAt: '2026-10-01T10:00:00Z' });
  const issue = githubIssuesAdapter.parseGet(stdout);
  assert.deepEqual(issue, {
    key: '22',
    externalId: null,
    title: 'Probe',
    body: 'a body',
    state: 'closed',
    stateReason: 'completed',
    labels: ['bug'],
    url: 'https://github.com/yeyo11/agentry-probe/issues/22',
    updatedAt: '2026-10-01T10:00:00Z',
    closedByChangeRequests: [24],
  });
  assert.equal(githubIssuesAdapter.parseGet(JSON.stringify({ ...recorded, number: 22, title: 'P', url: 'https://github.com/o/r/issues/22', state: 'CLOSED', stateReason: 'NOT_PLANNED' })).stateReason, 'not-planned');
  assert.equal(githubIssuesAdapter.parseGet(JSON.stringify({ number: 3, title: 'P', url: 'https://github.com/o/r/issues/3', state: 'OPEN', stateReason: '' })).stateReason, null);
  assert.throws(() => githubIssuesAdapter.parseGet(JSON.stringify({ number: 3, title: 'P', url: 'https://github.com/o/r/issues/3', state: 'MERGED' })), HostParseError);
});

test('gh: an empty list is the recorded []; a page is cut out of what gh printed', () => {
  assert.deepEqual(githubIssuesAdapter.parseList(out('gh/2.92.0', 'issue-list-sr'), { query: '', page: 1 }), { issues: [], page: 1, hasMore: false });
  const issue = (n: number): unknown => ({ number: n, title: `Issue ${String(n)}`, state: 'OPEN', stateReason: '', labels: [], url: `https://github.com/o/r/issues/${String(n)}`, updatedAt: '2026-10-01T10:00:00Z' });
  const all = JSON.stringify(Array.from({ length: ISSUES_PAGE_SIZE + 1 }, (_, i) => issue(i + 1)));
  const first = githubIssuesAdapter.parseList(all, { query: '', page: 1 });
  assert.equal(first.issues.length, ISSUES_PAGE_SIZE);
  assert.equal(first.hasMore, true);
  const second = githubIssuesAdapter.parseList(all, { query: '', page: 2 });
  assert.deepEqual(second.issues.map((i) => i.key), [String(ISSUES_PAGE_SIZE + 1)]);
  assert.equal(second.hasMore, false);
});

test('gh: a page asks for one more than it shows, and never past the ceiling', () => {
  const limit = (page: number): string => githubIssuesAdapter.list(ghRepo, { query: '', page }).args[githubIssuesAdapter.list(ghRepo, { query: '', page }).args.indexOf('--limit') + 1] ?? '';
  assert.equal(limit(1), String(ISSUES_PAGE_SIZE + 1));
  assert.equal(limit(2), String(2 * ISSUES_PAGE_SIZE + 1));
  assert.equal(limit(9), String(ISSUES_CEILING));
  // at the ceiling the last page has no next one, even when gh printed a full list
  const full = JSON.stringify(Array.from({ length: ISSUES_CEILING }, (_, i) => ({ number: i + 1, title: 't', state: 'OPEN', url: 'https://github.com/o/r/issues/1' })));
  assert.equal(githubIssuesAdapter.parseList(full, { query: '', page: ISSUES_CEILING / ISSUES_PAGE_SIZE }).hasMore, false);
});

test('gh: the labels are read with their name, colour and description', () => {
  assert.deepEqual(githubIssuesAdapter.parseLabels('[{"name":"bug","color":"d73a4a","description":"Something isn’t working"},{"name":"x","color":"fff","description":null}]'), [
    { name: 'bug', color: 'd73a4a', description: 'Something isn’t working' },
    { name: 'x', color: 'fff', description: '' },
  ]);
});

test('gh: update passes only what changes and the body on stdin', () => {
  const call = githubIssuesAdapter.update(ghRepo, '20', { title: 'T', body: 'B', addLabels: ['a'], removeLabels: ['b'] });
  assert.deepEqual(call.args, ['issue', 'edit', '20', '-R', 'github.com/yeyo11/agentry-probe', '--title', 'T', '--body-file', '-', '--add-label', 'a', '--remove-label', 'b']);
  assert.equal(call.input, 'B');
  assert.equal(githubIssuesAdapter.update(ghRepo, '20', { title: 'T' }).input, undefined);
});
