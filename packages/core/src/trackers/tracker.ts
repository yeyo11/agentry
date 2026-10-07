import type { CodeHostId, TrackerId, TrackerMappedStatus } from '@agentry/shared';
import type { HostCall, HostRepo } from '../hosts/code-host.ts';

// What a tracker adapter is, in the same shape as a code host's: a stateless translator from an
// action to the CLI call that does it, and from the CLI's recorded output to Agentry's words. An
// adapter never runs anything: `hosts/exec.ts` is the only place that spawns a CLI, writes are
// never retried, and the caller re-reads after every write (docs/plans/code-hosts.md, "The
// execution layer"). Issue text is untrusted: an adapter returns it as data and never acts on it.

/** Issues a person can import from one query, the ceiling the plan states ("showing the first N"). */
export const ISSUES_CEILING = 500;

/** Issues one page of a list holds. */
export const ISSUES_PAGE_SIZE = 100;

/** The longest issue body Agentry copies into a work item. */
export const MAX_ISSUE_BODY = 60_000;

/**
 * Where a tracker's issues live. For GitHub and GitLab, the project's repository: the tracker is the
 * host's own, so it is pinned exactly as the host's calls are. For YouTrack, `path` is the project's
 * short name and `host` the instance's address.
 */
export type TrackerScope = HostRepo;

/** An issue as a tracker prints it, in Agentry's words. */
export interface IssueRead {
  /** What the person reads and the CLI takes back: the issue number as a string */
  key: string;
  /** The tracker's own id when it differs from the key (GitLab's instance-wide `id`) */
  externalId: string | null;
  title: string;
  /** Untrusted text; empty when the issue has none */
  body: string;
  state: 'open' | 'closed';
  /** GitHub's `stateReason`, lower case with hyphens (`completed`, `not-planned`, `reopened`); null when it says none */
  stateReason: string | null;
  labels: string[];
  url: string | null;
  updatedAt: string | null;
  /** Pull requests that close it, by number (GitHub's `closedByPullRequestsReferences`) */
  closedByChangeRequests: number[];
  /** The tracker's own status name (YouTrack's `State`); absent for a tracker with only open and closed */
  status?: string | null;
  /** The tracker's own issue type (YouTrack's `Type`), which maps to a work item type when it is `Bug` */
  kind?: string | null;
}

/** An issue a change request closes when it merges, as the host says it does: where it lives, and its key. */
export interface ClosedIssue {
  /** The repository (`owner/repo`, `group/project`) the issue is in */
  scope: string;
  key: string;
}

export interface IssuePage {
  issues: IssueRead[];
  page: number;
  /** More issues exist past this page and below the ceiling */
  hasMore: boolean;
}

export interface IssueListRequest {
  /** The tracker's own query; empty lists the open issues of the scope */
  query: string;
  /** 1-based */
  page: number;
}

/** The tracker status a mapped column moves an issue to; `name` is the person's mapping, null when there is none. */
export interface TrackerStatusTarget {
  column: TrackerMappedStatus;
  name: string | null;
}

/** The input of a call is not something the CLI can be given: a key that is not a number, a body too long. A refusal before any call. */
export class TrackerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackerInputError';
  }
}

/** The issue a `get` resolved is a pull request, which `gh issue view` does for any number (recorded). */
export class IssueIsPullRequest extends Error {
  constructor(readonly key: string) {
    super(`#${key} is a pull request, not an issue`);
    this.name = 'IssueIsPullRequest';
  }
}

export interface TrackerAdapter {
  readonly id: TrackerId;
  /** The code host whose CLI and sign-in this tracker uses; null for a tracker with a CLI of its own */
  readonly host: CodeHostId | null;
  readonly cli: 'gh' | 'glab' | 'youtrack-app';
  /**
   * Whether the tracker has statuses of its own (YouTrack's `State`): a sync is then confirmed by the
   * status name read back, not by open or closed, and every mapped column writes.
   */
  readonly namedStatuses: boolean;

  /** The key as the tracker prints it, from what a person typed. Throws `TrackerInputError` for one it cannot take */
  key(key: string): string;

  /** One page of the query. Throws `TrackerInputError` for a page below 1 */
  list(scope: TrackerScope, req: IssueListRequest): HostCall;
  /** Throws `HostParseError` on a shape it cannot read */
  parseList(stdout: string, req: IssueListRequest): IssuePage;

  /** Throws `TrackerInputError` for a key that is not an issue number */
  get(scope: TrackerScope, key: string): HostCall;
  /** Throws `IssueIsPullRequest` for a pull request, `HostParseError` on a shape it cannot read */
  parseGet(stdout: string): IssueRead;

  /** Whether moving an item to this column is a write to the tracker at all: GitHub and GitLab only close, on `done` */
  writes(column: TrackerMappedStatus): boolean;
  /**
   * The write that moves an issue to a mapped status. GitHub and GitLab have one status, so only
   * `done` writes (it closes as completed); every other column is null: nothing to do, not a failure.
   */
  setStatus(scope: TrackerScope, key: string, to: TrackerStatusTarget): HostCall | null;
  /** Closes as completed: the one reason Agentry writes. Only the host trackers, whose `done` is a close */
  close?(scope: TrackerScope, key: string): HostCall;

  /**
   * The issues the host says a change request closes (matrix F10: `closingIssuesReferences` on
   * GitHub, `closes_issues` on GitLab). `repo` is the change request's repository. Read after the
   * merge: what the body asked for is not what the host did, as the body is written once.
   */
  closedByChangeRequest?(repo: TrackerScope, number: number): HostCall;
  /** Throws `HostParseError` on a shape it cannot read */
  parseClosedByChangeRequest?(stdout: string): ClosedIssue[];
}

/** A tracker that is a code host's own issues: `done` is a close, and the host says what a merge closed. */
export interface HostTrackerAdapter extends TrackerAdapter {
  readonly host: CodeHostId;
  readonly cli: 'gh' | 'glab';
  close(scope: TrackerScope, key: string): HostCall;
  closedByChangeRequest(repo: TrackerScope, number: number): HostCall;
  parseClosedByChangeRequest(stdout: string): ClosedIssue[];
}

/** The issue number a key stands for; `#12` is accepted, anything else that is not digits is refused so it can never be read as a flag. */
export function issueNumber(key: string): number {
  const match = /^#?([1-9]\d{0,9})$/.exec(key);
  if (!match?.[1]) throw new TrackerInputError(`"${key}" is not an issue number`);
  return Number(match[1]);
}

/** A change request number a call can be given: digits only, never read as a flag. */
export function requestNumber(number: number): number {
  if (!Number.isSafeInteger(number) || number < 1) throw new TrackerInputError(`${String(number)} is not a change request number`);
  return number;
}
