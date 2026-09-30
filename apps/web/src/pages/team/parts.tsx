import type { FlowRun, TeamMember } from '@agentry/shared';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Monogram } from '@agentry/ui/components/icons';
import { WorkItemKey, WorkItemStatusIcon } from '../../components/work-item-icons';
import { timeAgo } from '@agentry/ui/lib/format';
import { columnMeta, taskPath } from '../../lib/work-items';
import { runNote, runStep, runTimeOf } from './model';
import { RoleAvatar, useRoleName } from './RoleAvatar';
import { RunClock, RunNow, useRunReason } from './runs';

/** How a run that ended is told at rest: "refinada", "devuelta", "falló al comprobarla". */
export function useRunDone(): (run: FlowRun) => string {
  const { t } = useTranslation('team');
  return (run) => {
    if (run.outcome === 'passed') return t(`stage.${run.stage}.done`);
    if (run.outcome === 'rejected') return t('outcome.rejected');
    if (run.outcome === 'failed') return t(`step.${runStep(run)}.failed`).toLowerCase();
    if (run.outcome === 'cancelled') return t('outcome.cancelled');
    return t('outcome.queued');
  };
}

/** A run's outcome in words, in the bad colour when it failed: a colour never goes without its word. */
export function RunOutcome({ run }: { run: FlowRun }) {
  const done = useRunDone();
  return <span className={run.outcome === 'failed' ? 'text-err' : undefined}>{done(run)}</span>;
}

/**
 * The failed run that explains a member now: its last run failed and nothing has run that step on
 * the item since. It outranks the queue, since it is what the person has to act on.
 */
export const memberFailure = (member: Pick<TeamMember, 'running' | 'lastRun'>): FlowRun | null =>
  member.running.length === 0 && member.lastRun?.outcome === 'failed' && !member.lastRun.retriedBy ? member.lastRun : null;

/**
 * What a member does now: the live line of its run (the one thing on the card that moves), a failure
 * in bad with its reason, or, at rest, its last work, still. `compact` is the phone's line under a
 * member's name.
 */
export function MemberNow({ member, compact = false }: { member: TeamMember; compact?: boolean }) {
  const { t } = useTranslation('team');
  const reason = useRunReason();
  const run = member.running[0];
  const base = compact ? 'member-now-line' : 'member-now';
  if (run)
    return (
      <div className={`${base} is-live`}>
        <RunNow run={run} lead={run.item && <WorkItemKey value={run.item.key} />} className="member-now-ticker" />
        {member.running.length > 1 && <span className="member-now-more">{t('member.more', { count: member.running.length - 1 })}</span>}
        {!compact && run.startedAt && <RunClock since={run.startedAt} className="team-live-time" />}
      </div>
    );
  const failed = memberFailure(member);
  const why = failed && reason(failed);
  if (failed && why)
    return (
      <div className={`${base} is-failed`} title={failed.error ?? undefined}>
        <X size={13} strokeWidth={2} aria-hidden className="member-now-fail-icon" />
        <span className="member-now-fail">{t('run.failed')}</span>
        {failed.item && <WorkItemKey value={failed.item.key} />}
        <span className="ellipsis member-now-why">{why.short}</span>
        {!compact && <time className="team-live-time">{timeAgo(runTimeOf(failed))}</time>}
      </div>
    );
  const last = member.lastRun;
  return (
    <div className={base}>
      <span>{t('member.idle')}</span>
      {member.queued > 0 && (
        <>
          <span aria-hidden>·</span>
          <span>{t('member.queued', { count: member.queued })}</span>
        </>
      )}
      {!compact && last && member.queued === 0 && (
        <>
          <span aria-hidden>·</span>
          {last.item && <WorkItemKey value={last.item.key} />}
          <span className="ellipsis" title={runNote(last) ?? undefined}>
            <RunOutcome run={last} /> {timeAgo(runTimeOf(last))}
          </span>
        </>
      )}
    </div>
  );
}

/** The person's own mark where the flow names who approves Done: round, never a role's squircle. */
export function PersonMark({ size = 22 }: { size?: number }) {
  const { t } = useTranslation('team');
  return (
    <span className="team-person" role="img" aria-label={t('flow.you')} title={t('flow.youApprove')}>
      <Monogram name={t('flow.you')} size={size} />
    </span>
  );
}

/** The Team screen's summary of the flow: who answers for each column, and the bounce limit. */
export function FlowSummary({
  columns,
  enabled,
  saved,
  maxBounces,
  editHref,
}: {
  columns: Partial<Record<string, string>>;
  enabled: boolean;
  /** False while the project never saved a flow: nobody answers for any column yet */
  saved: boolean;
  maxBounces: number;
  editHref: string;
}) {
  const { t } = useTranslation(['team', 'tasks']);
  const roleName = useRoleName();
  const statuses = ['backlog', 'todo', 'in_progress', 'in_review'] as const;
  return (
    <section className="card team-side-card" aria-labelledby="team-flow-summary">
      <div className="card-head">
        <h2 id="team-flow-summary">{t('flow.summaryTitle')}</h2>
        <span className="team-side-head-end">
          <span className="badge badge-muted team-flow-state">
            {saved && enabled && <Check size={11} strokeWidth={2.25} aria-hidden />}
            {!saved ? t('flow.notSet') : enabled ? t('flow.on') : t('flow.off')}
          </span>
          <Link to={editHref} className="team-link">
            {saved ? t('flow.edit') : t('flow.setUp')}
          </Link>
        </span>
      </div>
      <ul className="team-flow-summary">
        {statuses.map((status) => {
          const role = columns[status];
          return (
            <li key={status}>
              <WorkItemStatusIcon status={status} decorative />
              <span className="grow">{t(`tasks:${columnMeta(status).label}`)}</span>
              {role ? (
                <>
                  <RoleAvatar role={role} size="sm" />
                  <span className="team-flow-who">{roleName(role)}</span>
                </>
              ) : (
                <span className="team-flow-who is-none">{t('flow.nobody')}</span>
              )}
            </li>
          );
        })}
        <li>
          <WorkItemStatusIcon status="done" decorative />
          <span className="grow">{t('tasks:status.done')}</span>
          <PersonMark size={22} />
          <span className="team-flow-who">{t('flow.youApproveShort')}</span>
        </li>
      </ul>
      <p className="team-flow-foot">{saved ? t('flow.bouncesLine', { count: maxBounces }) : t('flow.notSetLine')}</p>
    </section>
  );
}

/** The team's latest work: each member's run going now, or its last. Rows lead to the item; "See all" to every run. */
export function TeamActivity({ runs, allHref }: { runs: FlowRun[]; allHref: string }) {
  const { t } = useTranslation('team');
  const roleName = useRoleName();
  const reason = useRunReason();
  return (
    <section className="card team-side-card" aria-labelledby="team-activity">
      <div className="card-head">
        <h2 id="team-activity">{t('activity.title')}</h2>
        {runs.length > 0 && (
          <Link to={allHref} className="team-link">
            {t('activity.seeAll')}
          </Link>
        )}
      </div>
      {runs.length === 0 ? (
        <p className="team-muted">{t('activity.none')}</p>
      ) : (
        <ul className="team-activity">
          {runs.map((run) => {
            const note = reason(run)?.short ?? runNote(run) ?? t(`step.${runStep(run)}.name`);
            return (
              <li key={run.id} className="team-activity-row" data-status={run.outcome ?? run.state}>
                <RoleAvatar role={run.role} size="sm" />
                <span className="team-activity-text">
                  <span>
                    {run.item ? (
                      <Link to={taskPath(run.item.key)} className="team-activity-key">
                        {run.item.key}
                      </Link>
                    ) : null}{' '}
                    {run.state === 'running' ? <span className="team-activity-live">{t(`step.${runStep(run)}.doing`)}</span> : run.state === 'queued' ? t('outcome.queued') : <RunOutcome run={run} />}
                  </span>
                  <span className="team-activity-cause" title={note}>
                    {roleName(run.role)} · {note}
                  </span>
                </span>
                <time className="team-activity-time">{timeAgo(runTimeOf(run))}</time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
