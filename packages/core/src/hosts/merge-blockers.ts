import type { Check, MergeBlocker, MergeBlockerAction, MergeBlockerCode, MergeMethod } from '@agentry/shared';
import type { ChangeRequestState, MergeRules, MergeSettings } from './code-host.ts';

// "What blocks a merge" (docs/plans/code-hosts.md): the table as two pure functions, one per host,
// that read what the host printed and name the blockers in the table's order. Nothing here runs a
// call. GitHub's own refusal is computed client-side by gh (recorded), so Agentry computes the same
// from the fields and never relies on the refusal text. A value no row knows is `blocked-by-policy`,
// never "no blocker": a merge the host would refuse must not look possible.

/** The table's order: the first that applies is shown, the rest are listed under it. */
const ORDER: readonly MergeBlockerCode[] = [
  'not-open', 'computing', 'draft', 'conflicts', 'nothing-to-merge', 'behind', 'checks-running', 'checks-failing',
  'checks-missing', 'external-checks', 'review-required', 'changes-requested', 'threads-unresolved', 'tracker-key-missing',
  'title-rejected', 'blocked-by-dependency', 'not-yet', 'locked-files', 'merge-queue', 'blocked-by-policy',
];

/** The one action of each row: an Agentry action or a link, never a command to copy. */
const ACTIONS: Readonly<Record<MergeBlockerCode, MergeBlockerAction | null>> = {
  'not-open': null,
  computing: 'refresh',
  draft: 'mark-ready',
  conflicts: 'update-from-base',
  'nothing-to-merge': 'close',
  behind: 'update-from-base',
  'checks-running': 'auto-merge',
  'checks-failing': 'fix-checks',
  'checks-missing': 'rerun-checks',
  'external-checks': 'open-on-host',
  'review-required': 'request-reviewers',
  'changes-requested': 'address-review',
  'threads-unresolved': 'show-threads',
  'tracker-key-missing': 'edit-title',
  'title-rejected': 'edit-title',
  'blocked-by-dependency': 'open-on-host',
  'not-yet': null,
  'locked-files': 'open-on-host',
  'merge-queue': 'open-on-host',
  'blocked-by-policy': 'open-on-host',
};

export interface MergeBlockers {
  /** In the table's order; empty when nothing blocks */
  blockers: MergeBlocker[];
  /** GitHub `UNSTABLE`: a check that is not required failed. Merge stays on */
  warning: 'optional-checks-failing' | null;
}

function blocker(code: MergeBlockerCode, detail: string | null = null, action: MergeBlockerAction | null = ACTIONS[code]): MergeBlocker {
  return { code, detail, action };
}

/** Table order, one entry per code: the first detail wins. */
function ordered(found: MergeBlocker[]): MergeBlocker[] {
  const seen = new Set<MergeBlockerCode>();
  const unique = found.filter((b) => (seen.has(b.code) ? false : (seen.add(b.code), true)));
  return unique.sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code));
}

// ---------- required checks ----------

export interface RequiredCheckProblem {
  name: string;
  /** `pending` has not finished, `failed` finished badly, `missing` never reported for the head */
  problem: 'pending' | 'failed' | 'missing';
}

const FAILED_STATES: ReadonlySet<Check['state']> = new Set(['failed', 'cancelled']);
const PENDING_STATES: ReadonlySet<Check['state']> = new Set(['queued', 'running', 'manual']);

/**
 * What is wrong with each required check, from the head's check list. A name that several checks
 * carry (a matrix, a group) fails when any of them failed and waits while any is still going. With
 * no list of required names there is nothing to say.
 */
export function requiredCheckProblems(checks: readonly Check[], required: readonly string[] | null): RequiredCheckProblem[] {
  if (required === null) return [];
  return required.flatMap((name): RequiredCheckProblem[] => {
    const named = checks.filter((c) => c.name === name);
    if (named.length === 0) return [{ name, problem: 'missing' }];
    if (named.some((c) => FAILED_STATES.has(c.state))) return [{ name, problem: 'failed' }];
    if (named.some((c) => PENDING_STATES.has(c.state))) return [{ name, problem: 'pending' }];
    return [];
  });
}

// ---------- GitHub ----------

export interface GithubBlockerInput {
  state: ChangeRequestState;
  isDraft: boolean | null;
  /** `MERGEABLE`, `CONFLICTING`, `UNKNOWN` */
  mergeable: string | null;
  /** `CLEAN`, `UNSTABLE`, `HAS_HOOKS`, `BLOCKED`, `BEHIND`, `DIRTY`, `DRAFT`, `UNKNOWN` */
  mergeStateStatus: string | null;
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or `""`, which means unknown (recorded) */
  reviewDecision: string | null;
  required: readonly RequiredCheckProblem[];
  unresolvedThreads: number;
  threadResolutionRequired: boolean;
  mergeQueue: boolean;
}

const GITHUB_STATUSES: ReadonlySet<string> = new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT', 'UNKNOWN']);

export function githubBlockers(input: GithubBlockerInput): MergeBlockers {
  if (input.state !== 'open') return { blockers: [blocker('not-open', input.state)], warning: null };
  const status = (input.mergeStateStatus ?? '').toUpperCase();
  const mergeable = (input.mergeable ?? '').toUpperCase();
  const found: MergeBlocker[] = [];

  if (input.isDraft === true || status === 'DRAFT') found.push(blocker('draft'));
  // The status is not settled: the facts derived from it say nothing yet, the draft flag still does
  if (mergeable === 'UNKNOWN' || status === 'UNKNOWN') {
    return { blockers: ordered([blocker('computing'), ...found]), warning: null };
  }

  if (mergeable === 'CONFLICTING' || status === 'DIRTY') found.push(blocker('conflicts'));
  if (status === 'BEHIND') found.push(blocker('behind'));

  const blocked = status === 'BLOCKED';
  if (blocked) {
    for (const { name, problem } of input.required) {
      found.push(blocker(problem === 'pending' ? 'checks-running' : problem === 'failed' ? 'checks-failing' : 'checks-missing', name));
    }
    if (input.reviewDecision === 'REVIEW_REQUIRED') found.push(blocker('review-required'));
    if (input.threadResolutionRequired && input.unresolvedThreads > 0) found.push(blocker('threads-unresolved', String(input.unresolvedThreads)));
  }
  if (input.reviewDecision === 'CHANGES_REQUESTED') found.push(blocker('changes-requested'));
  if (input.mergeQueue) found.push(blocker('merge-queue'));

  // BLOCKED by something the fields do not name (a ruleset, a code owner, a deployment), or a status
  // nobody listed: Merge stays off and the person is sent to the host to see why
  if (found.length === 0 && (blocked || !GITHUB_STATUSES.has(status))) {
    found.push(blocker('blocked-by-policy', GITHUB_STATUSES.has(status) || status === '' ? null : status));
  }
  return { blockers: ordered(found), warning: status === 'UNSTABLE' ? 'optional-checks-failing' : null };
}

// ---------- GitLab ----------

/** One entry of GraphQL's `mergeabilityChecks`; `SUCCESS`, `FAILED`, `CHECKING`, `INACTIVE`, `WARNING`. */
export interface MergeabilityCheck {
  identifier: string;
  status: string;
}

export interface GitlabBlockerInput {
  state: ChangeRequestState;
  /** REST `detailed_merge_status` */
  detailedMergeStatus: string | null;
  /**
   * GraphQL `mergeabilityChecks`, read when REST says `unchecked` or `checking`; null when it was not
   * read. REST stays `unchecked` for minutes while GraphQL has every check (recorded).
   */
  checks: readonly MergeabilityCheck[] | null;
  /** The merge request has a head pipeline: `ci_must_pass` with none is a pipeline that never ran */
  hasHeadPipeline: boolean;
  /** `merge_method: ff`: `need_rebase` is answered with a host-side rebase */
  fastForward: boolean;
  mergeTrains: boolean;
}

/** `detailed_merge_status` and the identifiers GraphQL prints (the same words, upper case) */
function gitlabBlocker(value: string, input: GitlabBlockerInput): MergeBlocker | null {
  switch (value) {
    case 'mergeable':
      return null;
    case 'not_open':
      return blocker('not-open');
    case 'checking':
    case 'unchecked':
    case 'preparing':
    case 'approvals_syncing':
      return blocker('computing');
    case 'draft_status':
      return blocker('draft');
    case 'conflict':
      return blocker('conflicts');
    case 'commits_status':
      return blocker('nothing-to-merge');
    case 'need_rebase':
      return blocker('behind', null, input.fastForward ? 'rebase-on-host' : 'update-from-base');
    case 'ci_still_running':
      return blocker('checks-running');
    // No pipeline for the head while one is required reads the same, and glab refuses it (recorded)
    case 'ci_must_pass':
      return input.hasHeadPipeline ? blocker('checks-failing') : blocker('checks-missing');
    case 'status_checks_must_pass':
      return blocker('external-checks');
    case 'not_approved':
      return blocker('review-required');
    case 'requested_changes':
      return blocker('changes-requested');
    case 'discussions_not_resolved':
      return blocker('threads-unresolved');
    case 'jira_association_missing':
      return blocker('tracker-key-missing');
    case 'title_regex':
      return blocker('title-rejected');
    case 'merge_request_blocked':
      return blocker('blocked-by-dependency');
    case 'merge_time':
      return blocker('not-yet');
    case 'locked_paths':
    case 'locked_lfs_files':
      return blocker('locked-files');
    // security_policy_pipeline_check, security_policy_violations and any value GitLab adds later
    default:
      return blocker('blocked-by-policy', value);
  }
}

/** A computed REST status is read as it is; `unchecked` and `checking` are read from the GraphQL checks. */
function gitlabFromChecks(checks: readonly MergeabilityCheck[] | null, input: GitlabBlockerInput): MergeBlocker[] {
  // The checks were not read, so nothing is known
  if (checks === null) return [blocker('computing')];
  const found: MergeBlocker[] = [];
  for (const { identifier, status } of checks) {
    const id = identifier.toLowerCase();
    if (status === 'FAILED') {
      const mapped = gitlabBlocker(id, input);
      if (mapped) found.push(mapped);
    } else if (status === 'CHECKING') {
      // A pipeline that is still going is not "working it out": it is the wait that auto-merge answers
      found.push(id === 'ci_must_pass' ? blocker('checks-running') : blocker('computing'));
    }
  }
  // Every check settled and none failed: GitLab checks again on merge and refuses then, so Merge stays on
  return found;
}

export function gitlabBlockers(input: GitlabBlockerInput): MergeBlockers {
  if (input.state !== 'open') return { blockers: [blocker('not-open', input.state)], warning: null };
  const status = (input.detailedMergeStatus ?? '').toLowerCase();
  const found: MergeBlocker[] = [];
  if (status === '' || status === 'unchecked' || status === 'checking') {
    found.push(...gitlabFromChecks(input.checks, input));
  } else {
    const mapped = gitlabBlocker(status, input);
    if (mapped) found.push(mapped);
  }
  if (input.mergeTrains) found.push(blocker('merge-queue'));
  return { blockers: ordered(found), warning: null };
}

// ---------- methods ----------

/**
 * The methods the settings and the branch's rules both allow, in the settings' order. A rule can
 * narrow the list (`allowed_merge_methods`) and a linear-history rule removes the merge commit.
 */
export function allowedMethods(settings: Pick<MergeSettings, 'methods'>, rules: MergeRules | null): MergeMethod[] {
  return settings.methods.filter((method) => {
    if (rules?.methods && !rules.methods.includes(method)) return false;
    if (rules?.linearHistory && method === 'merge') return false;
    return true;
  });
}
