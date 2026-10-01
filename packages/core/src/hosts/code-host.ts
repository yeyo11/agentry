import type { CodeHostId, WorkItemPullRequestCi } from '@agentry/shared';

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
