import type { FlowRun, FlowRunStatus, Team } from '@agentry/shared';
import { FLOW_RUN_STATUSES, flowRunStatus } from '@agentry/shared';
import { ChevronLeft, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useFlowRuns } from '../../api';
import { Select } from '../../components/controls';
import { ICON, ICON_SM } from '../../components/icons';
import { Spinner } from '../../components/Spinner';
import { ErrorBox, Skeleton } from '../../components/ui';
import { formatNumber, timeAgo } from '../../lib/format';
import { taskPath } from '../../lib/work-items';
import { runNote } from './model';
import { runTime } from './parts';
import { RoleAvatar, useRoleName } from './RoleAvatar';

const ALL = '';

/** A run's state in one word, in the colour it means: failed is bad, cancelled stopped, running live. */
function RunStatus({ run }: { run: FlowRun }) {
  const { t } = useTranslation('team');
  const status = flowRunStatus(run);
  const tone = status === 'failed' ? 'text-err' : status === 'cancelled' ? 'text-warn' : status === 'running' ? 'is-live' : undefined;
  return <span className={`team-run-status ${tone ?? ''}`.trim()}>{status === 'passed' ? t(`stage.${run.stage}.done`) : t(`activity.status.${status}`)}</span>;
}

/** One run of the activity: who, which item and what came of it, why, and when; its chat beside. */
function ActivityRow({ run }: { run: FlowRun }) {
  const { t } = useTranslation('team');
  const roleName = useRoleName();
  const live = run.state === 'running';
  const note = runNote(run);
  return (
    <li className={`team-activity-row team-log-row ${live ? 'live-rail' : ''}`.trim()} data-status={flowRunStatus(run)}>
      <span className="team-activity-who">{live ? <Spinner variant="ring" className="member-run-spin" /> : <RoleAvatar role={run.role} size="sm" />}</span>
      <span className="team-activity-text">
        <span className="team-log-line">
          {run.item ? (
            <Link to={taskPath(run.item.key)} className="team-activity-key">
              {run.item.key}
            </Link>
          ) : (
            <span className="team-muted">{t('member.itemGone')}</span>
          )}
          {run.item && <span className="ellipsis team-log-title">{run.item.title}</span>}
          <RunStatus run={run} />
        </span>
        <span className="team-activity-cause" title={note ?? undefined}>
          {roleName(run.role)} · {note ?? t(`stage.${run.stage}.name`)}
        </span>
      </span>
      {run.chatId && (
        <Link to={`/chats/${run.chatId}`} className="icon-btn team-log-chat" aria-label={t('activity.openChat', { key: run.item?.key ?? '' })}>
          <MessageCircle {...ICON_SM} />
        </Link>
      )}
      <time className="team-activity-time" dateTime={runTime(run)}>
        {timeAgo(runTime(run))}
      </time>
    </li>
  );
}

/**
 * The team's activity, whole (`?view=team&section=activity`, "See all"): every flow run of the
 * project, newest first, filtered by member and by state, a page at a time. The Team screen's card
 * only holds each member's latest.
 */
export function TeamActivityView({ projectId, team, backHref, phone }: { projectId: string; team: Team; backHref: string; phone: boolean }) {
  const { t } = useTranslation('team');
  const roleName = useRoleName();
  const [agent, setAgent] = useState<string>(ALL);
  const [status, setStatus] = useState<FlowRunStatus | typeof ALL>(ALL);
  const pages = useFlowRuns(projectId, { ...(agent ? { agent: [agent] } : {}), ...(status ? { status: [status] } : {}) });
  const runs = pages.data?.pages.flatMap((page) => page.runs) ?? [];
  const total = pages.data?.pages[0]?.total ?? 0;
  const filtered = agent !== ALL || status !== ALL;

  const filters = (
    <div className="team-log-filters">
      <Select<string>
        className="team-log-filter"
        value={agent}
        onChange={setAgent}
        aria-label={t('activity.member')}
        options={[{ value: ALL, label: t('activity.allMembers') }, ...team.members.map((member) => ({ value: member.agent, label: roleName(member.role) }))]}
      />
      <Select<FlowRunStatus | typeof ALL>
        className="team-log-filter"
        value={status}
        onChange={setStatus}
        aria-label={t('activity.state')}
        options={[{ value: ALL, label: t('activity.allStates') }, ...FLOW_RUN_STATUSES.map((value) => ({ value, label: t(`activity.filter.${value}`) }))]}
      />
      <span className="grow" />
      {pages.data && <span className="team-log-count">{t('activity.count', { count: total, n: formatNumber(total) })}</span>}
    </div>
  );

  let body;
  if (pages.error && !pages.data) body = <ErrorBox error={pages.error} />;
  else if (!pages.data) body = <Skeleton rows={6} height={20} />;
  else if (runs.length === 0) body = <p className="team-muted team-log-empty">{filtered ? t('activity.noMatch') : t('activity.none')}</p>;
  else
    body = (
      <>
        <ul className="team-activity team-log">
          {runs.map((run) => (
            <ActivityRow key={run.id} run={run} />
          ))}
        </ul>
        {pages.hasNextPage && (
          <button type="button" className="btn team-log-more" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
            {t('activity.more', { n: formatNumber(total - runs.length) })}
          </button>
        )}
      </>
    );

  return (
    <div className={`team-page team-log-page ${phone ? 'is-phone' : ''}`.trim()}>
      {!phone && (
        <div className="team-toolbar">
          <Link to={backHref} className="icon-btn" aria-label={t('activity.back')}>
            <ChevronLeft {...ICON} />
          </Link>
          <h2 className="team-log-heading">{t('activity.title')}</h2>
        </div>
      )}
      <section className="card team-log-card" aria-label={t('activity.title')}>
        {filters}
        {body}
      </section>
    </div>
  );
}
