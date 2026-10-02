import { createHmac } from 'node:crypto';
import type { WebhookLastResponse } from '@agentry/shared';
import { HostParseError, type HostCall, type HostRepo } from '../code-host.ts';
import type { HookDriver, RemoteHook } from '../hook-driver.ts';
import { parseJson } from '../json.ts';
import { projectPath } from './checks.ts';

// The project webhook calls of `glab api`, exactly as recorded for glab 1.120.0 (the `w0_hook_*`
// captures, docs/plans/code-hosts.md matrix G). Bodies, the token above all, travel on stdin. `-i`
// is on every call: a failed `glab api` prints no status of its own on stdout, and the reason a
// call failed is read from the status line (recorded).

/** What a registration subscribes to (G1): what a merge request's state is made of, and nothing else. */
export const GITLAB_HOOK_EVENTS: readonly string[] = ['merge_requests_events', 'pipeline_events', 'note_events', 'issues_events'];

const hooksPath = (repo: HostRepo): string => `${projectPath(repo)}/hooks`;

const api = (repo: HostRepo, args: string[], kind: HostCall['kind'], input?: string): HostCall => ({
  cli: 'glab',
  args: ['api', '-i', '--hostname', repo.host, ...args],
  ...(input === undefined ? {} : { input }),
  kind,
  class: kind === 'write' ? 'write' : 'read',
  host: repo.host,
});

/**
 * The signing token GitLab wants in `whsec_<base64 of 32 bytes>` (recorded: any other shape is a 422).
 * Derived from the registration's secret, so no second secret is stored and the receiver can derive
 * the same key without asking anyone.
 */
export function signingTokenOf(secret: string): string {
  return `whsec_${createHmac('sha256', secret).update('agentry gitlab signing token').digest('base64')}`;
}

const body = (hook: { url: string; secret: string }): Record<string, unknown> => ({
  url: hook.url,
  token: hook.secret,
  signing_token: signingTokenOf(hook.secret),
  enable_ssl_verification: true,
});

export const gitlabHooks: HookDriver = {
  cli: 'glab',
  events: GITLAB_HOOK_EVENTS,

  /** G1: the token comes back only as `token_present`, so it is never read back. */
  create: (repo, hook) =>
    api(
      repo,
      ['-X', 'POST', hooksPath(repo), '-H', 'Content-Type: application/json', '--input', '-'],
      'write',
      JSON.stringify({ ...body(hook), name: 'agentry', merge_requests_events: true, pipeline_events: true, note_events: true, issues_events: true, push_events: false, job_events: false }),
    ),

  // A project holds at most 100 hooks, so one page is all of them
  list: (repo) => api(repo, [`${hooksPath(repo)}?per_page=100`], 'read'),

  read: (repo, hookId) => [api(repo, [`${hooksPath(repo)}/${idOf(hookId)}`], 'read'), api(repo, [`${hooksPath(repo)}/${idOf(hookId)}/events?per_page=1`], 'read')],

  /** `push_events` is the one test that always delivers: the others answer 422 for a project with no merge request, issue, note or pipeline (recorded). */
  test: (repo, hookId) => api(repo, ['-X', 'POST', `${hooksPath(repo)}/${idOf(hookId)}/test/push_events`], 'write'),

  /** G3: empty and exit 0; the second one is a 404. */
  remove: (repo, hookId) => api(repo, ['-X', 'DELETE', `${hooksPath(repo)}/${idOf(hookId)}`], 'write'),

  /** G7: the URL, the token and the signing token change in place; every other field stays. */
  repoint: (repo, hookId, hook) => api(repo, ['-X', 'PUT', `${hooksPath(repo)}/${idOf(hookId)}`, '-H', 'Content-Type: application/json', '--input', '-'], 'write', JSON.stringify(body(hook))),

  parseHook(stdouts: string[]): RemoteHook {
    const [hook, events] = stdouts;
    if (hook === undefined) throw new HostParseError('hook is missing');
    const parsed = hookOf(parseValue(hook, 'hook'));
    // The newest delivery says how the hook stands; an events listing that cannot be read leaves it unsaid
    const last = events === undefined ? null : lastDelivery(events);
    return { ...parsed, lastResponse: last?.response ?? null, deliveryKey: last?.id ?? null };
  },

  parseHooks(stdout: string): RemoteHook[] {
    const value = parseValue(stdout, 'hook list');
    if (!Array.isArray(value)) throw new HostParseError('hook list is not an array');
    return value.map(hookOf);
  },
};

function idOf(value: string): string {
  if (!/^\d+$/.test(value)) throw new HostParseError('a hook id is digits only');
  return value;
}

function parseValue(stdout: string, what: string): unknown {
  try {
    return parseJson(stdout);
  } catch {
    throw new HostParseError(`${what} is not JSON`);
  }
}

function hookOf(value: unknown): RemoteHook {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HostParseError('hook is not an object');
  const hook = value as Record<string, unknown>;
  if (typeof hook.id !== 'number' && typeof hook.id !== 'string') throw new HostParseError('hook has no id');
  // `executable` is a hook that delivers; `temporarily_disabled` and `disabled` are GitLab's own back-off after failures
  const alert = typeof hook.alert_status === 'string' ? hook.alert_status : 'executable';
  return { id: String(hook.id), url: typeof hook.url === 'string' ? hook.url : null, lastResponse: null, disabled: alert !== 'executable', deliveryKey: null };
}

/**
 * What the newest delivery of an events listing was answered with, in the shape GitHub's `last_response`
 * has: `active` for a 2xx, `failed` otherwise. Null for no delivery yet or text that is not a listing.
 */
function lastDelivery(stdout: string): { id: string | null; response: WebhookLastResponse } | null {
  let value: unknown;
  try {
    value = parseJson(stdout);
  } catch {
    return null;
  }
  const first: unknown = Array.isArray(value) ? value[0] : null;
  if (typeof first !== 'object' || first === null) return null;
  const status = (first as Record<string, unknown>).response_status;
  const code = typeof status === 'number' ? status : typeof status === 'string' && /^\d+$/.test(status) ? Number(status) : null;
  // A delivery that got no HTTP answer carries a word instead of a code ("internal error"): it failed
  const id = (first as Record<string, unknown>).id;
  const key = typeof id === 'number' || typeof id === 'string' ? String(id) : null;
  if (code === null) return typeof status === 'string' && status !== '' ? { id: key, response: { code: null, status: 'failed' } } : null;
  return { id: key, response: { code, status: code >= 200 && code < 300 ? 'active' : 'failed' } };
}
