/**
 * How the web reads a project's webhooks: the rows of Integrations → Webhooks and the freshness
 * line of a change request. Plain data, no React: tested without a browser (test/webhooks.test.ts).
 * A webhook only makes Agentry read sooner; nothing here describes it as changing anything, and a
 * secret is never part of the data it reads.
 */
import type { ChangeRequestFreshness, CodeHostId, ProjectWebhooks, WebhookRegistration, WebhookState, WebhookUnavailableReason } from '@agentry/shared';

/** The pacer's rhythm, in minutes, for the words a row says about the periodic read. The server decides; these only name it. */
export const POLL_MINUTES = 2;
export const BACKUP_POLL_MINUTES = 15;
/** A hook that has delivered or answered a test within this is healthy: the pacer's own window. */
export const HEALTHY_WINDOW_MS = 30 * 60_000;

export type WebhookTone = 'ok' | 'warn' | 'bad' | 'idle' | 'muted';

/** One word and one colour per state; `muted` is what is not registered. */
export function webhookTone(state: WebhookState | null): WebhookTone {
  switch (state) {
    case 'active': return 'ok';
    case 'failing': return 'bad';
    case 'stale': return 'warn';
    case 'removed':
    case null: return 'muted';
  }
}

/** The registration the row is about: a removed one is only kept to be seen, so it counts as none. */
export const liveRegistration = (list: readonly WebhookRegistration[] | undefined): WebhookRegistration | null =>
  list?.find((r) => r.state !== 'removed') ?? null;

/** GitLab's webhook calls are not recorded yet, so its row shows its reason and offers nothing. */
export const isWebhookBuilt = (host: CodeHostId): boolean => host === 'github';

export type WebhookRowKind = 'off' | 'active' | 'failing' | 'stale' | 'unavailable';

/** What a project's row shows. Unavailable wins: without an address or a remote nothing can be registered. */
export function rowKind(overview: Pick<ProjectWebhooks, 'available' | 'registrations'> | undefined): WebhookRowKind {
  if (!overview?.available) return 'unavailable';
  const reg = liveRegistration(overview.registrations);
  if (!reg) return 'off';
  return reg.state === 'failing' ? 'failing' : reg.state === 'stale' ? 'stale' : 'active';
}

export type WebhookActionKind = 'register' | 'test' | 'remove';

/**
 * What a person can do on a row. Registering needs an address and an unregistered repository; test
 * and removal need a registration the host still has. There is no redelivery: GitHub's needs a
 * scope the CLI may not hold, and the feature is not built.
 */
export function webhookActions(overview: Pick<ProjectWebhooks, 'available' | 'registrations'> | undefined): WebhookActionKind[] {
  if (!overview?.available) return [];
  return liveRegistration(overview.registrations) ? ['test', 'remove'] : ['register'];
}

/** Whether the registration has delivered or answered a test inside the healthy window. */
export function isHealthy(reg: Pick<WebhookRegistration, 'state' | 'lastDeliveryAt' | 'lastPingAt'>, now: number): boolean {
  if (reg.state !== 'active') return false;
  return [reg.lastDeliveryAt, reg.lastPingAt].some((at) => at !== null && now - Date.parse(at) <= HEALTHY_WINDOW_MS);
}

/** `webhooks` namespace keys for why a project has nothing to manage. */
export const UNAVAILABLE_REASON_KEYS: Readonly<Record<WebhookUnavailableReason, 'reason.hostNotRecorded' | 'reason.noPublicUrl' | 'reason.noRemote'>> = {
  'host-not-recorded': 'reason.hostNotRecorded',
  'no-public-url': 'reason.noPublicUrl',
  'no-remote': 'reason.noRemote',
};

/** The latest of the two moments a hook was heard from, or null. */
export function lastHeardAt(reg: Pick<WebhookRegistration, 'lastDeliveryAt' | 'lastPingAt'>): string | null {
  const times = [reg.lastDeliveryAt, reg.lastPingAt].filter((t): t is string => t !== null);
  return times.length === 0 ? null : times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

/** A host's answer to a delivery, as the row writes it: `204`, `timeout`, or null when it never said. */
export function responseWord(reg: Pick<WebhookRegistration, 'lastResponse'>): string | null {
  const r = reg.lastResponse;
  if (!r) return null;
  return r.code !== null ? String(r.code) : r.status;
}

/** The address without the receiver's path, for a line that names where the notices arrive. */
export function publicOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Seconds, minutes and hours as the line writes them: `40 s`, `2 min`; whole units, never a clock. */
export function spanWords(ms: number): { unit: 's' | 'min' | 'h'; value: number } {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return { unit: 's', value: s };
  const m = Math.round(s / 60);
  return m < 90 ? { unit: 'min', value: m } : { unit: 'h', value: Math.round(m / 60) };
}

export type FreshnessKind = 'instant' | 'checked' | 'unchecked' | 'paused';

export interface FreshnessLine {
  kind: FreshnessKind;
  /** Milliseconds since the last read; null before the first */
  sinceMs: number | null;
  /** Milliseconds to the next read; null while closed or paused */
  untilMs: number | null;
}

/**
 * The line under a change request: `instant` when a webhook moved the last read and the repository's
 * hook is healthy, otherwise the periodic read in words. `paused` has a last read and no next one.
 * An unhealthy or absent hook never says "instant", whatever the last source was.
 */
export function freshnessLine(f: ChangeRequestFreshness | null | undefined, healthy: boolean, now: number): FreshnessLine | null {
  if (!f) return null;
  const sinceMs = f.checkedAt === null ? null : Math.max(0, now - Date.parse(f.checkedAt));
  const untilMs = f.nextCheckAt === null ? null : Math.max(0, Date.parse(f.nextCheckAt) - now);
  if (sinceMs === null) return { kind: 'unchecked', sinceMs, untilMs };
  if (f.source === 'webhook' && healthy) return { kind: 'instant', sinceMs, untilMs };
  return { kind: untilMs === null ? 'paused' : 'checked', sinceMs, untilMs };
}
