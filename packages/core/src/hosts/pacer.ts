// The pacer: when each open change request is read next (docs/plans/code-hosts.md, phase 6).
// It replaces the fixed 60 s watch. It decides only *when*; the 4-processes-per-CLI cap
// (`limits.ts`) and the per-row claim (`claimed_until`, in the services) decide whether a read may
// go out, exactly as before. A webhook delivery never changes state: it only calls `nudge`, which
// moves the row's next read to now.

/** Checks running, or a merge waiting on a pipeline */
export const TIER_ACTIVE_MS = 30_000;
/** Its page is open in a browser */
export const TIER_VIEWING_MS = 20_000;
/** Open and waiting for a review or a merge */
export const TIER_WAITING_MS = 2 * 60_000;
/** Unchanged for an hour */
export const TIER_QUIET_MS = 10 * 60_000;
/** A healthy webhook for its repository: polling is the safety net */
export const TIER_WEBHOOK_MS = 15 * 60_000;
/** How long without a change before a row counts as quiet */
export const QUIET_AFTER_MS = 60 * 60_000;
/** A delivery or a successful ping this recent makes a repository's webhook healthy */
export const WEBHOOK_HEALTHY_MS = 30 * 60_000;
/** After a failure: 1, 2, 4, 8, then 15 minutes, for every failure after the fourth */
export const FAILURE_STEPS_MS: readonly number[] = [60_000, 2 * 60_000, 4 * 60_000, 8 * 60_000, 15 * 60_000];
/** A row held back by the host's floor (background polling paused) looks again after this */
export const PAUSED_RECHECK_MS = 60_000;
/** How long the web's read of a change request keeps it in the viewing tier */
export const VIEWING_TTL_MS = 60_000;

export type PaceTier = 'viewing' | 'webhook' | 'active' | 'quiet' | 'waiting';

/** What the pacer needs to know of a row, read by the caller on every pass. */
export interface PaceInput {
  /** When the row was last read by any process (`checked_at`); null when it never was */
  checkedAt: number | null;
  /** The CI rollup, `pending` meaning checks are running */
  ci: string | null;
  /** A merge is waiting on a pipeline */
  mergeWaiting?: boolean;
  /** Something that changes when the row's observable state does, to tell a quiet row from a live one */
  signature: string;
  /** Where "unchanged for an hour" counts from the first time the row is seen: when it opened */
  since: number;
  /** A healthy webhook covers the repository */
  webhookHealthy?: boolean;
}

/**
 * How a read ended: it read; it failed; it was held back by the host's floor (`paused`, the only
 * outcome that pauses the row); or it did not go out for another reason (`skipped`: another process
 * holds the claim, the project's path is gone), which leaves the row's state as it was.
 */
export type PaceOutcome = 'read' | 'failed' | 'skipped' | 'paused';

interface PaceState {
  /** Set by the first `state()` call that has the row's input; a nudge or a view can come first */
  seen: boolean;
  signature: string;
  changedAt: number;
  /** When the last read of this process started */
  lastAttempt: number | null;
  failures: number;
  nudgedAt: number | null;
  viewedUntil: number;
  paused: boolean;
}

/** The webhook is healthy when a delivery or a successful ping arrived in the last 30 minutes. */
export function webhookHealthy(registration: { state: string; lastDeliveryAt: string | null; lastPingAt: string | null } | null, now: number): boolean {
  if (registration?.state !== 'active') return false;
  return [registration.lastDeliveryAt, registration.lastPingAt].some((at) => at !== null && now - Date.parse(at) <= WEBHOOK_HEALTHY_MS);
}

export class Pacer {
  private readonly states = new Map<string, PaceState>();

  constructor(private readonly now: () => number = Date.now) {}

  private raw(key: string): PaceState {
    let state = this.states.get(key);
    if (!state) {
      state = { seen: false, signature: '', changedAt: 0, lastAttempt: null, failures: 0, nudgedAt: null, viewedUntil: 0, paused: false };
      this.states.set(key, state);
    }
    return state;
  }

  private state(key: string, input: PaceInput): PaceState {
    const state = this.raw(key);
    if (!state.seen) {
      state.seen = true;
      state.signature = input.signature;
      state.changedAt = input.since;
    }
    if (state.signature !== input.signature) {
      state.signature = input.signature;
      state.changedAt = this.now();
    }
    // A read by someone else (a person's refresh, another process) after our last attempt ended any failure streak
    if (state.failures > 0 && input.checkedAt !== null && (state.lastAttempt === null || input.checkedAt > state.lastAttempt)) state.failures = 0;
    return state;
  }

  /** The tier that sets a row's interval, when nothing has failed */
  tier(key: string, input: PaceInput): PaceTier {
    const state = this.state(key, input);
    const now = this.now();
    if (state.viewedUntil > now) return 'viewing';
    if (input.webhookHealthy) return 'webhook';
    if (input.ci === 'pending' || input.mergeWaiting) return 'active';
    if (now - state.changedAt >= QUIET_AFTER_MS) return 'quiet';
    return 'waiting';
  }

  intervalOf(tier: PaceTier): number {
    return { viewing: TIER_VIEWING_MS, webhook: TIER_WEBHOOK_MS, active: TIER_ACTIVE_MS, quiet: TIER_QUIET_MS, waiting: TIER_WAITING_MS }[tier];
  }

  /** When the row is next read, in ms since the epoch; a time in the past means now. */
  nextAt(key: string, input: PaceInput): number {
    const state = this.state(key, input);
    const last = Math.max(input.checkedAt ?? 0, state.lastAttempt ?? 0);
    if (input.checkedAt === null && state.lastAttempt === null) return 0;
    // A failing host keeps its back-off whatever the deliveries say: a nudge brings a healthy row forward only
    if (state.failures > 0) return (state.lastAttempt ?? last) + (FAILURE_STEPS_MS[Math.min(state.failures, FAILURE_STEPS_MS.length) - 1] ?? 0);
    if (state.nudgedAt !== null && (state.lastAttempt === null || state.nudgedAt > state.lastAttempt)) return state.nudgedAt;
    if (state.paused && state.lastAttempt !== null) return state.lastAttempt + PAUSED_RECHECK_MS;
    return last + this.intervalOf(this.tier(key, input));
  }

  isDue(key: string, input: PaceInput): boolean {
    return this.nextAt(key, input) <= this.now();
  }

  /** A webhook delivery named this row: its next read is now. */
  nudge(key: string): void {
    this.raw(key).nudgedAt = this.now();
  }

  /** The change request's page is open in a browser: it is read every 20 s for a minute */
  view(key: string): void {
    this.raw(key).viewedUntil = this.now() + VIEWING_TTL_MS;
  }

  /** A read of this row starts now (so a nudge that lands while it runs is not lost). */
  begin(key: string, input: PaceInput): void {
    this.state(key, input).lastAttempt = this.now();
  }

  /**
   * How the read ended. A failure steps the interval up and a read resets it. Only the floor pauses
   * the row; a read that did not go out for another reason changes nothing, so losing a claim to
   * another process does not reset a back-off.
   */
  settle(key: string, outcome: PaceOutcome): void {
    const state = this.states.get(key);
    if (!state || outcome === 'skipped') return;
    state.paused = outcome === 'paused';
    if (outcome === 'failed') state.failures += 1;
    else if (outcome === 'read') state.failures = 0;
  }

  /** The row is not open any more */
  forget(key: string): void {
    this.states.delete(key);
  }

  /** Rows the pacer remembers that are not in `open` are dropped, so the map does not grow with merged rows. */
  retain(open: ReadonlySet<string>): void {
    for (const key of [...this.states.keys()]) if (!open.has(key)) this.forget(key);
  }
}
