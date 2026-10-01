/**
 * The pure model of a change request's checks: how the list is grouped, which word and colour each
 * row carries, and which actions the section offers. The item page and the orchestration page read
 * their checks from here, so "failing" means one thing on both. No React and no fetching: tested
 * without a browser (test/change-requests.test.ts).
 *
 * Label keys are in the `checks` namespace: `t(label)` with `useTranslation('checks')`.
 */
import type { ChangeRequest, ChangeRequestChecks, Check, CheckState, WorkItemPullRequestCi } from '@agentry/shared';

/** The groups of the list, in the order the prototype draws them. */
export type CheckGroupId = 'failed' | 'running' | 'passed' | 'skipped';

/** The status colour of a row: ok, warn, bad or idle, or `live` for a job that runs now. */
export type CheckTone = 'ok' | 'warn' | 'bad' | 'idle' | 'live';

export interface CheckGroup {
  id: CheckGroupId;
  checks: Check[];
  /** The failures the pipeline lets fail: shown as a warning, never counted as a failure */
  allowed: number;
}

const GROUP_OF: Readonly<Record<CheckState, CheckGroupId>> = {
  failed: 'failed',
  running: 'running',
  queued: 'running',
  passed: 'passed',
  neutral: 'passed',
  skipped: 'skipped',
  cancelled: 'skipped',
  manual: 'skipped',
};

const GROUP_ORDER: readonly CheckGroupId[] = ['failed', 'running', 'passed', 'skipped'];

/** The non-empty groups, failures first, each keeping the host's order inside. */
export function groupChecks(checks: readonly Check[]): CheckGroup[] {
  const groups = new Map<CheckGroupId, CheckGroup>(GROUP_ORDER.map((id) => [id, { id, checks: [], allowed: 0 }]));
  for (const check of checks) {
    const group = groups.get(GROUP_OF[check.state]);
    if (!group) continue;
    group.checks.push(check);
    if (check.state === 'failed' && check.allowedToFail) group.allowed += 1;
  }
  return GROUP_ORDER.map((id) => groups.get(id)).filter((g): g is CheckGroup => g !== undefined && g.checks.length > 0);
}

/** A failed check that counts: one the pipeline does not let fail. */
export const isFailure = (check: Check): boolean => check.state === 'failed' && !check.allowedToFail;

export interface ChecksCounts {
  failed: number;
  allowed: number;
  running: number;
  passed: number;
  skipped: number;
}

export function countChecks(checks: readonly Check[]): ChecksCounts {
  const counts: ChecksCounts = { failed: 0, allowed: 0, running: 0, passed: 0, skipped: 0 };
  for (const check of checks) {
    if (check.state === 'failed') counts[check.allowedToFail ? 'allowed' : 'failed'] += 1;
    else counts[GROUP_OF[check.state]] += 1;
  }
  return counts;
}

export interface CheckMark {
  tone: CheckTone;
  /** The word that always goes with the colour */
  label: string;
}

/** The colour and the word of one row: an allowed failure is a warning, `running` alone is live. */
export function checkMark(check: Check): CheckMark {
  switch (check.state) {
    case 'failed':
      return check.allowedToFail ? { tone: 'warn', label: 'state.allowedFailure' } : { tone: 'bad', label: 'state.failed' };
    case 'running':
      return { tone: 'live', label: 'state.running' };
    case 'queued':
      return { tone: 'idle', label: 'state.queued' };
    case 'passed':
      return { tone: 'ok', label: 'state.passed' };
    case 'neutral':
      return { tone: 'idle', label: 'state.neutral' };
    case 'skipped':
      return { tone: 'idle', label: 'state.skipped' };
    case 'cancelled':
      return { tone: 'warn', label: 'state.cancelled' };
    case 'manual':
      return { tone: 'idle', label: 'state.manual' };
  }
}

/** How long a check ran, in ms: still counting for a running one, null when it never started. */
export function checkDurationMs(check: Check, now: number): number | null {
  if (!check.startedAt) return null;
  const start = Date.parse(check.startedAt);
  if (Number.isNaN(start)) return null;
  const end = check.finishedAt ? Date.parse(check.finishedAt) : check.state === 'running' ? now : NaN;
  return Number.isNaN(end) ? null : Math.max(0, end - start);
}

/** `2:14`, or `1:02:03` past an hour: the mono clock of a row. */
export function clockOf(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** The rollup the section is drawn for: the list's own when it has checks, else the watcher's. */
export function sectionRollup(checks: ChangeRequestChecks | undefined, cr: Pick<ChangeRequest, 'ci'> | undefined): WorkItemPullRequestCi {
  return checks?.rollup ?? cr?.ci ?? 'none';
}

/** The section's actions for a list of checks; each one is offered only when it can do something. */
export interface ChecksActions {
  rerunFailed: boolean;
  rerunAll: boolean;
  cancel: boolean;
  fix: boolean;
}

/**
 * - Re-run failed needs a failure whose job the host can run again.
 * - Cancel needs something running or queued.
 * - Fix failing checks needs a failure that counts and no fix under way: while one runs or waits
 *   for its push, the section shows that state instead.
 */
export function checksActions(list: Pick<ChangeRequestChecks, 'checks'> | undefined, cr: Pick<ChangeRequest, 'fixState'> | undefined): ChecksActions {
  const checks = list?.checks ?? [];
  return {
    rerunFailed: checks.some((c) => c.state === 'failed' && c.rerunnable),
    rerunAll: checks.some((c) => c.rerunnable),
    cancel: checks.some((c) => c.state === 'running' || c.state === 'queued'),
    fix: !cr?.fixState && checks.some(isFailure),
  };
}

/** Where a fix stands, as the card and the page word it; `null` when none is under way. */
export type FixStage = 'fixing' | 'verifying' | 'push';

export function fixStage(cr: Pick<ChangeRequest, 'fixState'> | undefined): FixStage | null {
  switch (cr?.fixState) {
    case 'fixing':
      return 'fixing';
    case 'awaiting-verify':
      return 'verifying';
    case 'awaiting-push':
      return 'push';
    default:
      return null;
  }
}

/** Attempts a decision may still make for this head; the dialog says how many are left. */
export function attemptsLeft(attempts: number, max: number): number {
  return Math.max(0, max - attempts);
}

/** The `Check` to run by hand: a GitLab manual job has its own action, not a re-run. */
export const isManual = (check: Check): boolean => check.state === 'manual';
