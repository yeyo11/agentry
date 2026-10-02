import type { CodeHostId, TrackerId, TrackerMappedStatus } from '@agentry/shared';
import { HostParseError, type HostCall, type HostRepo } from '../hosts/code-host.ts';

// What a tracker adapter is, in the same shape as a code host's: a stateless translator from an
// action to the CLI call that does it, and from the CLI's recorded output to Agentry's words. An
// adapter never runs anything: `hosts/exec.ts` is the only place that spawns a CLI, writes are
// never retried, and the caller re-reads after every write (docs/plans/code-hosts.md, "The
// execution layer"). Issue text is untrusted: an adapter returns it as data and never acts on it.

/** Issues a person can import from one query, the ceiling the plan states ("showing the first N"). */
export const ISSUES_CEILING = 500;

/** Issues one page of a list holds. */
export const ISSUES_PAGE_SIZE = 100;

/** The longest body Agentry puts in a create or an update: GitLab takes it in argv, GitHub's own limit is 65 536. */
export const MAX_ISSUE_BODY = 60_000;

/**
 * Where a GitHub or GitLab tracker's issues live: the project's repository. The tracker is the
 * host's own, so it is pinned exactly as the host's calls are.
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
}

export interface IssuePage {
  issues: IssueRead[];
  page: number;
  /** More issues exist past this page and below the ceiling */
  hasMore: boolean;
}

export interface TrackerLabel {
  name: string;
  /** As the host prints it: GitHub `0e8a16`, GitLab `#428BCA`; never parsed */
  color: string;
  description: string;
}

export interface IssueListRequest {
  /** The tracker's own query; empty lists the open issues of the scope */
  query: string;
  /** 1-based */
  page: number;
}

export interface IssueCreateRequest {
  title: string;
  body: string;
  /** Only labels the host has: GitHub refuses an unknown one, GitLab would create it */
  labels?: string[];
}

export interface IssueUpdateRequest {
  title?: string;
  body?: string;
  addLabels?: string[];
  removeLabels?: string[];
}

export type IssueCloseReason = 'completed' | 'not-planned';

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
  /** The code host whose CLI and sign-in this tracker uses */
  readonly host: CodeHostId;
  readonly cli: 'gh' | 'glab';

  /** One page of the query. Throws `TrackerInputError` for a page below 1 */
  list(scope: TrackerScope, req: IssueListRequest): HostCall;
  /** Throws `HostParseError` on a shape it cannot read */
  parseList(stdout: string, req: IssueListRequest): IssuePage;

  /** Throws `TrackerInputError` for a key that is not an issue number */
  get(scope: TrackerScope, key: string): HostCall;
  /** Throws `IssueIsPullRequest` for a pull request, `HostParseError` on a shape it cannot read */
  parseGet(stdout: string): IssueRead;

  /** Throws `TrackerInputError` for a body over `MAX_ISSUE_BODY` or a label it cannot pass */
  create(scope: TrackerScope, req: IssueCreateRequest): HostCall;
  /** The new issue's key and url, from stdout; the caller re-reads with `get` */
  parseCreated(stdout: string): { key: string; url: string };

  /** One call; throws `TrackerInputError` when nothing is asked to change */
  update(scope: TrackerScope, key: string, req: IssueUpdateRequest): HostCall;

  /** The body carries Agentry's marker, which the caller adds: it is how a comment whose write timed out is found */
  comment(scope: TrackerScope, key: string, body: string): HostCall;
  parseCommented(stdout: string): { id: string; url: string };

  /** Whether moving an item to this column is a write to the tracker at all: GitHub and GitLab only close, on `done` */
  writes(column: TrackerMappedStatus): boolean;
  /**
   * The write that moves an issue to a mapped status. GitHub and GitLab have one status, so only
   * `done` writes (it closes as completed); every other column is null: nothing to do, not a failure.
   */
  setStatus(scope: TrackerScope, key: string, to: TrackerStatusTarget): HostCall | null;
  /** GitLab has no reason: it is ignored there */
  close(scope: TrackerScope, key: string, reason: IssueCloseReason): HostCall;
  reopen(scope: TrackerScope, key: string): HostCall;

  labels(scope: TrackerScope): HostCall;
  parseLabels(stdout: string): TrackerLabel[];
}

/** The issue number a key stands for; `#12` is accepted, anything else that is not digits is refused so it can never be read as a flag. */
export function issueNumber(key: string): number {
  const match = /^#?([1-9]\d{0,9})$/.exec(key);
  if (!match?.[1]) throw new TrackerInputError(`"${key}" is not an issue number`);
  return Number(match[1]);
}

export function checkBody(body: string): string {
  if (body.length > MAX_ISSUE_BODY) throw new TrackerInputError(`the body is longer than ${String(MAX_ISSUE_BODY)} characters`);
  return body;
}

/** A label name the CLI can be given: GitLab joins labels with commas, and neither takes an empty one. */
export function checkLabels(labels: readonly string[] | undefined): string[] {
  return (labels ?? []).map((label) => {
    if (label.trim() === '' || label.includes(',') || label.includes('\n')) throw new TrackerInputError(`"${label}" is not a label name Agentry can pass`);
    return label;
  });
}

/** The url a CLI prints for a new issue or comment: `…/issues/20`, `…/work_items/4#note_3942895762`. */
export const ISSUE_URL = /^(https?:\/\/\S+?\/(?:issues|work_items)\/(\d+))(?:#(?:issuecomment-|note_)(\d+))?$/;

/** The last non-empty line of stdout: where both CLIs print the url, after any progress lines. */
function lastLine(stdout: string): string {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

/** What `issue create` printed: the new issue's key and url. Throws `HostParseError` for any other output. */
export function parseCreatedUrl(stdout: string): { key: string; url: string } {
  const match = ISSUE_URL.exec(lastLine(stdout));
  if (!match?.[1] || !match[2] || match[3] !== undefined) throw new HostParseError('issue create did not print the new issue’s url');
  return { key: match[2], url: match[1] };
}

/** What `issue comment` / `issue note` printed: the comment's id and its url. Throws `HostParseError` for any other output. */
export function parseCommentUrl(stdout: string): { id: string; url: string } {
  const line = lastLine(stdout);
  const match = ISSUE_URL.exec(line);
  if (!match?.[3]) throw new HostParseError('issue comment did not print the comment’s url');
  return { id: match[3], url: line };
}
