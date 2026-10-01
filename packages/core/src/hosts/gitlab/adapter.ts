import type { WorkItemPullRequestCi } from '@agentry/shared';
import {
  HostParseError,
  type ChangeRequestState,
  type ChangeRequestView,
  type ChangeRequestRead,
  type ChecksCodeHostAdapter,
  type HeadPipeline,
  type HostCall,
  type HostRepo,
  type HostResult,
} from '../code-host.ts';
import { envOf } from '../env.ts';
import { gitlabChecks } from './checks.ts';
import { parseJson } from '../json.ts';

// Every argument and every field below is what glab 1.120.0 was recorded to take and print
// (packages/core/test/fixtures/recordings/glab/NOTES.md, docs/plans/code-hosts.md matrix A, B, C1).

/** `-R` takes the URL form: `group/sub/project` is ambiguous with a host prefix, and a self-managed host is pinned too */
const projectUrl = (repo: HostRepo): string => `https://${repo.host}/${repo.path}`;

/** glab's merge request states, in Agentry's words; `locked` is a merge in flight, still open */
const STATES: Readonly<Record<string, ChangeRequestState>> = { opened: 'open', locked: 'open', merged: 'merged', closed: 'closed' };

const FAILING = new Set(['failed', 'canceled', 'canceling']);
const PASSING = new Set(['success', 'skipped']);

/**
 * `head_pipeline.status` as the rolled-up CI. No pipeline is `none` (a project without CI prints
 * `null`, recorded); `manual` waits for a person, so it is `pending`; a status nobody listed is
 * `pending` too, never `passing`.
 */
export function pipelineCi(status: unknown): WorkItemPullRequestCi {
  if (typeof status !== 'string') return 'pending';
  if (FAILING.has(status)) return 'failing';
  if (PASSING.has(status)) return 'passing';
  return 'pending';
}

function parseObject(stdout: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseJson(stdout);
  } catch {
    throw new HostParseError(`${what} is not JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HostParseError(`${what} is not an object`);
  return value as Record<string, unknown>;
}

/** An iid, which a 64-bit-safe parse may hand back as a string only above 2^53: never for a real merge request */
const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null);

/** The numeric project id kept from `repo view`: every `glab api` path is pinned on it */
export function parseProjectId(stdout: string): number | null {
  try {
    return numberOf(parseObject(stdout, 'repo view').id);
  } catch {
    return null;
  }
}

export const gitlabAdapter: ChecksCodeHostAdapter = {
  ...gitlabChecks,
  id: 'gitlab',
  refPrefix: '!',

  env: () => envOf('glab'),

  version: () => ({ cli: 'glab', args: ['version'], kind: 'read', class: 'probe', host: null }),

  // "glab 1.120.0 (78790114c)"
  parseVersion: (stdout) => /^glab (\d+\.\d+\.\d+)\b/.exec(stdout.trim())?.[1] ?? null,

  authStatus: (hostname) => ({
    cli: 'glab',
    args: ['auth', 'status', '--hostname', hostname],
    kind: 'read',
    class: 'probe',
    host: hostname,
  }),

  // Exit 0 is signed in, 1 is not (from the minimum release on). The status text is on stderr and
  // is display only, so the account name is not read from it: it comes from glab's config file.
  parseAuth: (result) => ({ signedIn: result.exitCode === 0, user: null }),

  defaultBranch: (repo) => ({
    cli: 'glab',
    args: ['repo', 'view', '-R', projectUrl(repo), '-F', 'json'],
    kind: 'read',
    class: 'read',
    host: repo.host,
  }),

  parseDefaultBranch: (stdout) => {
    try {
      const branch = parseObject(stdout, 'repo view').default_branch;
      return typeof branch === 'string' && branch !== '' ? branch : null;
    } catch {
      return null;
    }
  },

  // The description travels on stdin. The adapter never passes `--recover`: a failed create leaves
  // a recovery file in the person's own glab directory, which only that flag reads.
  create: (repo, req) => ({
    cli: 'glab',
    args: [
      'mr',
      'create',
      '-R',
      projectUrl(repo),
      '--source-branch',
      req.head,
      '--target-branch',
      req.base,
      '--title',
      req.title,
      '--description-file',
      '-',
      '--yes',
    ],
    input: req.body,
    kind: 'write',
    class: 'write',
    host: repo.host,
  }),

  // `-A` so a merged or closed one is found too, and two results so that "more than one" is visible
  find: (repo, req): HostCall => ({
    cli: 'glab',
    args: ['mr', 'list', '-R', projectUrl(repo), '-s', req.head, '-t', req.base, '-A', '-P', '2', '-F', 'json'],
    kind: 'read',
    class: 'read',
    host: repo.host,
  }),

  parseFind: (stdout) => {
    let value: unknown;
    try {
      value = parseJson(stdout);
    } catch {
      throw new HostParseError('mr list is not JSON');
    }
    if (!Array.isArray(value)) throw new HostParseError('mr list is not an array');
    return value.flatMap((item: unknown) => {
      if (typeof item !== 'object' || item === null) return [];
      const { iid, web_url: url, state } = item as Record<string, unknown>;
      const number = numberOf(iid);
      const mapped = typeof state === 'string' ? STATES[state] : undefined;
      if (number === null || typeof url !== 'string' || mapped === undefined) return [];
      return [{ number, url, state: mapped }];
    });
  },

  view: (repo, number) => ({
    cli: 'glab',
    args: ['mr', 'view', String(number), '-R', projectUrl(repo), '-F', 'json'],
    kind: 'read',
    class: 'read',
    host: repo.host,
  }),

  // A missing `iid`, `web_url` or a state it does not know fails the step; a missing `head_pipeline` is no CI.
  parseView: (stdout) => {
    const mr = parseObject(stdout, 'mr view');
    const number = numberOf(mr.iid);
    if (number === null) throw new HostParseError('mr view has no iid');
    if (typeof mr.web_url !== 'string' || mr.web_url === '') throw new HostParseError('mr view has no web_url');
    const state = typeof mr.state === 'string' ? STATES[mr.state] : undefined;
    if (state === undefined) throw new HostParseError(`mr view has an unknown state: ${String(mr.state)}`);
    const pipeline = mr.head_pipeline;
    const ci: WorkItemPullRequestCi =
      pipeline === null || pipeline === undefined
        ? 'none'
        : typeof pipeline === 'object'
          ? pipelineCi((pipeline as Record<string, unknown>).status)
          : 'pending';
    return {
      number,
      url: mr.web_url,
      state,
      mergedAt: typeof mr.merged_at === 'string' ? mr.merged_at : null,
      ci,
    } satisfies ChangeRequestView;
  },

  // GitLab's watcher keeps `mr view`: a failure there classifies as unreachable (plan, phase 2)
  readChangeRequest: (repo, number) => gitlabAdapter.view(repo, number),

  parseChangeRequest(result: HostResult): ChangeRequestRead {
    const view = gitlabAdapter.parseView(result.stdout);
    const mr = parseObject(result.stdout, 'mr view');
    const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
    const raw = mr.head_pipeline;
    const pipeline = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
    const id = numberOf(pipeline?.id);
    const headPipeline: HeadPipeline | null =
      pipeline && id !== null ? { id, status: text(pipeline.status) ?? '', sha: text(pipeline.sha), source: text(pipeline.source) } : null;
    return {
      view,
      // The merge request's head, which is also the head pipeline's commit unless a newer push has no pipeline yet
      headSha: text(mr.sha),
      baseRef: text(mr.target_branch),
      isDraft: typeof mr.draft === 'boolean' ? mr.draft : null,
      mergeable: text(mr.detailed_merge_status),
      mergeStateStatus: null,
      reviewDecision: null,
      autoMerge: typeof mr.merge_when_pipeline_succeeds === 'boolean' ? mr.merge_when_pipeline_succeeds : null,
      headPipeline,
      truncated: false,
      rateLimit: null,
    };
  },
};
