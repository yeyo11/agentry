import { useOverview, useUsage } from '../api';

const pad = (n: number) => String(n).padStart(2, '0');

/** Today in the browser's calendar, as the usage report takes it. */
export function usageToday(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * What the shell reads of the wrapper right now: the overview, each provider's last limit reading
 * and what today cost. The status bar and the phone's More card read the same two queries through
 * this hook, so each is fetched once and both always show the same figure.
 */
export function useUsageNow() {
  const overview = useOverview();
  const today = usageToday();
  const usage = useUsage({ from: today, to: today });
  const total = usage.data?.total;
  return {
    overview,
    usage,
    /** One reading per provider that has one; fresher than the statuses, which only change on detection */
    limits: overview.data?.limits ?? [],
    /** Null when nothing reported a cost today; undefined while it loads */
    todayCost: total === undefined ? undefined : total.costUsd,
  };
}
