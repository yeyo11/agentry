import type { Project } from '@agentry/shared';
import { FolderKanban, Plus, Settings, Sparkle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useProjectSettings, useProjectTemplates, useTeam } from '../../api';
import type { MenuEntry } from '../../components/controls';
import { ICON_SM } from '../../components/icons';
import { PhoneHeader } from '../../components/shell/PhoneHeader';
import { ErrorBox, Segmented, Skeleton } from '../../components/ui';
import { useLeaveGuard } from '../../lib/dirty';
import { NARROW, useMediaQuery } from '../../lib/media';
import { assistantEntry } from '../home/ProjectHead';
import { TeamActivityView } from './Activity';
import { AddMemberDialog } from './AddMember';
import { FlowEditor } from './Flow';
import { MemberPage } from './Member';
import { MemberCells, MemberGrid, ProposeButton, TeamEmpty, useProposeTeam } from './Members';
import { proposedFlow, savedFlow, teamActivity, teamSearch, teamSection, workingCount, type TeamSection } from './model';
import { FlowSummary, TeamActivity } from './parts';

/** Back from the Team tab on a phone: the project's page, with its selection kept. */
function summaryHref(params: URLSearchParams): string {
  const query = new URLSearchParams();
  const project = params.get('project');
  if (project) query.set('project', project);
  const text = query.toString();
  return text ? `/?${text}` : '/';
}

/**
 * The Team tab of a project: its members (`?view=team`), the flow by column (`&section=flow`), the
 * team's activity (`&section=activity`) and one member (`&member=<agent>`), the three views behind
 * one segmented control. With nobody on the team it offers the assistant's proposal and the
 * template's team. A phone draws the same under its own header (`PhoneHeader`): "Equipo", the
 * project and what it holds, the way back and "⋯".
 */
export function ProjectTeam({ project }: { project: Project }) {
  const { t } = useTranslation(['team', 'home', 'projects', 'assistant']);
  const phone = useMediaQuery(NARROW);
  const navigate = useNavigate();
  const guard = useLeaveGuard();
  const [params] = useSearchParams();
  const team = useTeam(project.id);
  const settings = useProjectSettings(project.id);
  const templates = useProjectTemplates();
  const propose = useProposeTeam(project.id);
  const [adding, setAdding] = useState<{ agent?: string } | null>(null);
  const [flowChanges, setFlowChanges] = useState(0);

  const section: TeamSection = teamSection(params.get('section'));
  const memberId = params.get('member');
  // The views are one screen: switching them replaces the entry, so "back" leaves Team, not the last view
  const go = (next: { section?: TeamSection; member?: string | null }) =>
    void guard().then((ok) => ok && navigate({ search: teamSearch(params, next) }, { replace: true }));
  const memberHref = (agent: string) => teamSearch(params, { member: agent });
  const back = summaryHref(params);

  if (team.error && !team.data) return <ErrorBox error={team.error} />;
  if (!team.data || !settings.data) return <Skeleton rows={6} height={20} />;
  const data = team.data;
  const members = data.members;
  // A project that never saved a flow has none: the summary says so, and the editor offers the
  // template's proposal as an unsaved draft instead of drawing it as if it were in force
  const flow = savedFlow(settings.data);
  const proposal = settings.data.flow ? null : proposedFlow(members);

  const member = memberId ? members.find((m) => m.agent === memberId) : undefined;
  // Keyed by the agent: what is typed for one member is never carried to the next one opened
  if (member) return <MemberPage key={member.agent} project={project} member={member} backHref={teamSearch(params, { member: null })} />;

  const count = members.length;
  // The assistant first: on a phone this sheet is the Team screens' only way to it (gap 8)
  const more: MenuEntry[] = [
    assistantEntry(project, t('projects:head.assistant'), (path) => navigate(path)),
    { id: 'add', label: t('add.title'), icon: Plus, onSelect: () => setAdding({}) },
    { id: 'propose', label: t('assistant:teamEmpty.propose'), icon: Sparkle, disabled: propose.isPending, onSelect: () => propose.mutate() },
    { id: 'board', label: t('phone.board'), icon: FolderKanban, onSelect: () => navigate(`/tasks?project=${encodeURIComponent(project.id)}`) },
    { id: 'settings', label: t('phone.settings'), icon: Settings, onSelect: () => navigate(`/?project=${encodeURIComponent(project.id)}&view=settings`) },
  ];
  const phoneDetail =
    section === 'flow' && flowChanges > 0 ? `${project.name} · ${t('flow.changes', { count: flowChanges })}` : count > 0 ? `${project.name} · ${t('members.count', { count })}` : project.name;
  // The activity's header carries its member filter before "⋯", which every Team screen keeps for the assistant
  const header = (action?: ReactNode) =>
    phone && <PhoneHeader title={t('home:tabs.team')} subtitle={phoneDetail} back={{ label: t('back'), fallback: back }} actions={action} more={more} moreLabel={t('phone.more')} />;
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
        {header()}
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
          { value: 'activity', label: t('log.title') },
        ]}
      />
    </div>
  );

  if (section === 'activity')
    return (
      <TeamActivityView
        projectId={project.id}
        team={data}
        flow={flow}
        switcher={switcher}
        flowHref={teamSearch(params, { section: 'flow' })}
        phone={phone}
        head={(action) => header(action)}
      />
    );

  if (section === 'flow')
    return (
      <div className="team-page">
        {header()}
        <FlowEditor
          key={project.id}
          project={project}
          team={data}
          flow={flow}
          proposal={proposal}
          switcher={switcher}
          activityHref={teamSearch(params, { section: 'activity' })}
          onChanges={setFlowChanges}
        />
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
        {header()}
        {switcher}
        <div className="team-section-head">
          <span className="section-label">{t('members.title')}</span>
          {working > 0 && <span className="team-working">{t('members.working', { count: working })}</span>}
        </div>
        <MemberCells team={data} memberHref={memberHref} />
        <div className="team-phone-actions">
          {addButton}
          <ProposeButton projectId={project.id} />
        </div>
        {addDialog}
      </div>
    );
  }

  return (
    <div className="team-page">
      <div className="team-toolbar">
        {switcher}
        <span className="grow" />
        <ProposeButton projectId={project.id} />
        {addButton}
      </div>
      <div className="team-layout">
        <div className="team-main">
          <MemberGrid team={data} memberHref={memberHref} onAdd={() => setAdding(data.unassignedAgents[0] ? { agent: data.unassignedAgents[0] } : {})} />
        </div>
        <div className="team-side">
          <FlowSummary columns={flow.columns} enabled={flow.enabled} saved={proposal === null} maxBounces={flow.maxBounces} editHref={teamSearch(params, { section: 'flow' })} />
          <TeamActivity runs={teamActivity(members)} allHref={teamSearch(params, { section: 'activity' })} />
        </div>
      </div>
      {addDialog}
    </div>
  );
}
