import type { HostReason, MergeMethod } from '@agentry/shared';
import {
  HostParseError,
  type ChangeRequestState,
  type HostCall,
  type HostRepo,
  type HostResult,
  type MergeAdapter,
  type MergeArmed,
  type MergeRules,
  type MergeSettings,
} from '../code-host.ts';
import { parseJson, tryParseJson } from '../json.ts';

// Arguments and fields are what gh 2.92.0 and 2.102.0 were recorded to take and print for merging
// (m0-NOTES.md, docs/plans/code-hosts.md matrix E). Three things are never built, so no argument
// list below can carry them: `--admin` (bypasses a rule), `gh pr merge --auto` (merges at once when
// the pull request is already mergeable, recorded) and the raw `mergePullRequest` mutation (it
// bypasses unenforced protection for an administrator, recorded). `pr merge` always has `-R`: without
// it gh switches the person's checkout and pulls (recorded).

const pin = (repo: HostRepo): string => `${repo.host}/${repo.owner}/${repo.name}`;
const scope = (repo: HostRepo): string => `repos/${repo.owner}/${repo.name}`;

const STATES: Readonly<Record<string, ChangeRequestState>> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };
const METHOD_FLAGS: Readonly<Record<MergeMethod, string>> = { squash: '--squash', merge: '--merge', rebase: '--rebase' };
const METHOD_ENUM: Readonly<Record<MergeMethod, string>> = { squash: 'SQUASH', merge: 'MERGE', rebase: 'REBASE' };
const METHODS_OF: Readonly<Record<string, MergeMethod>> = { SQUASH: 'squash', MERGE: 'merge', REBASE: 'rebase' };

/** The order Agentry offers them in: the repository's own default is not read, the first allowed wins */
const METHOD_ORDER: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];

/** The mutation of the recording (`automerge_off_graphql`), with the head the person saw as `expectedHeadOid` */
const ARM_MUTATION =
  'mutation($id:ID!,$m:PullRequestMergeMethod!,$oid:GitObjectID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m,expectedHeadOid:$oid}){pullRequest{autoMergeRequest{mergeMethod enabledAt}}}}';

/** A full commit id, SHA-1 or SHA-256: a shorter one is not what `--match-head-commit` compares */
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const commitOf = (value: string): string => {
  if (!COMMIT.test(value)) throw new HostParseError('the head to merge is not a full commit id');
  return value;
};

/** A GraphQL node id (`PR_kw…`): it goes into `-f id=`, so it never starts with `-` or holds anything but these */
const NODE_ID = /^[A-Za-z0-9_=-]{6,200}$/;
const nodeIdOf = (value: string | null): string => {
  if (value === null || !NODE_ID.test(value) || value.startsWith('-')) throw new HostParseError('the pull request has no GraphQL node id');
  return value;
};

const numberOf = (value: number): string => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new HostParseError('a pull request number is a positive integer');
  return String(value);
};

const objectOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

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

function call(args: string[], extra: Pick<HostCall, 'kind' | 'class'> & Partial<HostCall>, repo: HostRepo): HostCall {
  return { cli: 'gh', args, host: repo.host, bucket: 'graphql', ...extra };
}

const NO_ARM: MergeArmed = { armed: false, method: null, by: null, at: null };

export const githubMerge: MergeAdapter = {
  // `allow_auto_merge` is not in `gh repo view` (recorded): it is in the repository call that names the default branch
  parseMergeSettings(stdout): MergeSettings {
    const repo = parseObject(stdout, 'repository');
    const allow: Record<MergeMethod, unknown> = { squash: repo.allow_squash_merge, merge: repo.allow_merge_commit, rebase: repo.allow_rebase_merge };
    if (METHOD_ORDER.every((m) => typeof allow[m] !== 'boolean')) throw new HostParseError('repository has no merge settings');
    return {
      methods: METHOD_ORDER.filter((m) => allow[m] === true),
      autoMergeAllowed: repo.allow_auto_merge === true,
      deleteBranchDefault: repo.delete_branch_on_merge === true,
      fastForward: false,
      requiresPipeline: false,
      mergeTrains: false,
      ciConfigPath: null,
    };
  },

  // Rulesets show on `rules/branches`; the admin-only `…/protection` is never read
  rules(repo, base): HostCall[] {
    const branch = base.split('/').map(encodeURIComponent).join('/');
    return [call(['api', '--hostname', repo.host, `${scope(repo)}/rules/branches/${branch}`], { kind: 'read', class: 'read', bucket: 'core' }, repo)];
  },
  parseRules(results): MergeRules | null {
    const [rules] = results;
    if (!rules || rules.exitCode !== 0) return null;
    const list = tryParseJson(rules.stdout);
    if (!Array.isArray(list)) return null;
    let methods: MergeMethod[] | null = null;
    const found: MergeRules = { methods: null, linearHistory: false, threadResolution: false, mergeQueue: false };
    for (const item of list) {
      const rule = objectOf(item);
      if (!rule) continue;
      if (rule.type === 'required_linear_history') found.linearHistory = true;
      if (rule.type === 'merge_queue') found.mergeQueue = true;
      if (rule.type !== 'pull_request') continue;
      const parameters = objectOf(rule.parameters);
      if (parameters?.required_review_thread_resolution === true) found.threadResolution = true;
      const allowed = parameters?.allowed_merge_methods;
      if (Array.isArray(allowed)) {
        const these = allowed.flatMap((m): MergeMethod[] => (typeof m === 'string' && METHODS_OF[m.toUpperCase()] ? [METHODS_OF[m.toUpperCase()] as MergeMethod] : []));
        // Several rules each narrow the list: only what every one allows is left
        methods = methods === null ? these : methods.filter((m) => these.includes(m));
      }
    }
    found.methods = methods;
    return found;
  },

  // Never `number` alone: 2.92 answers {"number":N} with exit 0 for a pull request that does not exist
  readForMerge: (repo, number) =>
    call(
      [
        'pr', 'view', numberOf(number), '-R', pin(repo), '--json',
        'id,number,url,state,isDraft,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest',
      ],
      { kind: 'read', class: 'read' },
      repo,
    ),
  parseMergeRead(result) {
    const view = parseObject(result.stdout, 'pr view');
    const state = typeof view.state === 'string' ? STATES[view.state.toUpperCase()] : undefined;
    if (!state) throw new HostParseError('pr view has no known state');
    // It stays set after the merge: armed means open and set
    const request = objectOf(view.autoMergeRequest);
    const method = typeof request?.mergeMethod === 'string' ? (METHODS_OF[request.mergeMethod.toUpperCase()] ?? null) : null;
    const autoMerge: MergeArmed =
      request && state === 'open' ? { armed: true, method, by: text(objectOf(request.enabledBy)?.login), at: text(request.enabledAt) } : NO_ARM;
    return {
      number: typeof view.number === 'number' ? view.number : null,
      url: text(view.url),
      state,
      nodeId: text(view.id),
      headSha: text(view.headRefOid),
      headRef: text(view.headRefName),
      baseRef: text(view.baseRefName),
      isDraft: typeof view.isDraft === 'boolean' ? view.isDraft : null,
      autoMerge,
      mergeable: text(view.mergeable),
      mergeStateStatus: text(view.mergeStateStatus),
      // `""` right after a ruleset appears: unknown, not "no review needed" (recorded)
      reviewDecision: typeof view.reviewDecision === 'string' ? view.reviewDecision : null,
      detailedMergeStatus: null,
      hasConflicts: null,
      headPipeline: null,
      mergeError: null,
    };
  },

  mergeabilityChecks: () => null,
  parseMergeabilityChecks: () => [],

  // The body travels on stdin; a rebase keeps the commits, so it has no message to set
  merge(repo, req): HostCall {
    const message = req.method !== 'rebase';
    const subject = message && req.subject ? req.subject : null;
    if (subject !== null && /[\r\n]/.test(subject)) throw new HostParseError('a commit subject is one line');
    const body = message && req.body ? req.body : null;
    return call(
      [
        'pr', 'merge', numberOf(req.number), '-R', pin(repo), METHOD_FLAGS[req.method],
        '--match-head-commit', commitOf(req.expectedHead),
        ...(subject !== null ? ['--subject', subject] : []),
        ...(body !== null ? ['--body-file', '-'] : []),
        // With `-R` only the remote branch goes; the local one stays for the item's Changes (recorded)
        ...(req.deleteBranch ? ['--delete-branch'] : []),
      ],
      { kind: 'write', class: 'long-write', ...(body !== null ? { input: body } : {}) },
      repo,
    );
  },

  arm: (repo, req) =>
    call(
      [
        'api', '--hostname', repo.host, 'graphql',
        '-f', `query=${ARM_MUTATION}`,
        '-f', `id=${nodeIdOf(req.nodeId)}`,
        '-f', `m=${METHOD_ENUM[req.method]}`,
        '-f', `oid=${commitOf(req.expectedHead)}`,
      ],
      { kind: 'write', class: 'write' },
      repo,
    ),

  // Exit 0 also when none is armed (recorded)
  disarm: (repo, number) => call(['pr', 'merge', numberOf(number), '-R', pin(repo), '--disable-auto'], { kind: 'write', class: 'write' }, repo),
  parseDisarm: (result) => result.exitCode === 0,

  mergeReason(op, result): HostReason | null {
    if (op === 'merge') {
      // gh refuses on stderr only, and only the first line is kept: "GraphQL: Head branch was modified. …"
      const line = result.stderrFirstLine;
      if (/Head branch was modified/.test(line)) return 'head-moved';
      if (/ (?:are|is) not allowed on this repository/.test(line)) return 'method-not-allowed';
      return null;
    }
    if (op !== 'arm') return null;
    const body = objectOf(tryParseJson(result.stdout));
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    const messages = errors.flatMap((e) => text(objectOf(e)?.message) ?? []);
    // The setting is checked first, so it hides a stale head and an unstable pull request (recorded)
    if (messages.some((m) => /Auto merge is not allowed for this repository/.test(m))) return 'auto-merge-not-allowed';
    if (messages.some((m) => /expected head oid does not match/.test(m))) return 'head-moved';
    if (messages.some((m) => /is in (?:clean|unstable) status/.test(m))) return 'auto-merge-not-needed';
    return null;
  },

  // Exit 0 also when it is already so (a `!` line on stderr, recorded)
  ready: (repo, number, ready) =>
    call(['pr', 'ready', numberOf(number), '-R', pin(repo), ...(ready ? [] : ['--undo'])], { kind: 'write', class: 'write' }, repo),

  // `-i` so that a 404 (the branch is gone) is told from a failed call
  branchExists: (repo, branch) =>
    call(['api', '-i', '--hostname', repo.host, `${scope(repo)}/branches/${encodeURIComponent(branch)}`], { kind: 'read', class: 'read', bucket: 'core' }, repo),
  parseBranchExists(result: HostResult): boolean | null {
    if (result.exitCode === 0) return true;
    return result.http?.status === 404 ? false : null;
  },

  // Update from the base is Agentry's own merge in the item's worktree, not `gh pr update-branch`,
  // which moves the remote head away from the worktree
  rebase: () => null,
  rebaseStatus: () => null,
  parseRebaseStatus: () => ({ inProgress: false, error: null }),
};
