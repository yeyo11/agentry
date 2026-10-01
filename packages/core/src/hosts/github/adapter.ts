import {
  HostParseError,
  type ChangeRequestState,
  type ChangeRequestView,
  type MergeCodeHostAdapter,
  type HostCall,
  type HostRepo,
  type HostResult,
} from '../code-host.ts';
import { envOf } from '../env.ts';
import { githubChecks } from './checks.ts';
import { githubMerge } from './merge.ts';
import { githubReviews } from './reviews.ts';
import { ciOf } from './ci.ts';

export { ciOf };

// gh's arguments are today's, pinned to the host and repository on every call (`-R host/owner/repo`,
// `api --hostname`), and every answer is read from stdout only after a zero exit. The shapes come
// from the 2.92.0 and 2.102.0 recordings (packages/core/test/fixtures/recordings/gh).

const STATES: Readonly<Record<string, ChangeRequestState>> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

/** The repository flag value gh reads: the host is part of it, so a host-less `-R` never reaches gh. */
const pin = (repo: HostRepo): string => `${repo.host}/${repo.owner}/${repo.name}`;

function parseObject(stdout: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new HostParseError(`${what} is not JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HostParseError(`${what} is not an object`);
  return value as Record<string, unknown>;
}

/** An account entry of `auth status --json hosts`; only the fields Agentry reads, never a token source or scope. */
interface AuthAccount {
  active: boolean;
  state: string;
  login: string;
}

function accountsOf(value: unknown): AuthAccount[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): AuthAccount[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const e = entry as Record<string, unknown>;
    return [{ active: e.active === true, state: typeof e.state === 'string' ? e.state : '', login: typeof e.login === 'string' ? e.login : '' }];
  });
}

export const githubAdapter: MergeCodeHostAdapter = {
  ...githubChecks,
  ...githubReviews,
  ...githubMerge,
  id: 'github',
  refPrefix: '#',

  env: () => envOf('gh'),

  version: (): HostCall => ({ cli: 'gh', args: ['--version'], kind: 'read', class: 'probe', host: null }),
  parseVersion: (stdout) => /^gh version (\d+\.\d+\.\d+)/m.exec(stdout)?.[1] ?? null,

  // One call lists every host, so the hostname only picks the entry afterwards
  authStatus: (): HostCall => ({ cli: 'gh', args: ['auth', 'status', '--json', 'hosts'], kind: 'read', class: 'probe', host: null }),
  parseAuth(result: HostResult, hostname: string) {
    // It exits 0 whether the token is good, bad or missing, so a non-zero exit is gh failing, not "signed out"
    if (result.exitCode !== 0) throw new HostParseError(`gh auth status exited ${String(result.exitCode)}`);
    const hosts = parseObject(result.stdout, 'auth status').hosts;
    if (typeof hosts !== 'object' || hosts === null || Array.isArray(hosts)) throw new HostParseError('auth status has no hosts object');
    // Only the active account counts; a bad token on it is `error` and the person is signed out there
    const active = accountsOf((hosts as Record<string, unknown>)[hostname]).find((a) => a.active);
    return active?.state === 'success' ? { signedIn: true, user: active.login || null } : { signedIn: false, user: null };
  },

  defaultBranch: (repo): HostCall => ({
    cli: 'gh',
    args: ['api', '--hostname', repo.host, `repos/${repo.owner}/${repo.name}`],
    kind: 'read',
    class: 'read',
    host: repo.host,
    bucket: 'core',
  }),
  parseDefaultBranch(stdout) {
    try {
      const branch = parseObject(stdout, 'repository').default_branch;
      return typeof branch === 'string' && branch ? branch : null;
    } catch {
      return null;
    }
  },

  // The body travels on stdin only: it is up to 60 000 characters and may hold anything
  create: (repo, req): HostCall => ({
    cli: 'gh',
    args: ['pr', 'create', '-R', pin(repo), '--head', req.head, '--base', req.base, '--title', req.title, '--body-file', '-'],
    input: req.body,
    kind: 'write',
    class: 'write',
    host: repo.host,
    bucket: 'graphql',
  }),

  find: (repo, req): HostCall => ({
    cli: 'gh',
    args: [
      'pr', 'list', '-R', pin(repo), '--head', req.head, '--base', req.base, '--state', 'all', '--limit', '2',
      '--json', 'number,url,state,headRefName,baseRefName,isCrossRepository',
    ],
    kind: 'read',
    class: 'read',
    host: repo.host,
    bucket: 'graphql',
  }),
  parseFind(stdout) {
    let value: unknown;
    try {
      value = JSON.parse(stdout);
    } catch {
      throw new HostParseError('pr list is not JSON');
    }
    if (!Array.isArray(value)) throw new HostParseError('pr list is not an array');
    return value.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) throw new HostParseError('pr list holds a non-object');
      const e = entry as Record<string, unknown>;
      const state = typeof e.state === 'string' ? STATES[e.state.toUpperCase()] : undefined;
      if (typeof e.number !== 'number' || typeof e.url !== 'string' || !state) throw new HostParseError('pr list entry lacks number, url or state');
      // Agentry pushes to origin and never opens a fork's pull request, so one is never adopted
      return e.isCrossRepository === true ? [] : [{ number: e.number, url: e.url, state }];
    });
  },

  // Never `number` alone: 2.92 answers {"number":N} with exit 0 for a pull request that does not exist
  view: (repo, number): HostCall => ({
    cli: 'gh',
    args: ['pr', 'view', String(number), '-R', pin(repo), '--json', 'state,mergedAt,statusCheckRollup,url'],
    kind: 'read',
    class: 'read',
    host: repo.host,
    bucket: 'graphql',
  }),
  parseView(stdout): ChangeRequestView {
    const view = parseObject(stdout, 'pr view');
    // Anything but a state gh prints for a pull request is not one (`{"number":N}` has none)
    const state = typeof view.state === 'string' ? STATES[view.state.toUpperCase()] : undefined;
    if (!state) throw new HostParseError('pr view has no known state');
    return {
      number: typeof view.number === 'number' ? view.number : null,
      url: typeof view.url === 'string' ? view.url : null,
      state,
      mergedAt: typeof view.mergedAt === 'string' && view.mergedAt ? view.mergedAt : null,
      ci: ciOf(view.statusCheckRollup),
    };
  },
};
