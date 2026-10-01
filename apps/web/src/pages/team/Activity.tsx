import type { FlowRun, FlowRunStatus, ProjectFlowSettings, Team } from '@agentry/shared';
import { DEFAULT_FLOW_MAX_PARALLEL, FLOW_RUNS_PAGE, FLOW_RUNS_PAGE_MAX } from '@agentry/shared';
import { ChevronDown, Filter, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useFlow, useFlowRuns } from '../../api';
import { Sheet } from '@agentry/ui/components/controls';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { ErrorBox, Segmented, Skeleton } from '@agentry/ui/components/ui';
import { intlLocale } from '@agentry/ui/i18n/language';
import { formatCost, formatNumber } from '@agentry/ui/lib/format';
import { columnsOf, groupRuns, runDay, type RunDay, type RunGroup } from './model';
import { FlowRunRow, type RunContext } from './runs';
import { RoleAvatar, useRoleName } from './RoleAvatar';

/** The activity's views, as its segmented control offers them; each is a filter on the runs' status. */
export type LogView = 'all' | 'running' | 'failed' | 'rejected';

const VIEW_STATUS: Record<Exclude<LogView, 'all'>, FlowRunStatus[]> = {
  running: ['running'],
  failed: ['failed'],
  rejected: ['rejected'],
};

/** A day's head: "Hoy", "Ayer · domingo 27", or the weekday and date before that. */
function useDayHead(): (group: Extract<RunGroup, { kind: 'day' }>) => string {
  const { t } = useTranslation('team');
  return (group) => {
    if (group.days === 0) return t('log.today');
    const date = new Date(group.at);
    const weekday = new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', day: 'numeric' }).format(date);
    if (group.days === 1) return t('log.yesterday', { date: weekday });
    return new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  };
}

/** One line of today's figures, the numbers in mono: "Hoy 9 ejecuciones · 2 en marcha · 2 en cola · 1 fallida". */
function DaySummary({ day }: { day: RunDay }) {
  const { t } = useTranslation('team');
  const b = { b: <b /> };
  const n = (value: number) => formatNumber(value);
  return (
    <div className="flow-run-sum">
      <span>
        <Trans t={t} i18nKey="log.summary.today" count={day.runs} values={{ n: n(day.runs) }} components={b} />
      </span>
      <span>
        <Trans t={t} i18nKey="log.summary.running" values={{ n: n(day.running) }} components={b} />
      </span>
      <span>
        <Trans t={t} i18nKey="log.summary.queued" values={{ n: n(day.queued) }} components={b} />
      </span>
      <span>
        <Trans t={t} i18nKey="log.summary.failed" count={day.failed} values={{ n: n(day.failed) }} components={b} />
      </span>
    </div>
  );
}

/** "By member · today": who ran how much, a failure said in words; and who the flow never runs. */
function ByMember({ team, flow, day }: { team: Team; flow: ProjectFlowSettings; day: RunDay }) {
  const { t } = useTranslation('team');
  const roleName = useRoleName();
  const answering = team.members.filter((member) => columnsOf(flow, member.role).length > 0);
  const consulted = team.members.filter((member) => columnsOf(flow, member.role).length === 0);
  const names = new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(consulted.map((member) => roleName(member.role)));
  return (
    <section className="card team-side-card flow-log-members" aria-labelledby="flow-log-members">
      <div className="card-head">
        <h2 id="flow-log-members">{t('log.byMember')}</h2>
        <span className="team-side-note">{t('log.todayWord')}</span>
      </div>
      <ul className="flow-log-member-rows">
        {answering.map((member) => {
          const own = day.byAgent[member.agent];
          return (
            <li key={member.agent} className="flow-log-member">
              <RoleAvatar role={member.role} size="sm" />
              <span className="flow-log-member-text">
                <span>{roleName(member.role)}</span>
                {own && own.failed > 0 && (
                  <span className="flow-log-member-failed">
                    <X size={12} strokeWidth={2} aria-hidden />
                    {t('log.memberFailed', { count: own.failed })}
                  </span>
                )}
              </span>
              <span className="flow-log-member-runs">{t('log.memberRuns', { n: formatNumber(own?.runs ?? 0) })}</span>
            </li>
          );
        })}
      </ul>
      {consulted.length > 0 && <p className="field-hint">{t('log.consulted', { count: consulted.length, names })}</p>}
    </section>
  );
}

/** The flow's limits as they stand, with the way to change them. */
function Limits({ flow, running, queued, editHref }: { flow: ProjectFlowSettings; running: number; queued: number; editHref: string }) {
  const { t } = useTranslation('team');
  const parallel = flow.maxParallel ?? DEFAULT_FLOW_MAX_PARALLEL;
  return (
    <section className="card team-side-card flow-log-limits" aria-labelledby="flow-log-limits">
      <div className="card-head">
        <h2 id="flow-log-limits">{t('log.limits')}</h2>
        <Link to={editHref} className="team-link">
          {t('flow.edit')}
        </Link>
      </div>
      <div className="prop-row">
        <span className="prop-key">{t('log.atOnce')}</span>
        <span className="flow-log-limit">
          <span className="num">{formatNumber(parallel)}</span>
          <span className="team-muted">{t('log.inUse', { running: formatNumber(running), queued: formatNumber(queued) })}</span>
        </span>
      </div>
      <div className="prop-row">
        <span className="prop-key">{t('log.costPerRun')}</span>
        <span className="flow-log-limit">{flow.maxCostUsd ? <span className="num">{formatCost(flow.maxCostUsd)}</span> : t('flow.noLimit')}</span>
      </div>
      <div className="prop-row">
        <span className="prop-key">{t('log.bounces')}</span>
        <span className="flow-log-limit">
          <span className="num">{formatNumber(flow.maxBounces)}</span>
          <span className="team-muted">{t('log.atMost')}</span>
        </span>
      </div>
    </section>
  );
}

/** The phone's member filter: the header's filter button opens a sheet of big rows. */
function MemberSheet({ team, agent, onChange }: { team: Team; agent: string; onChange: (agent: string) => void }) {
  const { t } = useTranslation('team');
  const roleName = useRoleName();
  const [open, setOpen] = useState(false);
  const options = [{ agent: '', label: t('log.allMembers'), role: null as string | null }, ...team.members.map((member) => ({ agent: member.agent, label: roleName(member.role), role: member.role }))];
  return (
    <>
      <button type="button" className={`icon-btn phone-head-action ${agent ? 'is-on' : ''}`.trim()} aria-label={t('log.filterMember')} aria-pressed={agent !== ''} onClick={() => setOpen(true)}>
        <Filter {...ICON} />
      </button>
      <Sheet open={open} onOpenChange={setOpen} title={t('log.filterMember')} side="bottom">
        <div className="flow-log-sheet" role="listbox" aria-label={t('log.member')}>
          {options.map((option) => (
            <button
              key={option.agent || 'all'}
              type="button"
              role="option"
              aria-selected={option.agent === agent}
              className="flow-log-sheet-option"
              onClick={() => {
                setOpen(false);
                onChange(option.agent);
              }}
            >
              {option.role && <RoleAvatar role={option.role} size="sm" />}
              <span className="grow">{option.label}</span>
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}

/** The member chips of a desktop: "Todos" and each member the flow runs, with how many runs it had today. */
function MemberChips({ team, flow, day, agent, onChange }: { team: Team; flow: ProjectFlowSettings; day: RunDay; agent: string; onChange: (agent: string) => void }) {
  const { t } = useTranslation('team');
  const roleName = useRoleName();
  const shown = team.members.filter((member) => columnsOf(flow, member.role).length > 0 || day.byAgent[member.agent] || member.agent === agent);
  return (
    <div className="flow-log-chips" role="group" aria-label={t('log.member')}>
      <span className="section-label">{t('log.member')}</span>
      <button type="button" className={`chip ${agent === '' ? 'chip-on' : ''}`.trim()} aria-pressed={agent === ''} onClick={() => onChange('')}>
        {t('log.allMembers')}
      </button>
      {shown.map((member) => (
        <button key={member.agent} type="button" className={`chip ${agent === member.agent ? 'chip-on' : ''}`.trim()} aria-pressed={agent === member.agent} onClick={() => onChange(member.agent)}>
          <RoleAvatar role={member.role} size="xs" />
          {roleName(member.role)}
          <span className="n">{formatNumber(day.byAgent[member.agent]?.runs ?? 0)}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Team activity (`?view=team&section=activity`, "See all" and the third view of Team): every flow run
 * of the project, newest first, "Now" on top and then one group per day, filtered by status and
 * member and paged by 50 with "Mostrar 50 más". Beside it, today by member and the flow's limits.
 * On a phone the member filter is a sheet behind the header's button, and a row opens its chat.
 */
export function TeamActivityView({
  projectId,
  team,
  flow,
  switcher,
  flowHref,
  phone,
  head,
}: {
  projectId: string;
  team: Team;
  flow: ProjectFlowSettings;
  switcher: ReactNode;
  flowHref: string;
  phone: boolean;
  /** The phone's header, handed the member filter to carry as its action */
  head?: (action: ReactNode) => ReactNode;
}) {
  const { t } = useTranslation('team');
  const [view, setView] = useState<LogView>('all');
  const [agent, setAgent] = useState('');
  const query = { ...(agent ? { agent: [agent] } : {}), ...(view !== 'all' ? { status: VIEW_STATUS[view] } : {}) };
  const pages = useFlowRuns(projectId, query);
  // Today's figures come from the newest runs of the whole team, whatever the filter shows
  const recent = useFlowRuns(projectId, { limit: FLOW_RUNS_PAGE_MAX });
  const failed = useFlowRuns(projectId, { status: ['failed'], limit: 1 });
  const rejected = useFlowRuns(projectId, { status: ['rejected'], limit: 1 });
  const live = useFlow(projectId);
  const runs = pages.data?.pages.flatMap((page) => page.runs) ?? [];
  const total = pages.data?.pages[0]?.total ?? 0;
  const day = runDay(recent.data?.pages[0]?.runs ?? []);
  const running = live.data?.running.length ?? day.running;
  const queued = live.data?.queued.length ?? day.queued;
  const context: RunContext = { running, maxParallel: live.data?.maxParallel ?? flow.maxParallel ?? DEFAULT_FLOW_MAX_PARALLEL };
  const filtered = agent !== '' || view !== 'all';
  const dayHead = useDayHead();
  const count = (value: number | undefined) => (value ? <span className="count">{formatNumber(value)}</span> : null);

  const views = (
    <Segmented<LogView>
      className="flow-log-views"
      value={view}
      label={t('log.views')}
      onChange={setView}
      options={[
        { value: 'all', label: t('log.all') },
        { value: 'running', label: <>{t('log.running')}{count(running)}</> },
        { value: 'failed', label: <>{t('log.failed')}{count(failed.data?.pages[0]?.total)}</> },
        { value: 'rejected', label: <>{t('log.rejected')}{count(rejected.data?.pages[0]?.total)}</> },
      ]}
    />
  );

  let body: ReactNode;
  if (pages.error && !pages.data) body = <ErrorBox error={pages.error} />;
  else if (!pages.data) body = <Skeleton rows={6} height={20} />;
  else if (runs.length === 0) body = <p className="team-muted flow-log-empty">{filtered ? t('activity.noMatch') : t('activity.none')}</p>;
  else
    body = (
      <>
        {groupRuns(runs).map((group) => (
          <div key={group.kind === 'now' ? 'now' : group.at} className="flow-run-group" role="group" aria-label={group.kind === 'now' ? t('log.now') : dayHead(group)}>
            <div className="flow-run-day">
              <span className="section-label grow">{group.kind === 'now' ? t('log.now') : dayHead(group)}</span>
              <span className="flow-run-day-count">
                {group.kind === 'now' && !phone
                  ? t('log.nowCount', {
                      running: formatNumber(group.runs.filter((run) => run.state === 'running').length),
                      queued: formatNumber(group.runs.filter((run) => run.state === 'queued').length),
                    })
                  : formatNumber(group.runs.length)}
              </span>
            </div>
            {group.runs.map((run: FlowRun) => (
              <FlowRunRow key={run.id} run={run} days={group.kind === 'now' ? null : group.days} context={context} phone={phone} projectId={projectId} />
            ))}
          </div>
        ))}
        {pages.hasNextPage && (
          <div className="list-more flow-log-more">
            <button type="button" className="btn btn-small" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
              {t('log.more', { count: Math.min(FLOW_RUNS_PAGE, total - runs.length) })}
              <ChevronDown {...ICON_SM} />
            </button>
            <span className="flow-log-left">{t('log.left', { n: formatNumber(total - runs.length) })}</span>
          </div>
        )}
      </>
    );

  const list = (
    <section className="card flow-log-card" aria-label={t('log.runs')}>
      {!phone && recent.data && (
        <div className="flow-log-card-head">
          <DaySummary day={day} />
        </div>
      )}
      {body}
    </section>
  );

  if (phone)
    return (
      <div className="team-page flow-log-page is-phone">
        {head?.(<MemberSheet team={team} agent={agent} onChange={setAgent} />)}
        {switcher}
        {views}
        {list}
        <p className="team-muted flow-log-foot">{t('log.phoneFoot')}</p>
      </div>
    );

  return (
    <div className="team-page flow-log-page">
      <div className="team-toolbar">
        {switcher}
        <span className="grow" />
        {views}
      </div>
      <div className="team-layout">
        <div className="team-main">
          <MemberChips team={team} flow={flow} day={day} agent={agent} onChange={setAgent} />
          {list}
        </div>
        <div className="team-side">
          <ByMember team={team} flow={flow} day={day} />
          <Limits flow={flow} running={running} queued={queued} editHref={flowHref} />
        </div>
      </div>
    </div>
  );
}
