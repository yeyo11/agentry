import type { AssistantRun, AssistantRunDetail, Project } from '@agentry/shared';
import { ChevronRight, Clock, RefreshCw, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { LiveRunHead, RunFacts, RunFindings, RunSources } from '../../components/assistant/run';
import type { MenuEntry } from '../../components/controls/Menu';
import { ICON, ICON_SM } from '../../components/icons';
import { PhoneHeader } from '../../components/shell/PhoneHeader';
import { Segmented } from '../../components/ui';
import { projectPath, proposalsOf, stageOf, tally } from './model';
import { MemberProposalRow, SECTION_ICON, useDecide } from './proposals';
import { Describe, DoneLine, EmptyLine, NoRun, ResourcesCard, TasksCard, TeamCard } from './cards';
import { sectionsOf, type RunActions, type Section, type ViewProps } from './view';

export function PhoneAssistant({ project, run, tasksRun, following, actions }: ViewProps) {
  const { t } = useTranslation(['assistant', 'suggestion']);
  const navigate = useNavigate();
  const stage = stageOf(run);
  const finished = stage === 'done' || stage === 'failed' || stage === 'stopped';
  // What "⋯" offers once a run has ended: to ask again, or to leave for the project
  const more: MenuEntry[] = finished
    ? [
        { id: 'again', label: t('suggestAgain'), icon: RefreshCw, onSelect: () => actions.start.mutate({ kind: 'project', supersede: true }) },
        { id: 'project', label: t('goToProject'), icon: ChevronRight, onSelect: () => navigate(projectPath(project.id)) },
      ]
    : [];
  let body: ReactNode = null;
  let foot: ReactNode = null;
  if (stage === 'none') body = <NoRun project={project} actions={actions} />;
  if (stage === 'running' && run) {
    body = <PhoneRunning project={project} run={run} />;
    foot = (
      <>
        <button type="button" className="btn btn-tall" disabled={actions.stop.isPending} onClick={() => actions.stop.mutate(run.id)}>
          <X {...ICON} />
          {t('suggestion:stop')}
        </button>
        <Link to={projectPath(project.id)} className="btn btn-quiet btn-tall">
          {t('skip')}
        </Link>
      </>
    );
  }
  if (finished && run) {
    body = <PhoneDone project={project} run={run} />;
    foot = (
      <Link to={projectPath(project.id)} className="btn btn-primary btn-tall">
        <ChevronRight {...ICON} />
        {t('goToProject')}
      </Link>
    );
  }
  if (stage === 'empty' && run) {
    body = <PhoneEmpty project={project} run={run} tasksRun={tasksRun} following={following} actions={actions} />;
    foot = (
      <Link to={projectPath(project.id)} className="btn btn-tall">
        <ChevronRight {...ICON} />
        {t('goToProject')}
      </Link>
    );
  }
  if (stage === 'none')
    foot = (
      <Link to={projectPath(project.id)} className="btn btn-tall">
        {t('goToProject')}
      </Link>
    );
  return (
    <div className="assistant-page is-phone">
      {/* MobileAsistente: the screen's own header, the shell's top bar hidden on this route */}
      <PhoneHeader className="assistant-head-phone" title={t('title')} subtitle={`${project.name} · ${project.key}`} back={{ label: t('back'), fallback: projectPath(project.id) }} more={more} moreLabel={t('more')} />
      {body}
      {foot && <footer className="assistant-foot">{foot}</footer>}
    </div>
  );
}

function PhoneRunning({ project, run }: { project: Project; run: AssistantRunDetail }) {
  const { t } = useTranslation('assistant');
  const sections = sectionsOf(project);
  const order: Section[] = (['team', 'resources', 'tasks'] as const).filter((s) => sections.includes(s));
  return (
    <>
      <section className="suggestion-run is-live live-energy" aria-label={t('live.region')}>
        <LiveRunHead run={run} title={t('live.title')} />
        <RunFacts run={run} />
        <hr className="suggestion-run-divider" />
        <RunSources sources={run.sources} />
        <RunFindings findings={run.findings} />
      </section>
      <span className="section-label">{t('live.after')}</span>
      <ul className="card assistant-waiting">
        {order.map((section) => {
          const Icon = SECTION_ICON[section];
          return (
            <li key={section} className="assistant-waiting-row">
              <Icon {...ICON} className="muted" />
              <span className="grow">{t(`section.${section}`)}</span>
              <span className="mono small muted assistant-waiting-state">
                <Clock {...ICON_SM} />
                {t('waiting')}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="small muted">{t('live.notePhone')}</p>
    </>
  );
}

function PhoneDone({ project, run }: { project: Project; run: AssistantRunDetail }) {
  const { t } = useTranslation('assistant');
  const decide = useDecide(run.id);
  const sections = sectionsOf(project);
  const [section, setSection] = useState<Section>(sections[0] ?? 'resources');
  if (run.status !== 'completed') return <DoneLine run={run} open={false} phone />;
  const counts: Record<Section, number> = {
    tasks: proposalsOf(run, 'work-item').length,
    team: proposalsOf(run, 'team-member').length,
    resources: proposalsOf(run, 'resource').length,
  };
  const label = (s: Section) => {
    const items = s === 'tasks' ? proposalsOf(run, 'work-item') : s === 'team' ? proposalsOf(run, 'team-member') : proposalsOf(run, 'resource');
    const c = tally(items);
    return s === 'tasks' ? t('tasks.accepted', c) : s === 'team' ? t('team.acceptedPhone', c) : `${t('resources.saved', c)} · ${t('resources.reviewed')}`;
  };
  return (
    <>
      <DoneLine run={run} open={false} phone />
      <div className="assistant-tabs">
        <Segmented<Section>
          value={section}
          label={t('title')}
          onChange={setSection}
          options={sections.map((s) => ({
            value: s,
            label: (
              <>
                {s === 'tasks' ? t('section.tasksShort') : t(`section.${s}`)}
                <span className="count">{counts[s]}</span>
              </>
            ),
          }))}
        />
      </div>
      <span className="section-label">{label(section)}</span>
      {section === 'tasks' && <TasksCard run={run} decide={decide} phone />}
      {section === 'team' && <TeamCard run={run} decide={decide} phone />}
      {section === 'resources' && <ResourcesCard run={run} projectId={project.id} decide={decide} phone />}
    </>
  );
}

function PhoneEmpty({ project, run, tasksRun, following, actions }: { project: Project; run: AssistantRunDetail; tasksRun: AssistantRunDetail | null; following: AssistantRun | null; actions: RunActions }) {
  const { t } = useTranslation(['assistant', 'projects']);
  const decide = useDecide(run.id);
  const sections = sectionsOf(project);
  const members = proposalsOf(run, 'team-member');
  return (
    <>
      <EmptyLine project={project} phone />
      {sections.includes('team') && members.length > 0 && (
        <>
          <div className="assistant-label-row">
            <span className="section-label">{t('empty.templateTeam')}</span>
            {run.template && <span className="mono small muted">{t(`projects:templates.${run.template}.name`)}</span>}
          </div>
          <ul className="card assistant-rows">
            {members.map((p) => (
              <MemberProposalRow key={p.id} proposal={p} decide={decide} phone compact />
            ))}
          </ul>
        </>
      )}
      {sections.includes('tasks') && (
        <>
          <span className="section-label">{t('section.tasks')}</span>
          <Describe project={project} following={following} tasksRun={tasksRun} actions={actions} phone />
        </>
      )}
    </>
  );
}
