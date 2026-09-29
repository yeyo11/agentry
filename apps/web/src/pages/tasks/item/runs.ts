/**
 * The flow's runs as a work item and a run's chat tell them (decision 8 of the ecosystem design
 * review): what a run was called, what it did, why it failed in the person's words, and what a retry
 * did next. Pure, so the words each screen picks are unit tested (test/work-item-runs.test.ts).
 *
 * Every key returned here is in the `workItem` namespace.
 */
import { flowStepOf, type FlowRun, type FlowRunCause, type FlowRunRef, type FlowStep, type WorkItemComment, type WorkItemStatus } from '@agentry/shared';

/**
 * The stage as the person reads it, by the column it ran in; a run from before `step` was kept reads
 * it from its stage and column, by the same rule as Team activity (`flowStepOf`).
 */
export function runStep(run: Pick<FlowRun, 'stage' | 'column'> & { step?: FlowStep | null }): FlowStep {
  return run.step ?? flowStepOf(run.stage, run.column);
}

/** Where a run stands, as one word: running and queued while it has not ended, its outcome once it has. */
export type RunStatus = 'running' | 'queued' | 'passed' | 'rejected' | 'failed' | 'cancelled';

export function runStatus(run: Pick<FlowRunRef, 'state' | 'outcome'>): RunStatus {
  if (run.state === 'running' || run.state === 'queued') return run.state;
  return run.outcome ?? 'failed';
}

/** The badge's colour for each word: only a failure is bad, a pass is ok, a run at work is live; the rest stay neutral. */
export const RUN_STATUS_BADGE: Record<RunStatus, string> = {
  running: 'badge-active',
  queued: '',
  passed: 'badge-ok',
  rejected: '',
  failed: 'badge-bad',
  cancelled: '',
};

/** The causes a failed run is worded by; any other (a cancel) or none reads as "gave no reason". */
const FAILURE_CAUSES = new Set<FlowRunCause>([
  'budget',
  'no-account',
  'rate-limit',
  'stopped',
  'restarts',
  'unreadable',
  'no-verdict',
  'not-started',
  'not-continued',
  'chat-ended',
  'chat-failed',
]);

export type FailureReasonKey = `run.cause.${FlowRunCause}` | 'run.cause.unknown';

/**
 * Why a failed run failed, in the person's language, from its cause: the core's `error` is English
 * and stays under it in mono, as the raw text. `restarts` counts the cut-offs, one more than the
 * restarts it went on from. Null for a run that did not fail.
 */
export function failureReason(run: Pick<FlowRun, 'state' | 'outcome' | 'cause' | 'restarts'> & { step?: FlowStep | null; stage: FlowRun['stage']; column: WorkItemStatus }): {
  key: FailureReasonKey;
  values: { count: number; step: FlowStep };
} | null {
  if (run.state !== 'ended' || run.outcome !== 'failed') return null;
  const key: FailureReasonKey = run.cause && FAILURE_CAUSES.has(run.cause) ? `run.cause.${run.cause}` : 'run.cause.unknown';
  return { key, values: { count: run.restarts + 1, step: runStep(run) } };
}

/** The raw text under the reason: what the core or the CLI said, unless it only repeats that nothing was given. */
export function rawError(run: Pick<FlowRun, 'error'>): string | null {
  const error = run.error?.trim();
  return error ? error : null;
}

/**
 * The comment the core writes on the item when a run fails ("This verification run failed and moved
 * nothing: …"), in English. The item's activity draws that entry from the run instead, in the
 * person's language: this finds the run a comment stands for. Null for any other comment, a flow
 * run's summary included.
 */
export function failureCommentRun<R extends Pick<FlowRun, 'chatId' | 'state' | 'outcome'>>(comment: Pick<WorkItemComment, 'author' | 'source' | 'body'>, runs: readonly R[]): R | null {
  if (comment.author.kind !== 'agent' || !/^This [a-z]+ run failed and moved nothing\b/.test(comment.body)) return null;
  const chat = comment.source?.chatId;
  if (!chat) return null;
  return runs.find((run) => run.chatId === chat && run.state === 'ended' && run.outcome === 'failed') ?? null;
}

/** The flow run an agent's comment came from, by its chat: the comment then names the run and how it ended. */
export function commentRun<R extends Pick<FlowRun, 'chatId'>>(comment: Pick<WorkItemComment, 'author' | 'source'>, runs: readonly R[]): R | null {
  const chat = comment.source?.chatId;
  if (comment.author.kind !== 'agent' || !chat) return null;
  return runs.find((run) => run.chatId === chat) ?? null;
}

/**
 * The runs a person started rather than a card's entry, as entries of the item's history: a retry
 * ("Verification retried · yeyo · QA started chat 7c2e01") and a waiting card the person started
 * when switching the flow on ("Refinement started · yeyo · …"). The core writes no history for
 * either, so the page says it at the moment the run was queued. Oldest first.
 */
export function retriesOf<R extends Pick<FlowRun, 'retryOf' | 'queuedAt'> & Partial<Pick<FlowRun, 'queuedBy'>>>(runs: readonly R[]): R[] {
  return runs.filter((run) => run.retryOf !== null || run.queuedBy === 'person').sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

/**
 * What the failed run's next run did, for the banner and the item: its word, when it ended, and the
 * chat it ran in. Null until a later run of the same step exists.
 */
export function retryOutcome(run: Pick<FlowRun, 'retriedBy'>): { status: RunStatus; at: string | null; chatId: string | null } | null {
  const next = run.retriedBy;
  if (!next) return null;
  return { status: runStatus(next), at: next.endedAt, chatId: next.chatId };
}
