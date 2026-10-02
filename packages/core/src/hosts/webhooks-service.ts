import { randomUUID } from 'node:crypto';
import type { AgentryEvent, CodeHostId, HostReason, ProjectWebhooks, WebhookRegistration, WebhookUnavailableReason } from '@agentry/shared';
import type { AgentryEventInput } from '../events.ts';
import type { WebhookStore } from '../webhook-store.ts';
import { reasonOf } from './classify.ts';
import { HostParseError, type HostCall, type HostRepo } from './code-host.ts';
import type { HostResult } from './exec.ts';
import { GITHUB_HOOK_EVENTS, githubHooks, lastResponseFailed, lastResponseOk, type GithubHook } from './github/hooks.ts';
import { webhookHealthy } from './pacer.ts';
import { WebhookSecrets } from '../webhook-secrets.ts';

// Registering, testing, removing and re-pointing the hooks Agentry keeps on a repository
// (docs/plans/code-hosts.md, phase 6). It is the person's click that registers (the route is not
// open to a chat's token); after that, a new public URL from the tunnel re-points the hooks Agentry
// registered, by id and never anyone else's (decision 2). Only GitHub is recorded: a GitLab project
// is told so, with no action, and no GitLab call is built here. A hook only tells Agentry to look
// again (hosts/pacer.ts); polling stays the source of truth.

/** The receivers' path under the public origin (`apps/api` serves everything under `/api`). */
export const WEBHOOK_PATH = '/api/webhooks';

/** The address a hook delivers to: the public origin, the host's receiver and the registration's id. */
export function receiverUrl(origin: string, host: CodeHostId, registrationId: string): string {
  return `${origin.replace(/\/+$/, '')}${WEBHOOK_PATH}/${host}/${registrationId}`;
}

/** Whether a URL is one of Agentry's own receivers, on any origin: what makes a hook adoptable. */
function isReceiverUrl(url: string | null, host: CodeHostId): boolean {
  if (!url) return false;
  try {
    return new RegExp(`^${WEBHOOK_PATH}/${host}/[0-9a-f-]{36}$`).test(new URL(url).pathname);
  } catch {
    return false;
  }
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** Why the service did not do what was asked: a status the route answers with, and a code a client words. */
export class WebhooksError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 502,
    readonly code: HostReason | WebhookUnavailableReason | 'already-registered' | 'hook-no-permission' | 'hook-unreachable' | 'registration-not-found',
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'WebhooksError';
  }
}

/** What a project's remote is, from readiness and without running anything. Null: no remote on a code host. */
export interface WebhookTarget {
  host: CodeHostId;
  hostname: string;
  repoPath: string;
}

/** The project's host CLI, bound to its binary and checkout: the same door the trackers go through. */
export interface WebhookAccess {
  host: CodeHostId;
  hostname: string;
  repo: HostRepo;
  run: (call: HostCall) => Promise<HostResult>;
}

export interface WebhooksServiceDeps {
  store: WebhookStore;
  secrets: Pick<WebhookSecrets, 'get' | 'set' | 'delete'>;
  target: (projectId: string) => Promise<WebhookTarget | null>;
  access: (projectId: string) => Promise<WebhookAccess>;
  /** The origin the tunnel answers on right now; null without one */
  publicUrl: () => string | null;
  emit?: (event: AgentryEventInput) => void;
  now?: () => number;
  /** Waits between the reads that follow a ping; replaced in tests */
  sleep?: (ms: number) => Promise<void>;
}

/** A ping is answered within a second (recorded); the hook is read this often, this many times. */
const PING_READS = 3;
const PING_WAIT_MS = 1000;
/** A hook that has been silent is read again at most this often, however often the page is opened */
const SILENT_READ_MS = 5 * 60_000;

export class WebhooksService {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** When each registration's hook was last read because it had gone silent */
  private readonly readAt = new Map<string, number>();
  /** Re-pointing runs one batch at a time, so two tunnel events cannot patch one hook against each other */
  private repointing: Promise<void> | null = null;
  private repointPending: string | null = null;

  constructor(private readonly deps: WebhooksServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // ---------- what the receiver and the pacer ask ----------

  /** The secret a delivery for this registration is verified with; null when there is no such registration. */
  secretOf(registrationId: string): string | null {
    const registration = this.deps.store.get(registrationId);
    return registration && registration.state !== 'removed' ? this.deps.secrets.get(registrationId) : null;
  }

  /**
   * Whether a healthy hook covers the repository a change request's URL names: the pacer reads such a
   * row every 15 minutes instead of every two, because a delivery will say when it changes.
   */
  covers(changeRequestUrl: string | null | undefined): boolean {
    if (!changeRequestUrl) return false;
    let url: URL;
    try {
      url = new URL(changeRequestUrl);
    } catch {
      return false;
    }
    const path = url.pathname.toLowerCase();
    const now = this.now();
    return this.deps.store
      .listLive()
      .some((r) => r.hostname.toLowerCase() === url.hostname.toLowerCase() && path.startsWith(`/${r.repoPath.toLowerCase()}/`) && webhookHealthy(r, now));
  }

  // ---------- the project's webhooks ----------

  /** `GET /projects/:id/webhooks`. A hook that has gone quiet is read on the way, so a failure is said. */
  async overview(projectId: string): Promise<ProjectWebhooks> {
    const target = await this.deps.target(projectId);
    const publicUrl = this.deps.publicUrl();
    const reason = unavailable(target, publicUrl);
    if (target?.host === 'github') await this.readSilent(projectId);
    return {
      available: reason === null,
      reason,
      publicUrl,
      events: target?.host === 'github' ? [...GITHUB_HOOK_EVENTS] : [],
      // Redelivery needs the `admin:repo_hook` scope, which the token may not have (recorded): not offered
      canRedeliver: false,
      registrations: this.deps.store.list(projectId),
    };
  }

  /** Registers a hook on the project's repository, or adopts the one that already carries an Agentry address. */
  async register(projectId: string): Promise<WebhookRegistration> {
    const target = await this.githubTarget(projectId);
    const origin = this.publicOrigin();
    const access = await this.deps.access(projectId);
    const { store, secrets } = this.deps;
    const mine = store.list(projectId).filter((r) => r.hostname === access.repo.host && r.repoPath === access.repo.path);
    if (mine.some((r) => r.state !== 'removed')) throw new WebhooksError('this repository already has a webhook registered by Agentry', 409, 'already-registered');
    // A removed registration is only kept to be seen; registering again replaces it
    for (const old of mine) store.delete(old.id);

    const id = randomUUID();
    const secret = WebhookSecrets.generate();
    const url = receiverUrl(origin, 'github', id);
    // The secret is kept before the host knows it, so a delivery that races the answer is already verifiable
    await secrets.set(id, secret);
    let hookId: string;
    try {
      hookId = await this.createOrAdopt(access, { url, secret });
    } catch (error) {
      await secrets.delete(id);
      throw error;
    }
    const created = store.create({ id, projectId, host: target.host, hostname: access.repo.host, repoPath: access.repo.path, remoteHookId: hookId, url, events: [...GITHUB_HOOK_EVENTS] });
    this.changed(created);
    return created;
  }

  /** Pings the hook, then reads what GitHub says about the delivery: a good one makes the hook healthy. */
  async test(projectId: string, registrationId: string): Promise<WebhookRegistration> {
    const registration = this.owned(projectId, registrationId);
    const access = await this.deps.access(projectId);
    const hookId = this.remoteId(registration);
    const before = this.parse(await this.run(access, githubHooks.get(access.repo, hookId), 'read the hook'), (s) => githubHooks.parseHook(s));
    await this.run(access, githubHooks.ping(access.repo, hookId), 'ping the hook');

    let hook = before;
    for (let read = 0; read < PING_READS; read++) {
      await this.sleep(PING_WAIT_MS);
      hook = this.parse(await this.run(access, githubHooks.get(access.repo, hookId), 'read the hook'), (s) => githubHooks.parseHook(s));
      if (JSON.stringify(hook.lastResponse) !== JSON.stringify(before.lastResponse) || lastResponseOk(hook.lastResponse) || lastResponseFailed(hook.lastResponse)) break;
    }
    if (lastResponseOk(hook.lastResponse)) {
      return this.apply(registration, { state: 'active', lastPingAt: new Date(this.now()).toISOString(), lastResponse: hook.lastResponse });
    }
    this.apply(registration, { state: lastResponseFailed(hook.lastResponse) ? 'failing' : registration.state, lastResponse: hook.lastResponse });
    throw new WebhooksError('the host did not report a delivery that was answered', 502, 'hook-unreachable', describe(hook));
  }

  /** Removes the hook on the host and the secret here. A hook already gone on the host counts as removed. */
  async remove(projectId: string, registrationId: string): Promise<WebhookRegistration> {
    const registration = this.owned(projectId, registrationId);
    const hookId = registration.remoteHookId;
    if (hookId) {
      const access = await this.deps.access(projectId);
      const call = githubHooks.remove(access.repo, hookId);
      const result = await access.run(call);
      // The host says 404 for a hook that is gone, and with it a hint about a scope that is not the cause (recorded)
      if (result.exitCode !== 0 && reasonOf(result, 'gh') !== 'not-found') throw failure('remove the hook', result, call);
    }
    await this.deps.secrets.delete(registration.id);
    this.readAt.delete(registration.id);
    return this.apply(registration, { state: 'removed' });
  }

  /** Reads one registration's hook and says what the host reports: failing, active, or gone. */
  async check(projectId: string, registrationId: string): Promise<WebhookRegistration> {
    const registration = this.owned(projectId, registrationId);
    const access = await this.deps.access(projectId);
    const call = githubHooks.get(access.repo, this.remoteId(registration));
    const result = await access.run(call);
    if (result.exitCode !== 0) {
      // The person deleted it on the host: Agentry cannot re-point what is not there, and says so
      if (reasonOf(result, 'gh') === 'not-found') return this.apply(registration, { state: 'stale' });
      throw failure('read the hook', result, call);
    }
    const hook = this.parse(result, (s) => githubHooks.parseHook(s));
    const state = lastResponseFailed(hook.lastResponse) ? 'failing' : 'active';
    return this.apply(registration, { state, lastResponse: hook.lastResponse });
  }

  // ---------- the tunnel's new address ----------

  /** Hangs off the bus: a tunnel that came up on an address re-points the hooks that are not on it. */
  observe(event: AgentryEvent): void {
    if (event.type !== 'tunnel.changed' || event.tunnel.state !== 'active' || !event.tunnel.url) return;
    void this.follow(event.tunnel.url);
  }

  /** Re-points every hook Agentry registered to this origin. Settles when the hooks have been tried; never throws. */
  follow(publicUrl: string): Promise<void> {
    const origin = originOf(publicUrl);
    if (!origin) return Promise.resolve();
    // Only the latest address matters: events that arrive while a batch runs collapse into one more batch
    this.repointPending = origin;
    if (this.repointing) return this.repointing;
    this.repointing = (async () => {
      try {
        for (let next = this.repointPending; next !== null; next = this.repointPending) {
          this.repointPending = null;
          await this.repointAll(next).catch(() => undefined);
        }
      } finally {
        this.repointing = null;
      }
    })();
    return this.repointing;
  }

  private async repointAll(origin: string): Promise<void> {
    for (const registration of this.deps.store.listLive()) {
      if (registration.host !== 'github' || !registration.remoteHookId) continue;
      // A hook already on this address needs nothing, unless it was left stale and may be reachable now
      if (originOf(registration.url) === origin && registration.state !== 'stale') continue;
      await this.repoint(registration, origin);
    }
  }

  private async repoint(registration: WebhookRegistration, origin: string): Promise<void> {
    const url = receiverUrl(origin, registration.host, registration.id);
    try {
      const access = await this.deps.access(registration.projectId);
      // A secret that went missing is replaced in the same call: the hook gets the new one with its new address
      let secret = this.deps.secrets.get(registration.id);
      if (!secret) {
        secret = WebhookSecrets.generate();
        await this.deps.secrets.set(registration.id, secret);
      }
      const call = githubHooks.repoint(access.repo, registration.remoteHookId ?? '', { url, secret });
      const result = await access.run(call);
      if (result.exitCode !== 0) throw failure('re-point the hook', result, call);
      this.apply(registration, { url, state: 'active' });
    } catch {
      // Agentry could not move it: it stays on the old address and says so
      this.apply(registration, { state: 'stale' });
    }
  }

  // ---------- the pieces ----------

  private async createOrAdopt(access: WebhookAccess, hook: { url: string; secret: string }): Promise<string> {
    const taken = new Set(this.deps.store.listLive().map((r) => r.remoteHookId));
    const adoptable = (hooks: GithubHook[], same: (h: GithubHook) => boolean): GithubHook | undefined => hooks.find((h) => !taken.has(h.id) && same(h));
    const list = async (): Promise<GithubHook[]> => this.parse(await this.run(access, githubHooks.list(access.repo), 'list the hooks'), (s) => githubHooks.parseHooks(s));

    // A hook that already carries an Agentry address, from a registration this install lost: it is kept, and given the new address and secret
    const existing = adoptable(await list(), (h) => isReceiverUrl(h.url, 'github'));
    if (existing) return this.adopt(access, existing, hook);

    const call = githubHooks.create(access.repo, hook);
    const result = await access.run(call);
    if (result.exitCode === 0) return this.parse(result, (s) => githubHooks.parseHook(s)).id;
    // "Hook already exists on this repository": the one with this very address is the one to adopt
    if (errorStatus(result) === 422) {
      const same = adoptable(await list(), (h) => h.url === hook.url);
      if (same) return this.adopt(access, same, hook);
    }
    // GitHub answers 404 to a token that may not manage hooks: the repository is there, the right is not
    if (reasonOf(result, call.cli) === 'not-found') throw new WebhooksError('Agentry could not register the hook: this account cannot manage hooks on the repository', 403, 'hook-no-permission', result.stderrFirstLine || null);
    throw failure('register the hook', result, call);
  }

  private async adopt(access: WebhookAccess, existing: GithubHook, hook: { url: string; secret: string }): Promise<string> {
    await this.run(access, githubHooks.repoint(access.repo, existing.id, hook), 're-point the hook');
    return existing.id;
  }

  private async readSilent(projectId: string): Promise<void> {
    const now = this.now();
    const silent = this.deps.store
      .list(projectId)
      .filter((r) => (r.state === 'active' || r.state === 'failing') && !webhookHealthy(r, now) && now - (this.readAt.get(r.id) ?? 0) >= SILENT_READ_MS);
    for (const registration of silent) this.readAt.set(registration.id, now);
    // A hook that cannot be read now is read again the next time; the page is not held back by it
    await Promise.allSettled(silent.map((r) => this.check(projectId, r.id)));
  }

  private async githubTarget(projectId: string): Promise<WebhookTarget> {
    const target = await this.deps.target(projectId);
    if (!target) throw new WebhooksError("this project's remote is not on a code host Agentry knows", 409, 'no-remote');
    if (target.host !== 'github') throw new WebhooksError('webhooks on this host are not available yet: their calls have not been recorded', 409, 'host-not-recorded');
    return target;
  }

  private publicOrigin(): string {
    const url = this.deps.publicUrl();
    const origin = url ? originOf(url) : null;
    if (!origin) throw new WebhooksError('Agentry has no public address for a hook to deliver to: start the tunnel first', 409, 'no-public-url');
    return origin;
  }

  private owned(projectId: string, registrationId: string): WebhookRegistration {
    const registration = this.deps.store.get(registrationId);
    if (!registration || registration.projectId !== projectId) throw new WebhooksError('no such webhook on this project', 404, 'registration-not-found');
    if (registration.host !== 'github') throw new WebhooksError('webhooks on this host are not available yet: their calls have not been recorded', 409, 'host-not-recorded');
    return registration;
  }

  private remoteId(registration: WebhookRegistration): string {
    if (!registration.remoteHookId) throw new WebhooksError('this webhook has no hook on the host', 409, 'registration-not-found');
    return registration.remoteHookId;
  }

  private async run(access: WebhookAccess, call: HostCall, what: string): Promise<HostResult> {
    const result = await access.run(call);
    if (result.exitCode !== 0) throw failure(what, result, call);
    return result;
  }

  private parse<T>(result: HostResult | string, read: (stdout: string) => T): T {
    try {
      return read(typeof result === 'string' ? result : result.stdout);
    } catch (error) {
      if (error instanceof HostParseError) throw new WebhooksError(`the host's answer was not what Agentry expects: ${error.message}`, 502, 'unexpected-output');
      throw error;
    }
  }

  /** Writes what changed and tells the clients, only when something did. */
  private apply(registration: WebhookRegistration, patch: Parameters<WebhookStore['update']>[1]): WebhookRegistration {
    const updated = this.deps.store.update(registration.id, patch);
    if (!updated) return registration;
    const same = (['url', 'state', 'lastPingAt'] as const).every((key) => updated[key] === registration[key]) && JSON.stringify(updated.lastResponse) === JSON.stringify(registration.lastResponse);
    if (!same) this.changed(updated);
    return updated;
  }

  private changed(registration: WebhookRegistration): void {
    this.deps.emit?.({ type: 'webhook.changed', title: `Webhook ${registration.state}`, projectId: registration.projectId, registration });
  }
}

function unavailable(target: WebhookTarget | null, publicUrl: string | null): WebhookUnavailableReason | null {
  if (!target) return 'no-remote';
  if (target.host !== 'github') return 'host-not-recorded';
  return publicUrl ? null : 'no-public-url';
}

function describe(hook: GithubHook): string | null {
  const last = hook.lastResponse;
  if (!last) return null;
  return [last.code, last.status].filter((part) => part !== null).join(' ') || null;
}

/** The HTTP status a failed `gh api` printed in its structured body, which is all that is read of it. */
function errorStatus(result: HostResult): number | null {
  try {
    const body: unknown = JSON.parse(result.stdout);
    const status = typeof body === 'object' && body !== null ? Number((body as Record<string, unknown>).status) : NaN;
    return Number.isInteger(status) ? status : null;
  } catch {
    return null;
  }
}

/** What a failed call says as an error: a reason a client words, and the first line the host said. */
function failure(what: string, result: HostResult, call: HostCall): WebhooksError {
  const reason = reasonOf(result, call.cli) ?? 'unreachable';
  const detail = result.stderrFirstLine || null;
  // Hooks need admin rights on the repository: a refusal is that, in the person's words
  if (reason === 'forbidden') {
    return new WebhooksError(`Agentry could not ${what}: this account cannot manage hooks on the repository`, 403, 'hook-no-permission', detail);
  }
  return new WebhooksError(`Agentry could not ${what}`, reason === 'not-found' ? 404 : 502, reason, detail);
}
