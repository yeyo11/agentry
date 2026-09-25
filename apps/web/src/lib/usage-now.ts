import { useOverview, useUsage } from '../api';
import { pickUsageWindows, swapUsageWindows } from './shell-live';

const pad = (n: number) => String(n).padStart(2, '0');

/** Today in the browser's calendar, as the usage report takes it. */
export function usageToday(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The account's usage right now: its rate-limit windows and what today cost. The status bar and
 * the Home usage widgets read the same two queries through this hook, so each is fetched once and
 * both always show the same figure.
 */
export function useUsageNow() {
  const overview = useOverview();
  const today = usageToday();
  const usage = useUsage({ from: today, to: today });
  const windows = overview.data?.rateLimit?.windows ?? {};
  const swap = swapUsageWindows(overview.data?.accounts?.active?.usage);
  // Same precedence as Home's limits tile: claude-swap's reading of the active account, then the CLI's
  const { fiveHour, sevenDay } = swap.fiveHour || swap.sevenDay ? swap : pickUsageWindows(windows);
  const total = usage.data?.total;
  return {
    overview,
    usage,
    /** Every window the CLI reported, per-model ones included */
    windows,
    fiveHour,
    sevenDay,
    /** Null when nothing reported a cost today; undefined while it loads */
    todayCost: total === undefined ? undefined : total.costUsd,
  };
}
