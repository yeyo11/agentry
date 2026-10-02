import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CodeHostId, WebhookRegistration } from '@agentry/shared';
import type { AgentryEventInput } from '../events.ts';
import type { WebhookStore } from '../webhook-store.ts';
import type { WebhookSecrets } from './webhook-secrets.ts';

// What a webhook delivery is allowed to do: be believed or not, and then move the next read of the
// change requests it names to now. It never writes a change request, never reads a payload field
// into one, and never runs before its signature is verified over the raw bytes.

/** More than this many verified deliveries a minute for one registration are answered 429. */
export const DELIVERIES_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

/** Both sides are hashed first, so the comparison is constant time whatever the lengths are. */
function sameSecret(expected: string, given: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(given));
}

/**
 * GitHub's scheme, recorded on a real delivery: `X-Hub-Signature-256` is `sha256=` and the HMAC-SHA256
 * of the raw body bytes under the secret. The legacy SHA-1 header is never consulted.
 */
export function verifyGithubSignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return sameSecret(expected, header);
}

/** GitLab's legacy scheme: `X-Gitlab-Token` carries the secret itself. The signing token is not recorded yet and is not read. */
export function verifyGitlabToken(secret: string, header: string | undefined): boolean {
  return header !== undefined && sameSecret(secret, header);
}

/** What a verified delivery says about which change requests moved. Everything in it is untrusted text. */
export interface DeliveryTarget {
  event: string;
  /** The host's id for this delivery, for the replay check; null when the host sent none */
  deliveryId: string | null;
  repoPath: string | null;
  /** Pull or merge request numbers the payload names */
  numbers: number[];
  /** Branches whose head moved or whose checks ran, for events that name no number */
  branches: string[];
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const header = (headers: Record<string, string | string[] | undefined>, name: string): string | null => {
  const value = headers[name];
  return str(Array.isArray(value) ? value[0] : value);
};

const unique = <T>(values: Array<T | null>): T[] => [...new Set(values.filter((v): v is T => v !== null))];
const branchOf = (ref: unknown): string | null => str(ref)?.replace(/^refs\/heads\//, '') ?? null;

/** G6 on GitHub: the repository, then the pull request number or the branch, by event. */
export function githubTarget(headers: Record<string, string | string[] | undefined>, body: unknown): DeliveryTarget {
  const payload = obj(body) ?? {};
  const event = header(headers, 'x-github-event') ?? '';
  const numbers: Array<number | null> = [num(obj(payload.pull_request)?.number)];
  const branches: Array<string | null> = [];
  // check_run, check_suite and workflow_run carry the pull requests they ran for, which is empty
  // when the run is for a branch that has none yet (recorded): the branch covers that
  for (const key of ['check_run', 'check_suite', 'workflow_run'] as const) {
    const part = obj(payload[key]);
    if (!part) continue;
    for (const pr of list(part.pull_requests)) numbers.push(num(obj(pr)?.number));
    branches.push(str(part.head_branch), str(obj(part.check_suite)?.head_branch));
    for (const pr of list(obj(part.check_suite)?.pull_requests)) numbers.push(num(obj(pr)?.number));
  }
  const issue = obj(payload.issue);
  // An issue's comment is a pull request's too, but a plain issue is no change request
  if (issue && obj(issue.pull_request)) numbers.push(num(issue.number));
  if (event === 'push') branches.push(branchOf(payload.ref));
  return {
    event,
    deliveryId: header(headers, 'x-github-delivery'),
    repoPath: str(obj(payload.repository)?.full_name),
    numbers: unique(numbers),
    branches: unique(branches),
  };
}

/** G6 on GitLab: `project.path_with_namespace`, then the merge request's `iid`, or the pipeline's branch. */
export function gitlabTarget(headers: Record<string, string | string[] | undefined>, body: unknown): DeliveryTarget {
  const payload = obj(body) ?? {};
  const event = header(headers, 'x-gitlab-event') ?? '';
  const attributes = obj(payload.object_attributes);
  const kind = str(payload.object_kind);
  const numbers: Array<number | null> = [num(obj(payload.merge_request)?.iid)];
  const branches: Array<string | null> = [];
  if (kind === 'merge_request') numbers.push(num(attributes?.iid));
  if (kind === 'pipeline') branches.push(str(attributes?.ref));
  if (kind === 'push') branches.push(branchOf(payload.ref));
  return {
    event,
    deliveryId: header(headers, 'idempotency-key') ?? header(headers, 'webhook-id'),
    repoPath: str(obj(payload.project)?.path_with_namespace),
    numbers: unique(numbers),
    branches: unique(branches),
  };
}

interface OpenRow {
  id: string;
  branch: string;
  number: number;
  url: string | null;
}

/**
 * The open change requests of a repository that a delivery names, from both tables. A row has no
 * repository column, so it is placed by the address of its own pull request: the host's name and
 * the path before `/pull/` or `/-/merge_requests/`.
 */
export function changeRequestsOf(sql: DatabaseSync, registration: Pick<WebhookRegistration, 'host' | 'hostname' | 'repoPath'>, target: Pick<DeliveryTarget, 'numbers' | 'branches'>): string[] {
  if (target.numbers.length === 0 && target.branches.length === 0) return [];
  const rows: OpenRow[] = [];
  for (const table of ['work_item_pull_requests', 'orchestration_pull_requests']) {
    rows.push(...(sql.prepare(`SELECT id, branch, number, url FROM ${table} WHERE host = ? AND closed_at IS NULL AND number IS NOT NULL`).all(registration.host) as unknown as OpenRow[]));
  }
  const marker = registration.host === 'gitlab' ? '/-/merge_requests/' : '/pull/';
  return rows
    .filter((row) => {
      if (!row.url) return false;
      let url: URL;
      try {
        url = new URL(row.url);
      } catch {
        return false;
      }
      if (url.hostname.toLowerCase() !== registration.hostname.toLowerCase()) return false;
      if (url.pathname.toLowerCase() !== `/${registration.repoPath}${marker}${row.number}`.toLowerCase()) return false;
      return target.numbers.includes(row.number) || target.branches.includes(row.branch);
    })
    .map((row) => row.id);
}

export type DeliveryOutcome = 'accepted' | 'duplicate' | 'unauthorized' | 'rate-limited';

export interface WebhookReceiverDeps {
  store: WebhookStore;
  secrets: WebhookSecrets;
  sql: DatabaseSync;
  /** Moves each row's next read to now; nothing else */
  nudge: (ids: readonly string[]) => void;
  emit: (event: AgentryEventInput) => void;
  now?: () => number;
}

/**
 * What the receiver routes call. The raw body arrives as bytes and is parsed only after the
 * signature held; nothing in a payload reaches the store except the delivery id, and nothing
 * reaches a change request at all.
 */
export class WebhookReceiver {
  private readonly now: () => number;
  /** Verified deliveries in the last minute, per registration */
  private readonly seen = new Map<string, number[]>();

  constructor(private readonly deps: WebhookReceiverDeps) {
    this.now = deps.now ?? Date.now;
  }

  handle(host: CodeHostId, registrationId: string, headers: Record<string, string | string[] | undefined>, raw: Buffer): DeliveryOutcome {
    const registration = this.deps.store.get(registrationId);
    // Unknown, removed, or a hook of the other host: the same answer, so a probe learns nothing
    if (!registration || registration.state === 'removed' || registration.host !== host) return 'unauthorized';
    const secret = this.deps.secrets.get(registrationId);
    if (!secret) return 'unauthorized';
    const genuine =
      host === 'github'
        ? verifyGithubSignature(secret, raw, header(headers, 'x-hub-signature-256') ?? undefined)
        : verifyGitlabToken(secret, header(headers, 'x-gitlab-token') ?? undefined);
    if (!genuine) return 'unauthorized';
    // Counted once it is genuine, so a stranger who knows the address cannot spend the host's budget
    if (!this.admit(registrationId)) return 'rate-limited';

    let payload: unknown = null;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      // Signed but not JSON: nothing to read, and the host's retry would not change that
    }
    const target = host === 'github' ? githubTarget(headers, payload) : gitlabTarget(headers, payload);
    if (target.deliveryId !== null && !this.deps.store.recordDelivery(target.deliveryId, registrationId, target.event)) return 'duplicate';

    const at = new Date(this.now()).toISOString();
    const ping = target.event === 'ping';
    // A delivery reaching this address is proof the hook works, which clears a failure the host reported
    const state = registration.state === 'failing' ? 'active' : registration.state;
    const updated = this.deps.store.update(registrationId, { lastDeliveryAt: at, ...(ping ? { lastPingAt: at } : {}), state }, at);
    if (updated && (ping || state !== registration.state)) this.deps.emit({ type: 'webhook.changed', title: 'Webhook changed', projectId: updated.projectId, registration: updated });

    if (target.repoPath !== null && target.repoPath.toLowerCase() === registration.repoPath.toLowerCase()) {
      this.deps.nudge(changeRequestsOf(this.deps.sql, registration, target));
    }
    return 'accepted';
  }

  private admit(registrationId: string): boolean {
    const now = this.now();
    const recent = (this.seen.get(registrationId) ?? []).filter((at) => now - at < WINDOW_MS);
    if (recent.length >= DELIVERIES_PER_MINUTE) {
      this.seen.set(registrationId, recent);
      return false;
    }
    recent.push(now);
    this.seen.set(registrationId, recent);
    return true;
  }
}
