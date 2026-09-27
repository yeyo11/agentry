import type { AssistantRun, AssistantRunDetail, Project, ProjectModule } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, CircleAlert, CircleX, Clock, Info, RefreshCw, Sparkle, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, keys, useAssistantRun, useAssistantRuns, useProjects } from '../../api';
import { AssistantMark, LiveRunHead, RunFacts, RunFindings, RunSources, SuggestionWait } from '../../components/assistant/run';
import { MoreActions } from '../../components/controls';
import { ICON, ICON_SM, Monogram } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Empty, ErrorBox, Segmented, Skeleton, usePageTitle } from '../../components/ui';
import { formatNumber } from '../../lib/format';
import { NARROW, useMediaQuery } from '../../lib/media';
import { useProjectScope } from '../../lib/project-scope';
import { localized } from '../../lib/server-strings';
import { followingRun, latestRun, projectPath, proposalsOf, readSummary, stageOf, tally } from './model';
import { MemberProposalRow, ResourceProposalRow, SECTION_ICON, SectionHead, useDecide, WorkItemProposalRow } from './proposals';

type Section = 'tasks' | 'team' | 'resources';

/** Starting a run from this page, and stopping one; every screen of it reads the runs again after. */
function useRunActions(projectId: string) {
  const { t } = useTranslation('assistant');
  const toast = useToast();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.assistantRunsOf(projectId) });
  const start = useMutation({
    mutationFn: (req: { kind: 'project' | 'work-items'; description?: string; supersede?: boolean }) => api.startAssistantRun(projectId, req),
    onSuccess: (run) => queryClient.setQueryData(keys.assistantRun(run.id), run),
    onSettled: refresh,
    onError: (error) => toast.error(t('startFailed'), error),
  });
  const stop = useMutation({
    mutationFn: (runId: string) => api.stopAssistantRun(runId),
    onSuccess: (run) => queryClient.setQueryData(keys.assistantRun(run.id), run),
    onSettled: refresh,
    onError: (error) => toast.error(t('live.stopFailed'), error),
  });
  return { start, stop };
}

type RunActions = ReturnType<typeof useRunActions>;

/** `/projects/:id/assistant`: the project assistant of one project. */
export function AssistantPage() {
  const { t } = useTranslation('assistant');
  const { id = '' } = useParams();
  const projects = useProjects(false);
  const project = projects.data?.find((p) => p.id === id);
  usePageTitle(project ? `${t('title')} · ${project.name}` : t('title'));
  if (projects.error && !projects.data) return <ErrorBox error={projects.error} />;
  if (!projects.data) return <Skeleton rows={6} height={20} />;
  if (!project)
    return (
      <Empty illustration="not-found" size="md" title={t('title')} action={<Link to="/projects" className="btn">{t('back')}</Link>}>
        {id}
      </Empty>
    );
  return <ProjectAssistant key={project.id} project={project} />;
}

function ProjectAssistant({ project }: { project: Project }) {
  const phone = useMediaQuery(NARROW);
  const runs = useAssistantRuns(project.id, 'project');
  const run = latestRun(runs.data);
  const detail = useAssistantRun(run?.id ?? null);
  // An empty project's first tasks come from the run its description started, after the first
  const tasksRuns = useAssistantRuns(run?.empty ? project.id : null, 'work-items');
  const following = followingRun(run, tasksRuns.data);
  const followingDetail = useAssistantRun(following?.id ?? null);
  const actions = useRunActions(project.id);
  // The page is about one project, so the top bar's selector names it, as a project page's
  // `?project=` does. Once, on arrival: choosing another project afterwards is the person's choice
  const { select } = useProjectScope();
  useEffect(() => select(project.id), [project.id]);

  if (runs.error && !runs.data) return <ErrorBox error={runs.error} />;
  if (!runs.data || (run && !detail.data)) return <Skeleton rows={6} height={20} />;
  // The detail may still be the last run's for a moment after a new one started
  const shown: AssistantRunDetail | null = detail.data && detail.data.id === run?.id ? detail.data : null;
  const view = { project, run: shown, tasksRun: followingDetail.data ?? null, following, actions, phone };
  return phone ? <PhoneAssistant {...view} /> : <DesktopAssistant {...view} />;
}

interface ViewProps {
  project: Project;
  run: AssistantRunDetail | null;
  /** For an empty project: the run proposing its first tasks from the description */
  tasksRun: AssistantRunDetail | null;
  following: AssistantRun | null;
  actions: RunActions;
  phone: boolean;
}

const has = (project: Project, module: ProjectModule) => project.modules.includes(module);

/** Which of the three sections this project shows: a module switched off has none. */
function sectionsOf(project: Project): Section[] {
  return [...(has(project, 'board') ? (['tasks'] as const) : []), ...(has(project, 'team') ? (['team'] as const) : []), 'resources'];
}

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

// ---------------------------------------------------------------- desktop

function DesktopAssistant({ project, run, tasksRun, following, actions }: ViewProps) {
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
        <Monogram name={project.name} size={40} />
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

/** A project the assistant never read: what it would do, and the one button that starts it. */
function NoRun({ project, actions }: { project: Project; actions: RunActions }) {
  const { t } = useTranslation('assistant');
  return (
    <section className="card glow-top assistant-none">
      <Empty
        illustration="team"
        size="md"
        title={t('none.title')}
        action={
          <button type="button" className="btn btn-primary" disabled={actions.start.isPending} onClick={() => actions.start.mutate({ kind: 'project' })}>
            <Sparkle {...ICON_SM} />
            {t('none.start')}
          </button>
        }
      >
        {t('none.body')}
      </Empty>
      <ErrorBox error={actions.start.error} />
      <span className="sr-only">{project.name}</span>
    </section>
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

/** "14 proposals after reading 61 files, 23 chats and docs/". */
function useReadLine(run: AssistantRun, phone: boolean): { count: string; after: string } {
  const { t } = useTranslation('assistant');
  const summary = readSummary(run.sources);
  const parts = [
    ...(summary.files > 0 ? [t('done.files', { count: summary.files, n: formatNumber(summary.files) })] : []),
    ...(summary.chats > 0 ? [t('done.chats', { count: summary.chats, n: formatNumber(summary.chats) })] : []),
    ...(phone ? [] : summary.dirs),
  ];
  const what = parts.length === 0 ? t('done.nothingRead') : parts.length === 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} ${t('done.and')} ${parts[parts.length - 1] ?? ''}`;
  const total = Object.values(run.counts).reduce((sum, c) => sum + c.total - c.superseded, 0);
  return { count: t('done.proposals', { count: total, n: formatNumber(total) }), after: t(phone ? 'done.afterPhone' : 'done.after', { what }) };
}

/** A finished run folded into one still line, or, when it failed or was stopped, what happened. */
function DoneLine({ run, open, onToggle, phone }: { run: AssistantRunDetail; open: boolean; onToggle?: () => void; phone: boolean }) {
  const { t } = useTranslation('assistant');
  const line = useReadLine(run, phone);
  if (run.status === 'failed' || run.status === 'stopped') {
    const failed = run.status === 'failed';
    return (
      <section className={`suggestion-run is-done assistant-ended ${failed ? 'is-failed' : 'is-stopped'}`} aria-label={failed ? t('failed.title') : t('failed.stopped')}>
        {failed ? <CircleX {...ICON} className="text-bad" /> : <CircleAlert {...ICON} className="text-warn" />}
        <span className="small assistant-done-text">
          <b>{failed ? t('failed.title') : t('failed.stopped')}</b>{' '}
          <span className="muted">{failed && run.error ? localized(run.error) : t('failed.stoppedBody')}</span>
        </span>
        <span className="grow" />
        <RunFacts run={run} />
      </section>
    );
  }
  return (
    <section className="suggestion-run is-done" aria-label={t('done.region')}>
      <div className="assistant-done-lead">
        <AssistantMark small />
        <span className="small assistant-done-text">
          <b>{line.count}</b> <span className="muted">{line.after}</span>
        </span>
      </div>
      {!phone && <span className="grow" />}
      <RunFacts run={run} />
      {onToggle && (
        <button type="button" className="btn btn-quiet btn-small" aria-expanded={open} onClick={onToggle}>
          {open ? t('done.hideRead') : t('done.seeRead')}
        </button>
      )}
    </section>
  );
}

function ReadPanel({ run }: { run: AssistantRun }) {
  const { t } = useTranslation('assistant');
  return (
    <section className="card assistant-read" aria-label={t('done.readTitle')}>
      <RunSources sources={run.sources} label={t('done.readTitle')} />
      <RunFindings findings={run.findings} label={t('live.found')} />
    </section>
  );
}

function TasksCard({ run, decide, phone }: { run: AssistantRunDetail; decide: ReturnType<typeof useDecide>; phone: boolean }) {
  const { t } = useTranslation('assistant');
  const items = proposalsOf(run, 'work-item');
  const count = tally(items);
  return (
    <section className="card grad-border assistant-card assistant-tasks" aria-label={t('section.tasks')}>
      {!phone && <SectionHead section="tasks" tally={count.total > 0 ? t('tasks.accepted', count) : t('tasks.toBacklog')} />}
      {items.length === 0 ? (
        <SuggestionWait>{t('empty.noProposals')}</SuggestionWait>
      ) : (
        <ul className="assistant-rows">
          {items.map((p) => (
            <WorkItemProposalRow key={p.id} proposal={p} decide={decide} phone={phone} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TeamCard({ run, decide, phone, compact = false }: { run: AssistantRunDetail; decide: ReturnType<typeof useDecide>; phone: boolean; compact?: boolean }) {
  const { t } = useTranslation(['assistant', 'projects']);
  const members = proposalsOf(run, 'team-member');
  const count = tally(members);
  const template = run.template ? t(`projects:templates.${run.template}.name`) : null;
  return (
    <section className={phone ? 'card grad-border assistant-card' : 'card assistant-card'} aria-label={t('section.team')}>
      {!phone && (
        <SectionHead
          section="team"
          tally={members.length > 0 ? t('team.accepted', count) : t('empty.noProposals')}
          note={template && (run.empty ? t('team.theTemplate', { name: template }) : t('team.fromTemplate', { name: template }))}
        />
      )}
      {run.empty && !phone && (
        <div className="callout assistant-card-callout">
          <Info {...ICON} className="muted" />
          <span>{t('empty.teamNote')}</span>
        </div>
      )}
      {members.length === 0 ? (
        <SuggestionWait>{t('empty.noProposals')}</SuggestionWait>
      ) : (
        <ul className="assistant-rows">
          {members.map((p) => (
            <MemberProposalRow key={p.id} proposal={p} decide={decide} phone={phone} compact={compact} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ResourcesCard({ run, projectId, decide, phone }: { run: AssistantRunDetail; projectId: string; decide: ReturnType<typeof useDecide>; phone: boolean }) {
  const { t } = useTranslation('assistant');
  const resources = proposalsOf(run, 'resource');
  const count = tally(resources);
  return (
    <section className={phone ? 'card grad-border assistant-card' : 'card assistant-card'} aria-label={t('section.resources')}>
      {!phone && <SectionHead section="resources" tally={resources.length > 0 ? t('resources.saved', count) : t('empty.noProposals')} note={resources.length > 0 && t('resources.reviewed')} />}
      {resources.length === 0 ? (
        <SuggestionWait>{run.empty ? t('empty.resourcesLater') : t('empty.noProposals')}</SuggestionWait>
      ) : (
        <ul className="assistant-rows">
          {resources.map((p) => (
            <ResourceProposalRow key={p.id} proposal={p} projectId={projectId} decide={decide} phone={phone} />
          ))}
        </ul>
      )}
    </section>
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

/** Describe the project, and the assistant proposes its first tasks from that (an empty directory has nothing else to read). */
function Describe({ project, following, tasksRun, actions, phone }: { project: Project; following: AssistantRun | null; tasksRun: AssistantRunDetail | null; actions: RunActions; phone: boolean }) {
  const { t } = useTranslation('assistant');
  const [text, setText] = useState('');
  const running = following?.status === 'running';
  const decide = useDecide(tasksRun?.id ?? '');
  if (tasksRun && tasksRun.status === 'running')
    return (
      <section className="suggestion-run is-live live-energy" aria-label={t('live.region')}>
        <LiveRunHead run={tasksRun} title={t('live.title')} onStop={() => actions.stop.mutate(tasksRun.id)} stopping={actions.stop.isPending} />
        <RunFacts run={tasksRun} showSchema />
        <RunSources sources={tasksRun.sources} />
      </section>
    );
  if (tasksRun && tasksRun.status === 'completed' && proposalsOf(tasksRun, 'work-item').length > 0) return <TasksCard run={tasksRun} decide={decide} phone={phone} />;
  const submit = () => actions.start.mutate({ kind: 'work-items', description: text.trim() });
  return (
    <section className="card grad-border assistant-card" aria-label={t('section.tasks')}>
      {!phone && <SectionHead section="tasks" tally={t('tasks.toBacklog')} />}
      <div className="assistant-describe">
        <p className="small muted">{phone ? t('empty.tasksIntroPhone') : t('empty.tasksIntro')}</p>
        <textarea
          className="assistant-describe-input"
          rows={3}
          value={text}
          aria-label={t('empty.describe')}
          placeholder={phone ? t('empty.describePlaceholderPhone') : t('empty.describePlaceholder')}
          onChange={(e) => setText(e.target.value)}
        />
        {tasksRun && tasksRun.status !== 'completed' && <DoneLine run={tasksRun} open={false} phone={phone} />}
        <div className="assistant-describe-foot">
          {!phone && (
            <span className="form-hint grow">
              <Trans t={t} i18nKey="empty.proposeHint" components={{ mono: <span className="mono" /> }} />
            </span>
          )}
          <button type="button" className="btn btn-primary" disabled={!text.trim() || running || actions.start.isPending} onClick={submit}>
            <Sparkle {...ICON_SM} />
            {t('empty.propose')}
          </button>
        </div>
      </div>
      <span className="sr-only">{project.name}</span>
    </section>
  );
}

function EmptyLine({ project, phone }: { project: Project; phone: boolean }) {
  const { t } = useTranslation(['assistant', 'suggestion']);
  return (
    <section className={`suggestion-run is-done assistant-empty-line ${phone ? 'is-phone' : ''}`.trim()} aria-label={t('empty.region')}>
      <AssistantMark small />
      {phone ? (
        <span className="assistant-done-text">
          <b>{t('empty.titlePhone')}</b>
          <span className="muted">
            <Trans t={t} i18nKey="empty.bodyPhone" values={{ path: project.path }} components={{ mono: <span className="mono" /> }} />
          </span>
        </span>
      ) : (
        <>
          <span className="small assistant-done-text">
            <b>{t('empty.title')}</b>{' '}
            <span className="muted">
              <Trans t={t} i18nKey="empty.body" values={{ path: project.path }} components={{ mono: <span className="mono" /> }} />
            </span>
          </span>
          <span className="grow" />
          <div className="suggestion-facts">
            <span className="cost">{t('suggestion:facts.noCost')}</span>
          </div>
        </>
      )}
    </section>
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

// ---------------------------------------------------------------- phone

function PhoneAssistant({ project, run, tasksRun, following, actions }: ViewProps) {
  const { t } = useTranslation(['assistant', 'suggestion']);
  const navigate = useNavigate();
  const stage = stageOf(run);
  const finished = stage === 'done' || stage === 'failed' || stage === 'stopped';
  const more = finished && (
    <MoreActions
      label={t('more')}
      entries={[
        { id: 'again', label: t('suggestAgain'), icon: RefreshCw, onSelect: () => actions.start.mutate({ kind: 'project', supersede: true }) },
        { id: 'project', label: t('goToProject'), icon: ChevronRight, onSelect: () => navigate(projectPath(project.id)) },
      ]}
    />
  );
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
      <header className="page-header project-head project-head-phone assistant-head-phone">
        <Link to={projectPath(project.id)} className="icon-btn" aria-label={t('back')}>
          <ChevronLeft {...ICON} />
        </Link>
        <div className="page-header-text project-head-text">
          <h1>{t('title')}</h1>
          <span className="mono small muted ellipsis">
            {project.name} · {project.key}
          </span>
        </div>
        {more}
      </header>
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
