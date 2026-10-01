import type {
  ApprovalState,
  Check,
  CheckAnnotation,
  ChangeRequestReviewers,
  CodeHostId,
  HostReason,
  MergeMethod,
  ReviewComment,
  ReviewEvent,
  ReviewSide,
  ReviewThread,
  WorkItemPullRequestCi,
} from '@agentry/shared';

/**
 * One call to a CLI, as an adapter describes it. An adapter never runs anything: it returns this
 * and `hosts/exec.ts` is the only place that spawns it (docs/plans/code-hosts.md, execution layer).
 */
export interface HostCall {
  cli: 'gh' | 'glab' | 'acli' | 'youtrack-app';
  /** argv, never a shell string */
  args: string[];
  /** stdin; bodies always travel here or in a 0600 temp file */
  input?: string;
  /** Declared by the adapter, checked against the classifier */
  kind: 'read' | 'write';
  /** Picks the timeout and the output caps */
  class: 'probe' | 'read' | 'write' | 'log' | 'long-write';
  /** The pinned host, for the breaker and the concurrency cap */
  host: string | null;
  /** GitHub's rate-limit bucket; GitLab has one */
  bucket?: 'core' | 'graphql' | 'search';
}

/** What a call answered: stdout, stderr and the exit code are three different things. */
export interface HostResult {
  /** Null when Agentry killed it */
  exitCode: number | null;
  /** The data; parsed only when the exit code is 0 */
  stdout: string;
  /** Redacted, 500 characters, for the person to read; never parsed */
  stderrFirstLine: string;
  /** Redacted and cut: only for an adapter that must read a boxed refusal (glab's merge), never shown as it is */
  stderrText?: string;
  /** From `api -i` only */
  http: { status: number; headers: Record<string, string> } | null;
  truncated: boolean;
  durationMs: number;
}

/** Where a project's change requests live: what pins every call. */
export interface HostRepo {
  host: string;
  path: string;
  owner: string;
  name: string;
  projectId?: number;
}

/** A parser met output that is not the shape the CLI is recorded to print. */
export class HostParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostParseError';
  }
}

export type ChangeRequestState = 'open' | 'merged' | 'closed';

/** What a view says, in Agentry's words. */
export interface ChangeRequestView {
  number: number | null;
  url: string | null;
  state: ChangeRequestState;
  mergedAt: string | null;
  /** `none | pending | passing | failing` */
  ci: WorkItemPullRequestCi;
}

/**
 * An adapter is a stateless translator from these calls to one CLI's arguments and JSON.
 * Everything around it (running, git, rows, claims, the flow) stays in the execution layer and the
 * service.
 */
export interface CodeHostAdapter {
  readonly id: CodeHostId;
  /** `#` or `!`: how the host writes a change request's number */
  readonly refPrefix: '#' | '!';
  /** Environment that keeps the CLI from prompting, paging or phoning home, and what to remove */
  env(): { set: Record<string, string>; unset: string[] };
  version(): HostCall;
  parseVersion(stdout: string): string | null;
  /** gh: one call for every host (`auth status --json hosts`); glab: per known host */
  authStatus(hostname: string): HostCall;
  parseAuth(result: HostResult, hostname: string): { signedIn: boolean; user: string | null };
  defaultBranch(repo: HostRepo): HostCall;
  parseDefaultBranch(stdout: string): string | null;
  create(repo: HostRepo, req: { head: string; base: string; title: string; body: string }): HostCall;
  /** The exact lookup after a create, and whenever a write's effect must be found */
  find(repo: HostRepo, req: { head: string; base: string }): HostCall;
  parseFind(stdout: string): Array<{ number: number; url: string; state: ChangeRequestState }>;
  view(repo: HostRepo, number: number): HostCall;
  /** Throws `HostParseError` on a shape it cannot read */
  parseView(stdout: string): ChangeRequestView;
}

/** The newest pipeline of a GitLab merge request, as `mr view` prints it. */
export interface HeadPipeline {
  id: number;
  status: string;
  sha: string | null;
  /** `merge_request_event` when the pipeline runs for the merge request, else a branch pipeline */
  source: string | null;
}

/**
 * Everything one read of a change request says that checks need: the view, the head commit the
 * checks belong to and the host's own merge facts. GitHub fills it from one GraphQL query, GitLab
 * from `mr view`; a fact a host does not print is null.
 */
export interface ChangeRequestRead {
  view: ChangeRequestView;
  headSha: string | null;
  baseRef: string | null;
  isDraft: boolean | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  /** Auto-merge is armed */
  autoMerge: boolean | null;
  headPipeline: HeadPipeline | null;
  /** GitLab's `diff_refs`, which a review note is placed on; absent on GitHub */
  diffRefs?: DiffRefs | null;
  /** The host listed fewer contexts than it has: `view.ci` then comes from its own rollup state */
  truncated: boolean;
  rateLimit: { cost: number | null; remaining: number | null; resetAt: string | null } | null;
}

/** What a check list is read for: GitHub reads the commit, GitLab the head pipeline. */
export interface ChecksRef {
  headSha: string | null;
  pipelineId: number | null;
}

/** A call to make after the first round, and the group its checks belong to. */
export interface ChecksFollowUp {
  call: HostCall;
  group: string;
}

/**
 * One round of a check list read. The adapter never runs a call: the service runs `next` and hands
 * the results to `parseChecksMore`; the checks of every round are appended.
 */
export interface ChecksParse {
  checks: Check[];
  /** The list reached its ceiling, or a pipeline's children were left out */
  truncated: boolean;
  next: ChecksFollowUp[];
}

/** The most checks a list holds; GitHub paginates without a bound of its own. */
export const MAX_CHECKS = 1000;

export interface RerunRequest {
  scope: 'failed' | 'check' | 'all';
  /** The list the person saw: what a scope is resolved against */
  checks: Check[];
  /** For `check`: the check to run again */
  checkId?: string;
  number: number;
  /** The source branch, for a GitLab pipeline that is not a merge request's */
  branch: string;
  headPipeline: HeadPipeline | null;
}

export interface JobLogRead {
  text: string;
  /** The job printed nothing: it is running and the host's log lags, or it never ran */
  noOutputYet: boolean;
}

/** A refusal before any call is made: the request names something the host cannot do. */
export class HostRequestError extends Error {
  constructor(
    message: string,
    readonly reason: 'check-not-rerunnable' | 'rerun-refused',
  ) {
    super(message);
    this.name = 'HostRequestError';
  }
}

/**
 * The host offers no such action (Agentry does not approve or request changes on GitHub, nor remove
 * a reviewer there, and a review is posted as comments only). It is Agentry's own refusal before a
 * call is made, never a host failure.
 */
export class HostActionNotOffered extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostActionNotOffered';
  }
}

/**
 * What an adapter adds in phase 2: reading a change request for checks, the checks, their logs,
 * annotations and the writes on them. Writes return calls to run in order, never retried, and the
 * service re-reads after every one.
 */
export interface ChecksAdapter {
  readChangeRequest(repo: HostRepo, number: number): HostCall;
  /** Reads the whole result: GitHub says some failures on a 200, so the status line is not enough */
  parseChangeRequest(result: HostResult): ChangeRequestRead;
  /** Round one of a list read; empty when there is nothing to read yet */
  checks(repo: HostRepo, ref: ChecksRef): HostCall[];
  /** `results` are the outputs of `checks()`, in order */
  parseChecks(repo: HostRepo, ref: ChecksRef, results: HostResult[]): ChecksParse;
  /** Later rounds: `results` are the outputs of the previous `next`, in order */
  parseChecksMore(repo: HostRepo, follow: ChecksFollowUp[], results: HostResult[]): ChecksParse;
  /** Null when the check has no log (a bridge, a commit status, another app's check) */
  jobLog(repo: HostRepo, check: Check, cliVersion: string | null): HostCall | null;
  parseJobLog(result: HostResult): JobLogRead;
  /** Null when the host has none (GitLab) or the check is not a check run */
  annotations(repo: HostRepo, check: Check): HostCall | null;
  parseAnnotations(stdout: string): CheckAnnotation[];
  /** Calls to run in order; throws `HostRequestError` when nothing can be run again */
  rerun(repo: HostRepo, req: RerunRequest): HostCall[];
  cancel(repo: HostRepo, req: { checks: Check[]; pipelineId: number | null }): HostCall[];
  /** Null on GitHub, which has no manual jobs per pull request */
  playManual(repo: HostRepo, check: Check): HostCall | null;
  /** The calls that say which checks the base branch requires; empty when the host has no such rule */
  required(repo: HostRepo, base: string): HostCall[];
  /** The required check names, or null when `results` do not say */
  parseRequired(results: HostResult[]): string[] | null;
}

/** An adapter that does checks too: both shipped ones. */
export type ChecksCodeHostAdapter = CodeHostAdapter & ChecksAdapter;

// ---------- Reviews (phase 3) ----------

/** The most threads one read keeps; GitHub paginates without a bound of its own. */
export const MAX_THREADS = 500;

/** A comment thread of GitHub that has more comments than the first page holds. */
export interface ThreadFollowUp {
  threadId: string;
  /** The cursor the first read ended its comments at: the remainder starts there */
  after: string;
}

/** What a threads read says; the service runs `followUps` and appends their comments. */
export interface ThreadsRead {
  headSha: string | null;
  threads: ReviewThread[];
  /** The list reached `MAX_THREADS` */
  truncated: boolean;
  followUps: ThreadFollowUp[];
}

/** A note of the person's draft review that belongs on a file line. General notes go in the review body. */
export interface ReviewNote {
  path: string;
  /** GitLab: the file's old path, when the file was renamed */
  oldPath?: string | null;
  side: ReviewSide;
  /** The last line of the range on `side` */
  line: number;
  /** The first line of a range; GitLab places a plain note on `line` and uses this only for a suggestion */
  startLine?: number | null;
  /** GitLab: the old-side line of a context line, which needs both */
  oldLine?: number | null;
  /** `body` holds the replacement lines of a suggestion; the adapter writes the fence */
  suggestion: boolean;
  body: string;
}

/** The three commits GitLab pins a position on (`diff_refs` of the merge request). */
export interface DiffRefs {
  baseSha: string;
  startSha: string;
  headSha: string;
}

export interface ReviewSubmission {
  /** The head the person looked at */
  headSha: string;
  /** The review's own text, marker included; never empty */
  body: string;
  notes: ReviewNote[];
  /** Required by GitLab, ignored by GitHub */
  diffRefs?: DiffRefs | null;
}

/**
 * How a review reaches the host. GitHub is one request, all or nothing. GitLab has no review
 * object: a note per call is saved as a draft, then `publish` turns them into discussions.
 */
export interface SubmitPlan {
  /** In order; a failed one stops the rest */
  calls: HostCall[];
  /** GitLab only, run after every call succeeded */
  publish: HostCall | null;
}

/** What creating one GitLab draft note answered. */
export interface DraftNoteMade {
  id: string;
  /** GitLab accepts a line outside the diff and drops it on publish (`line_code: null`, recorded) */
  placed: boolean;
}

/** A review (GitHub) or draft note (GitLab) of the viewer, found when a post may be in the way or may have landed. */
export interface PendingReviewEntry {
  id: string;
  /** Still unpublished: a GitHub review in state PENDING, any GitLab draft note */
  pending: boolean;
  body: string;
  author: string | null;
}

export type ReviewOperation = 'submit' | 'draft' | 'reply' | 'resolve' | 'reviewers' | 'approve';

/** What an adapter adds in phase 3. Writes are calls to run, never retried; the service re-reads after each. */
export interface ReviewsAdapter {
  /** Round one of the threads read (`$endCursor` pagination on GitHub, `per_page` on GitLab) */
  threads(repo: HostRepo, number: number): HostCall;
  /** `headSha` marks a GitLab thread left on another commit as outdated; GitHub says so itself */
  parseThreads(result: HostResult, ctx: { headSha: string | null }): ThreadsRead;
  /** GitHub only: the comments of a thread past its first 100. Null on GitLab, which returns them all */
  threadComments(repo: HostRepo, follow: ThreadFollowUp): HostCall | null;
  parseThreadComments(result: HostResult): { comments: ReviewComment[]; after: string | null };

  reply(repo: HostRepo, number: number, thread: Pick<ReviewThread, 'id' | 'comments'>, body: string): HostCall;
  /** Resolve or unresolve; both are idempotent */
  resolve(repo: HostRepo, number: number, threadId: string, resolved: boolean): HostCall;

  /**
   * Throws `HostActionNotOffered` for an event the host does not offer (only `comment` is posted: an
   * approval is `approve`), `HostParseError` for a note it cannot place.
   */
  submit(repo: HostRepo, number: number, review: ReviewSubmission, event?: ReviewEvent): SubmitPlan;
  /** The host's review id from the answer of GitHub's single call; null on GitLab, which has no review object */
  parseSubmitted(result: HostResult): { remoteId: string | null };
  /** GitLab: one draft note per call of `submit`; null on GitHub */
  parseDraftNote(result: HostResult): DraftNoteMade | null;
  /** The viewer's pending reviews (GitHub, all reviews) or draft notes (GitLab) */
  pendingReviews(repo: HostRepo, number: number): HostCall;
  parsePendingReviews(result: HostResult): PendingReviewEntry[];
  /** GitLab: publish what was saved. Null on GitHub */
  publishSaved(repo: HostRepo, number: number): HostCall | null;
  /** GitLab: delete a draft note. Null on GitHub, where a person's pending review is never deleted */
  discardDraft(repo: HostRepo, number: number, draftId: string): HostCall | null;

  /** Null where Agentry does not approve (GitHub, decision 1) */
  approve(repo: HostRepo, number: number, headSha: string): HostCall | null;
  revoke(repo: HostRepo, number: number): HostCall | null;
  /** GitLab's approvals endpoint; null on GitHub, whose decision comes with `reviewers` */
  approvals(repo: HostRepo, number: number): HostCall | null;
  parseApprovals(result: HostResult, headSha: string | null): ApprovalState;

  /** Adds and removes; never replaces the list */
  requestReviewers(repo: HostRepo, number: number, req: { add: string[]; remove?: string[] }): HostCall[];
  /** The reviewers, the decision and the unresolved count, re-read after every write */
  reviewers(repo: HostRepo, number: number): HostCall;
  parseReviewers(result: HostResult, unresolvedThreads: number): ChangeRequestReviewers;

  /** A reason only the answer's own body can say (stdout, never stderr); null leaves it to the generic one */
  reasonOf(op: ReviewOperation, result: HostResult): HostReason | null;
}

/** An adapter that does reviews too: both shipped ones. */
export type ReviewsCodeHostAdapter = ChecksCodeHostAdapter & ReviewsAdapter;

// ---------- Merging (phase 4) ----------

/**
 * What a repository's own settings say about merging (A6): read from the same call as the default
 * branch, so no extra request. `methods` is before the branch's rules.
 */
export interface MergeSettings {
  /** In the order Agentry offers them; empty when the repository allows none */
  methods: MergeMethod[];
  /** GitHub `allow_auto_merge`; GitLab always */
  autoMergeAllowed: boolean;
  /** `delete_branch_on_merge` / `remove_source_branch_after_merge` */
  deleteBranchDefault: boolean;
  /** GitLab `merge_method: ff`: a branch that is behind cannot merge until it is rebased */
  fastForward: boolean;
  /** GitLab `only_allow_merge_if_pipeline_succeeds` */
  requiresPipeline: boolean;
  /** GitLab `merge_trains_enabled` */
  mergeTrains: boolean;
  /** GitLab `ci_config_path`, which the guard looks for at the head commit; null for the default `.gitlab-ci.yml` */
  ciConfigPath: string | null;
}

/** What the branch's rules add to the settings (E2): GitHub rulesets; GitLab has none of these. */
export interface MergeRules {
  /** A `pull_request` rule's `allowed_merge_methods`; null when no rule restricts them */
  methods: MergeMethod[] | null;
  /** `required_linear_history`: no merge commit */
  linearHistory: boolean;
  /** `pull_request.required_review_thread_resolution` */
  threadResolution: boolean;
  /** A `merge_queue` rule: the branch merges through a queue */
  mergeQueue: boolean;
}

/** Whether an auto-merge is armed on the host, and what it says about it. */
export interface MergeArmed {
  armed: boolean;
  method: MergeMethod | null;
  by: string | null;
  at: string | null;
}

/**
 * One read of a change request for merging (B2). A fact a host does not print is null: the
 * GitHub-only fields are null on GitLab and the other way round.
 */
export interface MergeRead {
  number: number | null;
  url: string | null;
  state: ChangeRequestState;
  /** GitHub: the node id the arming mutation takes */
  nodeId: string | null;
  headSha: string | null;
  headRef: string | null;
  baseRef: string | null;
  isDraft: boolean | null;
  autoMerge: MergeArmed;
  // GitHub
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  // GitLab
  detailedMergeStatus: string | null;
  hasConflicts: boolean | null;
  headPipeline: HeadPipeline | null;
  mergeError: string | null;
}

export type MergeOperation = 'merge' | 'arm' | 'disarm' | 'rebase';

export interface MergeNowRequest {
  number: number;
  method: MergeMethod;
  /** The full id of the head the person looked at */
  expectedHead: string;
  deleteBranch: boolean;
  /** Squash and merge commits only; a rebase keeps the commits as they are */
  subject?: string;
  body?: string;
}

export interface ArmRequest {
  number: number;
  method: MergeMethod;
  expectedHead: string;
  /** GitHub: the node id of the pull request */
  nodeId: string | null;
}

/**
 * What an adapter adds in phase 4. Merging is the person's click: nothing here runs from a run or a
 * chat token (the routes refuse those). `--admin`, `gh pr merge --auto` and the raw
 * `mergePullRequest` mutation are never built.
 */
export interface MergeAdapter {
  /** Settings from the repository call that names the default branch (A6) */
  parseMergeSettings(stdout: string): MergeSettings;
  /** The calls that read the branch's rules (E2); empty on GitLab */
  rules(repo: HostRepo, base: string): HostCall[];
  /** Null when a rule read failed: the service then assumes none restrict */
  parseRules(results: HostResult[]): MergeRules | null;

  /** The read a merge state is built from (B2, with the node id and the armed details) */
  readForMerge(repo: HostRepo, number: number): HostCall;
  parseMergeRead(result: HostResult): MergeRead;
  /** GitLab: the checks GraphQL names when REST says `unchecked` or `checking`; null on GitHub */
  mergeabilityChecks(repo: HostRepo, number: number): HostCall | null;
  parseMergeabilityChecks(result: HostResult): Array<{ identifier: string; status: string }>;

  /** Throws `HostParseError` when the head is not a full commit id */
  merge(repo: HostRepo, req: MergeNowRequest): HostCall;
  arm(repo: HostRepo, req: ArmRequest): HostCall;
  disarm(repo: HostRepo, number: number): HostCall;
  /** False when the host answered "done" with an error inside (GitLab's cancel: `status: error` on a success exit, recorded) */
  parseDisarm(result: HostResult): boolean;
  /** The reason only the answer itself can say; null leaves it to the re-read and the generic one */
  mergeReason(op: MergeOperation, result: HostResult): HostReason | null;
  /** What the refusal said in the host's own words, when the first line of stderr says nothing (glab's box); null keeps the first line */
  mergeDetail?(op: MergeOperation, result: HostResult): string | null;

  /** Mark ready or back to draft (B9); the service re-reads `isDraft` */
  ready(repo: HostRepo, number: number, ready: boolean): HostCall;

  /** The branch after a merge, for the box (E6); `-i` so a 404 is told from a failure */
  branchExists(repo: HostRepo, branch: string): HostCall;
  /** Null when the answer does not say */
  parseBranchExists(result: HostResult): boolean | null;

  /** GitLab `ff` projects: a host-side rebase (E9); null on GitHub, whose update is Agentry's own merge */
  rebase(repo: HostRepo, number: number): HostCall | null;
  /** GitLab: `rebase_in_progress` is only in the body with `include_rebase_in_progress=true` */
  rebaseStatus(repo: HostRepo, number: number): HostCall | null;
  parseRebaseStatus(result: HostResult): { inProgress: boolean; error: string | null };
}

/** An adapter that does merging too: both shipped ones. */
export type MergeCodeHostAdapter = ReviewsCodeHostAdapter & MergeAdapter;
