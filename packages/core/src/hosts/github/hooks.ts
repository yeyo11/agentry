import type { WebhookLastResponse } from '@agentry/shared';
import { HostParseError, type HostCall, type HostRepo } from '../code-host.ts';
import { parseJson } from '../json.ts';

// The repository webhook calls of `gh api`, exactly as recorded for gh 2.92.0 and 2.102.0 (the
// `hook_*` captures, docs/plans/code-hosts.md matrix G). Every body, the secret above all, travels
// on stdin: argv shows up in the process list. Like the other adapters this only builds calls and
// reads what came back; hosts/webhooks-service.ts runs them.

/** What a registration subscribes to (G1): what a change request's state is made of, and nothing else. */
export const GITHUB_HOOK_EVENTS: readonly string[] = [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
  'check_run',
  'check_suite',
  'workflow_run',
  'issue_comment',
  'issues',
];

const hooksPath = (repo: HostRepo): string => `repos/${repo.owner}/${repo.name}/hooks`;

const api = (repo: HostRepo, args: string[], kind: HostCall['kind'], input?: string): HostCall => ({
  cli: 'gh',
  args: ['api', '--hostname', repo.host, ...args],
  ...(input === undefined ? {} : { input }),
  kind,
  class: kind === 'write' ? 'write' : 'read',
  host: repo.host,
  bucket: 'core',
});

/** The hook as GitHub keeps it: what Agentry reads of a listing and of a single hook. */
export interface GithubHook {
  /** As text: a 64-bit id must never pass through a double */
  id: string;
  url: string | null;
  events: string[];
  active: boolean;
  /** GitHub's report of the last delivery; `unused` until one was made */
  lastResponse: WebhookLastResponse | null;
}

export const githubHooks = {
  /** G1: the secret is on stdin, and comes back as `********`, so it is never read back. */
  create: (repo: HostRepo, hook: { url: string; secret: string }): HostCall =>
    api(
      repo,
      ['-X', 'POST', hooksPath(repo), '--input', '-'],
      'write',
      JSON.stringify({ name: 'web', active: true, events: GITHUB_HOOK_EVENTS, config: { url: hook.url, content_type: 'json', secret: hook.secret, insecure_ssl: '0' } }),
    ),

  /**
   * Every hook of a repository, to find the one a registration made and to tell when another
   * install's is there. A repository may have more than 30 hooks, so every page is read:
   * `--paginate --slurp` prints an array of pages (recorded).
   */
  list: (repo: HostRepo): HostCall => api(repo, ['--paginate', '--slurp', `${hooksPath(repo)}?per_page=100`], 'read'),

  /** A hook, for `last_response`: what the host says about the last delivery. */
  get: (repo: HostRepo, hookId: string): HostCall => api(repo, [`${hooksPath(repo)}/${hookId}`], 'read'),

  /** G2: empty stdout, exit 0; the delivery arrives within a second and `get` tells how it went. */
  ping: (repo: HostRepo, hookId: string): HostCall => api(repo, ['-X', 'POST', `${hooksPath(repo)}/${hookId}/pings`], 'write'),

  /** G3: empty and exit 0; the second one is a 404. */
  remove: (repo: HostRepo, hookId: string): HostCall => api(repo, ['-X', 'DELETE', `${hooksPath(repo)}/${hookId}`], 'write'),

  /** G7: only the config changes, by id; the answer carries the new URL and the masked secret. */
  repoint: (repo: HostRepo, hookId: string, hook: { url: string; secret: string }): HostCall =>
    api(repo, ['-X', 'PATCH', `${hooksPath(repo)}/${hookId}/config`, '--input', '-'], 'write', JSON.stringify({ url: hook.url, content_type: 'json', secret: hook.secret, insecure_ssl: '0' })),

  parseHook(stdout: string): GithubHook {
    return hookOf(parseValue(stdout, 'hook'));
  },

  parseHooks(stdout: string): GithubHook[] {
    const value = parseValue(stdout, 'hook list');
    if (!Array.isArray(value)) throw new HostParseError('hook list is not an array');
    // An array of pages; a flat array of hooks is read the same way
    return value.flatMap((page) => (Array.isArray(page) ? page : [page])).map(hookOf);
  },
};

function parseValue(stdout: string, what: string): unknown {
  try {
    return parseJson(stdout);
  } catch {
    throw new HostParseError(`${what} is not JSON`);
  }
}

function hookOf(value: unknown): GithubHook {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HostParseError('hook is not an object');
  const hook = value as Record<string, unknown>;
  if (typeof hook.id !== 'number' && typeof hook.id !== 'string') throw new HostParseError('hook has no id');
  const config = typeof hook.config === 'object' && hook.config !== null ? (hook.config as Record<string, unknown>) : {};
  const last = typeof hook.last_response === 'object' && hook.last_response !== null ? (hook.last_response as Record<string, unknown>) : null;
  return {
    id: String(hook.id),
    url: typeof config.url === 'string' ? config.url : null,
    events: Array.isArray(hook.events) ? hook.events.filter((e): e is string => typeof e === 'string') : [],
    active: hook.active !== false,
    lastResponse: last ? { code: typeof last.code === 'number' ? last.code : null, status: typeof last.status === 'string' ? last.status : null } : null,
  };
}

/**
 * Whether GitHub says its last delivery failed. Recorded: `unused` before any, `active` with 204
 * after a good one, and `connection_error` with 502 for an address that did not answer. Anything
 * else, and any code from 400, counts as failing, because a hook that is not delivering must not
 * look healthy.
 */
export function lastResponseFailed(last: WebhookLastResponse | null): boolean {
  if (!last) return false;
  if (last.code !== null && last.code >= 400) return true;
  return last.status !== null && last.status !== 'unused' && last.status !== 'active';
}

/** Whether a delivery was made and answered: what a ping must show to count as a successful one. */
export function lastResponseOk(last: WebhookLastResponse | null): boolean {
  return last !== null && last.status === 'active' && last.code !== null && last.code >= 200 && last.code < 300;
}
