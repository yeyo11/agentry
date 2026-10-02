import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyCall } from '../src/hosts/classify.ts';
import { HostParseError, type HostCall, type HostRepo, type HostResult, type MergeRead } from '../src/hosts/code-host.ts';
import { githubAdapter } from '../src/hosts/github/adapter.ts';
import { githubManifest } from '../src/hosts/github/manifest.ts';
import { gitlabAdapter } from '../src/hosts/gitlab/adapter.ts';
import { boxedRefusal } from '../src/hosts/gitlab/merge.ts';
import { gitlabManifest } from '../src/hosts/gitlab/manifest.ts';
import { firstLine } from '../src/hosts/redact.ts';
import { checkConformance, MERGE_HEAD, type RecordedOutputs } from './hosts/conformance.ts';

// Tests against what m0 recorded (fixtures/recordings, m0-NOTES.md): the adapters read the real
// outputs and build the argv that was run, with the host pinned.

const here = dirname(fileURLToPath(import.meta.url));
const file = (dir: string, label: string, ext: string): string => readFileSync(join(here, 'fixtures/recordings', dir, `${label}.${ext}`), 'utf8');
const gh = (label: string): string => file('gh/2.102.0', label, 'out');
const gl = (label: string): string => file('glab/1.120.0', label, 'out');

const ghRepo: HostRepo = { host: 'github.com', path: 'yeyo11/agentry-probe', owner: 'yeyo11', name: 'agentry-probe' };
const glRepo: HostRepo = { host: 'gitlab.com', path: 'yeyo11/agentry', owner: 'yeyo11', name: 'agentry', projectId: 87089091 };

const result = (stdout: string, extra: Partial<HostResult> = {}): HostResult => ({ exitCode: 0, stdout, stderrFirstLine: '', http: null, truncated: false, durationMs: 1, ...extra });
const argv = (call: HostCall | null): string => (call ? call.args.join(' ') : 'none');

const GH_HEAD = 'ee4c2b9707a2d898bcde196bb64171055bf4e3ba';
const GL_HEAD = 'b4199b8f0000000000000000000000000000abcd';

// ---------- conformance, merge section ----------

const ghReads: RecordedOutputs['mergeReads'] = [
  { name: 'blocked, mergeable, no decision', stdout: gh('blocked_view'), expect: { state: 'open', nodeId: 'PR_kwDOU1zIIM8AAAABGIG01w', headSha: GH_HEAD, mergeStateStatus: 'BLOCKED', reviewDecision: '', isDraft: false } },
  { name: 'unstable', stdout: gh('clean_view_32'), expect: { mergeStateStatus: 'UNSTABLE', autoMerge: { armed: false, method: null, by: null, at: null } } },
];
const glReads: RecordedOutputs['mergeReads'] = [
  { name: 'merged', stdout: gl('ci3_get_after_merge'), expect: { state: 'merged', detailedMergeStatus: 'not_open', headRef: 'probe/m0-ci', baseRef: 'probe/m0-base' } },
];

for (const [adapter, manifest, repo, reads] of [
  [githubAdapter, githubManifest, ghRepo, ghReads],
  [gitlabAdapter, gitlabManifest, glRepo, glReads],
] as const) {
  for (const [rule, problems] of Object.entries(checkConformance({ adapter, manifest, repo, classify: classifyCall, recorded: { mergeReads: reads } }))) {
    if (!rule.startsWith('merge:') && !rule.startsWith('every ') && !rule.startsWith('no call')) continue;
    test(`${manifest.id} adapter (merge): ${rule}`, () => {
      assert.deepEqual(problems, []);
    });
  }
}

test('the merge section of the conformance suite is built for both adapters, so it is not vacuous', () => {
  for (const [adapter, manifest, repo] of [[githubAdapter, githubManifest, ghRepo], [gitlabAdapter, gitlabManifest, glRepo]] as const) {
    const rules = Object.keys(checkConformance({ adapter, manifest, repo, classify: classifyCall })).filter((rule) => rule.startsWith('merge:'));
    assert.ok(rules.length >= 8, `${manifest.id}: ${String(rules.length)} merge rules`);
  }
});

// ---------- GitHub ----------

test('github merge: settings come from the repository object', () => {
  const settings = githubAdapter.parseMergeSettings(gh('probe-repo'));
  assert.deepEqual(settings.methods, ['squash', 'merge', 'rebase']);
  assert.equal(settings.fastForward, false);
  const mixed = githubAdapter.parseMergeSettings(JSON.stringify({ allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true, allow_auto_merge: true, delete_branch_on_merge: true }));
  assert.deepEqual(mixed, { methods: ['merge', 'rebase'], autoMergeAllowed: true, deleteBranchDefault: true, fastForward: false, requiresPipeline: false, mergeTrains: false, ciConfigPath: null });
  assert.equal(githubAdapter.parseMergeSettings(JSON.stringify({ allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: false })).methods.length, 0);
  for (const bad of ['', 'x', '[]', '{}', '{"default_branch":"main"}']) assert.throws(() => githubAdapter.parseMergeSettings(bad), HostParseError, bad);
});

test('github merge: the rules narrow the methods, and a read that failed says nothing', () => {
  const [call] = githubAdapter.rules(ghRepo, 'release/1');
  assert.equal(argv(call ?? null), 'api --hostname github.com repos/yeyo11/agentry-probe/rules/branches/release/1');
  const rules = JSON.stringify([
    { type: 'required_linear_history' },
    { type: 'pull_request', parameters: { allowed_merge_methods: ['squash', 'rebase'], required_review_thread_resolution: true } },
    { type: 'pull_request', parameters: { allowed_merge_methods: ['squash', 'merge'] } },
    { type: 'merge_queue', parameters: {} },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'x' }] } },
  ]);
  assert.deepEqual(githubAdapter.parseRules([result(rules)]), { methods: ['squash'], linearHistory: true, threadResolution: true, mergeQueue: true });
  assert.deepEqual(githubAdapter.parseRules([result('[]')]), { methods: null, linearHistory: false, threadResolution: false, mergeQueue: false });
  assert.equal(githubAdapter.parseRules([result('{"message":"Not Found"}', { exitCode: 1 })]), null);
  assert.equal(githubAdapter.parseRules([result('{}')]), null);
  assert.equal(githubAdapter.parseRules([]), null);
});

test('github merge: the read, armed or not', () => {
  assert.equal(argv(githubAdapter.readForMerge(ghRepo, 32)), 'pr view 32 -R github.com/yeyo11/agentry-probe --json id,number,url,state,isDraft,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest');
  const armed = githubAdapter.parseMergeRead(result(gh('automerge-armed')));
  assert.deepEqual(armed.autoMerge, { armed: true, method: 'squash', by: 'yeyo11', at: '2026-09-30T18:53:17Z' });
  assert.equal(armed.mergeStateStatus, 'BLOCKED');
  // It stays set after the merge: armed is open and set
  const merged = githubAdapter.parseMergeRead(result(JSON.stringify({ state: 'MERGED', autoMergeRequest: { mergeMethod: 'SQUASH', enabledAt: '2026-09-30T18:53:17Z' } })));
  assert.equal(merged.autoMerge.armed, false);
  assert.equal(merged.state, 'merged');
  // `{"number":N}` is what 2.92 prints for a pull request that does not exist
  assert.throws(() => githubAdapter.parseMergeRead(result('{"number":7}')), HostParseError);
});

test('github merge: the merge call is the recorded one, with the head guard, the body on stdin and -R', () => {
  const call = githubAdapter.merge(ghRepo, { number: 32, method: 'squash', expectedHead: GH_HEAD, deleteBranch: false, subject: 'probe m0 squash subject', body: 'line one\n\nline three' });
  assert.equal(argv(call), `pr merge 32 -R github.com/yeyo11/agentry-probe --squash --match-head-commit ${GH_HEAD} --subject probe m0 squash subject --body-file -`);
  assert.equal(call.input, 'line one\n\nline three');
  assert.equal(call.kind, 'write');
  assert.equal(call.class, 'long-write');
  assert.equal(call.bucket, 'graphql');
  assert.equal(argv(githubAdapter.merge(ghRepo, { number: 5, method: 'rebase', expectedHead: GH_HEAD, deleteBranch: true, subject: 'ignored', body: 'ignored' })), `pr merge 5 -R github.com/yeyo11/agentry-probe --rebase --match-head-commit ${GH_HEAD} --delete-branch`);
  assert.equal(githubAdapter.merge(ghRepo, { number: 5, method: 'merge', expectedHead: GH_HEAD, deleteBranch: false }).input, undefined);
  assert.throws(() => githubAdapter.merge(ghRepo, { number: 5, method: 'merge', expectedHead: GH_HEAD, deleteBranch: false, subject: 'two\nlines' }), HostParseError);
});

test('github merge: arming is the recorded mutation, never gh pr merge --auto', () => {
  const call = githubAdapter.arm(ghRepo, { number: 32, method: 'squash', expectedHead: GH_HEAD, nodeId: 'PR_kwDOU1zIIM8AAAABGIG3lg' });
  assert.equal(
    argv(call),
    `api --hostname github.com graphql -f query=mutation($id:ID!,$m:PullRequestMergeMethod!,$oid:GitObjectID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m,expectedHeadOid:$oid}){pullRequest{autoMergeRequest{mergeMethod enabledAt}}}} -f id=PR_kwDOU1zIIM8AAAABGIG3lg -f m=SQUASH -f oid=${GH_HEAD}`,
  );
  assert.equal(classifyCall(call), 'write');
  assert.ok(githubAdapter.arm(ghRepo, { number: 1, method: 'rebase', expectedHead: GH_HEAD, nodeId: 'PR_kwDOU1zIIM8AAAABGIG3lg' }).args.includes('m=REBASE'));
  assert.equal(argv(githubAdapter.disarm(ghRepo, 32)), 'pr merge 32 -R github.com/yeyo11/agentry-probe --disable-auto');
  assert.equal(githubAdapter.parseDisarm(result('')), true);
  assert.equal(githubAdapter.parseDisarm(result('', { exitCode: 1 })), false);
});

test('github merge: refusals read from the recorded answers', () => {
  const err = (label: string): string => firstLine(file('gh/2.102.0', label, 'err'));
  assert.equal(githubAdapter.mergeReason('merge', result('', { exitCode: 1, stderrFirstLine: err('st-merge-7-stale') })), 'head-moved');
  for (const label of ['merge-merge-disabled', 'merge-squash-disabled', 'merge-rebase-disabled']) {
    assert.equal(githubAdapter.mergeReason('merge', result('', { exitCode: 1, stderrFirstLine: err(label) })), 'method-not-allowed', label);
  }
  // A draft, a conflict and a blocked base are the re-read's to explain
  for (const label of ['st-merge-draft', 'st-merge-dirty', 'st-merge-review']) {
    assert.equal(githubAdapter.mergeReason('merge', result('', { exitCode: 1, stderrFirstLine: err(label) })), null, label);
  }
  const arm = (label: string): HostResult => result(gh(label), { exitCode: 1 });
  assert.equal(githubAdapter.mergeReason('arm', arm('automerge_off_graphql')), 'auto-merge-not-allowed');
  // The setting is checked first: it hides a stale head and an unstable pull request (recorded)
  assert.equal(githubAdapter.mergeReason('arm', arm('automerge_off_graphql_stale')), 'auto-merge-not-allowed');
  assert.equal(githubAdapter.mergeReason('arm', arm('automerge_off_graphql_unstable')), 'auto-merge-not-allowed');
  assert.equal(githubAdapter.mergeReason('arm', arm('gql-automerge-stale')), 'head-moved');
  assert.equal(githubAdapter.mergeReason('arm', result(JSON.stringify({ errors: [{ type: 'UNPROCESSABLE', message: 'Pull request Pull request is in unstable status' }] }), { exitCode: 1 })), 'auto-merge-not-needed');
  assert.equal(githubAdapter.mergeReason('arm', result('not json', { exitCode: 1 })), null);
  assert.equal(githubAdapter.mergeReason('disarm', result('', { exitCode: 1 })), null);
});

test('github merge: ready, the branch box and the calls GitHub does not have', () => {
  assert.equal(argv(githubAdapter.ready(ghRepo, 3, true)), 'pr ready 3 -R github.com/yeyo11/agentry-probe');
  assert.equal(argv(githubAdapter.ready(ghRepo, 3, false)), 'pr ready 3 -R github.com/yeyo11/agentry-probe --undo');
  const exists = githubAdapter.branchExists(ghRepo, 'probe/m0-a');
  assert.equal(argv(exists), 'api -i --hostname github.com repos/yeyo11/agentry-probe/branches/probe%2Fm0-a');
  assert.equal(githubAdapter.parseBranchExists(result('{}')), true);
  assert.equal(githubAdapter.parseBranchExists(result('', { exitCode: 1, http: { status: 404, headers: {} } })), false);
  assert.equal(githubAdapter.parseBranchExists(result('', { exitCode: 1, http: { status: 502, headers: {} } })), null);
  assert.equal(githubAdapter.parseBranchExists(result('', { exitCode: 1 })), null);
  // Update from the base is Agentry's own merge in the worktree
  assert.equal(githubAdapter.rebase?.(ghRepo, 1), null);
  assert.equal(githubAdapter.rebaseStatus?.(ghRepo, 1), null);
  assert.equal(githubAdapter.mergeabilityChecks?.(ghRepo, 1), null);
});

// ---------- GitLab ----------

test('gitlab merge: settings from the recorded repo view and from every strategy', () => {
  const recorded = gitlabAdapter.parseMergeSettings(gl('repoview'));
  assert.deepEqual(recorded, { methods: ['merge', 'squash'], autoMergeAllowed: true, deleteBranchDefault: true, fastForward: false, requiresPipeline: false, mergeTrains: false, ciConfigPath: null });
  const settings = (over: Record<string, unknown>) => gitlabAdapter.parseMergeSettings(JSON.stringify({ merge_method: 'merge', squash_option: 'default_off', ...over }));
  assert.deepEqual(settings({ squash_option: 'always' }).methods, ['squash']);
  assert.deepEqual(settings({ squash_option: 'never' }).methods, ['merge']);
  assert.deepEqual(settings({ squash_option: 'default_on' }).methods, ['squash', 'merge']);
  assert.deepEqual(settings({ merge_method: 'rebase_merge' }).methods, ['merge', 'squash']);
  const ff = settings({ merge_method: 'ff', squash_option: 'never', only_allow_merge_if_pipeline_succeeds: true, merge_trains_enabled: true, ci_config_path: 'ci/main.yml' });
  assert.deepEqual(ff, { methods: ['rebase'], autoMergeAllowed: true, deleteBranchDefault: false, fastForward: true, requiresPipeline: true, mergeTrains: true, ciConfigPath: 'ci/main.yml' });
  for (const bad of ['', '[]', '{}', '{"merge_method":"squashy"}']) assert.throws(() => gitlabAdapter.parseMergeSettings(bad), HostParseError, bad);
  assert.deepEqual(gitlabAdapter.rules(glRepo, 'main'), []);
  assert.deepEqual(gitlabAdapter.parseRules([]), { methods: null, linearHistory: false, threadResolution: false, mergeQueue: false });
});

test('gitlab merge: the read of an open, a merged and an armed merge request', () => {
  assert.equal(argv(gitlabAdapter.readForMerge(glRepo, 14)), 'api --hostname gitlab.com projects/87089091/merge_requests/14?with_merge_status_recheck=true');
  const open = gitlabAdapter.parseMergeRead(result(gl('disc_mr_view_blocked')));
  assert.equal(open.state, 'open');
  assert.equal(open.detailedMergeStatus, 'discussions_not_resolved');
  assert.equal(open.nodeId, null);
  assert.equal(open.autoMerge.armed, false);
  assert.match(open.headSha ?? '', /^[0-9a-f]{40}$/);
  const merged: MergeRead = gitlabAdapter.parseMergeRead(result(gl('ci3_get_after_merge')));
  assert.equal(merged.headPipeline?.status, 'running');
  assert.equal(merged.hasConflicts, false);
  const armedBody = { ...(JSON.parse(gl('disc_mr_view_blocked')) as Record<string, unknown>), merge_when_pipeline_succeeds: true, merge_user: { username: 'yeyo11' }, squash: true };
  assert.deepEqual(gitlabAdapter.parseMergeRead(result(JSON.stringify(armedBody))).autoMerge, { armed: true, method: 'squash', by: 'yeyo11', at: null });
  assert.throws(() => gitlabAdapter.parseMergeRead(result('{"iid":3,"state":"weird"}')), HostParseError);
});

test('gitlab merge: the mergeability checks are read through GraphQL, pinned to the project', () => {
  const call = gitlabAdapter.mergeabilityChecks?.(glRepo, 14);
  assert.equal(
    argv(call ?? null),
    'api --hostname gitlab.com graphql -f query=query{project(fullPath:"yeyo11/agentry"){mergeRequest(iid:"14"){detailedMergeStatus mergeStatusEnum mergeable mergeabilityChecks{identifier status}}}}',
  );
  assert.equal(call?.kind, 'read');
  assert.equal(classifyCall(call as HostCall), 'read');
  const checks = gitlabAdapter.parseMergeabilityChecks(result(gl('disc_gql_checks')));
  assert.equal(checks.length, 18);
  assert.deepEqual(checks.find((c) => c.identifier === 'DISCUSSIONS_NOT_RESOLVED'), { identifier: 'DISCUSSIONS_NOT_RESOLVED', status: 'FAILED' });
  assert.throws(() => gitlabAdapter.parseMergeabilityChecks(result('{"data":{"project":null}}')), HostParseError);
  assert.throws(() => gitlabAdapter.parseMergeabilityChecks(result('nope')), HostParseError);
  for (const path of ['a"b/c', 'a/b"){x', 'a b/c', '../x', '']) {
    assert.throws(() => gitlabAdapter.mergeabilityChecks?.({ ...glRepo, path }, 1), HostParseError, path);
  }
});

test('gitlab merge: Merge now has the head guard and --auto-merge=false, and the message in its own flag', () => {
  const base = 'mr merge 14 -R https://gitlab.com/yeyo11/agentry -y';
  assert.equal(argv(gitlabAdapter.merge(glRepo, { number: 14, method: 'merge', expectedHead: GL_HEAD, deleteBranch: false })), `${base} --sha ${GL_HEAD} --auto-merge=false`);
  assert.equal(argv(gitlabAdapter.merge(glRepo, { number: 14, method: 'rebase', expectedHead: GL_HEAD, deleteBranch: true, subject: 'ignored' })), `${base} --sha ${GL_HEAD} --auto-merge=false -d`);
  assert.equal(
    argv(gitlabAdapter.merge(glRepo, { number: 14, method: 'squash', expectedHead: GL_HEAD, deleteBranch: false, subject: 'Subject', body: 'Body' })),
    `${base} --sha ${GL_HEAD} --auto-merge=false --squash --squash-message Subject\n\nBody`,
  );
  assert.equal(
    argv(gitlabAdapter.merge(glRepo, { number: 14, method: 'merge', expectedHead: GL_HEAD, deleteBranch: false, subject: 'Subject' })),
    `${base} --sha ${GL_HEAD} --auto-merge=false -m Subject`,
  );
  assert.equal(argv(gitlabAdapter.merge(glRepo, { number: 14, method: 'squash', expectedHead: GL_HEAD, deleteBranch: false })), `${base} --sha ${GL_HEAD} --auto-merge=false --squash`);
  const call = gitlabAdapter.merge(glRepo, { number: 14, method: 'merge', expectedHead: GL_HEAD, deleteBranch: false });
  assert.equal(call.class, 'long-write');
  assert.equal(classifyCall(call), 'write');
  // A short head gives 409, which would read as head-moved (recorded)
  assert.throws(() => gitlabAdapter.merge(glRepo, { number: 14, method: 'merge', expectedHead: '7d13d5b97', deleteBranch: false }), HostParseError);
});

test('gitlab merge: arming, and turning it off with the cancel that fails with exit 0', () => {
  assert.equal(argv(gitlabAdapter.arm(glRepo, { number: 10, method: 'merge', expectedHead: GL_HEAD, nodeId: null })), `mr merge 10 -R https://gitlab.com/yeyo11/agentry -y --auto-merge --sha ${GL_HEAD}`);
  assert.equal(argv(gitlabAdapter.arm(glRepo, { number: 10, method: 'squash', expectedHead: GL_HEAD, nodeId: null })), `mr merge 10 -R https://gitlab.com/yeyo11/agentry -y --auto-merge --sha ${GL_HEAD} --squash`);
  const disarm = gitlabAdapter.disarm(glRepo, 10);
  assert.equal(argv(disarm), 'api --hostname gitlab.com -X POST projects/87089091/merge_requests/10/cancel_merge_when_pipeline_succeeds');
  assert.equal(classifyCall(disarm), 'write');
  assert.equal(gitlabAdapter.parseDisarm(result(gl('api_cancel_auto'))), true);
  // `{"status":"error"}` on exit 0: a failure that looks like a success
  assert.equal(gitlabAdapter.parseDisarm(result(gl('api_cancel_auto2'))), false);
  assert.equal(gitlabAdapter.parseDisarm(result('', { exitCode: 1 })), false);
});

test('gitlab merge: the recorded boxes are parsed for their status and message, never for ERROR', () => {
  // What the execution layer hands over: the first line is "ERROR", the whole box is `stderrText`
  const refused = (label: string): HostResult => {
    const text = file('glab/1.120.0', label, 'err');
    return result('', { exitCode: 1, stderrFirstLine: firstLine(text), stderrText: text });
  };
  assert.equal(firstLine(file('glab/1.120.0', 'ff_merge_stale_sha', 'err')), 'ERROR');
  for (const label of ['ff_merge_stale_sha', 'disc_merge_short_sha']) {
    assert.equal(gitlabAdapter.mergeReason('merge', refused(label)), 'head-moved', label);
    const parsed = boxedRefusal(refused(label));
    assert.equal(parsed?.status, 409);
    assert.match(parsed?.detail ?? '', /^409 SHA does not match HEAD of source branch: [0-9a-f]{40}$/);
  }
  // A 405 never says why: it is a refusal with a status, and the re-read names the blocker
  assert.deepEqual(boxedRefusal(refused('disc_merge_refused')), { status: 405, detail: '405 Method Not Allowed' });
  assert.equal(gitlabAdapter.mergeReason('merge', refused('disc_merge_refused')), 'merge-failed');
  // glab's own boxes carry no status; the detail is Agentry's wording, never glab's command to copy
  assert.deepEqual(boxedRefusal(refused('conf_merge_refused')), { status: null, detail: 'the merge request has conflicts' });
  assert.deepEqual(boxedRefusal(refused('nopipe_merge_refused')), { status: null, detail: 'a passing pipeline is required before merging' });
  assert.deepEqual(boxedRefusal(refused('draft_merge_refused')), { status: null, detail: 'the merge request is a draft' });
  assert.equal(gitlabAdapter.mergeDetail?.('merge', refused('draft_merge_refused')), 'the merge request is a draft');
  // Text that is not a box says nothing, and an arm is never read as a merge
  assert.equal(boxedRefusal(result('', { exitCode: 1, stderrFirstLine: 'boom' })), null);
  assert.equal(gitlabAdapter.mergeReason('merge', result('', { exitCode: 1, stderrFirstLine: 'boom' })), null);
  assert.equal(gitlabAdapter.mergeReason('arm', refused('ff_merge_stale_sha')), null);
});

test('gitlab merge: ready, the branch box, the host-side rebase and its status', () => {
  assert.equal(argv(gitlabAdapter.ready(glRepo, 15, true)), 'mr update 15 -R https://gitlab.com/yeyo11/agentry --ready');
  assert.equal(argv(gitlabAdapter.ready(glRepo, 15, false)), 'mr update 15 -R https://gitlab.com/yeyo11/agentry --draft');
  assert.equal(argv(gitlabAdapter.branchExists(glRepo, 'probe/m0-ci')), 'api -i --hostname gitlab.com projects/87089091/repository/branches/probe%2Fm0-ci');
  assert.equal(gitlabAdapter.parseBranchExists(result('', { exitCode: 1, http: { status: 404, headers: {} } })), false);
  assert.equal(gitlabAdapter.parseBranchExists(result('{}', { http: { status: 200, headers: {} } })), true);
  assert.equal(gitlabAdapter.parseBranchExists(result('', { exitCode: 1 })), null);

  const rebase = gitlabAdapter.rebase?.(glRepo, 14);
  assert.equal(argv(rebase ?? null), 'mr rebase 14 -R https://gitlab.com/yeyo11/agentry');
  assert.equal(rebase?.class, 'long-write');
  assert.equal(classifyCall(rebase as HostCall), 'write');
  const status = gitlabAdapter.rebaseStatus?.(glRepo, 14);
  assert.equal(argv(status ?? null), 'api --hostname gitlab.com projects/87089091/merge_requests/14?include_rebase_in_progress=true');
  assert.equal(classifyCall(status as HostCall), 'read');
  assert.deepEqual(gitlabAdapter.parseRebaseStatus(result(gl('ff_get_irp'))), { inProgress: false, error: null });
  assert.deepEqual(gitlabAdapter.parseRebaseStatus(result(JSON.stringify({ rebase_in_progress: false, merge_error: 'Rebase failed: conflicts' }))), { inProgress: false, error: 'Rebase failed: conflicts' });
  assert.equal(gitlabAdapter.parseRebaseStatus(result('{"rebase_in_progress":true}')).inProgress, true);
  // The plain body has no such field (recorded): it is not a rebase status
  assert.throws(() => gitlabAdapter.parseRebaseStatus(result(gl('ff_get_1'))), HostParseError);
});

test('the classifier knows every verb a merge call uses as a write', () => {
  const writes: Array<[HostCall['cli'], string[]]> = [
    ['gh', ['pr', 'merge', '1', '-R', 'github.com/o/r', '--squash']],
    ['gh', ['pr', 'merge', '1', '-R', 'github.com/o/r', '--disable-auto']],
    ['gh', ['pr', 'ready', '1', '-R', 'github.com/o/r', '--undo']],
    ['glab', ['mr', 'merge', '1', '-R', 'https://gitlab.com/o/r', '-y']],
    ['glab', ['mr', 'rebase', '1', '-R', 'https://gitlab.com/o/r']],
    ['glab', ['mr', 'update', '1', '-R', 'https://gitlab.com/o/r', '--ready']],
    ['glab', ['api', '--hostname', 'gitlab.com', '-X', 'POST', 'projects/1/merge_requests/1/cancel_merge_when_pipeline_succeeds']],
  ];
  for (const [cli, args] of writes) assert.equal(classifyCall({ cli, args }), 'write', args.join(' '));
});

test('merge: the head the guards carry is a full id, and nothing built here has --admin or --auto', () => {
  for (const adapter of [githubAdapter, gitlabAdapter]) {
    const repo = adapter === githubAdapter ? ghRepo : glRepo;
    for (const method of ['squash', 'merge', 'rebase'] as const) {
      const calls = [
        adapter.merge(repo, { number: 9, method, expectedHead: MERGE_HEAD, deleteBranch: true, subject: 's', body: 'b' }),
        adapter.arm(repo, { number: 9, method, expectedHead: MERGE_HEAD, nodeId: 'PR_kwDOU1zIIM8AAAABGIG01w' }),
        adapter.disarm(repo, 9),
      ];
      for (const call of calls) {
        assert.ok(!call.args.includes('--admin') && !call.args.includes('--auto'), argv(call));
      }
    }
  }
});
