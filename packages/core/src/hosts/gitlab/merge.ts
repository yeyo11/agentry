import type { HostReason, MergeMethod } from '@agentry/shared';
import {
  HostParseError,
  type ChangeRequestState,
  type HeadPipeline,
  type HostCall,
  type HostRepo,
  type HostResult,
  type MergeAdapter,
  type MergeArmed,
  type MergeRules,
  type MergeSettings,
} from '../code-host.ts';
import { parseJson, tryParseJson } from '../json.ts';
import { firstLine } from '../redact.ts';
import { projectPath, projectUrl } from './checks.ts';

// Arguments and fields are what glab 1.120.0 was recorded to take and print for merging
// (m0-NOTES.md, docs/plans/code-hosts.md matrix E). `--auto-merge=false` is always on Merge now, so
// glab's default (arm when a pipeline runs) can never turn a merge into an arming or the other way
// round (recorded: it merges at once, and is refused with 405 when the project requires a pipeline).
// `glab mr merge` refuses in a boxed stderr, not in `glab api`'s `glab: … (HTTP n)` line, and a 405
// never says why: every blocker comes from the re-read, not from the refusal. Only a 409 (the head
// moved) is read from the box.

const STATES: Readonly<Record<string, ChangeRequestState>> = { opened: 'open', locked: 'open', merged: 'merged', closed: 'closed' };

/** A full commit id: a short one gives 409, which would read as `head-moved` (recorded) */
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const commitOf = (value: string): string => {
  if (!COMMIT.test(value)) throw new HostParseError('the head to merge is not a full commit id');
  return value;
};

const numberOf = (value: number): string => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new HostParseError('a merge request number is a positive integer');
  return String(value);
};

/** A project path as GitLab writes it; it goes into a quoted GraphQL string, so nothing else is let through */
const PROJECT_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

const objectOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
/** GitLab's `merge_error` is free text from the host and ends up in an error message: redacted, one line */
const redactedLine = (value: unknown): string | null => {
  const raw = text(value);
  return raw === null ? null : firstLine(raw) || null;
};

function parseObject(stdout: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseJson(stdout);
  } catch {
    throw new HostParseError(`${what} is not JSON`);
  }
  const object = objectOf(value);
  if (!object) throw new HostParseError(`${what} is not an object`);
  return object;
}

const read = (repo: HostRepo, args: string[]): HostCall => ({ cli: 'glab', args, kind: 'read', class: 'read', host: repo.host });
const write = (repo: HostRepo, args: string[], cls: 'write' | 'long-write' = 'write'): HostCall => ({ cli: 'glab', args, kind: 'write', class: cls, host: repo.host });

/** The squash and merge-commit messages are one text: the subject, a blank line, the body */
const messageOf = (subject: string | undefined, body: string | undefined): string | null => {
  const text = [subject, body].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join('\n\n');
  return text === '' ? null : text;
};

/** What glab 1.120.0 prints, unwrapped, when it refuses a merge on its own (recorded, m0 §2, §5, §8) */
const CLIENT_REFUSALS: ReadonlyArray<[RegExp, string]> = [
  [/^This merge request requires a passing pipeline before merging\.?$/, 'a passing pipeline is required before merging'],
  [/^Merge conflicts exist;/, 'the merge request has conflicts'],
  // glab hands out a command here: Agentry words its own
  [/^This merge request is still a draft;/, 'the merge request is a draft'],
];

export interface BoxedRefusal {
  /** The HTTP status of the request that failed; null for a refusal glab made before sending one */
  status: number | null;
  /** The parsed reason, never the box's `ERROR` heading, and never a line that hands out a command */
  detail: string;
}

/**
 * `glab mr merge` refuses in a box whose first line is always `ERROR`, wrapped at ~118 columns, so it
 * is unwrapped before it is read: `All attempts fail: #1: PUT <url>: 409 {message: …}.` for a refusal
 * from GitLab, one plain sentence for a refusal glab made itself. Null when the text is neither.
 */
export function boxedRefusal(result: Pick<HostResult, 'stderrFirstLine' | 'stderrText'>): BoxedRefusal | null {
  const unwrapped = (result.stderrText ?? result.stderrFirstLine)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== 'ERROR')
    .join(' ')
    .replace(/\s+/g, ' ');
  if (unwrapped === '') return null;
  const http = /\b(\d{3}) \{message: (.*?)\}\.?(?: |$)/.exec(unwrapped);
  if (http) {
    // GitLab's 405 repeats its own status in the message
    const message = http[2] ?? '';
    return { status: Number(http[1]), detail: firstLine(message.startsWith(`${http[1] ?? ''} `) ? message : `${http[1] ?? ''} ${message}`) };
  }
  for (const [pattern, detail] of CLIENT_REFUSALS) if (pattern.test(unwrapped)) return { status: null, detail };
  return null;
}

const NO_ARM: MergeArmed = { armed: false, method: null, by: null, at: null };

export const gitlabMerge: MergeAdapter = {
  // The settings come with `repo view`, the call that names the default branch (A6)
  parseMergeSettings(stdout): MergeSettings {
    const project = parseObject(stdout, 'repo view');
    const strategy = project.merge_method;
    if (strategy !== 'merge' && strategy !== 'rebase_merge' && strategy !== 'ff') throw new HostParseError('repo view has no known merge_method');
    // The project's strategy picks the merge; squash is the merge request's own choice, bounded by the option
    const own: MergeMethod = strategy === 'ff' ? 'rebase' : 'merge';
    const squash = project.squash_option;
    const methods: MergeMethod[] =
      squash === 'always' ? ['squash'] : squash === 'never' ? [own] : squash === 'default_on' ? ['squash', own] : [own, 'squash'];
    return {
      methods,
      autoMergeAllowed: true,
      deleteBranchDefault: project.remove_source_branch_after_merge === true,
      fastForward: strategy === 'ff',
      requiresPipeline: project.only_allow_merge_if_pipeline_succeeds === true,
      mergeTrains: project.merge_trains_enabled === true,
      ciConfigPath: text(project.ci_config_path),
    };
  },

  // GitLab has no rulesets of this kind: its rules are in the settings and in `detailed_merge_status`
  rules: () => [],
  parseRules: (): MergeRules => ({ methods: null, linearHistory: false, threadResolution: false, mergeQueue: false }),

  // The REST object, as `mr view -F json` prints it, with `with_merge_status_recheck`: a request that
  // GitLab honoured right after a push (recorded, m0 §1) and never harms
  readForMerge: (repo, number) =>
    read(repo, ['api', '--hostname', repo.host, `${projectPath(repo)}/merge_requests/${numberOf(number)}?with_merge_status_recheck=true`]),
  parseMergeRead(result) {
    const mr = parseObject(result.stdout, 'mr view');
    const state = typeof mr.state === 'string' ? STATES[mr.state] : undefined;
    if (state === undefined) throw new HostParseError(`mr view has an unknown state: ${String(mr.state)}`);
    const iid = mr.iid;
    const raw = objectOf(mr.head_pipeline);
    const pipelineId = typeof raw?.id === 'number' ? raw.id : null;
    const headPipeline: HeadPipeline | null =
      raw && pipelineId !== null ? { id: pipelineId, status: text(raw.status) ?? '', sha: text(raw.sha), source: text(raw.source) } : null;
    // `merge_user` is who armed it; the time is not printed
    const autoMerge: MergeArmed =
      mr.merge_when_pipeline_succeeds === true && state === 'open'
        ? { armed: true, method: mr.squash === true ? 'squash' : null, by: text(objectOf(mr.merge_user)?.username), at: null }
        : NO_ARM;
    return {
      number: typeof iid === 'number' ? iid : null,
      url: text(mr.web_url),
      state,
      nodeId: null,
      headSha: text(mr.sha),
      headRef: text(mr.source_branch),
      baseRef: text(mr.target_branch),
      isDraft: typeof mr.draft === 'boolean' ? mr.draft : null,
      autoMerge,
      mergeable: null,
      mergeStateStatus: null,
      reviewDecision: null,
      detailedMergeStatus: text(mr.detailed_merge_status),
      // `false` is not "no conflict" while the status is `unchecked` (recorded)
      hasConflicts: typeof mr.has_conflicts === 'boolean' ? mr.has_conflicts : null,
      headPipeline,
      mergeError: redactedLine(mr.merge_error),
    };
  },

  // REST stays `unchecked` for minutes while GraphQL has every check, and `with_merge_status_recheck`
  // did not change that (recorded), so the checks are read here
  mergeabilityChecks(repo, number) {
    if (!PROJECT_PATH.test(repo.path) || repo.path.split('/').some((part) => part === '.' || part === '..')) throw new HostParseError('the project path is not one GitLab writes');
    const query = `query{project(fullPath:"${repo.path}"){mergeRequest(iid:"${numberOf(number)}"){detailedMergeStatus mergeStatusEnum mergeable mergeabilityChecks{identifier status}}}}`;
    return read(repo, ['api', '--hostname', repo.host, 'graphql', '-f', `query=${query}`]);
  },
  parseMergeabilityChecks(result) {
    const body = parseObject(result.stdout, 'mergeability checks');
    const request = objectOf(objectOf(objectOf(body.data)?.project)?.mergeRequest);
    const checks = request?.mergeabilityChecks;
    if (!Array.isArray(checks)) throw new HostParseError('the merge request has no mergeability checks');
    return checks.flatMap((item) => {
      const check = objectOf(item);
      const identifier = text(check?.identifier);
      const status = text(check?.status);
      return identifier && status ? [{ identifier, status }] : [];
    });
  },

  // The strategy (merge commit or fast-forward) is the project's: only squash is asked for. A rebase
  // keeps the commits, so it carries no message.
  merge(repo, req): HostCall {
    const message = req.method === 'rebase' ? null : messageOf(req.subject, req.body);
    return write(
      repo,
      [
        'mr', 'merge', numberOf(req.number), '-R', projectUrl(repo), '-y',
        '--sha', commitOf(req.expectedHead), '--auto-merge=false',
        ...(req.method === 'squash' ? ['--squash', ...(message !== null ? ['--squash-message', message] : [])] : []),
        ...(req.method === 'merge' && message !== null ? ['-m', message] : []),
        // The project's `remove_source_branch_after_merge` may delete it anyway (recorded)
        ...(req.deleteBranch ? ['-d'] : []),
      ],
      'long-write',
    );
  },

  // Only when the head's pipeline exists and is not finished: the service holds that guard
  arm: (repo, req) =>
    write(repo, ['mr', 'merge', numberOf(req.number), '-R', projectUrl(repo), '-y', '--auto-merge', '--sha', commitOf(req.expectedHead), ...(req.method === 'squash' ? ['--squash'] : [])]),

  disarm: (repo, number) =>
    write(repo, ['api', '--hostname', repo.host, '-X', 'POST', `${projectPath(repo)}/merge_requests/${numberOf(number)}/cancel_merge_when_pipeline_succeeds`]),
  // A failure comes back with exit 0 and `{"status":"error"}` (recorded): only a re-read settles it, but this says no first
  parseDisarm(result) {
    if (result.exitCode !== 0) return false;
    const body = objectOf(tryParseJson(result.stdout));
    return body?.status !== 'error';
  },

  mergeReason(op, result): HostReason | null {
    if (op !== 'merge') return null;
    const refusal = boxedRefusal(result);
    if (refusal?.status === 409) return 'head-moved';
    // The client-side boxes and the 405 say what blocks, not why it is wrong: the re-read names the blocker
    return refusal ? 'merge-failed' : null;
  },
  mergeDetail: (op, result) => (op === 'merge' ? (boxedRefusal(result)?.detail ?? null) : null),

  ready: (repo, number, ready) => write(repo, ['mr', 'update', numberOf(number), '-R', projectUrl(repo), ready ? '--ready' : '--draft']),

  // `-i` so that a 404 (the branch is gone) is told from a failed call
  branchExists: (repo, branch) => read(repo, ['api', '-i', '--hostname', repo.host, `${projectPath(repo)}/repository/branches/${encodeURIComponent(branch)}`]),
  parseBranchExists(result: HostResult): boolean | null {
    if (result.exitCode === 0) return true;
    return result.http?.status === 404 ? false : null;
  },

  // glab waits for the rebase to finish; the worktree then fetches and `reset --keep`s (the service's)
  rebase: (repo, number) => write(repo, ['mr', 'rebase', numberOf(number), '-R', projectUrl(repo)], 'long-write'),
  rebaseStatus: (repo, number) =>
    read(repo, ['api', '--hostname', repo.host, `${projectPath(repo)}/merge_requests/${numberOf(number)}?include_rebase_in_progress=true`]),
  parseRebaseStatus(result) {
    const mr = parseObject(result.stdout, 'mr');
    // Absent without the parameter (recorded): a body without it is not a rebase status
    if (typeof mr.rebase_in_progress !== 'boolean') throw new HostParseError('mr has no rebase_in_progress');
    return { inProgress: mr.rebase_in_progress, error: redactedLine(mr.merge_error) };
  },
};
