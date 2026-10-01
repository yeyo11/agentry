import type { FlowRun, FlowRunStatus } from '@agentry/shared';
import { flowRunStatus } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, CornerDownLeft, RotateCcw, X } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../api';
import { WorkItemKey } from '../../components/work-item-icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { formatDuration, formatHour, timeAgo } from '@agentry/ui/lib/format';
import { activityTarget, elapsedSince, formatElapsed } from '@agentry/ui/lib/live';
import { useClockTick } from '@agentry/ui/lib/motion';
import { chatActivity } from '../../lib/shell-live';
import { columnMeta, taskPath } from '../../lib/work-items';
import { runDuration, runReason, runStep, runTimeOf } from './model';
import { RoleAvatar, useRoleName } from './RoleAvatar';

/**
 * The vocabulary of a flow run, in one place for every screen that shows one: the step by its column
 * (refinado in Backlog, comprobación in Por hacer), its verb while it runs, and the reason it failed,
 * worded from its cause in the person's language with the core's raw English kept under it.
 */

const BADGE_ICON: Partial<Record<FlowRunStatus, ReactNode>> = {
  queued: <Clock size={11} strokeWidth={2} aria-hidden />,
  passed: <Check size={11} strokeWidth={2.25} aria-hidden />,
  failed: <X size={11} strokeWidth={2.25} aria-hidden />,
  rejected: <CornerDownLeft size={11} strokeWidth={2} aria-hidden />,
};

const BADGE_TONE: Partial<Record<FlowRunStatus, string>> = {
  running: 'badge-active',
  passed: 'badge-ok',
  failed: 'badge-bad',
};

/** A run's state as a badge: live while it runs, ok when it passed, bad when it failed; always with its word. */
export function RunBadge({ run }: { run: FlowRun }) {
  const { t } = useTranslation('team');
  const status = flowRunStatus(run);
  return (
    <span className={`badge flow-run-badge ${BADGE_TONE[status] ?? ''}`.trim()} data-status={status}>
      {BADGE_ICON[status]}
      {t(`run.badge.${status}`)}
    </span>
  );
}

/** The causes a failed run has, each worded as a title, what it means for the item, and a short form. */
const FAILURES = [
  'budget',
  'no-account',
  'rate-limit',
  'stopped',
  'unreadable',
  'no-verdict',
  'max-tokens',
  'not-started',
  'not-continued',
  'chat-ended',
  'chat-failed',
  'conflict-unresolved',
  'unknown',
] as const;
type Failure = (typeof FAILURES)[number];
const isFailure = (reason: string): reason is Failure => (FAILURES as readonly string[]).includes(reason);

/** The causes a cancelled run has, each one line. */
const CANCELS = ['item-moved', 'item-removed', 'item-done', 'replaced', 'flow-off', 'no-member', 'refined', 'chat-busy'] as const;
type Cancel = (typeof CANCELS)[number];
const isCancel = (reason: string): reason is Cancel => (CANCELS as readonly string[]).includes(reason);

/** A run's reason in words: a bold sentence, what it means for the item, and a short form for one line. */
export function useRunReason(): (run: FlowRun) => { title: string; body: string; short: string } | null {
  const { t } = useTranslation(['team', 'tasks']);
  const roleName = useRoleName();
  return (run) => {
    const reason = runReason(run);
    if (reason === null || run.outcome !== 'failed') return null;
    const column = t(`tasks:${columnMeta(run.column).label}`);
    const role = roleName(run.role);
    if (reason === 'restarts')
      return { title: t('cause.restarts.title', { count: run.restarts + 1 }), body: t('cause.restarts.body', { role }), short: t('cause.restarts.short') };
    // A cause only a cancellation has, on a failed run, is told as a failure whose reason is not known
    const cause: Failure = isFailure(reason) ? reason : 'unknown';
    const short = cause === 'unknown' ? run.error?.trim() || t('cause.unknown.short') : t(`cause.${cause}.short`);
    return { title: t(`cause.${cause}.title`), body: t(`cause.${cause}.body`, { column }), short };
  };
}

/** What a cancelled run's line says: why it never started, or was replaced. */
export function useCancelNote(): (run: FlowRun) => string | null {
  const { t } = useTranslation('team');
  return (run) => {
    const reason = runReason(run);
    if (run.outcome !== 'cancelled' || reason === null) return null;
    if (isCancel(reason)) return t(`cause.${reason}.note`);
    return run.error?.trim() || t('cause.cancelledUnknown');
  };
}

/**
 * "Retry": queues the failed run's step again for its item (`POST /flow-runs/:runId/retry`). The
 * button shows only while the server says it would (`retryable`); a 409 means that changed since.
 */
export function useRetryFlowRun(projectId: string) {
  const { t } = useTranslation('team');
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.retryFlowRun(runId),
    onSuccess: () => toast.success(t('run.retryQueued')),
    onError: (error) => toast.error(t('run.retryFailed'), error),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.flowRunsOf(projectId) });
      void queryClient.invalidateQueries({ queryKey: keys.flow(projectId) });
      void queryClient.invalidateQueries({ queryKey: keys.team(projectId) });
    },
  });
}

/** A running clock, ticking each second: `m:ss` from the first second, so its width holds. */
export function RunClock({ since, className = 'flow-run-clock' }: { since: string; className?: string }) {
  const tick = useClockTick(1000);
  const elapsed = useMemo(() => formatElapsed(elapsedSince(since)), [since, tick]);
  return <time className={className}>{elapsed}</time>;
}

/**
 * What a running run does now, as the design's strip says it: the braille spinner, the step's verb
 * ("Implementando", never the chat's own tool verb, which the sidebar already says), and what it is
 * on in mono. `lead` goes after the spinner: a member's line names the item there.
 */
export function RunNow({ run, lead, className = '' }: { run: FlowRun; lead?: ReactNode; className?: string }) {
  const { t } = useTranslation('team');
  const activity = chatActivity(run);
  const target = activity ? activityTarget(activity) : '';
  return (
    <span className={`flow-run-now ${className}`.trim()}>
      <Spinner className="flow-run-spin" />
      {lead}
      <span className="flow-run-verb">{t(`step.${runStep(run)}.doing`)}</span>
      {target && <span className="flow-run-target">{target}</span>}
    </span>
  );
}

/**
 * When a run did something, as its list reads it: a clock while it runs, a relative time today
 * ("12 min"), and the bare hour before today, where the day's head already says which day it is.
 */
export function RunWhen({ run, days }: { run: FlowRun; days: number | null }) {
  if (run.state === 'running' && run.startedAt) return <RunClock since={run.startedAt} />;
  const at = runTimeOf(run);
  return <time dateTime={at}>{days !== null && days > 0 ? formatHour(at) : timeAgo(at)}</time>;
}

/** The failed run's reason, the raw error under it, and its way on: the chat, "Retry", or what the retry did. */
export function RunWhy({ run, phone, projectId }: { run: FlowRun; phone: boolean; projectId: string }) {
  const { t } = useTranslation('team');
  const reason = useRunReason()(run);
  const retry = useRetryFlowRun(projectId);
  if (!reason) return null;
  // The run that took this one's place once it failed: what the retry, or the flow, did next
  const next = run.retriedBy;
  const retried = next && t(`run.retriedBy.${next.state === 'ended' ? (next.outcome ?? 'failed') : next.state}`, { when: next.endedAt ? timeAgo(next.endedAt) : '' });
  return (
    <div className="flow-run-why">
      <X size={14} strokeWidth={2} aria-hidden className="flow-run-why-icon" />
      <span className="flow-run-why-text">
        <span>
          <b>{reason.title}</b> {reason.body}
        </span>
        {!phone && (
          <span className="flow-run-why-acts">
            {run.error && <span className="flow-run-raw">{run.error}</span>}
            {run.chatId && (
              <Link to={`/chats/${run.chatId}`} className="team-link">
                {t('run.openChat')}
              </Link>
            )}
            {next ? (
              <span className="flow-run-retried">
                <RotateCcw size={12} strokeWidth={1.75} aria-hidden />
                {next.chatId ? (
                  <Link to={`/chats/${next.chatId}`} className="flow-run-retried-link">
                    {retried}
                  </Link>
                ) : (
                  retried
                )}
              </span>
            ) : (
              run.retryable && (
                <button type="button" className="btn btn-small btn-quiet flow-run-retry" disabled={retry.isPending} onClick={() => retry.mutate(run.id)}>
                  <RotateCcw size={13} strokeWidth={1.75} aria-hidden />
                  {t('run.retry')}
                </button>
              )
            )}
          </span>
        )}
      </span>
    </div>
  );
}

/** What a run that did not fail says under its item: the summary it wrote, why it waits, or why it never started. */
function useRunLine(): (run: FlowRun, context: RunContext) => string | null {
  const { t } = useTranslation('team');
  const cancelNote = useCancelNote();
  return (run, context) => {
    if (run.state === 'queued') {
      if (run.stage === 'work' && run.chatId) return t('run.resumes');
      if (context.running >= context.maxParallel) return t('run.waitsPlace', { running: context.running, max: context.maxParallel });
      return t('run.waitsTurn');
    }
    if (run.outcome === 'cancelled') return cancelNote(run);
    if (run.state !== 'ended' || run.outcome === 'failed') return null;
    const summary = run.summary?.trim();
    if (run.outcome === 'rejected') return summary ? `«${summary}»` : null;
    // Where the item stands now, when it still stands where this run left it
    const after =
      run.stage === 'verify' && run.item?.status === 'in_review' ? t('run.waitsForYou') : run.stage === 'work' && run.item?.status === 'in_review' ? t('run.passedToReview') : null;
    return [summary, after].filter(Boolean).join(' · ') || null;
  };
}

/** What a row of the activity needs of the flow around it: how full the queue is. */
export interface RunContext {
  running: number;
  maxParallel: number;
}

/**
 * One run of Team activity (`.flow-run`, the design's `.run-row`): the role's squircle, who and which
 * step with the run's state, the item it was for, what it does now or what came of it, and the time
 * with its duration. A failed run carries its reason; a running one the live rail. On a phone the
 * whole row opens the run's chat, so nothing inside it is a control of its own.
 */
export function FlowRunRow({ run, days, context, phone, projectId }: { run: FlowRun; days: number | null; context: RunContext; phone: boolean; projectId: string }) {
  const { t } = useTranslation('team');
  const roleName = useRoleName();
  const line = useRunLine()(run, context);
  const role = roleName(run.role);
  const step = t(`step.${runStep(run)}.name`);
  const live = run.state === 'running';
  const duration = runDuration(run);
  const label = run.item ? t('run.label', { role, step, key: run.item.key }) : t('run.labelGone', { role, step });
  const itemLine = run.item ? (
    phone ? (
      <span className="flow-run-item">
        <WorkItemKey value={run.item.key} />
        <span className="flow-run-item-title">{run.item.title}</span>
      </span>
    ) : (
      <Link to={taskPath(run.item.key)} className="flow-run-item">
        <WorkItemKey value={run.item.key} />
        <span className="flow-run-item-title ellipsis">{run.item.title}</span>
      </Link>
    )
  ) : (
    <span className="flow-run-item is-gone">{t('run.itemGone')}</span>
  );
  const durationText = duration !== null ? formatDuration(duration) : null;
  const body = (
    <>
      <RoleAvatar role={run.role} />
      <div className="flow-run-main">
        <span className="flow-run-title">
          {/* Who and the step wrap as one, so a narrow row moves the badge down rather than splitting them */}
          <span className="flow-run-actor">
            <span className="who">{role}</span> <span className="stage">· {step}</span>
          </span>
          <RunBadge run={run} />
        </span>
        {itemLine}
        {live ? <RunNow run={run} /> : line && <span className="flow-run-line">{line}</span>}
        {phone && durationText && <span className="flow-run-duration">{durationText}</span>}
      </div>
      <span className="flow-run-side">
        <RunWhen run={run} days={days} />
        {!phone && live && run.chatId && (
          <Link to={`/chats/${run.chatId}`} className="team-link">
            {t('run.openChat')}
          </Link>
        )}
        {!phone && durationText && <span className="flow-run-duration">{durationText}</span>}
      </span>
      {run.outcome === 'failed' && <RunWhy run={run} phone={phone} projectId={projectId} />}
    </>
  );
  const className = `flow-run ${live ? 'live-rail' : ''}`.trim();
  const status = flowRunStatus(run);
  if (phone && run.chatId)
    return (
      <Link to={`/chats/${run.chatId}`} className={className} aria-label={label} data-status={status}>
        {body}
      </Link>
    );
  return (
    <article className={className} aria-label={label} data-status={status}>
      {body}
    </article>
  );
}
