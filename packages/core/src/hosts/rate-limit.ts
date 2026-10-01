import type { DatabaseSync } from 'node:sqlite';
import type { HostCall } from './exec.ts';

// The breaker per host. Its state lives in SQLite (`host_rate_limits`, one row per host and bucket)
// because two Agentry processes share the data directory and would otherwise spend the same budget
// twice. It is scoped by host: a limit on github.example.com never stops github.com.
// Signals are structured only: GitHub's `X-Ratelimit-*` headers and GitLab's `RateLimit-*`
// headers (both recorded, from `api -i`), `Retry-After`, and GraphQL's `rateLimit{…}` fed in by the
// caller. `gh api rate_limit` is exempt and never used: its counts did not match the headers of
// the same calls (recorded).

export type RateBucket = NonNullable<HostCall['bucket']>;

/** GitHub: below this many calls left in core or graphql, background polling pauses for the host */
export const GITHUB_FLOOR = 50;
/** GitHub: the same for the search bucket */
export const GITHUB_SEARCH_FLOOR = 5;
/** GitLab: below this share of the limit left, background polling pauses */
export const GITLAB_FLOOR_SHARE = 0.05;
/** A secondary limit or throttle waits at least this long, doubling on each repeat */
export const SECONDARY_MIN_MS = 60_000;
export const SECONDARY_MAX_MS = 15 * 60_000;

interface LimitRow {
  limit_value: number | null;
  remaining: number | null;
  reset_at: string | null;
  blocked_until: string | null;
  strikes: number;
}

export type BreakerState = { open: false } | { open: true; until: Date; reason: 'rate-limited' | 'slowed-down' };

export interface ObservedLimit {
  limit?: number | null;
  remaining?: number | null;
  /** when the budget comes back */
  resetAt?: Date | null;
}

/** The values of a GitHub or GitLab rate-limit header set. Header names are lower case. */
export function readLimitHeaders(headers: Record<string, string>): ObservedLimit & { resource: string | null; retryAfterMs: number | null } {
  const number = (...names: string[]): number | null => {
    for (const name of names) {
      const raw = headers[name];
      if (raw === undefined) continue;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
    return null;
  };
  const reset = number('x-ratelimit-reset', 'ratelimit-reset');
  return {
    limit: number('x-ratelimit-limit', 'ratelimit-limit'),
    remaining: number('x-ratelimit-remaining', 'ratelimit-remaining'),
    resetAt: reset === null ? null : new Date(reset * 1000),
    resource: headers['x-ratelimit-resource'] ?? headers['ratelimit-name'] ?? null,
    retryAfterMs: retryAfterMs(headers['retry-after']),
  };
}

/** `Retry-After` is seconds or an HTTP date */
export function retryAfterMs(value: string | undefined, now: Date = new Date()): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && value.trim() !== '') return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now.getTime());
}

export class HostRateLimiter {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private row(host: string, bucket: RateBucket): LimitRow | undefined {
    return this.db.prepare('SELECT limit_value, remaining, reset_at, blocked_until, strikes FROM host_rate_limits WHERE host = ? AND bucket = ?').get(host, bucket) as LimitRow | undefined;
  }

  private write(host: string, bucket: RateBucket, row: LimitRow): void {
    this.db
      .prepare(
        `INSERT INTO host_rate_limits (host, bucket, limit_value, remaining, reset_at, blocked_until, strikes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (host, bucket) DO UPDATE SET limit_value = excluded.limit_value, remaining = excluded.remaining, reset_at = excluded.reset_at,
           blocked_until = excluded.blocked_until, strikes = excluded.strikes, updated_at = excluded.updated_at`,
      )
      .run(host, bucket, row.limit_value, row.remaining, row.reset_at, row.blocked_until, row.strikes, this.now().toISOString());
  }

  /** Whether a call to (host, bucket) may go out now. Read from the table every time, so another process's block counts. */
  check(host: string, bucket: RateBucket = 'core'): BreakerState {
    const row = this.row(host, bucket);
    if (!row?.blocked_until) return { open: false };
    const until = new Date(row.blocked_until);
    if (until.getTime() <= this.now().getTime()) return { open: false };
    // A block set by a primary limit ends at the reset; any other block is a throttle
    const primary = row.remaining === 0 && row.reset_at !== null && row.reset_at === row.blocked_until;
    return { open: true, until, reason: primary ? 'rate-limited' : 'slowed-down' };
  }

  /**
   * Whether background polling should stay away from (host, bucket): the budget is under its floor.
   * A person's own action is never held by this. Unknown budgets are not paused.
   */
  backgroundPaused(host: string, bucket: RateBucket = 'core', cli: 'gh' | 'glab' = 'gh'): boolean {
    const row = this.row(host, bucket);
    if (row?.remaining === null || row?.remaining === undefined) return false;
    // A budget that has come back since the last reading is not low any more
    if (row.reset_at && new Date(row.reset_at).getTime() <= this.now().getTime()) return false;
    if (cli === 'glab') return row.limit_value ? row.remaining < row.limit_value * GITLAB_FLOOR_SHARE : false;
    return row.remaining < (bucket === 'search' ? GITHUB_SEARCH_FLOOR : GITHUB_FLOOR);
  }

  /** The numbers a response reported (headers, or GraphQL's `rateLimit{remaining resetAt}`). Remaining 0 opens the breaker until the reset. */
  observe(host: string, bucket: RateBucket, seen: ObservedLimit): void {
    const before = this.row(host, bucket);
    const next: LimitRow = {
      limit_value: seen.limit ?? before?.limit_value ?? null,
      remaining: seen.remaining ?? before?.remaining ?? null,
      reset_at: seen.resetAt ? seen.resetAt.toISOString() : (before?.reset_at ?? null),
      blocked_until: before?.blocked_until ?? null,
      strikes: before?.strikes ?? 0,
    };
    const now = this.now().getTime();
    if (next.remaining === 0 && seen.resetAt && seen.resetAt.getTime() > now) {
      next.blocked_until = seen.resetAt.toISOString();
    }
    this.write(host, bucket, next);
  }

  /**
   * Reads a response's status and headers and opens the breaker when they say so:
   * - primary: a 403 or 429 with remaining 0, or any response reporting remaining 0 → until the reset;
   * - secondary or throttling: a 429, or a 403 with `Retry-After` → `Retry-After`, at least 60 s,
   *   doubling on each repeat up to 15 min.
   * A 403 that carries neither `Retry-After` nor an empty budget is a permission failure, not a
   * limit: hosts send their remaining count on every response, and stderr is never read.
   * Returns the breaker's state after this response.
   */
  record(host: string, bucket: RateBucket, http: { status: number; headers: Record<string, string> }): BreakerState {
    const seen = readLimitHeaders(http.headers);
    const hasNumbers = seen.limit !== null || seen.remaining !== null || seen.resetAt !== null;
    if (hasNumbers) this.observe(host, bucket, seen);
    const limited = http.status === 429 || http.status === 403;
    if (!limited) {
      // The block has run out and the host answered normally: the doubling starts over
      const row = this.row(host, bucket);
      if (row && row.strikes > 0 && !this.check(host, bucket).open) this.write(host, bucket, { ...row, blocked_until: null, strikes: 0 });
    }
    if (limited && seen.remaining !== 0 && (http.status === 429 || seen.retryAfterMs !== null)) {
      const row = this.row(host, bucket);
      const strikes = row?.strikes ?? 0;
      const wait = Math.min(Math.max(seen.retryAfterMs ?? 0, SECONDARY_MIN_MS) * 2 ** strikes, Math.max(SECONDARY_MAX_MS, seen.retryAfterMs ?? 0));
      this.write(host, bucket, {
        limit_value: row?.limit_value ?? null,
        remaining: row?.remaining ?? null,
        reset_at: row?.reset_at ?? null,
        blocked_until: new Date(this.now().getTime() + wait).toISOString(),
        strikes: strikes + 1,
      });
    }
    return this.check(host, bucket);
  }

  /** Opens the breaker for a stated time (a `Retry-After` longer than a read is willing to wait for) */
  openFor(host: string, bucket: RateBucket, ms: number): void {
    const row = this.row(host, bucket);
    this.write(host, bucket, {
      limit_value: row?.limit_value ?? null,
      remaining: row?.remaining ?? null,
      reset_at: row?.reset_at ?? null,
      blocked_until: new Date(this.now().getTime() + ms).toISOString(),
      strikes: (row?.strikes ?? 0) + 1,
    });
  }
}
