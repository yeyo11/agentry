import type { ProviderId, ProviderLimit, RateLimitInfo, RateLimitWindow } from '@agentry/shared';
import type { DriverEvent } from './driver.ts';

/** From this use of the binding window a provider is `near`, the same line the usage bars draw. */
export const NEAR_UTILIZATION = 0.6;
/** A stream of events becomes at most one write a minute, unless the state or the binding window changes. */
export const LIMIT_WRITE_GAP_MS = 60_000;

/** What `ProviderLimits` needs of the store: `Db` has all three. */
export interface ProviderLimitStore {
  upsertProviderLimit(limit: ProviderLimit): boolean;
  providerLimit(provider: string): ProviderLimit | null;
  providerLimits(): ProviderLimit[];
}

/** A handshake that also read the account's limits (Codex's does); the driver's own type does not name it. */
export interface HandshakeLimits {
  rateLimits?: RateLimitInfo | null;
}

const iso = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();

/**
 * The window that binds: the most used one. A rejection names its own window (`rateLimitType`), and
 * that one binds even when another reads higher.
 */
function bindingWindow(info: RateLimitInfo): { name: string; window: RateLimitWindow | null } | null {
  const named = info.rateLimitType ? info.windows[info.rateLimitType] : undefined;
  if (info.status === 'rejected' && info.rateLimitType && named) return { name: info.rateLimitType, window: named };
  let top: { name: string; window: RateLimitWindow } | null = null;
  for (const [name, window] of Object.entries(info.windows)) {
    if (!top || window.utilization > top.window.utilization) top = { name, window };
  }
  if (top) return top;
  return info.rateLimitType ? { name: info.rateLimitType, window: null } : null;
}

/** What a window report means as one `ProviderLimit`; pure, so a fixture event gives a fixed answer. */
export function limitFromInfo(provider: ProviderId, info: RateLimitInfo, source: ProviderLimit['source'], observedAt: string): ProviderLimit {
  const bound = bindingWindow(info);
  const utilization = bound?.window ? bound.window.utilization : null;
  const resetsAtSeconds = bound?.window?.resetsAt || info.resetsAt || 0;
  const known = info.status === 'allowed' || info.status === 'allowed_warning' || info.status === 'rejected';
  let state: ProviderLimit['state'];
  if (info.status === 'rejected' || (utilization !== null && utilization >= 1)) state = 'exhausted';
  else if (info.status === 'allowed_warning' || (utilization !== null && utilization >= NEAR_UTILIZATION)) state = 'near';
  else state = known || utilization !== null ? 'ok' : 'unknown';
  return {
    provider,
    state,
    window: bound?.name ?? null,
    utilization,
    resetsAt: resetsAtSeconds > 0 ? iso(resetsAtSeconds) : null,
    windows: info.windows,
    observedAt,
    source,
  };
}

/**
 * A turn died on the limit. The reset comes from the last reading while it is still ahead, else it
 * is unknown; the wording of the failure is never read for it.
 */
export function limitFromFailure(provider: ProviderId, last: ProviderLimit | null, observedAt: string): ProviderLimit {
  const ahead = last?.resetsAt !== null && last?.resetsAt !== undefined && Date.parse(last.resetsAt) > Date.parse(observedAt);
  return {
    provider,
    state: 'exhausted',
    window: ahead ? last.window : null,
    utilization: ahead ? 1 : null,
    resetsAt: ahead ? last.resetsAt : null,
    windows: ahead ? last.windows : {},
    observedAt,
    source: 'failure',
  };
}

/**
 * A reading as it stands at `nowMs`. Once the binding window has reset the old use says nothing, so
 * the reading becomes `unknown`, never `ok` without a new one.
 */
export function limitAt(limit: ProviderLimit, nowMs: number): ProviderLimit {
  if (limit.state === 'unknown' || !limit.resetsAt || Date.parse(limit.resetsAt) > nowMs) return limit;
  return { ...limit, state: 'unknown', utilization: null, windows: {} };
}

/**
 * One `ProviderLimit` per provider, folded from what the drivers emit, replacing the app-wide "last
 * rate limit". The row is shared through the store with every process on the data directory.
 */
export class ProviderLimits {
  /** The newest reading seen by this process, written or not yet */
  private readonly latest = new Map<ProviderId, ProviderLimit>();
  private readonly written = new Map<ProviderId, { at: number; state: ProviderLimit['state']; window: string | null }>();
  private readonly listeners = new Set<(limit: ProviderLimit) => void>();

  constructor(
    private readonly store: ProviderLimitStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** A driver event of `provider`'s chat: the window reports, a failure on the limit, a result that says so. */
  observe(provider: ProviderId, event: DriverEvent): void {
    if (event.kind === 'rate-limit') this.record(limitFromInfo(provider, event.info, 'stream', this.stamp()));
    else if (event.kind === 'rate-limited' || (event.kind === 'result' && event.rateLimited)) this.observeFailure(provider);
  }

  /** A turn failed on the limit (Claude's 429, Codex's `usageLimitExceeded`). */
  observeFailure(provider: ProviderId): void {
    this.record(limitFromFailure(provider, this.raw(provider), this.stamp()));
  }

  /** A read that spends nothing (Codex's `account/rateLimits/read`). */
  observeProbe(provider: ProviderId, info: RateLimitInfo): void {
    this.record(limitFromInfo(provider, info, 'probe', this.stamp()));
  }

  /** The reading as it stands now, or null when nothing was ever read. */
  get(provider: ProviderId): ProviderLimit | null {
    const raw = this.raw(provider);
    return raw ? limitAt(raw, this.now()) : null;
  }

  list(): ProviderLimit[] {
    const ids = new Set<ProviderId>([...this.latest.keys(), ...this.store.providerLimits().map((l) => l.provider)]);
    return [...ids].sort().flatMap((id) => this.get(id) ?? []);
  }

  /** The stored reading before a reset is applied: what a probe is scheduled on. */
  raw(provider: ProviderId): ProviderLimit | null {
    const mine = this.latest.get(provider) ?? null;
    const stored = this.store.providerLimit(provider);
    if (mine && stored) return mine.observedAt >= stored.observedAt ? mine : stored;
    return mine ?? stored;
  }

  /** Called when a reading is written with another state or window. Returns how to stop listening. */
  onChange(listener: (limit: ProviderLimit) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private record(limit: ProviderLimit): void {
    this.latest.set(limit.provider, limit);
    const before = this.written.get(limit.provider) ?? this.fromStore(limit.provider);
    const at = this.now();
    const changed = !before || before.state !== limit.state || before.window !== limit.window;
    if (!changed && at - before.at < LIMIT_WRITE_GAP_MS) return;
    this.store.upsertProviderLimit(limit);
    this.written.set(limit.provider, { at, state: limit.state, window: limit.window });
    if (changed) for (const listener of this.listeners) listener(limit);
  }

  private fromStore(provider: ProviderId): { at: number; state: ProviderLimit['state']; window: string | null } | null {
    const stored = this.store.providerLimit(provider);
    return stored ? { at: Date.parse(stored.observedAt), state: stored.state, window: stored.window } : null;
  }
}
