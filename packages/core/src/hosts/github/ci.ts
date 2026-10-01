import type { WorkItemPullRequestCi } from '@agentry/shared';

/**
 * The CI state `statusCheckRollup` comes to: none without checks; failing when one failed, was
 * cancelled or timed out; pending while one is queued or running; passing when all succeeded or
 * were skipped.
 */
export function ciOf(rollup: unknown): WorkItemPullRequestCi {
  const checks = Array.isArray(rollup) ? rollup.filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null) : [];
  if (!checks.length) return 'none';
  const up = (v: unknown): string => (typeof v === 'string' ? v.toUpperCase() : '');
  const failing = checks.some((c) => ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(up(c.conclusion) || up(c.state)));
  if (failing) return 'failing';
  const pending = checks.some((c) => {
    // A check run has a status and, once completed, a conclusion; a commit status has a state
    if (c.status !== undefined && up(c.status) !== 'COMPLETED') return true;
    return ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(up(c.state));
  });
  return pending ? 'pending' : 'passing';
}
