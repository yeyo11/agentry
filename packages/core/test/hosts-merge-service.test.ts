import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Check, MergeMethod } from '@agentry/shared';
import type { AgentryEventInput } from '../src/events.ts';
import { Db } from '../src/db.ts';
import { HostActionNotOffered, type HostCall, type HostRepo } from '../src/hosts/code-host.ts';
import type { HostResult } from '../src/hosts/exec.ts';
import { githubAdapter } from '../src/hosts/github/adapter.ts';
import { gitlabAdapter } from '../src/hosts/gitlab/adapter.ts';
import { COMPUTING_SHOWN, MergeError, MergeService, NO_PIPELINE_GRACE, type MergeTarget } from '../src/hosts/merge-service.ts';
import { tempConfig } from './helpers.ts';

// The service against what m0 recorded for the shapes, with the facts each scenario needs written
// out: calls are answered by their argv, anything else is exit 97 and fails the test, so a changed
// argv shows up as a failure. The golden logs hold every call of the main scenarios.

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(here, 'fixtures/golden/phase4');

const glRepo: HostRepo = { host: 'gitlab.com', path: 'yeyo11/agentry', owner: 'yeyo11', name: 'agentry', projectId: 87089091 };
const ghRepo: HostRepo = { host: 'github.com', path: 'yeyo11/agentry-probe', owner: 'yeyo11', name: 'agentry-probe' };

const GH_HEAD = '1edb6cba70c6420d6e75a44963ca93fed97ec760';
const GH_NEW = '2edb6cba70c6420d6e75a44963ca93fed97ec761';
const GL_HEAD = '6e0dab83d5074227e4d2827ebb745edf1aa2c943';
const PERSON = 'yeyo11';

const ok = (stdout = ''): HostResult => ({ exitCode: 0, stdout, stderrFirstLine: '', http: null, truncated: false, durationMs: 1 });
const failed = (exitCode: number, stderr = 'boom', extra: Partial<HostResult> = {}): HostResult => ({ exitCode, stdout: '', stderrFirstLine: stderr, http: null, truncated: false, durationMs: 1, ...extra });

const roots: string[] = [];
function database(): Db {
  const config = tempConfig();
  roots.push(dirname(config.dataDir));
  return new Db(config);
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// ---------- what the hosts print ----------

/** A recorded glab stderr (m0), as the execution layer hands it over in `stderrText` */
const file = (label: string): string => readFileSync(join(here, 'fixtures/recordings/glab/1.120.0', `${label}.err`), 'utf8');


const ghRepoJson = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({ default_branch: 'main', allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true, allow_auto_merge: true, delete_branch_on_merge: false, ...o });
const ghView = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: 'PR_kwDOU1zIIM8AAAABGIG01w', number: 12, url: 'https://github.com/yeyo11/agentry-probe/pull/12', state: 'OPEN', isDraft: false,
    headRefOid: GH_HEAD, headRefName: 'task/cw-1', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', autoMergeRequest: null, ...o,
  });
const armedOn = { mergeMethod: 'SQUASH', enabledAt: '2026-10-01T10:00:00Z', enabledBy: { login: PERSON } };

const glRepoJson = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({ merge_method: 'merge', squash_option: 'default_off', only_allow_merge_if_pipeline_succeeds: false, remove_source_branch_after_merge: false, merge_trains_enabled: false, ci_config_path: '', ...o });
const glView = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({
    iid: 12, web_url: 'https://gitlab.com/yeyo11/agentry/-/merge_requests/12', state: 'opened', draft: false, sha: GL_HEAD, source_branch: 'task/cw-1', target_branch: 'main',
    detailed_merge_status: 'mergeable', has_conflicts: false, merge_when_pipeline_succeeds: false,
    head_pipeline: { id: 7, status: 'success', sha: GL_HEAD, source: 'merge_request_event' }, ...o,
  });
const glChecks = (...checks: Array<[string, string]>): string =>
  JSON.stringify({ data: { project: { mergeRequest: { mergeabilityChecks: checks.map(([identifier, status]) => ({ identifier, status })) } } } });

type Answer = HostResult | (() => HostResult);

interface Harness {
  service: MergeService;
  target: MergeTarget;
  /** Every call: argv, and the body of a write */
  calls: string[];
  sleeps: number[];
  clock: { now: number };
  merged: string[];
  events: AgentryEventInput[];
  /** The detail of the first audit row */
  detail: () => string | null;
  /** The most recent rule whose pattern matches the call's line wins */
  answer: (pattern: RegExp, result: Answer) => void;
  /** The writes among the calls */
  writes: () => string[];
  rows: () => Array<{ action: string; outcome: string; by: string; reason: string | null; method: string | null }>;
}

interface Options {
  fileAt?: MergeTarget['fileAt'];
  updateFromBase?: MergeTarget['updateFromBase'];
  syncAfterRebase?: MergeTarget['syncAfterRebase'];
  busy?: MergeTarget['busy'];
  checkout?: MergeTarget['checkout'];
  checks?: Check[];
  unresolved?: number;
}

function harness(host: 'github' | 'gitlab', options: Options = {}): Harness {
  const db = database();
  const rules: Array<{ pattern: RegExp; result: Answer }> = [];
  const calls: string[] = [];
  const sleeps: number[] = [];
  const merged: string[] = [];
  const events: AgentryEventInput[] = [];
  const clock = { now: Date.parse('2026-10-01T12:00:00Z') };
  const run = async (call: HostCall): Promise<HostResult> => {
    const line = `${call.cli} ${call.args.join(' ')}`;
    calls.push(call.input ? `${line} <<< ${call.input}` : line);
    const rule = rules.find((r) => r.pattern.test(line));
    if (!rule) return failed(97, `unrecorded call: ${line}`);
    return typeof rule.result === 'function' ? rule.result() : rule.result;
  };
  const target: MergeTarget = {
    id: 'cr-1',
    kind: 'work-item',
    host,
    adapter: host === 'github' ? githubAdapter : gitlabAdapter,
    repo: host === 'github' ? ghRepo : glRepo,
    number: 12,
    branch: 'task/cw-1',
    base: 'main',
    run,
    ...(options.fileAt ? { fileAt: options.fileAt } : {}),
    ...(options.updateFromBase ? { updateFromBase: options.updateFromBase } : {}),
    ...(options.syncAfterRebase ? { syncAfterRebase: options.syncAfterRebase } : {}),
    ...(options.busy ? { busy: options.busy } : {}),
    ...(options.checkout ? { checkout: options.checkout } : {}),
  };
  let n = 0;
  const service = new MergeService({
    db: db.connection,
    resolve: async (id) => (id === 'cr-1' ? target : null),
    ...(options.checks ? { checks: async () => options.checks as Check[] } : {}),
    unresolvedThreads: async () => options.unresolved ?? 0,
    merged: async (id) => void merged.push(id),
    emit: (event) => void events.push(event),
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    uuid: () => `row-${String((n += 1))}`,
  });
  const h: Harness = {
    service,
    target,
    calls,
    sleeps,
    clock,
    merged,
    events,
    detail: () => (db.connection.prepare('SELECT detail FROM change_request_merges ORDER BY requested_at, rowid').get() as { detail: string | null } | undefined)?.detail ?? null,
    answer: (pattern, result) => rules.unshift({ pattern, result }),
    writes: () => calls.filter((c) => /pr merge|mr merge|mr rebase|mr update|pr ready|-X POST|graphql -f query=mutation/.test(c)),
    rows: () =>
      (db.connection.prepare('SELECT * FROM change_request_merges ORDER BY requested_at, rowid').all() as unknown as Array<Record<string, string | null>>).map((r) => ({
        action: r.action as string,
        outcome: r.outcome as string,
        by: r.requested_by as string,
        reason: r.reason ?? null,
        method: r.method ?? null,
      })),
  };
  if (host === 'github') {
    h.answer(/^gh api --hostname github.com repos\/yeyo11\/agentry-probe$/, ok(ghRepoJson()));
    h.answer(/rules\/branches\/main$/, ok('[]'));
    h.answer(/repos\/yeyo11\/agentry-probe\/branches\/main$/, ok('{}'));
    h.answer(/^gh pr view 12/, ok(ghView()));
  } else {
    h.answer(/^glab repo view/, ok(glRepoJson()));
    h.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView()));
  }
  return h;
}

function golden(name: string, calls: string[]): void {
  const file = join(GOLDEN, `${name}.log`);
  const actual = `# ${name}\n${calls.join('\n')}\n`;
  // A missing golden is a failure: writing it would make the test pass on whatever it saw first
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
  }
  assert.ok(existsSync(file), `golden ${name} is missing: run with UPDATE_GOLDEN=1 to record it`);
  assert.equal(actual, readFileSync(file, 'utf8'));
}

const reasonOfError = (error: unknown): string | null => (error instanceof MergeError ? error.reason : null);
const rejectsWith = async (work: Promise<unknown>, reason: string): Promise<MergeError> => {
  try {
    await work;
  } catch (error) {
    assert.equal(reasonOfError(error), reason, error instanceof Error ? error.message : String(error));
    return error as MergeError;
  }
  throw new assert.AssertionError({ message: `expected a ${reason} refusal` });
};

const squash = (head = GH_HEAD, extra: { deleteBranch?: boolean; subject?: string; body?: string } = {}) => ({ method: 'squash' as MergeMethod, expectedHead: head, deleteBranch: extra.deleteBranch ?? false, ...extra });

// ---------- the state ----------

test('GitHub state: a clean pull request can merge, the repository default method is the first allowed, and the golden log holds the reads', async () => {
  const h = harness('github');
  const state = await h.service.state('cr-1');
  assert.equal(state.canMerge, true);
  assert.equal(state.headSha, GH_HEAD);
  assert.deepEqual(state.methods, ['squash', 'merge', 'rebase']);
  assert.equal(state.defaultMethod, 'squash');
  assert.equal(state.blocker, null);
  assert.equal(state.host, 'github');
  assert.equal(state.waitingForPipeline, false);
  assert.deepEqual(state.autoMerge, { available: false, reason: 'auto-merge-not-needed', armed: false, method: null, armedBy: null, armedAt: null });
  golden('merge-github-state-clean', h.calls);
});

test('GitHub state: computing is read again after 5 s, three times at most, and then it is shown', async () => {
  const h = harness('github');
  let reads = 0;
  h.answer(/^gh pr view 12/, () => ok(++reads < 3 ? ghView({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) : ghView()));
  const state = await h.service.state('cr-1');
  assert.deepEqual(h.sleeps, [5000, 5000]);
  assert.equal(state.canMerge, true);

  const never = harness('github');
  never.answer(/^gh pr view 12/, ok(ghView({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })));
  const stuck = await never.service.state('cr-1');
  assert.deepEqual(never.sleeps, [5000, 5000, 5000]);
  assert.equal(stuck.blocker?.code, 'computing');
  assert.equal(stuck.canMerge, false);
});

test('GitHub state: a required check still running blocks, offers auto-merge when the repository allows it, and the rule reads are cached', async () => {
  const h = harness('github', { checks: [{ name: 'build', state: 'running' } as Check] });
  h.answer(/rules\/branches\/main$/, ok(JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }])));
  h.answer(/^gh pr view 12/, ok(ghView({ mergeStateStatus: 'BLOCKED' })));
  const state = await h.service.state('cr-1');
  assert.equal(state.canMerge, false);
  assert.equal(state.blocker?.code, 'checks-running');
  assert.equal(state.blocker?.detail, 'build');
  assert.equal(state.autoMerge.available, true);
  const before = h.calls.length;
  await h.service.state('cr-1');
  // Only the pull request itself is read again within the minute
  assert.deepEqual(h.calls.slice(before), ['gh pr view 12 -R github.com/yeyo11/agentry-probe --json id,number,url,state,isDraft,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest']);

  const off = harness('github');
  off.answer(/^gh api --hostname github.com repos\/yeyo11\/agentry-probe$/, ok(ghRepoJson({ allow_auto_merge: false })));
  off.answer(/^gh pr view 12/, ok(ghView({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' })));
  const refused = await off.service.state('cr-1');
  assert.equal(refused.blocker?.code, 'review-required');
  assert.deepEqual([refused.autoMerge.available, refused.autoMerge.reason], [false, 'auto-merge-not-allowed']);
});

test('GitHub state: a refresh the person asks for reads the repository rules again, and a plain read does not', async () => {
  const h = harness('github');
  h.answer(/rules\/branches\/main$/, ok(JSON.stringify([])));
  h.answer(/^gh pr view 12/, ok(ghView({ mergeStateStatus: 'BLOCKED' })));
  assert.equal((await h.service.state('cr-1')).blocker?.code, 'blocked-by-policy');
  // The host's rules change (a required check is added): a plain read inside the minute still has the old ones
  h.answer(/rules\/branches\/main$/, ok(JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }])));
  const plain = h.calls.length;
  await h.service.state('cr-1');
  assert.ok(!h.calls.slice(plain).some((c) => /rules\/branches/.test(c)), 'the rules are cached for the minute');
  const before = h.calls.length;
  await h.service.state('cr-1', { refresh: true, rules: true });
  assert.ok(h.calls.slice(before).some((c) => /rules\/branches/.test(c)), 'a refresh reads them again');
});

test('GitHub state: a conflict is not something auto-merge waits for, and the rules narrow the methods', async () => {
  const h = harness('github');
  h.answer(/rules\/branches\/main$/, ok(JSON.stringify([{ type: 'required_linear_history' }, { type: 'pull_request', parameters: { allowed_merge_methods: ['squash', 'merge'] } }])));
  h.answer(/^gh pr view 12/, ok(ghView({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })));
  const state = await h.service.state('cr-1');
  assert.equal(state.blocker?.code, 'conflicts');
  assert.equal(state.blocker?.action, 'update-from-base');
  assert.equal(state.autoMerge.available, false);
  assert.deepEqual(state.methods, ['squash']);
});

test('GitHub state: an armed auto-merge is shown with who and when, and a merged pull request is not open', async () => {
  const h = harness('github');
  h.answer(/^gh pr view 12/, ok(ghView({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', autoMergeRequest: armedOn })));
  const state = await h.service.state('cr-1');
  assert.deepEqual(state.autoMerge, { available: false, reason: null, armed: true, method: 'squash', armedBy: PERSON, armedAt: '2026-10-01T10:00:00Z' });
  h.answer(/^gh pr view 12/, ok(ghView({ state: 'MERGED', autoMergeRequest: armedOn })));
  const done = await h.service.state('cr-1');
  assert.equal(done.blocker?.code, 'not-open');
  assert.equal(done.autoMerge.armed, false);
});

test('state: a change request nobody has is not found, and a rate limit serves the last state with the time to read again', async () => {
  const h = harness('github');
  await rejectsWith(h.service.state('nope'), 'not-found');
  const first = await h.service.state('cr-1');
  h.answer(/^gh pr view 12/, failed(1, 'API rate limit exceeded', { reason: 'rate-limited', http: { status: 429, headers: { 'retry-after': '30' } } }));
  const limited = await h.service.state('cr-1');
  assert.equal(limited.headSha, first.headSha);
  assert.ok(limited.limitedUntil);
});

// ---------- GitLab's guard ----------

test('GitLab state: a finished pipeline for the head lets Merge now through, and a stale one does not count', async () => {
  const h = harness('gitlab');
  const state = await h.service.state('cr-1');
  assert.equal(state.canMerge, true);
  assert.equal(state.waitingForPipeline, false);
  assert.deepEqual([state.autoMerge.available, state.autoMerge.reason], [false, 'auto-merge-not-needed']);
  golden('merge-gitlab-state-pipeline-finished', h.calls);

  const stale = harness('gitlab', { fileAt: async () => true });
  stale.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ head_pipeline: { id: 6, status: 'success', sha: 'f'.repeat(40), source: 'merge_request_event' } })));
  const waiting = await stale.service.state('cr-1');
  assert.equal(waiting.canMerge, false);
  assert.equal(waiting.waitingForPipeline, true);
  assert.equal(waiting.autoMerge.reason, 'waiting-for-pipeline');
});

test('GitLab state: a pipeline still running blocks Merge now and is what auto-merge is for', async () => {
  const h = harness('gitlab');
  h.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ detailed_merge_status: 'ci_still_running', head_pipeline: { id: 7, status: 'running', sha: GL_HEAD, source: 'merge_request_event' } })));
  const state = await h.service.state('cr-1');
  assert.equal(state.canMerge, false);
  assert.equal(state.blocker?.code, 'checks-running');
  assert.equal(state.autoMerge.available, true);

  // Nothing refused it, and the guard still holds Merge now back
  h.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ head_pipeline: { id: 7, status: 'pending', sha: GL_HEAD, source: 'merge_request_event' } })));
  const quiet = await h.service.state('cr-1');
  assert.equal(quiet.canMerge, false);
  assert.equal(quiet.blocker?.code, 'checks-running');
});

test('GitLab state: with no pipeline the guard waits 90 s after the push when the project has no CI file, and never when it needs a pipeline', async () => {
  const noCi = harness('gitlab', { fileAt: async (sha, path) => (sha === GL_HEAD && path === '.gitlab-ci.yml' ? false : null) });
  noCi.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ head_pipeline: null })));
  const early = await noCi.service.state('cr-1');
  assert.equal(early.canMerge, false);
  assert.equal(early.waitingForPipeline, true);
  noCi.clock.now += NO_PIPELINE_GRACE - 1;
  assert.equal((await noCi.service.state('cr-1')).waitingForPipeline, true);
  noCi.clock.now += 1;
  const late = await noCi.service.state('cr-1');
  assert.equal(late.waitingForPipeline, false);
  assert.equal(late.canMerge, true);

  const required = harness('gitlab', { fileAt: async () => false });
  required.answer(/^glab repo view/, ok(glRepoJson({ only_allow_merge_if_pipeline_succeeds: true })));
  required.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ head_pipeline: null, detailed_merge_status: 'ci_must_pass' })));
  const refused = await required.service.state('cr-1');
  assert.equal(refused.canMerge, false);
  assert.equal(refused.blocker?.code, 'checks-missing');
  assert.equal(refused.waitingForPipeline, false);

  // A CI file at the head means a pipeline is coming; one Agentry cannot look for is not "no CI"
  for (const fileAt of [async () => true, async () => null] as Array<NonNullable<MergeTarget['fileAt']>>) {
    const coming = harness('gitlab', { fileAt });
    coming.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ head_pipeline: null })));
    await coming.service.state('cr-1');
    coming.clock.now += 10 * NO_PIPELINE_GRACE;
    assert.equal((await coming.service.state('cr-1')).waitingForPipeline, true);
  }
  // A configuration that lives in another project is not a file here
  const remote = harness('gitlab', { fileAt: async () => false });
  remote.answer(/^glab repo view/, ok(glRepoJson({ ci_config_path: 'ci/main.yml@group/templates' })));
  remote.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ head_pipeline: null })));
  await remote.service.state('cr-1');
  remote.clock.now += 10 * NO_PIPELINE_GRACE;
  assert.equal((await remote.service.state('cr-1')).waitingForPipeline, true);
});

test('GitLab state: unchecked is read from the mergeability checks and is not a wait unless one is still checking', async () => {
  const settled = harness('gitlab');
  settled.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ detailed_merge_status: 'unchecked' })));
  settled.answer(/graphql/, ok(glChecks(['CI_MUST_PASS', 'SUCCESS'], ['CONFLICT', 'SUCCESS'], ['DRAFT_STATUS', 'SUCCESS'])));
  const state = await settled.service.state('cr-1');
  assert.equal(state.canMerge, true);
  assert.deepEqual(settled.sleeps, []);

  const conflicting = harness('gitlab');
  conflicting.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ detailed_merge_status: 'unchecked', has_conflicts: false })));
  conflicting.answer(/graphql/, ok(glChecks(['CONFLICT', 'FAILED'], ['CI_MUST_PASS', 'SUCCESS'])));
  assert.equal((await conflicting.service.state('cr-1')).blocker?.code, 'conflicts');

  // CONFLICT: CHECKING lasts minutes (recorded): computing shows for a fresh head only, and nothing is slept through
  const checking = harness('gitlab');
  checking.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ detailed_merge_status: 'unchecked' })));
  checking.answer(/graphql/, ok(glChecks(['CONFLICT', 'CHECKING'], ['CI_MUST_PASS', 'SUCCESS'])));
  const fresh = await checking.service.state('cr-1');
  assert.deepEqual([fresh.blocker?.code, fresh.canMerge], ['computing', false]);
  checking.clock.now += COMPUTING_SHOWN + 1;
  const later = await checking.service.state('cr-1');
  assert.deepEqual([later.blocker, later.canMerge], [null, true]);
  assert.deepEqual(checking.sleeps, []);

  // An unreadable GraphQL does not disable Merge either, and a real reason is not hidden behind computing
  const unreadable = harness('gitlab');
  unreadable.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ detailed_merge_status: 'unchecked' })));
  unreadable.answer(/graphql/, failed(1, 'boom'));
  assert.equal((await unreadable.service.state('cr-1')).canMerge, true);
  const draft = harness('gitlab');
  draft.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ detailed_merge_status: 'unchecked' })));
  draft.answer(/graphql/, ok(glChecks(['DRAFT_STATUS', 'FAILED'], ['CONFLICT', 'CHECKING'])));
  assert.equal((await draft.service.state('cr-1')).blocker?.code, 'draft');
});

test('GitLab Merge: a head GitLab is still checking is tried, and its refusal is explained by the re-read', async () => {
  const h = harness('gitlab');
  let done = false;
  h.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, () => ok(glView({ detailed_merge_status: 'unchecked', ...(done ? { detailed_merge_status: 'conflict' } : {}) })));
  h.answer(/graphql/, () => ok(done ? glChecks(['CONFLICT', 'FAILED']) : glChecks(['CONFLICT', 'CHECKING'])));
  h.answer(/^glab mr merge 12/, () => {
    done = true;
    return failed(1, 'ERROR', { stderrText: file('conf_merge_refused') });
  });
  const error = await rejectsWith(h.service.merge('cr-1', { method: 'merge', expectedHead: GL_HEAD, deleteBranch: false }, PERSON), 'merge-failed');
  assert.equal(h.writes().length, 1, 'the attempt is what makes GitLab run the conflict check');
  assert.equal(error.blocker?.code, 'conflicts');
  assert.deepEqual(h.sleeps, []);
});

test('GitLab state: a fast-forward project offers Rebase on GitLab for need_rebase, the other the update from the base', async () => {
  const ff = harness('gitlab');
  ff.answer(/^glab repo view/, ok(glRepoJson({ merge_method: 'ff' })));
  ff.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ detailed_merge_status: 'need_rebase' })));
  const state = await ff.service.state('cr-1');
  assert.deepEqual([state.blocker?.code, state.blocker?.action, state.canRebaseOnHost, state.methods], ['behind', 'rebase-on-host', true, ['rebase', 'squash']]);

  const plain = harness('gitlab');
  plain.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ detailed_merge_status: 'need_rebase' })));
  const other = await plain.service.state('cr-1');
  assert.deepEqual([other.blocker?.action, other.canRebaseOnHost], ['update-from-base', false]);
});

// ---------- Merge ----------

test('GitHub Merge: the head guard and the method go to the host, the person is recorded, the owner is told, and the golden log holds the calls', async () => {
  const h = harness('github');
  let done = false;
  h.answer(/^gh pr view 12/, () => ok(done ? ghView({ state: 'MERGED' }) : ghView()));
  h.answer(/^gh pr merge 12/, () => {
    done = true;
    return ok();
  });
  h.answer(/branches\/task%2Fcw-1$/, failed(1, 'Not Found', { http: { status: 404, headers: {} } }));
  const outcome = await h.service.merge('cr-1', squash(GH_HEAD, { deleteBranch: true, subject: 'Add the cart (#12)', body: 'Closes the loop.' }), PERSON);
  assert.equal(outcome.merged, true);
  assert.equal(outcome.branchDeleted, true);
  assert.deepEqual(h.writes(), ['gh pr merge 12 -R github.com/yeyo11/agentry-probe --squash --match-head-commit ' + GH_HEAD + ' --subject Add the cart (#12) --body-file - --delete-branch <<< Closes the loop.']);
  assert.deepEqual(h.merged, ['cr-1']);
  assert.deepEqual(h.rows(), [{ action: 'merge', outcome: 'merged', by: PERSON, reason: null, method: 'squash' }]);
  assert.ok(h.calls.every((c) => !/--admin|--auto\b/.test(c)));
  golden('merge-github-merge', h.calls);
});

test('GitHub Merge: a moved head, a method the repository does not allow and a blocker each refuse before the host is asked to merge', async () => {
  const h = harness('github');
  await rejectsWith(h.service.merge('cr-1', squash(GH_NEW), PERSON), 'head-moved');
  h.answer(/^gh api --hostname github.com repos\/yeyo11\/agentry-probe$/, ok(ghRepoJson({ allow_squash_merge: false })));
  h.clock.now += 120_000;
  await rejectsWith(h.service.merge('cr-1', squash(), PERSON), 'method-not-allowed');
  h.answer(/^gh pr view 12/, ok(ghView({ isDraft: true })));
  const refused = await rejectsWith(h.service.merge('cr-1', { ...squash(), method: 'merge' }, PERSON), 'merge-failed');
  assert.equal(refused.blocker?.code, 'draft');
  assert.deepEqual(h.writes(), []);
  assert.deepEqual(h.rows().map((r) => [r.outcome, r.reason]), [['failed', 'head-moved'], ['failed', 'method-not-allowed'], ['failed', 'merge-failed']]);
});

test('GitHub Merge: gh refusing while the head is the one seen is a head that moved only when the re-read says so', async () => {
  const moved = harness('github');
  let after = false;
  moved.answer(/^gh pr view 12/, () => ok(after ? ghView({ headRefOid: GH_NEW }) : ghView()));
  moved.answer(/^gh pr merge 12/, () => {
    after = true;
    return failed(1, 'GraphQL: Head branch was modified. Review the changes and try again.');
  });
  await rejectsWith(moved.service.merge('cr-1', squash(), PERSON), 'head-moved');

  const other = harness('github');
  other.answer(/^gh pr merge 12/, failed(1, 'something else'));
  const error = await rejectsWith(other.service.merge('cr-1', squash(), PERSON), 'merge-failed');
  assert.equal(error.detail, 'something else');

  const forbidden = harness('github');
  forbidden.answer(/^gh pr merge 12/, failed(1, 'HTTP 403: Resource not accessible', { http: { status: 403, headers: {} } }));
  await rejectsWith(forbidden.service.merge('cr-1', squash(), PERSON), 'forbidden');

  // The call died but the merge landed: the re-read is the truth
  const landed = harness('github');
  let merged = false;
  landed.answer(/^gh pr view 12/, () => ok(merged ? ghView({ state: 'MERGED' }) : ghView()));
  landed.answer(/^gh pr merge 12/, () => {
    merged = true;
    return failed(1, 'connection reset');
  });
  assert.equal((await landed.service.merge('cr-1', squash(), PERSON)).merged, true);
});

test('Merge: a timeout that merged nothing is write-unconfirmed, and a second click while one runs is busy', async () => {
  const h = harness('github');
  h.answer(/^gh pr merge 12/, failed(1, '', { reason: 'timeout' }));
  await rejectsWith(h.service.merge('cr-1', squash(), PERSON), 'write-unconfirmed');

  const busy = harness('github');
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const view = busy.target.run;
  busy.target.run = async (call) => {
    if (call.args[0] === 'pr' && call.args[1] === 'merge') await gate;
    return view(call);
  };
  busy.answer(/^gh pr merge 12/, failed(1, 'nope'));
  const first = busy.service.merge('cr-1', squash(), PERSON).catch((e: unknown) => e);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await rejectsWith(busy.service.merge('cr-1', squash(), PERSON), 'busy');
  release();
  assert.equal(reasonOfError(await first), 'merge-failed');
});

test('GitLab Merge: --sha with the full id and --auto-merge=false, and the 409 box is a head that moved', async () => {
  const h = harness('gitlab');
  let done = false;
  h.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, () => ok(done ? glView({ state: 'merged' }) : glView()));
  h.answer(/^glab mr merge 12/, () => {
    done = true;
    return ok('✓ Merged');
  });
  const outcome = await h.service.merge('cr-1', { method: 'merge', expectedHead: GL_HEAD, deleteBranch: false, body: 'Merged by Agentry' }, PERSON);
  assert.equal(outcome.merged, true);
  assert.equal(outcome.branchDeleted, null);
  assert.deepEqual(h.writes(), [`glab mr merge 12 -R https://gitlab.com/yeyo11/agentry -y --sha ${GL_HEAD} --auto-merge=false -m Merged by Agentry`]);
  assert.deepEqual(h.merged, ['cr-1']);
  golden('merge-gitlab-merge', h.calls);

  const moved = harness('gitlab');
  // The recorded box: its first line is ERROR, the whole text carries the 409
  moved.answer(/^glab mr merge 12/, failed(1, 'ERROR', { stderrText: file('ff_merge_stale_sha') }));
  const movedError = await rejectsWith(moved.service.merge('cr-1', { method: 'merge', expectedHead: GL_HEAD, deleteBranch: false }, PERSON), 'head-moved');
  assert.match(movedError.detail ?? '', /^409 SHA does not match HEAD of source branch/);
  assert.match(moved.detail() ?? '', /^409 SHA does not match HEAD/);

  // A boxed 405 says nothing about why: the re-read explains it, and the audit keeps the parsed message, not ERROR
  const boxed = harness('gitlab');
  boxed.answer(/^glab mr merge 12/, failed(1, 'ERROR', { stderrText: file('disc_merge_refused') }));
  const error = await rejectsWith(boxed.service.merge('cr-1', { method: 'merge', expectedHead: GL_HEAD, deleteBranch: false }, PERSON), 'merge-failed');
  assert.equal(error.detail, '405 Method Not Allowed');
  assert.equal(boxed.detail(), '405 Method Not Allowed');

  // A short head is never sent, and the guard keeps a merge ahead of the pipeline from happening
  const short = harness('gitlab');
  await rejectsWith(short.service.merge('cr-1', { method: 'merge', expectedHead: GL_HEAD.slice(0, 8), deleteBranch: false }, PERSON), 'head-moved');
  const early = harness('gitlab', { fileAt: async () => true });
  early.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ head_pipeline: null })));
  await rejectsWith(early.service.merge('cr-1', { method: 'merge', expectedHead: GL_HEAD, deleteBranch: false }, PERSON), 'waiting-for-pipeline');
  assert.deepEqual(early.writes(), []);
});

// ---------- auto-merge ----------

test('GitHub auto-merge: armed through the mutation with the head, the state says so, and it is never gh pr merge --auto', async () => {
  const h = harness('github', { checks: [{ name: 'build', state: 'running' } as Check] });
  h.answer(/rules\/branches\/main$/, ok(JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }])));
  let armed = false;
  h.answer(/^gh pr view 12/, () => ok(ghView({ mergeStateStatus: 'BLOCKED', autoMergeRequest: armed ? armedOn : null })));
  h.answer(/graphql -f query=mutation/, () => {
    armed = true;
    return ok('{"data":{}}');
  });
  const state = await h.service.arm('cr-1', { method: 'squash', expectedHead: GH_HEAD }, PERSON);
  assert.equal(state.autoMerge.armed, true);
  assert.equal(h.writes().length, 1);
  assert.match(h.writes()[0] ?? '', /-f id=PR_kwDOU1zIIM8AAAABGIG01w -f m=SQUASH -f oid=1edb6cba/);
  assert.ok(h.calls.every((c) => !/pr merge/.test(c)));
  assert.deepEqual(h.rows(), [{ action: 'arm', outcome: 'armed', by: PERSON, reason: null, method: 'squash' }]);
  golden('merge-github-arm', h.calls);
});

test('auto-merge: refused when the repository does not allow it, when there is nothing to wait for and when the head moved, with no write', async () => {
  const off = harness('github');
  off.answer(/^gh api --hostname github.com repos\/yeyo11\/agentry-probe$/, ok(ghRepoJson({ allow_auto_merge: false })));
  off.answer(/^gh pr view 12/, ok(ghView({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' })));
  await rejectsWith(off.service.arm('cr-1', { method: 'squash', expectedHead: GH_HEAD }, PERSON), 'auto-merge-not-allowed');

  const clean = harness('github');
  await rejectsWith(clean.service.arm('cr-1', { method: 'squash', expectedHead: GH_HEAD }, PERSON), 'auto-merge-not-needed');
  await rejectsWith(clean.service.arm('cr-1', { method: 'squash', expectedHead: GH_NEW }, PERSON), 'head-moved');
  assert.deepEqual(off.writes().concat(clean.writes()), []);
  assert.deepEqual(clean.rows().map((r) => r.outcome), ['failed', 'failed']);
});

test('GitHub auto-merge: the mutation refused is read from its own errors, and the re-read is the truth', async () => {
  const h = harness('github');
  h.answer(/^gh pr view 12/, ok(ghView({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' })));
  h.answer(/graphql -f query=mutation/, { ...failed(1, 'gh: boom'), stdout: JSON.stringify({ errors: [{ type: 'UNPROCESSABLE', message: 'Pull request is in unstable status' }] }) });
  await rejectsWith(h.service.arm('cr-1', { method: 'squash', expectedHead: GH_HEAD }, PERSON), 'auto-merge-not-needed');
});

test('GitLab auto-merge: only while the head pipeline runs, with --sha and no squash flag unless asked', async () => {
  const h = harness('gitlab');
  h.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ detailed_merge_status: 'ci_still_running', head_pipeline: { id: 7, status: 'running', sha: GL_HEAD, source: 'merge_request_event' } })));
  let armed = false;
  h.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, () => ok(glView({ detailed_merge_status: 'ci_still_running', merge_when_pipeline_succeeds: armed, merge_user: { username: PERSON }, head_pipeline: { id: 7, status: 'running', sha: GL_HEAD, source: 'merge_request_event' } })));
  h.answer(/^glab mr merge 12/, () => {
    armed = true;
    return ok();
  });
  const state = await h.service.arm('cr-1', { method: 'merge', expectedHead: GL_HEAD }, PERSON);
  assert.equal(state.autoMerge.armed, true);
  assert.equal(state.autoMerge.armedBy, PERSON);
  assert.deepEqual(h.writes(), [`glab mr merge 12 -R https://gitlab.com/yeyo11/agentry -y --auto-merge --sha ${GL_HEAD}`]);
  golden('merge-gitlab-arm', h.calls);

  const none = harness('gitlab', { fileAt: async () => true });
  none.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ head_pipeline: null })));
  await rejectsWith(none.service.arm('cr-1', { method: 'merge', expectedHead: GL_HEAD }, PERSON), 'waiting-for-pipeline');
  assert.deepEqual(none.writes(), []);
});

test('disarm: the cancel that says "error" with exit 0 is not believed, and the re-read settles it', async () => {
  const h = harness('gitlab');
  const running = { id: 7, status: 'running', sha: GL_HEAD, source: 'merge_request_event' };
  let armed = true;
  h.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, () => ok(glView({ detailed_merge_status: 'ci_still_running', merge_when_pipeline_succeeds: armed, head_pipeline: running })));
  h.answer(/cancel_merge_when_pipeline_succeeds/, ok('{"status":"error"}'));
  await rejectsWith(h.service.disarm('cr-1', PERSON), 'write-unconfirmed');
  h.answer(/cancel_merge_when_pipeline_succeeds/, () => {
    armed = false;
    return ok('{"status":"success"}');
  });
  armed = true;
  const state = await h.service.disarm('cr-1', PERSON);
  assert.equal(state.autoMerge.armed, false);
  assert.deepEqual(h.rows().map((r) => [r.action, r.outcome, r.reason]), [['disarm', 'failed', 'write-unconfirmed'], ['disarm', 'disarmed', null]]);
  golden('merge-gitlab-disarm', h.calls);
});

// ---------- before Agentry pushes ----------

test('disarmBeforePush: an armed auto-merge is turned off and confirmed before the push, as Agentry, and nothing is written when none is armed', async () => {
  const h = harness('github');
  let armed = true;
  h.answer(/^gh pr view 12/, () => ok(ghView({ mergeStateStatus: 'BLOCKED', autoMergeRequest: armed ? armedOn : null })));
  h.answer(/--disable-auto/, () => {
    armed = false;
    return ok();
  });
  const hold = await h.service.holdForPush('cr-1');
  assert.equal(hold.disarmed, true);
  assert.deepEqual(h.writes(), ['gh pr merge 12 -R github.com/yeyo11/agentry-probe --disable-auto']);
  assert.deepEqual(h.rows(), [{ action: 'disarm', outcome: 'disarmed', by: 'agentry', reason: null, method: null }]);
  assert.match(h.service.history('cr-1')[0]?.detail ?? '', /arm it again/);
  assert.deepEqual(h.events.map((e) => [e.type, e.type === 'change-request.auto-merge-off' ? e.why : null]), [['change-request.auto-merge-off', 'push']]);
  hold.release();
  const again = await h.service.holdForPush('cr-1');
  assert.equal(again.disarmed, false);
  again.release();
  assert.equal(h.writes().length, 1);
  assert.equal(h.events.length, 1);
  golden('merge-github-disarm-before-push', h.calls);

  assert.equal((await h.service.holdForPush('nobody')).disarmed, false);
});

test('disarmBeforePush fails closed: a host that still shows it armed, or cannot be read, stops the push', async () => {
  const stuck = harness('github');
  stuck.answer(/^gh pr view 12/, ok(ghView({ mergeStateStatus: 'BLOCKED', autoMergeRequest: armedOn })));
  stuck.answer(/--disable-auto/, ok());
  await rejectsWith(stuck.service.holdForPush('cr-1'), 'write-unconfirmed');
  assert.deepEqual(stuck.rows().map((r) => r.outcome), ['failed']);
  // Nothing stays held after a refusal: the next push can try again
  await rejectsWith(stuck.service.holdForPush('cr-1'), 'write-unconfirmed');

  const down = harness('github');
  down.answer(/^gh pr view 12/, failed(1, 'dial tcp: lookup github.com'));
  await rejectsWith(down.service.holdForPush('cr-1'), 'unreachable');
});

test('a push resets the guard: the pipeline that follows it is the one GitLab Merge now waits for', async () => {
  const h = harness('gitlab', { fileAt: async () => false });
  h.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ head_pipeline: null })));
  await h.service.state('cr-1');
  h.clock.now += NO_PIPELINE_GRACE;
  assert.equal((await h.service.state('cr-1')).canMerge, true);
  (await h.service.holdForPush('cr-1')).release();
  assert.equal((await h.service.state('cr-1')).waitingForPipeline, true);
});

// ---------- update from the base ----------

test('Update from base on GitHub is Agentry\'s own merge, after auto-merge is off, and a conflict pushes nothing', async () => {
  let ran = 0;
  const h = harness('github', { updateFromBase: async () => ({ conflicts: ran++ === 0 ? ['src/a.ts'] : [] }) });
  let armed = true;
  h.answer(/^gh pr view 12/, () => ok(ghView({ mergeStateStatus: 'BEHIND', autoMergeRequest: armed ? armedOn : null })));
  h.answer(/--disable-auto/, () => {
    armed = false;
    return ok();
  });
  const conflicted = await h.service.updateBranch('cr-1', PERSON);
  assert.deepEqual([conflicted.via, conflicted.conflicts], ['merge', ['src/a.ts']]);
  const updated = await h.service.updateBranch('cr-1', PERSON);
  assert.deepEqual(updated.conflicts, []);
  assert.deepEqual(h.writes(), ['gh pr merge 12 -R github.com/yeyo11/agentry-probe --disable-auto']);
  assert.ok(h.calls.every((c) => !/update-branch/.test(c)));

  const none = harness('github');
  await assert.rejects(none.service.updateBranch('cr-1', PERSON), HostActionNotOffered);
});

test('Update from base on a GitLab fast-forward project is the host\'s rebase, waited for, and the checkout follows', async () => {
  let synced = 0;
  const h = harness('gitlab', { syncAfterRebase: async () => void (synced += 1) });
  h.answer(/^glab repo view/, ok(glRepoJson({ merge_method: 'ff' })));
  h.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ detailed_merge_status: 'need_rebase' })));
  h.answer(/^glab mr rebase 12/, ok());
  let status = 0;
  h.answer(/include_rebase_in_progress=true/, () => ok(JSON.stringify({ rebase_in_progress: status++ < 1, merge_error: null })));
  const outcome = await h.service.updateBranch('cr-1', PERSON);
  assert.equal(outcome.via, 'rebase');
  assert.equal(synced, 1);
  assert.deepEqual(h.sleeps, [5000]);
  assert.deepEqual(h.writes(), ['glab mr rebase 12 -R https://gitlab.com/yeyo11/agentry']);
  golden('merge-gitlab-rebase', h.calls);

  const broken = harness('gitlab');
  broken.answer(/^glab repo view/, ok(glRepoJson({ merge_method: 'ff' })));
  broken.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ detailed_merge_status: 'need_rebase' })));
  broken.answer(/^glab mr rebase 12/, ok());
  broken.answer(/include_rebase_in_progress=true/, ok(JSON.stringify({ rebase_in_progress: false, merge_error: 'Rebase failed. Please rebase locally' })));
  const error = await rejectsWith(broken.service.updateBranch('cr-1', PERSON), 'merge-failed');
  assert.match(error.detail ?? '', /Rebase failed/);
});

test('a merge request that is not open cannot be updated, and Ready marks it and answers the state', async () => {
  const h = harness('github');
  h.answer(/^gh pr view 12/, ok(ghView({ state: 'MERGED' })));
  await rejectsWith(h.service.updateBranch('cr-1', PERSON), 'merge-failed');

  const draft = harness('github');
  let isDraft = true;
  draft.answer(/^gh pr view 12/, () => ok(ghView({ isDraft })));
  draft.answer(/^gh pr ready 12/, () => {
    isDraft = false;
    return ok();
  });
  assert.equal((await draft.service.markReady('cr-1', true)).blocker, null);
  draft.answer(/^gh pr ready 12/, ok());
  await rejectsWith(draft.service.markReady('cr-1', false), 'write-unconfirmed');
});

test('history lists the newest clicks first', async () => {
  const h = harness('github');
  await h.service.merge('cr-1', squash(GH_NEW), PERSON).catch(() => undefined);
  h.clock.now += 1000;
  await h.service.arm('cr-1', { method: 'squash', expectedHead: GH_HEAD }, PERSON).catch(() => undefined);
  assert.deepEqual(h.service.history('cr-1').map((r) => [r.action, r.outcome, r.requestedBy]), [['arm', 'failed', PERSON], ['merge', 'failed', PERSON]]);
  assert.deepEqual(h.service.history('other'), []);
});

// ---------- the person is told, and the guard holds ----------

test('a push holds the change request: arming is busy until it ends, and the state says Agentry turned auto-merge off until the person arms again', async () => {
  const h = harness('github');
  let armed = true;
  h.answer(/^gh pr view 12/, () => ok(ghView({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', autoMergeRequest: armed ? armedOn : null })));
  h.answer(/--disable-auto/, () => {
    armed = false;
    return ok();
  });
  h.answer(/graphql -f query=mutation/, () => {
    armed = true;
    return ok('{"data":{}}');
  });
  const hold = await h.service.holdForPush('cr-1');
  await rejectsWith(h.service.arm('cr-1', { method: 'squash', expectedHead: GH_HEAD }, PERSON), 'busy');
  await rejectsWith(h.service.disarm('cr-1', PERSON), 'busy');
  const during = await h.service.state('cr-1');
  assert.deepEqual(during.autoMergeOff, { by: 'agentry', at: '2026-10-01T12:00:00.000Z', why: 'push', pushing: true });
  hold.release();
  hold.release();
  const after = await h.service.state('cr-1');
  assert.equal(after.autoMergeOff?.pushing, false);

  h.clock.now += 1000;
  const rearmed = await h.service.arm('cr-1', { method: 'squash', expectedHead: GH_HEAD }, PERSON);
  assert.equal(rearmed.autoMerge.armed, true);
  assert.equal(rearmed.autoMergeOff, null);
});

test('the person turning auto-merge off themselves is not Agentry\'s doing', async () => {
  const h = harness('github');
  let armed = true;
  h.answer(/^gh pr view 12/, () => ok(ghView({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', autoMergeRequest: armed ? armedOn : null })));
  h.answer(/--disable-auto/, () => {
    armed = false;
    return ok();
  });
  assert.equal((await h.service.disarm('cr-1', PERSON)).autoMergeOff, null);
});

test('arming what is already armed writes no row; Update from base records the person who clicked, not agentry', async () => {
  const h = harness('github', { updateFromBase: async () => ({ conflicts: [] }) });
  let armed = true;
  h.answer(/^gh pr view 12/, () => ok(ghView({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', autoMergeRequest: armed ? armedOn : null })));
  h.answer(/--disable-auto/, () => {
    armed = false;
    return ok();
  });
  const state = await h.service.arm('cr-1', { method: 'squash', expectedHead: GH_HEAD }, 'someone-else');
  assert.equal(state.autoMerge.armedBy, PERSON);
  assert.deepEqual(h.rows(), []);
  assert.deepEqual(h.writes(), []);

  h.clock.now += 1000;
  const outcome = await h.service.updateBranch('cr-1', 'maria');
  assert.deepEqual(h.rows(), [{ action: 'disarm', outcome: 'disarmed', by: 'maria', reason: null, method: null }]);
  assert.equal(outcome.state.autoMergeOff?.by, 'maria');
  assert.equal(outcome.state.autoMergeOff?.why, 'update');
  assert.match(h.service.history('cr-1')[0]?.detail ?? '', /updated the branch/);
  assert.deepEqual(h.events.map((e) => (e.type === 'change-request.auto-merge-off' ? e.why : e.type)), ['update']);
});

// ---------- Update from base: the guards ----------

const ffHarness = (options: Options): Harness => {
  const h = harness('gitlab', options);
  h.answer(/^glab repo view/, ok(glRepoJson({ merge_method: 'ff' })));
  h.answer(/^glab api .*merge_requests\/12\?with_merge_status_recheck=true$/, ok(glView({ detailed_merge_status: 'need_rebase' })));
  return h;
};

test('Rebase on GitLab is offered only when the checkout loses nothing, and says why otherwise', async () => {
  assert.equal((await ffHarness({}).service.state('cr-1')).canRebaseOnHost, true);
  const clean = await ffHarness({ checkout: async () => ({ uncommitted: false, unpushed: false }) }).service.state('cr-1');
  assert.deepEqual([clean.canRebaseOnHost, clean.rebaseOnHostWhy], [true, null]);
  assert.equal(clean.blocker?.action, 'rebase-on-host');
  const dirty = await ffHarness({ checkout: async () => ({ uncommitted: true, unpushed: true }) }).service.state('cr-1');
  assert.deepEqual([dirty.canRebaseOnHost, dirty.rebaseOnHostWhy], [false, 'uncommitted-changes']);
  assert.equal(dirty.blocker?.action, 'update-from-base', 'with no host rebase on offer the way out of behind is Agentry\'s own update');
  const ahead = await ffHarness({ checkout: async () => ({ uncommitted: false, unpushed: true }) }).service.state('cr-1');
  assert.deepEqual([ahead.canRebaseOnHost, ahead.rebaseOnHostWhy], [false, 'unpushed-commits']);
  assert.equal(ahead.blocker?.action, 'update-from-base', 'with no host rebase on offer the way out of behind is Agentry\'s own update');
  const unreadable = await ffHarness({ checkout: () => Promise.reject(new Error('git failed')) }).service.state('cr-1');
  assert.deepEqual([unreadable.canRebaseOnHost, unreadable.rebaseOnHostWhy], [false, 'unpushed-commits']);
  assert.equal(unreadable.blocker?.action, 'update-from-base', 'with no host rebase on offer the way out of behind is Agentry\'s own update');

  // With the rebase not offered, Update from base is Agentry's own merge, and the host is never asked to rebase
  let merged = 0;
  const own = ffHarness({
    checkout: async () => ({ uncommitted: true, unpushed: false }),
    updateFromBase: async () => {
      merged += 1;
      return { conflicts: [] };
    },
  });
  assert.equal((await own.service.updateBranch('cr-1', PERSON)).via, 'merge');
  assert.equal(merged, 1);
  assert.deepEqual(own.writes(), []);
});

test('Update from base is refused while a chat or a run works in the checkout, and a host rebase that conflicts falls back to Agentry\'s own update', async () => {
  let working = true;
  let merged = 0;
  const updateFromBase = async (): Promise<{ conflicts: string[] }> => {
    merged += 1;
    return { conflicts: ['src/a.ts'] };
  };
  const busy = ffHarness({ busy: () => working, updateFromBase });
  await rejectsWith(busy.service.updateBranch('cr-1', PERSON), 'busy');
  assert.deepEqual(busy.writes(), []);
  assert.equal(merged, 0);

  working = false;
  busy.answer(/^glab mr rebase 12/, ok());
  busy.answer(/include_rebase_in_progress=true/, ok(JSON.stringify({ rebase_in_progress: false, merge_error: 'Rebase failed. Please rebase locally' })));
  const outcome = await busy.service.updateBranch('cr-1', PERSON);
  assert.deepEqual([outcome.via, outcome.conflicts, merged], ['merge', ['src/a.ts'], 1]);
  assert.deepEqual(busy.writes(), ['glab mr rebase 12 -R https://gitlab.com/yeyo11/agentry']);

  // A host that did not answer is not a conflict: nothing falls back
  const down = ffHarness({ updateFromBase });
  down.answer(/^glab mr rebase 12/, failed(1, 'dial tcp: lookup gitlab.com'));
  await rejectsWith(down.service.updateBranch('cr-1', PERSON), 'unreachable');
  assert.equal(merged, 1);
});
