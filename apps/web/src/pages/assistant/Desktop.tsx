import type { AssistantRun, AssistantRunDetail, Project } from '@agentry/shared';
import { ChevronLeft, ChevronRight, Info, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { LiveRunHead, RunFacts, RunFindings, RunSources, SuggestionWait } from '../../components/assistant/run';
import { ICON, ICON_SM, Monogram } from '../../components/icons';
import { ErrorBox } from '../../components/ui';
import { projectPath, stageOf } from './model';
import { SectionHead, useDecide } from './proposals';
import { Describe, DoneLine, EmptyLine, NoRun, ReadPanel, ResourcesCard, TasksCard, TeamCard } from './cards';
import { sectionsOf, type RunActions, type Section, type ViewProps } from './view';

function Subtitle({ project, run }: { project: Project; run: AssistantRun | null }) {
  const { t } = useTranslation('assistant');
  const stage = stageOf(run);
  const key = stage === 'running' ? 'running' : stage === 'empty' ? 'empty' : stage === 'none' ? 'none' : 'done';
  return (
    <>
      {project.name} · {t(`subtitle.${key}`)}
    </>
  );
}

export function DesktopAssistant({ project, run, tasksRun, following, actions }: ViewProps) {
  const { t } = useTranslation('assistant');
  const stage = stageOf(run);
  const suggestAgain = () => actions.start.mutate({ kind: 'project', supersede: true });
  const buttons =
    stage === 'running' ? (
      <>
        <Link to={projectPath(project.id)} className="btn btn-quiet">
          {t('skip')}
        </Link>
        <button type="button" className="btn btn-primary" disabled>
          <ChevronRight {...ICON} />
          {t('goToProject')}
        </button>
      </>
    ) : stage === 'empty' || stage === 'none' ? (
      <Link to={projectPath(project.id)} className="btn">
        <ChevronRight {...ICON} />
        {t('goToProject')}
      </Link>
    ) : (
      <>
        <button type="button" className="btn" disabled={actions.start.isPending} onClick={suggestAgain}>
          <RefreshCw {...ICON_SM} />
          {t('suggestAgain')}
        </button>
        <Link to={projectPath(project.id)} className="btn btn-primary">
          <ChevronRight {...ICON} />
          {t('goToProject')}
        </Link>
      </>
    );
  return (
    <div className="assistant-page">
      <header className="page-header assistant-head">
        <Link to={projectPath(project.id)} className="btn assistant-back" aria-label={t('back')}>
          <ChevronLeft {...ICON} />
        </Link>
        <Monogram name={project.name} size={40} project />
        <div className="page-header-text">
          <h1>{t('title')}</h1>
          <div className="muted assistant-subtitle">
            <Subtitle project={project} run={run} />
          </div>
        </div>
        <div className="assistant-head-actions">{buttons}</div>
      </header>
      {stage === 'none' && <NoRun project={project} actions={actions} />}
      {stage === 'running' && run && <DesktopRunning project={project} run={run} actions={actions} />}
      {(stage === 'done' || stage === 'failed' || stage === 'stopped') && run && <DesktopDone project={project} run={run} actions={actions} />}
      {stage === 'empty' && run && <DesktopEmpty project={project} run={run} tasksRun={tasksRun} following={following} actions={actions} />}
    </div>
  );
}

/** The run at work: what it reads on the left, the sections it will fill waiting on the right. */
function DesktopRunning({ project, run, actions }: { project: Project; run: AssistantRunDetail; actions: RunActions }) {
  const { t } = useTranslation('assistant');
  const sections = sectionsOf(project);
  const order: Section[] = (['team', 'resources', 'tasks'] as const).filter((s) => sections.includes(s));
  return (
    <div className="assistant-grid is-running">
      <section className="suggestion-run is-live live-energy" aria-label={t('live.region')}>
        <LiveRunHead run={run} title={t('live.title')} onStop={() => actions.stop.mutate(run.id)} stopping={actions.stop.isPending} />
        <RunFacts run={run} showSchema />
        <hr className="suggestion-run-divider" />
        <RunSources sources={run.sources} label={t('live.read')} />
        <RunFindings findings={run.findings} label={t('live.found')} />
      </section>
      <div className="assistant-side">
        {order.map((section) => (
          <section key={section} className="card assistant-card" aria-label={t(`section.${section}`)}>
            <SectionHead section={section} note={<span className="mono">{t('waiting')}</span>} />
            <SuggestionWait>{t(`wait.${section}`, { name: project.name })}</SuggestionWait>
          </section>
        ))}
        <div className="callout assistant-callout">
          <Info {...ICON} className="muted" />
          <span>
            <Trans t={t} i18nKey="live.note" components={{ code: <code /> }} />
          </span>
        </div>
      </div>
    </div>
  );
}

function DesktopDone({ project, run, actions }: { project: Project; run: AssistantRunDetail; actions: RunActions }) {
  const [open, setOpen] = useState(false);
  const decide = useDecide(run.id);
  const sections = sectionsOf(project);
  const ended = run.status !== 'completed';
  const [first, ...rest] = sections;
  const card = (section: Section) =>
    section === 'tasks' ? (
      <TasksCard key={section} run={run} decide={decide} phone={false} />
    ) : section === 'team' ? (
      <TeamCard key={section} run={run} decide={decide} phone={false} />
    ) : (
      <ResourcesCard key={section} run={run} projectId={project.id} decide={decide} phone={false} />
    );
  return (
    <>
      <DoneLine run={run} open={open} onToggle={run.sources.length > 0 ? () => setOpen((v) => !v) : undefined} phone={false} />
      {open && <ReadPanel run={run} />}
      <ErrorBox error={actions.start.error} />
      {!ended && first && (
        <div className="assistant-grid">
          {card(first)}
          <div className="assistant-side">{rest.map(card)}</div>
        </div>
      )}
    </>
  );
}

function DesktopEmpty({ project, run, tasksRun, following, actions }: { project: Project; run: AssistantRunDetail; tasksRun: AssistantRunDetail | null; following: AssistantRun | null; actions: RunActions }) {
  const decide = useDecide(run.id);
  const sections = sectionsOf(project);
  return (
    <>
      <EmptyLine project={project} phone={false} />
      <div className="assistant-grid">
        {sections.includes('tasks') ? <Describe project={project} following={following} tasksRun={tasksRun} actions={actions} phone={false} /> : <TeamCard run={run} decide={decide} phone={false} />}
        <div className="assistant-side">
          {sections.includes('tasks') && sections.includes('team') && <TeamCard run={run} decide={decide} phone={false} />}
          <ResourcesCard run={run} projectId={project.id} decide={decide} phone={false} />
        </div>
      </div>
    </>
  );
}
