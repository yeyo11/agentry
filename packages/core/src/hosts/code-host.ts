import type { Check, CheckAnnotation, CodeHostId, WorkItemPullRequestCi } from '@agentry/shared';

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
