import { hostErrorFields, reasonOf } from './classify.ts';
import type { HostCall, HostResult } from './exec.ts';
import { retryAfterMs } from './rate-limit.ts';

// Reads only. A write is never retried by Agentry: it is re-read, and the person is told when the
// effect could not be found (see "After every write, re-read" in docs/plans/code-hosts.md).

/** Waits before the second and the third attempt */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];
/** All attempts together, waits included */
export const RETRY_BUDGET_MS = 90_000;
/** A `Retry-After` up to this is waited for; a longer one opens the host's breaker instead */
export const RETRY_AFTER_MAX_MS = 60_000;

export interface RetryOptions {
  delaysMs?: readonly number[];
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 0..1, for the jitter */
  random?: () => number;
  now?: () => number;
  /** True while the host's breaker is open: nothing is retried then */
  isOpen?: () => boolean;
  /** Opens the breaker for a `Retry-After` that is too long to wait for */
  openFor?: (ms: number) => void;
}

/**
 * A timeout, a 5xx, or a non-zero exit with no structured client error. Never a 4xx (401, 403, 404,
 * 422 and the rest), gh's exit 4, a missing binary, an oversized answer, or a limit.
 */
export function isRetryable(result: HostResult, cli: HostCall['cli']): boolean {
  if (result.exitCode === 0) return false;
  const reason = reasonOf(result, cli);
  if (reason === 'timeout' || reason === 'server-error') return true;
  if (reason !== 'unreachable') return false;
  const { status } = hostErrorFields(result);
  return status === null || status >= 500;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `attempt` up to three times while the result is retryable; returns the last result. */
export async function retryRead(attempt: () => Promise<HostResult>, cli: HostCall['cli'], options: RetryOptions = {}): Promise<HostResult> {
  const delays = options.delaysMs ?? RETRY_DELAYS_MS;
  const budget = options.budgetMs ?? RETRY_BUDGET_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const started = now();
  let result = await attempt();
  for (const base of delays) {
    if (!isRetryable(result, cli)) return result;
    if (options.isOpen?.()) return result;
    let wait = base * (0.75 + random() * 0.5);
    const asked = retryAfterMs(result.http?.headers['retry-after']);
    if (asked !== null) {
      if (asked > RETRY_AFTER_MAX_MS) {
        options.openFor?.(asked);
        return result;
      }
      wait = asked;
    }
    if (now() - started + wait > budget) return result;
    await sleep(wait);
    if (options.isOpen?.()) return result;
    result = await attempt();
  }
  return result;
}
