import type { FlowRun, TeamMember } from '@agentry/shared';
import { FLOW_RUNS_PAGE_MAX } from '@agentry/shared';
import { MessageCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useFlowRuns } from '../../api';
import { ICON_SM, WorkItemKey } from '../../components/icons';
import { Spinner } from '../../components/Spinner';
import { formatNumber, timeAgo } from '../../lib/format';
import { taskPath } from '../../lib/work-items';
import { memberRuns, runNote, runTimeOf } from './model';
import { RunBadge, RunClock, RunNow, useRunReason } from './runs';

/** Lines "now and before" lists: the member's latest; every run is on the team's activity. */
const SHOWN = 5;

/** A line of "now and before": a run going now (live), queued, or ended, leading to its item. */
export function RunRow({ run }: { run: FlowRun }) {
  const { t } = useTranslation('team');
  const reason = useRunReason()(run);
  const live = run.state === 'running';
  // A failure says its reason in the person's language; the raw text stays in the tooltip
  const note = reason ? reason.short : runNote(run);
  const body = (
    <>
      {live ? <Spinner variant="ring" className="member-run-spin" /> : <MessageCircle {...ICON_SM} className="member-run-icon" />}
      <span className="member-run-text">
        <span className="member-run-title">
          {run.item && <WorkItemKey value={run.item.key} />}
          <span className="member-run-name">{run.item?.title ?? t('member.itemGone')}</span>
        </span>
        <span className="member-run-state">{live ? <RunNow run={run} /> : <RunBadge run={run} />}</span>
        {note && (
          <span className={`member-run-note ${reason ? 'is-failed' : ''}`.trim()} title={run.error ?? note}>
            {note}
          </span>
        )}
      </span>
      {live ? run.startedAt && <RunClock since={run.startedAt} className="team-live-time" /> : <time className="member-run-time">{timeAgo(runTimeOf(run))}</time>}
    </>
  );
  const className = `member-run ${live ? 'live-rail' : ''}`.trim();
  return run.item ? (
    <Link to={taskPath(run.item.key)} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/**
 * "Now and before": what the member does now, then its latest runs, and how many tasks it has worked
 * on. The runs come from the team's activity (`GET /projects/:id/flow/runs`, this member only); until
 * they arrive, and should they fail, the team's own snapshot of the member stands in.
 */
export function NowAndBefore({ projectId, member }: { projectId: string; member: TeamMember }) {
  const { t } = useTranslation('team');
  const pages = useFlowRuns(projectId, { agent: [member.agent], limit: FLOW_RUNS_PAGE_MAX });
  const first = pages.data?.pages[0];
  const { runs, tasks } = memberRuns(member, first?.runs);
  const more = Boolean(first?.nextCursor);
  return (
    <section className="member-aside-section" aria-labelledby="member-runs-title">
      <div className="member-aside-head">
        <span id="member-runs-title" className="section-label grow">
          {t('member.nowAndBefore')}
        </span>
        {tasks > 0 && <span className="member-run-count">{t(more ? 'member.tasksMore' : 'member.tasks', { count: tasks, n: formatNumber(tasks) })}</span>}
      </div>
      {runs.length === 0 ? <p className="team-muted">{t('member.noRuns')}</p> : runs.slice(0, SHOWN).map((run) => <RunRow key={run.id} run={run} />)}
      {member.queued > 0 && <p className="team-muted">{t('member.queued', { count: member.queued })}</p>}
    </section>
  );
}
