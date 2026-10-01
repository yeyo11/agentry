import type { Check, CheckAnnotation, CheckState, WorkItemPullRequestCi } from '@agentry/shared';
import {
  HostParseError,
  HostRequestError,
  MAX_CHECKS,
  type ChangeRequestRead,
  type ChangeRequestState,
  type ChecksAdapter,
  type ChecksParse,
  type HostCall,
  type HostRepo,
  type HostResult,
} from '../code-host.ts';
import { parseJson } from '../json.ts';
import { ciOf } from './ci.ts';
import { CHANGE_REQUEST_QUERY } from './queries/change-request.ts';

// Arguments and fields are what gh 2.92.0 and 2.102.0 were recorded to take and print (recordings/gh,
// docs/plans/code-hosts.md matrix C). Check runs and statuses are the REST shapes; the change
// request read is the GraphQL query in `queries/`.

const pin = (repo: HostRepo): string => `${repo.host}/${repo.owner}/${repo.name}`;
const scope = (repo: HostRepo): string => `repos/${repo.owner}/${repo.name}`;

const STATES: Readonly<Record<string, ChangeRequestState>> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

/** The first release whose `gh api` takes `--allow-escape-sequences`; 2.102 refuses an ANSI log without it. */
const ESCAPE_FLAG_FROM = [2, 97, 0] as const;

export function atLeast(version: string | null, minimum: readonly [number, number, number]): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!parts) return false;
  for (let i = 0; i < 3; i += 1) {
    const have = Number(parts[i + 1]);
    const want = minimum[i] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
}

/** An id that goes into an argv: digits only, so no value from a host can become a flag or a path. */
function idOf(value: unknown, what: string): string {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!/^\d+$/.test(text)) throw new HostParseError(`${what} has no numeric id`);
  return text;
}

const RUN_OF = /\/actions\/runs\/(\d+)\/job\/\d+/;

/** The Actions run a check belongs to, from the job URL the check run carries. */
export function runIdOf(check: Check): string | null {
  return (check.url ? RUN_OF.exec(check.url)?.[1] : undefined) ?? null;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pagesOf(stdout: string, what: string): Record<string, unknown>[] {
  let value: unknown;
  try {
    value = parseJson(stdout);
  } catch {
    throw new HostParseError(`${what} is not JSON`);
  }
  // `--paginate --slurp` prints an array of pages; a single page is an object
  const pages = Array.isArray(value) ? value : [value];
  return pages.map((page) => {
    const object = objectOf(page);
    if (!object) throw new HostParseError(`${what} holds a page that is not an object`);
    return object;
  });
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function runState(status: string, conclusion: string): CheckState {
  if (status !== 'completed') return status === 'in_progress' ? 'running' : 'queued';
  switch (conclusion) {
    case 'success':
      return 'passed';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
    case 'action_required':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      // neutral, stale, or a conclusion nobody listed: finished without a verdict
      return 'neutral';
  }
}

const FINISHED: ReadonlySet<CheckState> = new Set(['passed', 'failed', 'cancelled', 'skipped', 'neutral']);

function checkRun(item: Record<string, unknown>): Check {
  const state = runState(String(item.status ?? '').toLowerCase(), String(item.conclusion ?? '').toLowerCase());
  const slug = text(objectOf(item.app)?.slug);
  const actions = slug === 'github-actions';
  const url = text(item.html_url) ?? text(item.details_url);
  const check: Check = {
    id: idOf(item.id, 'check run'),
    name: text(item.name) ?? '(unnamed)',
    // The REST list names no workflow; the job URL has only its id
    group: null,
    state,
    allowedToFail: false,
    required: false,
    startedAt: text(item.started_at),
    finishedAt: text(item.completed_at),
    url,
    rerunnable: false,
    hasLog: actions,
    source: actions ? 'actions' : 'app',
  };
  // A check run's id is the Actions job id only for Actions; the run id comes from the URL
  check.rerunnable = actions && FINISHED.has(state) && runIdOf(check) !== null;
  return check;
}

function commitStatus(item: Record<string, unknown>): Check {
  const raw = String(item.state ?? '').toLowerCase();
  const state: CheckState = raw === 'success' ? 'passed' : raw === 'failure' || raw === 'error' ? 'failed' : 'queued';
  return {
    id: idOf(item.id, 'commit status'),
    name: text(item.context) ?? '(unnamed)',
    group: null,
    state,
    allowedToFail: false,
    required: false,
    startedAt: text(item.created_at),
    finishedAt: state === 'queued' ? null : text(item.updated_at),
    url: text(item.target_url),
    rerunnable: false,
    hasLog: false,
    source: 'status',
  };
}

const ROLLUP_STATES: Readonly<Record<string, WorkItemPullRequestCi>> = {
  SUCCESS: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

function failures(data: Record<string, unknown>): string | null {
  const errors = data.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = objectOf(errors[0]);
  return text(first?.type) ?? 'error';
}

export const githubChecks: ChecksAdapter = {
  readChangeRequest: (repo, number): HostCall => ({
    cli: 'gh',
    // `-i`: a failed poll then has its status and rate-limit headers. The document is inline (-f) so
    // the classifier can read that it is a query
    args: [
      'api', '-i', '--hostname', repo.host, 'graphql',
      '-f', `query=${CHANGE_REQUEST_QUERY}`,
      '-f', `owner=${repo.owner}`,
      '-f', `repo=${repo.name}`,
      '-F', `number=${String(number)}`,
    ],
    kind: 'read',
    class: 'read',
    host: repo.host,
    bucket: 'graphql',
  }),

  parseChangeRequest(result: HostResult): ChangeRequestRead {
    let body: unknown;
    try {
      body = parseJson(result.stdout);
    } catch {
      throw new HostParseError('graphql answer is not JSON');
    }
    const data = objectOf(body);
    if (!data) throw new HostParseError('graphql answer is not an object');
    const pull = objectOf(objectOf(objectOf(data.data)?.repository)?.pullRequest);
    // A not-found is HTTP 200 with `errors[]` and exit 1 (recorded), so the status line decides nothing
    if (!pull) throw new HostParseError(`graphql answer has no pull request${failures(data) ? ` (${failures(data) ?? ''})` : ''}`);
    const state = typeof pull.state === 'string' ? STATES[pull.state.toUpperCase()] : undefined;
    if (!state) throw new HostParseError('pull request has no known state');

    const commit = objectOf(objectOf(Array.isArray(objectOf(pull.commits)?.nodes) ? (objectOf(pull.commits)?.nodes as unknown[])[0] : null)?.commit);
    const rollup = objectOf(commit?.statusCheckRollup);
    const contexts = objectOf(rollup?.contexts);
    const nodes = Array.isArray(contexts?.nodes) ? (contexts.nodes as unknown[]) : [];
    const truncated = objectOf(contexts?.pageInfo)?.hasNextPage === true;
    const ci: WorkItemPullRequestCi = !rollup
      ? 'none'
      : truncated
        ? (ROLLUP_STATES[String(rollup.state).toUpperCase()] ?? 'pending')
        : ciOf(nodes); // the query names the fields like the CLI's own rollup does

    const limit = objectOf(objectOf(data.data)?.rateLimit);
    const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
    return {
      view: {
        number: typeof pull.number === 'number' ? pull.number : null,
        url: text(pull.url),
        state,
        mergedAt: text(pull.mergedAt),
        ci,
      },
      headSha: text(pull.headRefOid),
      baseRef: text(pull.baseRefName),
      isDraft: typeof pull.isDraft === 'boolean' ? pull.isDraft : null,
      mergeable: text(pull.mergeable),
      mergeStateStatus: text(pull.mergeStateStatus),
      reviewDecision: text(pull.reviewDecision),
      autoMerge: pull.autoMergeRequest === undefined ? null : pull.autoMergeRequest !== null,
      headPipeline: null,
      truncated,
      rateLimit: limit ? { cost: num(limit.cost), remaining: num(limit.remaining), resetAt: text(limit.resetAt) } : null,
    };
  },

  checks(repo, ref): HostCall[] {
    if (!ref.headSha) return [];
    const sha = encodeURIComponent(ref.headSha);
    const read = (path: string): HostCall => ({
      cli: 'gh',
      args: ['api', '--hostname', repo.host, '--paginate', '--slurp', `${scope(repo)}/commits/${sha}/${path}?per_page=100`],
      kind: 'read',
      class: 'read',
      host: repo.host,
      bucket: 'core',
    });
    // Check runs and commit statuses are two lists: an app may report either one
    return [read('check-runs'), read('status')];
  },

  parseChecks(_repo, _ref, results): ChecksParse {
    const [runs, statuses] = results;
    if (!runs || !statuses) throw new HostParseError('checks need the check runs and the statuses');
    for (const result of [runs, statuses]) {
      if (result.exitCode !== 0) throw new HostParseError(`checks read exited ${String(result.exitCode)}`);
    }
    const checks: Check[] = [];
    let total = 0;
    for (const page of pagesOf(runs.stdout, 'check runs')) {
      if (typeof page.total_count === 'number') total = Math.max(total, page.total_count);
      if (!Array.isArray(page.check_runs)) throw new HostParseError('check runs page has no check_runs');
      for (const item of page.check_runs) {
        const object = objectOf(item);
        if (!object) throw new HostParseError('check_runs holds a non-object');
        checks.push(checkRun(object));
      }
    }
    for (const page of pagesOf(statuses.stdout, 'commit statuses')) {
      if (!Array.isArray(page.statuses)) continue;
      for (const item of page.statuses) {
        const object = objectOf(item);
        if (object) checks.push(commitStatus(object));
      }
    }
    const truncated = checks.length > MAX_CHECKS || total > MAX_CHECKS;
    return { checks: checks.slice(0, MAX_CHECKS), truncated, next: [] };
  },

  // GitHub's list is one round
  parseChecksMore: () => ({ checks: [], truncated: false, next: [] }),

  jobLog(repo, check, cliVersion): HostCall | null {
    if (check.source !== 'actions' || !check.hasLog) return null;
    return {
      cli: 'gh',
      args: [
        'api', '--hostname', repo.host,
        // 2.102 refuses a log with ANSI codes without it; 2.92 does not know the flag
        ...(atLeast(cliVersion, ESCAPE_FLAG_FROM) ? ['--allow-escape-sequences'] : []),
        `${scope(repo)}/actions/jobs/${idOf(check.id, 'check')}/logs`,
      ],
      kind: 'read',
      class: 'log',
      host: repo.host,
      bucket: 'core',
    };
  },
  parseJobLog: (result) => ({ text: result.stdout, noOutputYet: result.stdout.trim() === '' }),

  annotations(repo, check): HostCall | null {
    if (check.source === 'status') return null;
    return {
      cli: 'gh',
      args: ['api', '--hostname', repo.host, `${scope(repo)}/check-runs/${idOf(check.id, 'check')}/annotations?per_page=100`],
      kind: 'read',
      class: 'read',
      host: repo.host,
      bucket: 'core',
    };
  },
  parseAnnotations(stdout): CheckAnnotation[] {
    let value: unknown;
    try {
      value = parseJson(stdout);
    } catch {
      throw new HostParseError('annotations are not JSON');
    }
    if (!Array.isArray(value)) throw new HostParseError('annotations are not an array');
    return value.flatMap((item): CheckAnnotation[] => {
      const a = objectOf(item);
      const message = text(a?.message);
      if (!a || message === null) return [];
      const level = a.annotation_level === 'failure' || a.annotation_level === 'warning' ? a.annotation_level : 'notice';
      // The runner's own annotations use the path ".github": they are about the run, not a file
      const path = text(a.path);
      const file = path === '.github' ? null : path;
      const line = (v: unknown): number | null => (file !== null && typeof v === 'number' ? v : null);
      return [{ path: file, startLine: line(a.start_line), endLine: line(a.end_line), level, title: text(a.title), message }];
    });
  },

  rerun(repo, req): HostCall[] {
    const write = (args: string[]): HostCall => ({ cli: 'gh', args, kind: 'write', class: 'write', host: repo.host, bucket: 'core' });
    if (req.scope === 'check') {
      const check = req.checks.find((c) => c.id === req.checkId);
      if (!check || !check.rerunnable) throw new HostRequestError('That check cannot be run again', 'check-not-rerunnable');
      return [write(['run', 'rerun', '-R', pin(repo), '--job', idOf(check.id, 'check')])];
    }
    const wanted = req.checks.filter((c) => c.source === 'actions' && (req.scope === 'all' || c.state === 'failed'));
    const runs = [...new Set(wanted.flatMap((c) => runIdOf(c) ?? []))].slice(0, 20);
    if (runs.length === 0) throw new HostRequestError('There is no workflow run to run again', 'rerun-refused');
    return runs.map((run) => write(['run', 'rerun', run, '-R', pin(repo), ...(req.scope === 'failed' ? ['--failed'] : [])]));
  },

  cancel(repo, req): HostCall[] {
    const live = req.checks.filter((c) => c.source === 'actions' && (c.state === 'running' || c.state === 'queued'));
    const runs = [...new Set(live.flatMap((c) => runIdOf(c) ?? []))].slice(0, 20);
    return runs.map((run) => ({ cli: 'gh', args: ['run', 'cancel', run, '-R', pin(repo)], kind: 'write', class: 'write', host: repo.host, bucket: 'core' }));
  },

  // Environment approvals and dispatches are not per pull request: the check links to its run page
  playManual: () => null,

  required(repo, base): HostCall[] {
    const branch = base.split('/').map(encodeURIComponent).join('/');
    const read = (path: string): HostCall => ({
      cli: 'gh',
      args: ['api', '--hostname', repo.host, `${scope(repo)}/${path}`],
      kind: 'read',
      class: 'read',
      host: repo.host,
      bucket: 'core',
    });
    // Rulesets show on `rules/branches`, classic protection on `branches`; each misses the other
    return [read(`rules/branches/${branch}`), read(`branches/${branch}`)];
  },
  parseRequired(results): string[] | null {
    const [rules, branch] = results;
    if (!rules || !branch || rules.exitCode !== 0 || branch.exitCode !== 0) return null;
    let ruleList: unknown;
    let branchObject: unknown;
    try {
      ruleList = parseJson(rules.stdout);
      branchObject = parseJson(branch.stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(ruleList)) return null;
    const names = new Set<string>();
    for (const rule of ruleList) {
      const r = objectOf(rule);
      if (r?.type !== 'required_status_checks') continue;
      const list = objectOf(r.parameters)?.required_status_checks;
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const context = text(objectOf(entry)?.context);
        if (context) names.add(context);
      }
    }
    const protection = objectOf(objectOf(objectOf(branchObject)?.protection)?.required_status_checks);
    if (Array.isArray(protection?.contexts)) {
      for (const context of protection.contexts) if (typeof context === 'string' && context) names.add(context);
    }
    return [...names];
  },
};
