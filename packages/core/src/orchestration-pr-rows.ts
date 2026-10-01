import type { OrchestrationPullRequest, OrchestrationPullRequestPhase, WorkItemPullRequestCi } from '@agentry/shared';
import { hostOf, refOf } from './work-item-rows.ts';

/**
 * The orchestration change request table as SQLite hands its rows back, and the conversion to the
 * contract's shape. No query runs here.
 */

export interface OrchestrationPullRequestRow {
  id: string;
  orchestration_id: string;
  cwd: string;
  host: string;
  hostname: string | null;
  phase: string;
  number: number | null;
  url: string | null;
  branch: string;
  base: string;
  ci: string | null;
  error_code: string | null;
  error_detail: string | null;
  opened_at: string | null;
  closed_at: string | null;
  checked_at: string | null;
  claimed_until: string | null;
  created_at: string;
  updated_at: string;
}

const PHASES: readonly OrchestrationPullRequestPhase[] = ['preparing', 'open', 'merged', 'closed', 'failed'];
const CI: readonly WorkItemPullRequestCi[] = ['none', 'pending', 'passing', 'failing'];

/** A stored change request as the contract carries it; a phase this version does not know reads as failed. */
export function orchestrationPullRequestOf(row: OrchestrationPullRequestRow): OrchestrationPullRequest {
  const host = hostOf(row.host);
  return {
    phase: PHASES.find((p) => p === row.phase) ?? 'failed',
    host,
    ref: refOf(host, row.number),
    number: row.number,
    url: row.url,
    branch: row.branch,
    base: row.base,
    ci: CI.find((c) => c === row.ci) ?? null,
    error: row.error_code ? { code: row.error_code, detail: row.error_detail ?? '' } : null,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    checkedAt: row.checked_at,
  };
}
