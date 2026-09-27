import type { FlowRun, TeamMember } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ActivityTicker } from '../../components/ActivityTicker';
import { Monogram, WorkItemKey, WorkItemStatusIcon } from '../../components/icons';
import { Spinner } from '../../components/Spinner';
import { timeAgo } from '../../lib/format';
import { chatActivity } from '../../lib/shell-live';
import { columnMeta, taskPath } from '../../lib/work-items';
import { RoleAvatar, useRoleName } from './RoleAvatar';

/** What a run is doing now, as the live line of a card says it: its verb, what it is on, and the time. */
export function RunTicker({ run, className = '', showTime = true }: { run: FlowRun; className?: string; showTime?: boolean }) {
  const { t } = useTranslation('team');
  const activity = chatActivity(run);
  if (activity) return <ActivityTicker activity={activity} className={className} showElapsed={showTime} />;
  return (
    <span className={`team-run-working ${className}`.trim()}>
      <Spinner className="team-live-spin" />
      <span className="team-live-verb">{t(`stage.${run.stage}.doing`)}</span>
    </span>
  );
}

/** How a run that ended is told at rest: "refined", "sent back", "failed". */
export function useRunDone(): (run: FlowRun) => string {
  const { t } = useTranslation('team');
  return (run) => {
    if (run.outcome === 'passed') return t(`stage.${run.stage}.done`);
    if (run.outcome === 'rejected') return t('outcome.rejected');
    if (run.outcome === 'failed') return t('outcome.failed');
    if (run.outcome === 'cancelled') return t('outcome.cancelled');
    return t('outcome.queued');
  };
}

/** When a run last did something: it ended, it started, or it was queued. */
export const runTime = (run: FlowRun): string => run.endedAt ?? run.startedAt ?? run.queuedAt;

/**
 * What a member is doing now: the live line of its run (the one thing on the card that moves), or,
 * at rest, its last work, still. `compact` is the phone's line under a member's name.
 */
export function MemberNow({ member, compact = false }: { member: TeamMember; compact?: boolean }) {
  const { t } = useTranslation('team');
  const done = useRunDone();
  const run = member.running[0];
  if (run)
    return (
      <div className={compact ? 'member-now-line is-live' : 'member-now is-live'}>
        {run.item && <WorkItemKey value={run.item.key} />}
        <RunTicker run={run} className="member-now-ticker" />
        {member.running.length > 1 && <span className="member-now-more">{t('member.more', { count: member.running.length - 1 })}</span>}
      </div>
    );
  const last = member.lastRun;
  return (
    <div className={compact ? 'member-now-line' : 'member-now'}>
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
          <span className="ellipsis">
            {done(last)} {timeAgo(runTime(last))}
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
export function FlowSummary({ columns, enabled, maxBounces, editHref }: { columns: Partial<Record<string, string>>; enabled: boolean; maxBounces: number; editHref: string }) {
  const { t } = useTranslation(['team', 'tasks']);
  const roleName = useRoleName();
  const statuses = ['backlog', 'todo', 'in_progress', 'in_review'] as const;
  return (
    <section className="card team-side-card" aria-labelledby="team-flow-summary">
      <div className="card-head">
        <h2 id="team-flow-summary">{t('flow.summaryTitle')}</h2>
        <span className="team-side-head-end">
          <span className="badge badge-muted team-flow-state">{enabled ? t('flow.on') : t('flow.off')}</span>
          <Link to={editHref} className="team-link">
            {t('flow.edit')}
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
      <p className="team-flow-foot">{t('flow.bouncesLine', { count: maxBounces })}</p>
    </section>
  );
}

/** The team's latest work: each member's run going now, or its last. Rows lead to the item. */
export function TeamActivity({ runs }: { runs: FlowRun[] }) {
  const { t } = useTranslation('team');
  const roleName = useRoleName();
  const done = useRunDone();
  return (
    <section className="card team-side-card" aria-labelledby="team-activity">
      <div className="card-head">
        <h2 id="team-activity">{t('activity.title')}</h2>
      </div>
      {runs.length === 0 ? (
        <p className="team-muted">{t('activity.none')}</p>
      ) : (
        <ul className="team-activity">
          {runs.map((run) => (
            <li key={run.id} className="team-activity-row">
              <RoleAvatar role={run.role} size="sm" />
              <span className="team-activity-text">
                <span>
                  {run.item ? (
                    <Link to={taskPath(run.item.key)} className="team-activity-key">
                      {run.item.key}
                    </Link>
                  ) : null}{' '}
                  {run.state === 'running' ? t(`stage.${run.stage}.doing`) : run.state === 'queued' ? t('outcome.queued') : done(run)}
                </span>
                <span className="team-activity-cause">
                  {roleName(run.role)} · {run.summary && run.state === 'ended' ? run.summary : t(`stage.${run.stage}.name`)}
                </span>
              </span>
              <time className="team-activity-time">{timeAgo(runTime(run))}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
