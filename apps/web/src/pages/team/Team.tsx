import type { Project } from '@agentry/shared';
import { ChevronLeft, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useProjectSettings, useProjectTemplates, useTeam } from '../../api';
import { ICON, ICON_SM } from '../../components/icons';
import { ErrorBox, Segmented, Skeleton } from '../../components/ui';
import { useLeaveGuard } from '../../lib/dirty';
import { NARROW, useMediaQuery } from '../../lib/media';
import { AddMemberDialog } from './AddMember';
import { FlowEditor } from './Flow';
import { MemberPage } from './Member';
import { MemberCells, MemberGrid, TeamEmpty } from './Members';
import { flowOf, teamActivity, teamSearch, workingCount, type TeamSection } from './model';
import { FlowSummary, TeamActivity } from './parts';

/** Back from the Team tab on a phone: the project's page, with its selection kept. */
function summaryHref(params: URLSearchParams): string {
  const query = new URLSearchParams();
  const project = params.get('project');
  if (project) query.set('project', project);
  const text = query.toString();
  return text ? `/?${text}` : '/';
}

/** A phone's Team screen heads itself: the tab's name, the project and what it holds, and the way back. */
function PhoneHead({ title, detail, backHref }: { title: string; detail: string; backHref: string }) {
  const { t } = useTranslation('team');
  return (
    <header className="page-header project-head project-head-phone">
      <Link to={backHref} className="icon-btn" aria-label={t('back')}>
        <ChevronLeft {...ICON} />
      </Link>
      <div className="page-header-text project-head-text">
        <h1>{title}</h1>
        <span className="mono small muted ellipsis">{detail}</span>
      </div>
    </header>
  );
}

/**
 * The Team tab of a project: its members (`?view=team`), the flow by column (`&section=flow`) and one
 * member (`&member=<agent>`). With nobody on the team it offers the template's team. A phone draws
 * the same, headed by its own title line.
 */
export function ProjectTeam({ project }: { project: Project }) {
  const { t } = useTranslation(['team', 'home', 'projects']);
  const phone = useMediaQuery(NARROW);
  const navigate = useNavigate();
  const guard = useLeaveGuard();
  const [params] = useSearchParams();
  const team = useTeam(project.id);
  const settings = useProjectSettings(project.id);
  const templates = useProjectTemplates();
  const [adding, setAdding] = useState<{ agent?: string } | null>(null);

  const section: TeamSection = params.get('section') === 'flow' ? 'flow' : 'members';
  const memberId = params.get('member');
  const go = (next: { section?: TeamSection; member?: string | null }) => void guard().then((ok) => ok && navigate({ search: teamSearch(params, next) }));
  const memberHref = (agent: string) => teamSearch(params, { member: agent });
  const back = summaryHref(params);

  if (team.error && !team.data) return <ErrorBox error={team.error} />;
  if (!team.data || !settings.data) return <Skeleton rows={6} height={20} />;
  const data = team.data;
  const members = data.members;
  const flow = flowOf(settings.data, members);

  const member = memberId ? members.find((m) => m.agent === memberId) : undefined;
  // Keyed by the agent: what is typed for one member is never carried to the next one opened
  if (member) return <MemberPage key={member.agent} project={project} member={member} backHref={teamSearch(params, { member: null })} />;

  const count = members.length;
  const phoneDetail = section === 'members' && count > 0 ? `${project.name} · ${t('members.count', { count })}` : project.name;
  const head = phone && <PhoneHead title={t('home:tabs.team')} detail={phoneDetail} backHref={back} />;
  const addDialog = adding && (
    <AddMemberDialog
      projectId={project.id}
      team={data}
      {...(adding.agent ? { initialAgent: adding.agent } : {})}
      onClose={() => setAdding(null)}
      onAdded={(agent) => {
        setAdding(null);
        navigate({ search: memberHref(agent) });
      }}
    />
  );

  if (count === 0) {
    const own = templates.data?.find((template) => template.id === settings.data.template);
    const roles = own && own.team.length > 0 ? own.team : (templates.data?.find((template) => template.id === 'custom')?.team ?? []);
    const templateName = own && own.team.length > 0 ? t(`projects:templates.${own.id}.name`) : null;
    return (
      <div className="team-page is-empty">
        {head}
        <TeamEmpty projectId={project.id} roles={roles} templateName={templateName} phone={phone} onAdd={() => setAdding({})} />
        {addDialog}
      </div>
    );
  }

  const switcher = (
    <div className="team-switch">
      <Segmented<TeamSection>
        value={section}
        label={t('home:tabs.team')}
        onChange={(next) => go({ section: next })}
        options={[
          {
            value: 'members',
            label: (
              <>
                {t('members.title')}
                {!phone && <span className="count">{count}</span>}
              </>
            ),
          },
          { value: 'flow', label: t('flow.title') },
        ]}
      />
    </div>
  );

  if (section === 'flow')
    return (
      <div className="team-page">
        {head}
        <FlowEditor key={project.id} project={project} team={data} flow={flow} switcher={switcher} />
      </div>
    );

  const addButton = (
    <button type="button" className={phone ? 'btn' : 'btn btn-primary'} onClick={() => setAdding({})}>
      <Plus {...ICON_SM} />
      {t('add.title')}
    </button>
  );

  if (phone) {
    const working = workingCount(members);
    return (
      <div className="team-page is-phone">
        {head}
        {switcher}
        <div className="team-section-head">
          <span className="section-label">{t('members.title')}</span>
          {working > 0 && <span className="team-working">{t('members.working', { count: working })}</span>}
        </div>
        <MemberCells team={data} memberHref={memberHref} />
        <div className="team-phone-actions">{addButton}</div>
        {addDialog}
      </div>
    );
  }

  return (
    <div className="team-page">
      <div className="team-toolbar">
        {switcher}
        <span className="grow" />
        {addButton}
      </div>
      <div className="team-layout">
        <div className="team-main">
          <MemberGrid team={data} memberHref={memberHref} onAdd={() => setAdding(data.unassignedAgents[0] ? { agent: data.unassignedAgents[0] } : {})} />
        </div>
        <div className="team-side">
          <FlowSummary columns={flow.columns} enabled={flow.enabled} maxBounces={flow.maxBounces} editHref={teamSearch(params, { section: 'flow' })} />
          <TeamActivity runs={teamActivity(members)} />
        </div>
      </div>
      {addDialog}
    </div>
  );
}
