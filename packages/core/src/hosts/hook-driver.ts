import type { WebhookLastResponse } from '@agentry/shared';
import type { HostCall, HostRepo } from './code-host.ts';

/** A hook as a host reports it: what Agentry reads of a listing and of a single hook, in one shape for every host. */
export interface RemoteHook {
  /** As text: a 64-bit id must never pass through a double */
  id: string;
  url: string | null;
  /** The host's report of the last delivery; null until it said */
  lastResponse: WebhookLastResponse | null;
  /** The host stopped delivering by itself (GitLab disables a hook after repeated failures) */
  disabled: boolean;
  /** The id of the newest delivery, when the host lists them: a test waits for it to change. Null when the host does not say. */
  deliveryKey: string | null;
}

/**
 * What the registration service needs of a host's hook calls. Each driver only builds calls and
 * reads what came back; the service runs them. Every body, the secret above all, is on stdin.
 */
export interface HookDriver {
  readonly cli: HostCall['cli'];
  /** What a registration subscribes to, in the host's words */
  readonly events: readonly string[];
  create(repo: HostRepo, hook: { url: string; secret: string }): HostCall;
  list(repo: HostRepo): HostCall;
  /** The calls that say how a hook stands: the first reads the hook, the others (optional) what it delivered */
  read(repo: HostRepo, hookId: string): HostCall[];
  /** A call that makes the host deliver once, to the hook's address */
  test(repo: HostRepo, hookId: string): HostCall;
  remove(repo: HostRepo, hookId: string): HostCall;
  repoint(repo: HostRepo, hookId: string, hook: { url: string; secret: string }): HostCall;
  parseHook(stdout: string[]): RemoteHook;
  parseHooks(stdout: string): RemoteHook[];
}
