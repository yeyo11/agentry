import type { Check, CheckState } from '@agentry/shared';
import {
  HostParseError,
  HostRequestError,
  MAX_CHECKS,
  type ChecksAdapter,
  type ChecksFollowUp,
  type ChecksParse,
  type HostCall,
  type HostRepo,
  type HostResult,
} from '../code-host.ts';
import { parseJson } from '../json.ts';

// Every argument and field is what glab 1.120.0 was recorded to take and print (recordings/glab,
// k0-NOTES.md, docs/plans/code-hosts.md matrix C). A pipeline's checks are three reads: its jobs, its
// bridges, and the jobs of each bridge's child pipeline. The jobs endpoint lists neither bridges nor
// child jobs, and `glab ci get --merge-request` has neither, so this is the only complete list.

/** The most child pipelines followed, at depth 2: a parent and its children */
const MAX_CHILDREN = 20;

/** The most failed jobs one "re-run failed" retries, a call each */
const MAX_RETRIES = 100;

const projectUrl =(repo: HostRepo): string => `https://${repo.host}/${repo.path}`;

function projectPath(repo: HostRepo): string {
  if (repo.projectId === undefined) throw new HostParseError('GitLab calls need the numeric project id');
  return `projects/${String(repo.projectId)}`;
}

/** An id that goes into an argv or a path: digits only. */
function idOf(value: unknown, what: string): string {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!/^\d+$/.test(text)) throw new HostParseError(`${what} has no numeric id`);
  return text;
}

const objectOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function read(repo: HostRepo, args: string[]): HostCall {
  return { cli: 'glab', args: ['api', '--hostname', repo.host, ...args], kind: 'read', class: 'read', host: repo.host };
}

function write(repo: HostRepo, args: string[]): HostCall {
  return { cli: 'glab', args, kind: 'write', class: 'write', host: repo.host };
}

/** GitLab's job and pipeline statuses in Agentry's words; an unknown one waits rather than passes. */
function stateOf(status: unknown): CheckState {
  switch (status) {
    case 'success':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    case 'manual':
      return 'manual';
    case 'running':
    case 'canceling':
      return 'running';
    default:
      return 'queued';
  }
}

/** `retry` only takes a job that finished and did not skip: a running, waiting or manual one is refused */
const RETRYABLE: ReadonlySet<CheckState> = new Set(['passed', 'failed', 'cancelled']);

/** A job or a bridge; they print the same keys, bar `runner` and `downstream_pipeline`. */
function checkOf(item: Record<string, unknown>, group: string | null, source: 'job' | 'bridge'): Check {
  const state = stateOf(item.status);
  const stage = text(item.stage);
  return {
    id: idOf(item.id, source),
    name: text(item.name) ?? '(unnamed)',
    group: group === null ? stage : stage === null ? group : `${group} › ${stage}`,
    state,
    // A manual job is allowed to fail by default; that only matters once a job has failed
    allowedToFail: state === 'failed' && item.allow_failure === true,
    required: false,
    startedAt: text(item.started_at),
    finishedAt: text(item.finished_at),
    url: text(item.web_url),
    rerunnable: RETRYABLE.has(state),
    // A bridge has no log: its GET and trace answer 404 (recorded)
    hasLog: source === 'job',
    source,
  };
}

/** `--paginate --output ndjson` prints one object per line; a plain read prints an array. Both are read. */
function itemsOf(stdout: string, what: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const take = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(take);
    const object = objectOf(value);
    if (!object) throw new HostParseError(`${what} holds a non-object`);
    out.push(object);
  };
  const body = stdout.trim();
  if (body === '') return out;
  try {
    take(parseJson(body));
  } catch (error) {
    if (error instanceof HostParseError) throw error;
    // Not one document: ndjson
    for (const line of body.split('\n')) {
      if (line.trim() === '') continue;
      try {
        take(parseJson(line));
      } catch (inner) {
        if (inner instanceof HostParseError) throw inner;
        throw new HostParseError(`${what} is not JSON`);
      }
    }
  }
  return out;
}

function ok(result: HostResult | undefined, what: string): HostResult {
  if (!result) throw new HostParseError(`${what} was not read`);
  if (result.exitCode !== 0) throw new HostParseError(`${what} exited ${String(result.exitCode)}`);
  return result;
}

const jobsCall = (repo: HostRepo, pipelineId: string): HostCall =>
  read(repo, ['--paginate', '--output', 'ndjson', `${projectPath(repo)}/pipelines/${pipelineId}/jobs?per_page=100`]);

function capped(checks: Check[], truncated: boolean, next: ChecksFollowUp[]): ChecksParse {
  return { checks: checks.slice(0, MAX_CHECKS), truncated: truncated || checks.length > MAX_CHECKS, next };
}

export const gitlabChecks: Omit<ChecksAdapter, 'readChangeRequest' | 'parseChangeRequest'> = {
  checks(repo, ref): HostCall[] {
    if (ref.pipelineId === null) return [];
    const id = idOf(ref.pipelineId, 'pipeline');
    return [jobsCall(repo, id), read(repo, [`${projectPath(repo)}/pipelines/${id}/bridges?per_page=100`])];
  },

  parseChecks(repo, ref, results): ChecksParse {
    if (ref.pipelineId === null) return { checks: [], truncated: false, next: [] };
    const checks: Check[] = [];
    for (const job of itemsOf(ok(results[0], 'jobs').stdout, 'jobs')) checks.push(checkOf(job, null, 'job'));
    const next: ChecksFollowUp[] = [];
    let truncated = false;
    for (const bridge of itemsOf(ok(results[1], 'bridges').stdout, 'bridges')) {
      const check = checkOf(bridge, null, 'bridge');
      checks.push(check);
      // `null` when the child could not be created (recorded): the bridge is a failed check of its own
      const child = objectOf(bridge.downstream_pipeline);
      if (!child) continue;
      if (next.length >= MAX_CHILDREN) {
        truncated = true;
        continue;
      }
      next.push({ call: jobsCall(repo, idOf(child.id, 'child pipeline')), group: check.name });
    }
    return capped(checks, truncated, next);
  },

  // Depth 2: a child's own bridges were `[]` in every recording, so its jobs end the walk
  parseChecksMore(_repo, follow, results): ChecksParse {
    const checks: Check[] = [];
    follow.forEach((step, at) => {
      for (const job of itemsOf(ok(results[at], 'child jobs').stdout, 'child jobs')) checks.push(checkOf(job, step.group, 'job'));
    });
    return capped(checks, false, []);
  },

  jobLog(repo, check): HostCall | null {
    if (check.source !== 'job' || !check.hasLog) return null;
    // Never `glab ci trace`: it follows a running job. The API's trace is one read, and lags a running job by up to a minute
    return { ...read(repo, [`${projectPath(repo)}/jobs/${idOf(check.id, 'check')}/trace`]), class: 'log' };
  },
  // A manual job's trace is empty with exit 0, not 404 (recorded)
  parseJobLog: (result) => ({ text: result.stdout, noOutputYet: result.stdout.trim() === '' }),

  // GitLab has none: the person sees `failure_reason` through the log tail
  annotations: () => null,
  parseAnnotations: () => [],

  rerun(repo, req): HostCall[] {
    const retryJob = (check: Check): HostCall =>
      check.source === 'bridge'
        ? // A bridge can be retried through the jobs endpoint (recorded); `ci retry` was recorded on jobs only
          write(repo, ['api', '--hostname', repo.host, '-X', 'POST', `${projectPath(repo)}/jobs/${idOf(check.id, 'check')}/retry`])
        : write(repo, ['ci', 'retry', idOf(check.id, 'check'), '-R', projectUrl(repo)]);

    if (req.scope === 'check') {
      const check = req.checks.find((c) => c.id === req.checkId);
      if (!check || !check.rerunnable) throw new HostRequestError('That check cannot be run again', 'check-not-rerunnable');
      return [retryJob(check)];
    }
    if (req.scope === 'failed') {
      // One retry per failed job rather than a pipeline retry: that one skips a failed bridge, and a
      // child's jobs are not in the parent pipeline (recorded)
      const failed = req.checks.filter((c) => c.state === 'failed' && !c.allowedToFail && c.rerunnable);
      if (failed.length === 0) throw new HostRequestError('There is no failed check to run again', 'rerun-refused');
      return failed.slice(0, MAX_RETRIES).map(retryJob);
    }
    // Everything again: a new pipeline, the merge request's when that is what ran
    if (req.headPipeline?.source === 'merge_request_event') {
      return [write(repo, ['api', '--hostname', repo.host, '-X', 'POST', `${projectPath(repo)}/merge_requests/${String(req.number)}/pipelines`])];
    }
    return [write(repo, ['ci', 'run', '-R', projectUrl(repo), '-b', req.branch])];
  },

  cancel(repo, req): HostCall[] {
    if (req.pipelineId === null) return [];
    // Cancelling the parent cancels a bridge and its child (recorded). The API, because it is the one recorded
    // to answer `running`, then `canceling`; the re-read must not wait for `canceled`
    return [write(repo, ['api', '--hostname', repo.host, '-X', 'POST', `${projectPath(repo)}/pipelines/${idOf(req.pipelineId, 'pipeline')}/cancel`])];
  },

  playManual(repo, check): HostCall | null {
    if (check.state !== 'manual' || check.source !== 'job') return null;
    return write(repo, ['ci', 'trigger', idOf(check.id, 'check'), '-R', projectUrl(repo)]);
  },

  // The whole pipeline is the requirement (`only_allow_merge_if_pipeline_succeeds`, matrix A6)
  required: () => [],
  parseRequired: () => null,
};
