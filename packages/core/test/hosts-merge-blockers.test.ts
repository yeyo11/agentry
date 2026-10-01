import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Check, MergeBlockerCode } from '@agentry/shared';
import type { HostResult } from '../src/hosts/code-host.ts';
import { githubAdapter } from '../src/hosts/github/adapter.ts';
import { gitlabAdapter } from '../src/hosts/gitlab/adapter.ts';
import {
  allowedMethods,
  githubBlockers,
  gitlabBlockers,
  requiredCheckProblems,
  type GithubBlockerInput,
  type GitlabBlockerInput,
} from '../src/hosts/merge-blockers.ts';

// The blocked table of docs/plans/code-hosts.md, row by row, with every status m0 recorded and
// every `detailed_merge_status` GitLab documents.

const here = dirname(fileURLToPath(import.meta.url));
const recordings = join(here, 'fixtures/recordings');
const ghOut = (file: string): string => readFileSync(join(recordings, 'gh/2.102.0', `${file}.out`), 'utf8');
const glOut = (file: string): string => readFileSync(join(recordings, 'glab/1.120.0', `${file}.out`), 'utf8');
const wrap = (stdout: string): HostResult => ({ exitCode: 0, stdout, stderrFirstLine: '', http: null, truncated: false, durationMs: 1 });

const codes = (blockers: Array<{ code: MergeBlockerCode }>): MergeBlockerCode[] => blockers.map((b) => b.code);

const gh = (over: Partial<GithubBlockerInput> = {}): GithubBlockerInput => ({
  state: 'open',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: '',
  required: [],
  unresolvedThreads: 0,
  threadResolutionRequired: false,
  mergeQueue: false,
  ...over,
});

const gl = (over: Partial<GitlabBlockerInput> = {}): GitlabBlockerInput => ({
  state: 'open',
  detailedMergeStatus: 'mergeable',
  checks: null,
  hasHeadPipeline: true,
  fastForward: false,
  mergeTrains: false,
  ...over,
});

// ---------- GitHub ----------

test('github blockers: a clean pull request has none, and an unstable one warns', () => {
  assert.deepEqual(githubBlockers(gh()), { blockers: [], warning: null });
  assert.deepEqual(githubBlockers(gh({ mergeStateStatus: 'UNSTABLE' })), { blockers: [], warning: 'optional-checks-failing' });
  // GHES: hooks run before the merge; nothing blocks
  assert.deepEqual(githubBlockers(gh({ mergeStateStatus: 'HAS_HOOKS' })), { blockers: [], warning: null });
});

test('github blockers: each row of the table', () => {
  const only = (over: Partial<GithubBlockerInput>, code: MergeBlockerCode, action: string | null): void => {
    const { blockers } = githubBlockers(gh(over));
    assert.deepEqual(codes(blockers), [code], code);
    assert.equal(blockers[0]?.action, action, `${code} action`);
  };
  only({ state: 'merged' }, 'not-open', null);
  only({ state: 'closed' }, 'not-open', null);
  only({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, 'computing', 'refresh');
  only({ mergeable: 'UNKNOWN' }, 'computing', 'refresh');
  only({ isDraft: true, mergeStateStatus: 'BLOCKED' }, 'draft', 'mark-ready');
  only({ mergeStateStatus: 'DRAFT' }, 'draft', 'mark-ready');
  only({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, 'conflicts', 'update-from-base');
  only({ mergeStateStatus: 'DIRTY' }, 'conflicts', 'update-from-base');
  only({ mergeStateStatus: 'BEHIND' }, 'behind', 'update-from-base');
  only({ mergeStateStatus: 'BLOCKED', required: [{ name: 'build', problem: 'pending' }] }, 'checks-running', 'auto-merge');
  only({ mergeStateStatus: 'BLOCKED', required: [{ name: 'build', problem: 'failed' }] }, 'checks-failing', 'fix-checks');
  only({ mergeStateStatus: 'BLOCKED', required: [{ name: 'build', problem: 'missing' }] }, 'checks-missing', 'rerun-checks');
  only({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, 'review-required', 'request-reviewers');
  only({ mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' }, 'changes-requested', 'address-review');
  only({ mergeStateStatus: 'BLOCKED', threadResolutionRequired: true, unresolvedThreads: 2 }, 'threads-unresolved', 'show-threads');
  only({ mergeQueue: true }, 'merge-queue', 'open-on-host');
  only({ mergeStateStatus: 'BLOCKED' }, 'blocked-by-policy', 'open-on-host');
});

test('github blockers: the detail names the check, and the first blocker is the table’s first', () => {
  const result = githubBlockers(
    gh({
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED',
      required: [
        { name: 'lint', problem: 'failed' },
        { name: 'unit', problem: 'pending' },
        { name: 'e2e', problem: 'missing' },
      ],
    }),
  );
  assert.deepEqual(codes(result.blockers), ['checks-running', 'checks-failing', 'checks-missing', 'review-required']);
  assert.equal(result.blockers.find((b) => b.code === 'checks-failing')?.detail, 'lint');
  assert.equal(result.blockers.find((b) => b.code === 'checks-running')?.detail, 'unit');
  // A draft that conflicts: the draft comes first, as in the table
  assert.deepEqual(codes(githubBlockers(gh({ isDraft: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).blockers), ['draft', 'conflicts']);
});

test('github blockers: facts that do not apply are not reported', () => {
  // Pending required checks only count while the pull request is BLOCKED, and `""` is not "no review needed"
  assert.deepEqual(codes(githubBlockers(gh({ mergeStateStatus: 'CLEAN', required: [{ name: 'a', problem: 'failed' }] })).blockers), []);
  assert.deepEqual(codes(githubBlockers(gh({ mergeStateStatus: 'BLOCKED', reviewDecision: '' })).blockers), ['blocked-by-policy']);
  assert.deepEqual(codes(githubBlockers(gh({ mergeStateStatus: 'BLOCKED', unresolvedThreads: 3 })).blockers), ['blocked-by-policy']);
  // A draft that is still being computed keeps its draft flag
  assert.deepEqual(codes(githubBlockers(gh({ isDraft: true, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })).blockers), ['draft', 'computing']);
});

test('github blockers: a status nobody listed is blocked-by-policy, with the word as detail', () => {
  const { blockers } = githubBlockers(gh({ mergeStateStatus: 'SOMETHING_NEW' }));
  assert.deepEqual(blockers, [{ code: 'blocked-by-policy', detail: 'SOMETHING_NEW', action: 'open-on-host' }]);
  assert.deepEqual(codes(githubBlockers(gh({ mergeStateStatus: null, mergeable: null })).blockers), ['blocked-by-policy']);
});

test('github blockers: every status and decision m0 and r0 recorded', () => {
  const view = (file: string): GithubBlockerInput => {
    const read = githubAdapter.parseMergeRead(wrap(ghOut(file)));
    return gh({ state: read.state, isDraft: read.isDraft, mergeable: read.mergeable, mergeStateStatus: read.mergeStateStatus, reviewDecision: read.reviewDecision });
  };
  // BLOCKED, MERGEABLE, review decision "" (a ruleset on the base, recorded)
  assert.deepEqual(codes(githubBlockers(view('blocked_view')).blockers), ['blocked-by-policy']);
  // UNSTABLE: a check that is not required failed
  assert.deepEqual(githubBlockers(view('clean_view_32')), { blockers: [], warning: 'optional-checks-failing' });
  // The recorded `UNKNOWN`/`UNKNOWN` that settled in 2–5 s
  const unknown = readdirSync(join(recordings, 'gh/2.102.0')).filter((f) => f.endsWith('.out') && /"mergeStateStatus":"UNKNOWN"/.test(readFileSync(join(recordings, 'gh/2.102.0', f), 'utf8')));
  assert.ok(unknown.length > 0, 'a recording of UNKNOWN exists');
  for (const file of unknown) {
    const text = readFileSync(join(recordings, 'gh/2.102.0', file), 'utf8');
    const object = JSON.parse(text) as Record<string, unknown>;
    const input = gh({ state: 'open', mergeable: String(object.mergeable), mergeStateStatus: String(object.mergeStateStatus), reviewDecision: null });
    assert.deepEqual(codes(githubBlockers(input).blockers), ['computing'], file);
  }
});

// ---------- required checks ----------

const check = (name: string, state: Check['state']): Check =>
  ({ id: name, name, group: null, state, allowedToFail: false, required: true, startedAt: null, finishedAt: null, url: null, rerunnable: false, hasLog: false, source: 'actions' });

test('required checks: pending, failed and missing, matrix names together', () => {
  const checks = [check('build', 'passed'), check('unit', 'running'), check('lint', 'failed'), check('shard', 'passed'), check('shard', 'failed'), check('slow', 'queued'), check('slow', 'passed'), check('opt', 'skipped'), check('stop', 'cancelled')];
  assert.deepEqual(requiredCheckProblems(checks, ['build', 'unit', 'lint', 'e2e', 'shard', 'slow', 'opt', 'stop']), [
    { name: 'unit', problem: 'pending' },
    { name: 'lint', problem: 'failed' },
    { name: 'e2e', problem: 'missing' },
    { name: 'shard', problem: 'failed' },
    { name: 'slow', problem: 'pending' },
    { name: 'stop', problem: 'failed' },
  ]);
  // Nothing is said when the required names are not known
  assert.deepEqual(requiredCheckProblems(checks, null), []);
});

// ---------- GitLab ----------

/** Every `detailed_merge_status` of GitLab's merge requests API, and the row it lands on. */
const DOCUMENTED: Array<[string, MergeBlockerCode | null, string | null]> = [
  ['mergeable', null, null],
  ['not_open', 'not-open', null],
  // Read from the GraphQL checks: with none read GitLab re-checks on merge, so nothing blocks (recorded)
  ['checking', null, null],
  ['unchecked', null, null],
  ['preparing', 'computing', 'refresh'],
  ['approvals_syncing', 'computing', 'refresh'],
  ['draft_status', 'draft', 'mark-ready'],
  ['conflict', 'conflicts', 'update-from-base'],
  ['commits_status', 'nothing-to-merge', 'close'],
  ['need_rebase', 'behind', 'update-from-base'],
  ['ci_still_running', 'checks-running', 'auto-merge'],
  ['ci_must_pass', 'checks-failing', 'fix-checks'],
  ['status_checks_must_pass', 'external-checks', 'open-on-host'],
  ['not_approved', 'review-required', 'request-reviewers'],
  ['requested_changes', 'changes-requested', 'address-review'],
  ['discussions_not_resolved', 'threads-unresolved', 'show-threads'],
  ['jira_association_missing', 'tracker-key-missing', 'edit-title'],
  ['title_regex', 'title-rejected', 'edit-title'],
  ['merge_request_blocked', 'blocked-by-dependency', 'open-on-host'],
  ['merge_time', 'not-yet', null],
  ['locked_paths', 'locked-files', 'open-on-host'],
  ['locked_lfs_files', 'locked-files', 'open-on-host'],
  ['security_policy_pipeline_check', 'blocked-by-policy', 'open-on-host'],
  ['security_policy_violations', 'blocked-by-policy', 'open-on-host'],
];

test('gitlab blockers: every documented detailed_merge_status', () => {
  for (const [status, code, action] of DOCUMENTED) {
    // `unchecked` and `checking` are read from the GraphQL checks; with none read, nothing is known
    const { blockers } = gitlabBlockers(gl({ detailedMergeStatus: status }));
    if (code === null) {
      assert.deepEqual(blockers, [], status);
      continue;
    }
    assert.deepEqual(codes(blockers), [code], status);
    assert.equal(blockers[0]?.action, action, `${status} action`);
  }
});

test('gitlab blockers: a value nobody listed is blocked-by-policy, never none', () => {
  for (const status of ['something_new', 'MERGEABLE_SOON', 'x']) {
    const { blockers } = gitlabBlockers(gl({ detailedMergeStatus: status.toLowerCase() }));
    assert.deepEqual(blockers, [{ code: 'blocked-by-policy', detail: status.toLowerCase(), action: 'open-on-host' }], status);
  }
  // Upper case is read the same way
  assert.deepEqual(codes(gitlabBlockers(gl({ detailedMergeStatus: 'NOT_APPROVED' })).blockers), ['review-required']);
});

test('gitlab blockers: not open stops the table, and a merge train adds the queue', () => {
  assert.deepEqual(gitlabBlockers(gl({ state: 'merged', detailedMergeStatus: 'not_open' })).blockers, [{ code: 'not-open', detail: 'merged', action: null }]);
  assert.deepEqual(codes(gitlabBlockers(gl({ mergeTrains: true })).blockers), ['merge-queue']);
  assert.deepEqual(codes(gitlabBlockers(gl({ detailedMergeStatus: 'ci_must_pass', mergeTrains: true })).blockers), ['checks-failing', 'merge-queue']);
});

test('gitlab blockers: ci_must_pass with no head pipeline is a pipeline that never ran, and need_rebase on ff is a host rebase', () => {
  assert.deepEqual(codes(gitlabBlockers(gl({ detailedMergeStatus: 'ci_must_pass', hasHeadPipeline: false })).blockers), ['checks-missing']);
  assert.equal(gitlabBlockers(gl({ detailedMergeStatus: 'need_rebase', fastForward: true })).blockers[0]?.action, 'rebase-on-host');
  assert.equal(gitlabBlockers(gl({ detailedMergeStatus: 'need_rebase', fastForward: false })).blockers[0]?.action, 'update-from-base');
});

test('gitlab blockers: on unchecked the GraphQL checks decide, and Merge stays on when none failed', () => {
  const checks = (...pairs: Array<[string, string]>) => pairs.map(([identifier, status]) => ({ identifier, status }));
  const unchecked = (list: ReturnType<typeof checks> | null, over: Partial<GitlabBlockerInput> = {}) =>
    gitlabBlockers(gl({ detailedMergeStatus: 'unchecked', checks: list, ...over }));
  // Unreadable GraphQL never disables Merge: GitLab re-checks on merge and refuses with the 405 or the conflict box
  assert.deepEqual(unchecked(null).blockers, []);
  assert.deepEqual(unchecked(null, { settling: true }).blockers, []);
  // Every check settled and none failed (recorded: `unchecked` for minutes): GitLab refuses on merge if it must
  assert.deepEqual(unchecked(checks(['NOT_OPEN', 'SUCCESS'], ['CONFLICT', 'SUCCESS'], ['MERGE_TIME', 'INACTIVE'])).blockers, []);
  // CONFLICT: CHECKING lasts minutes to tens of minutes (m0 §1, §6, §8): shown only for a fresh head, never as a lasting block
  assert.deepEqual(unchecked(checks(['CONFLICT', 'CHECKING'])).blockers, []);
  assert.deepEqual(codes(unchecked(checks(['CONFLICT', 'CHECKING']), { settling: true }).blockers), ['computing']);
  assert.deepEqual(codes(unchecked(checks(['CI_MUST_PASS', 'CHECKING'])).blockers), ['checks-running']);
  // A real blocker is never hidden behind computing, even for a fresh head
  assert.deepEqual(codes(unchecked(checks(['CI_MUST_PASS', 'FAILED'], ['CONFLICT', 'CHECKING']), { settling: true }).blockers), ['checks-failing']);
  assert.deepEqual(codes(unchecked(checks(['DRAFT_STATUS', 'FAILED'], ['CONFLICT', 'FAILED'])).blockers), ['draft', 'conflicts']);
  assert.deepEqual(codes(unchecked(checks(['NEED_REBASE', 'FAILED']), { fastForward: true }).blockers), ['behind']);
  // WARNING and INACTIVE say nothing; an identifier GitLab adds later that failed is a policy
  assert.deepEqual(unchecked(checks(['LOCKED_PATHS', 'WARNING'], ['TITLE_REGEX', 'INACTIVE'])).blockers, []);
  assert.deepEqual(unchecked(checks(['BRAND_NEW_CHECK', 'FAILED'])).blockers, [{ code: 'blocked-by-policy', detail: 'brand_new_check', action: 'open-on-host' }]);
  // `checking` is read the same way; a computed REST status ignores the checks
  assert.deepEqual(codes(gitlabBlockers(gl({ detailedMergeStatus: 'checking', checks: checks(['CI_MUST_PASS', 'CHECKING']) })).blockers), ['checks-running']);
  // The statuses GitLab itself reports as short-lived stay computing, after any real blocker
  assert.deepEqual(codes(gitlabBlockers(gl({ detailedMergeStatus: 'preparing', mergeTrains: true })).blockers), ['merge-queue', 'computing']);
  assert.deepEqual(gitlabBlockers(gl({ detailedMergeStatus: 'mergeable', checks: checks(['CONFLICT', 'FAILED']) })).blockers, []);
});

test('gitlab blockers: the recorded GraphQL answers, and every recorded REST status', () => {
  const read = (file: string) => gitlabAdapter.parseMergeabilityChecks(wrap(glOut(file)));
  const unchecked = (file: string, over: Partial<GitlabBlockerInput> = {}) =>
    codes(gitlabBlockers(gl({ detailedMergeStatus: 'unchecked', checks: read(file), ...over })).blockers);
  assert.deepEqual(unchecked('disc_gql_checks_blocked'), ['threads-unresolved']);
  assert.deepEqual(unchecked('conf_gql_checks'), ['conflicts']);
  // The recorded reads that have CONFLICT: CHECKING for minutes: the real reason shows, Merge is never held for the check
  assert.deepEqual(unchecked('draft_gql_checks'), ['draft', 'checks-running']);
  assert.deepEqual(unchecked('mt_gql_checks'), ['not-yet']);
  assert.deepEqual(unchecked('nopipe_gql_checks', { hasHeadPipeline: false }), ['checks-missing']);
  assert.deepEqual(unchecked('ff_gql_checks', { fastForward: true }), ['behind']);
  assert.deepEqual(unchecked('ci_gql_checks'), ['checks-running']);
  assert.deepEqual(unchecked('cifail_gql_checks'), ['checks-failing']);
  assert.deepEqual(unchecked('ci2_gql_checks'), ['checks-running']);

  // Every `detailed_merge_status` in the recordings maps to a row of DOCUMENTED, none to the fallback
  const documented = new Map(DOCUMENTED.map(([status, code]) => [status, code]));
  const seen = new Set<string>();
  const dir = join(recordings, 'glab/1.120.0');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.out'))) {
    for (const match of readFileSync(join(dir, file), 'utf8').matchAll(/"detailed_merge_status":"([a-z_]+)"/g)) seen.add(match[1] as string);
  }
  assert.ok(seen.size >= 8, `recorded statuses: ${[...seen].join(', ')}`);
  for (const status of seen) {
    assert.ok(documented.has(status), `${status} is a row of the table`);
    const { blockers } = gitlabBlockers(gl({ detailedMergeStatus: status }));
    assert.notEqual(blockers[0]?.code, 'blocked-by-policy', status);
  }
});

// ---------- methods ----------

test('allowed methods: the rules narrow the settings, linear history removes the merge commit', () => {
  const settings = { methods: ['squash', 'merge', 'rebase'] as Array<'squash' | 'merge' | 'rebase'> };
  const rules = { methods: null, linearHistory: false, threadResolution: false, mergeQueue: false };
  assert.deepEqual(allowedMethods(settings, null), ['squash', 'merge', 'rebase']);
  assert.deepEqual(allowedMethods(settings, rules), ['squash', 'merge', 'rebase']);
  assert.deepEqual(allowedMethods(settings, { ...rules, methods: ['rebase', 'squash'] }), ['squash', 'rebase']);
  assert.deepEqual(allowedMethods(settings, { ...rules, linearHistory: true }), ['squash', 'rebase']);
  assert.deepEqual(allowedMethods(settings, { ...rules, methods: [] }), []);
  assert.deepEqual(allowedMethods({ methods: [] }, rules), []);
});
