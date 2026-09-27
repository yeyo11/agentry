import type { Project } from '@agentry/shared';
import { BookText, ChevronLeft, ChevronRight, FileText, FolderX, GitFork, LayoutDashboard, MessageCircle, Package, Plus, SlidersHorizontal, SquareKanban, type LucideIcon } from 'lucide-react';
import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useDocuments, useOpenTaskCount, useProjectSettings } from '../api';
import { ICON, ICON_SM, Monogram, WorkItemKey } from '../components/icons';
import { Skeleton, TabPanel, Tabs, usePageTitle, useTabGroup } from '../components/ui';
import { DirtyProvider, useDirtyKeys, useLeaveGuard } from '../lib/dirty';
import { formatNumber } from '../lib/format';
import { NARROW, useMediaQuery } from '../lib/media';
import { useProjectScope } from '../lib/project-scope';
import { NEW_TASK_PATH } from '../lib/work-items';
import { Dashboard } from './dashboard/Dashboard';
import { HomeHero } from './dashboard/Hero';
import { defaultLayout } from './dashboard/registry';
import { usePendingProposalCount } from './home/memory/Proposals';
import { asProjectView, legacyTabRedirect, projectViews, type ProjectViewId } from './dashboard/views';

// The dashboard is what most visits are for; the project's other tabs load when opened
const ProjectSettings = lazy(() => import('./home/ProjectSettings').then((m) => ({ default: m.ProjectSettings })));
const ProjectMemory = lazy(() => import('./home/ProjectMemory').then((m) => ({ default: m.ProjectMemory })));
const ProjectResources = lazy(() => import('./home/ProjectResources').then((m) => ({ default: m.ProjectResources })));
const ProjectDocuments = lazy(() => import('./documents/Documents').then((m) => ({ default: m.ProjectDocuments })));
const ProjectWorktrees = lazy(() => import('./home/ProjectWorktrees').then((m) => ({ default: m.ProjectWorktrees })));
// The Tasks board itself: it reads the selected project, which on this page is the one shown
const ProjectBoard = lazy(() => import('./tasks/Board').then((m) => ({ default: m.Board })));

type TabId = 'summary' | ProjectViewId;

const TAB_ICON: Record<TabId, LucideIcon> = {
  summary: LayoutDashboard,
  board: SquareKanban,
  documents: FileText,
  memory: BookText,
  resources: Package,
  worktrees: GitFork,
  settings: SlidersHorizontal,
};

function MissingAlert({ project }: { project: Project }) {
  const { t } = useTranslation('home');
  if (project.exists) return null;
  return (
    <div className="alert alert-warn" role="alert">
      <FolderX size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
      <div className="alert-body">
        <strong>{t('page.missing')}</strong>
        <div>{t('page.missingHint')}</div>
      </div>
    </div>
  );
}

/**
 * The figure each tab carries, neutral: open tasks on the board, the documents, the worktrees.
 * Memory's is the proposals waiting for the person, which `IDLE_COUNT` draws in idle.
 */
function useTabCounts(project: Project): Partial<Record<TabId, number>> {
  const open = useOpenTaskCount(project, true);
  const documents = useDocuments(project.modules.includes('documents') ? project.id : null).data?.fileCount;
  const proposals = usePendingProposalCount(project.id, project.modules.includes('memory'));
  return { board: open, documents, memory: proposals || undefined, worktrees: project.worktrees.length || undefined };
}

/** Tabs whose figure waits for the person: drawn in idle, and said in words to a screen reader. */
const IDLE_COUNT: ReadonlySet<TabId> = new Set(['memory']);

function TabCount({ id, count }: { id: TabId; count: number }) {
  const { t } = useTranslation('home');
  if (!IDLE_COUNT.has(id)) return <span className="count">{formatNumber(count)}</span>;
  const label = t('memoryTab.proposals.waiting', { count, n: formatNumber(count) });
  return (
    <span className="count count-idle" title={label} aria-label={label}>
      {formatNumber(count)}
    </span>
  );
}

/**
 * The top of every tab: who the project is (its monogram, name, key and template), where it lives
 * and how much it holds, and the two ways to start work in it. "New task" is the gradient only on
 * Resumen; on a tab with a primary of its own it steps back.
 */
function ProjectHead({ project, tab }: { project: Project; tab: TabId }) {
  const { t } = useTranslation(['home', 'projects', 'common']);
  const template = useProjectSettings(project.id).data?.template ?? null;
  const board = project.modules.includes('board');
  return (
    <header className="page-header project-head">
      <Monogram name={project.name} size={44} />
      <div className="page-header-text project-head-text">
        <div className="project-head-title">
          <h1>{project.name}</h1>
          <WorkItemKey value={project.key} boxed />
          {template && <span className="badge badge-muted project-head-template">{t(`projects:templates.${template}.name`)}</span>}
        </div>
        <span className="mono small muted project-head-facts">
          <span className="ellipsis" title={project.path}>
            {project.path}
          </span>
          <span aria-hidden>·</span>
          <span>{t('projects:head.chats', { count: project.chatCount, n: formatNumber(project.chatCount) })}</span>
          <span aria-hidden>·</span>
          <span>{t('projects:head.worktrees', { count: project.worktrees.length, n: formatNumber(project.worktrees.length) })}</span>
        </span>
      </div>
      <div className="page-actions">
        <Link
          to={`/chats/new?cwd=${encodeURIComponent(project.path)}`}
          className={board ? 'btn' : 'btn btn-primary'}
          aria-disabled={!project.exists || undefined}
          aria-label={t('projects:worktrees.newChatIn', { name: project.name })}
        >
          <MessageCircle {...ICON_SM} />
          {t('projects:worktrees.newChatHere')}
        </Link>
        {board && (
          <Link to={NEW_TASK_PATH} className={tab === 'summary' ? 'btn btn-primary' : 'btn'}>
            <Plus {...ICON_SM} />
            {t('projects:head.newTask')}
          </Link>
        )}
      </div>
    </header>
  );
}

/** A phone's project: back to the list, then who it is, in one line under the name. */
function PhoneHead({ project }: { project: Project }) {
  const { t } = useTranslation('projects');
  return (
    <header className="page-header project-head project-head-phone">
      <Link to="/projects" className="icon-btn" aria-label={t('head.backToProjects')}>
        <ChevronLeft {...ICON} />
      </Link>
      <Monogram name={project.name} size={40} />
      <div className="page-header-text project-head-text">
        <h1>{project.name}</h1>
        <span className="mono small muted ellipsis">
          {project.key} · {project.path}
        </span>
      </div>
    </header>
  );
}

/** On a phone a tab opens as its own screen, headed by its name and the project it belongs to. */
function PhoneViewHead({ project, view, onBack }: { project: Project; view: ProjectViewId; onBack: () => void }) {
  const { t } = useTranslation('home');
  return (
    <header className="page-header project-head project-head-phone">
      <button type="button" className="icon-btn" aria-label={t('dashboard.back')} onClick={onBack}>
        <ChevronLeft {...ICON} />
      </button>
      <div className="page-header-text project-head-text">
        <h1>{t(`tabs.${view}`)}</h1>
        <span className="mono small muted ellipsis">{project.name}</span>
      </div>
    </header>
  );
}

/** The phone's stand-in for the tab strip: a card of cells, one per tab, with the same figures. */
function PhoneTabCells({ views, counts }: { views: ProjectViewId[]; counts: Partial<Record<TabId, number>> }) {
  const { t } = useTranslation(['home', 'projects']);
  const [params] = useSearchParams();
  const href = (view: ProjectViewId) => {
    const next = new URLSearchParams(params);
    next.set('view', view);
    return `/?${next.toString()}`;
  };
  return (
    <nav aria-label={t('page.sections')}>
      <ul className="card settings-cells project-tab-cells">
        {views.map((view) => {
          const Icon = TAB_ICON[view];
          const count = counts[view];
          return (
            <li key={view}>
              <Link to={href(view)} className="settings-cell project-tab-cell">
                <span className="project-tab-cell-icon" aria-hidden>
                  <Icon {...ICON} />
                </span>
                <span className="settings-cell-name">{t(`tabs.${view}`)}</span>
                {count !== undefined &&
                  (IDLE_COUNT.has(view) ? (
                    <TabCount id={view} count={count} />
                  ) : (
                    <span className="mono small muted">{view === 'board' ? t('projects:head.open', { count, n: formatNumber(count) }) : formatNumber(count)}</span>
                  ))}
                <ChevronRight {...ICON_SM} className="settings-cell-chevron" />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function ProjectDashboard({ project }: { project: Project }) {
  const { t } = useTranslation('home');
  const layout = useMemo(() => defaultLayout('project'), []);
  return <Dashboard layout={layout} project={project} label={t('dashboard.label', { name: project.name })} />;
}

function TabBody({ project, tab }: { project: Project; tab: ProjectViewId }) {
  return (
    <Suspense fallback={<Skeleton rows={4} height={18} />}>
      {tab === 'board' && <ProjectBoard />}
      {tab === 'settings' && <ProjectSettings project={project} />}
      {tab === 'memory' && <ProjectMemory project={project} />}
      {tab === 'documents' && <ProjectDocuments project={project} />}
      {tab === 'resources' && <ProjectResources project={project} />}
      {tab === 'worktrees' && <ProjectWorktrees project={project} />}
    </Suspense>
  );
}

/**
 * A project's page: its header and a tab strip, Resumen (the dashboard) first. A tab exists only
 * while its module is on, so an address that names a hidden one lands on Resumen. On a phone the
 * strip is a card of cells above Resumen's widgets, and each tab is a screen of its own.
 */
function ProjectPage({ project }: { project: Project }) {
  const { t } = useTranslation('home');
  usePageTitle(project.name);
  const narrow = useMediaQuery(NARROW);
  const [params, setParams] = useSearchParams();
  const dirtyKeys = useDirtyKeys();
  const guard = useLeaveGuard();
  const group = useTabGroup();
  const counts = useTabCounts(project);
  const views = projectViews(project.modules);
  const asked = asProjectView(params.get('view'));
  const view = asked && views.includes(asked) ? asked : null;
  const tab: TabId = view ?? 'summary';

  if (asked && !view) {
    const next = new URLSearchParams(params);
    next.delete('view');
    next.delete('section');
    const query = next.toString();
    return <Navigate to={{ pathname: '/', search: query ? `?${query}` : '' }} replace />;
  }

  // Each tab keeps its own sections in the address, so switching starts the next one clean
  const open = (next: TabId) =>
    void guard().then((ok) => {
      if (!ok) return;
      const query = new URLSearchParams();
      const selected = params.get('project');
      if (selected) query.set('project', selected);
      if (next !== 'summary') query.set('view', next);
      setParams(query, { replace: next !== 'summary' });
    });

  if (narrow) {
    return view ? (
      <>
        {/* A document open on a phone heads its own screen, with its way back to the list */}
        {!(view === 'documents' && params.has('doc')) && <PhoneViewHead project={project} view={view} onBack={() => open('summary')} />}
        <MissingAlert project={project} />
        <div className="tab-panel">
          <TabBody project={project} tab={view} />
        </div>
      </>
    ) : (
      <>
        <PhoneHead project={project} />
        <MissingAlert project={project} />
        {/* The cells are how a phone reaches the board and the settings: under the whole dashboard
            they sat a dozen widgets down, where the reference has them near the top */}
        <PhoneTabCells views={views} counts={counts} />
        <ProjectDashboard project={project} />
      </>
    );
  }

  const tabs: TabId[] = ['summary', ...views];
  return (
    <>
      <ProjectHead project={project} tab={tab} />
      <MissingAlert project={project} />
      <div className="project-tabs">
        <Tabs
          label={t('page.sections')}
          group={group}
          value={tab}
          tabs={tabs.map((id) => {
            const Icon = TAB_ICON[id];
            const count = counts[id];
            const label: ReactNode = (
              <>
                <Icon {...ICON_SM} />
                {t(`tabs.${id}`)}
                {count !== undefined && <TabCount id={id} count={count} />}
              </>
            );
            return { id, label, dirty: dirtyKeys.size > 0 && id === tab };
          })}
          onChange={open}
        />
      </div>
      <TabPanel group={group} tab={tab} className="tab-panel" key={`${project.id}:${tab}`}>
        {view ? <TabBody project={project} tab={view} /> : <ProjectDashboard project={project} />}
      </TabPanel>
    </>
  );
}

/**
 * Home is a dashboard of widgets across every project, or, with a project selected, that project's
 * page: its tabs, Resumen (its dashboard) first. The tabs mean nothing without a project, so All
 * projects has only the dashboard.
 */
export function Home() {
  const { t } = useTranslation('home');
  const [params] = useSearchParams();
  const { project, ready } = useProjectScope();
  const globalLayout = useMemo(() => defaultLayout('global'), []);
  const redirect = legacyTabRedirect(params);
  if (redirect !== null) return <Navigate to={{ pathname: '/', search: redirect }} replace />;
  if (!ready) return <Skeleton rows={5} height={18} />;
  if (!project) {
    return (
      <>
        <HomeHero project={null} />
        <Dashboard layout={globalLayout} project={null} label={t('dashboard.labelAll')} />
      </>
    );
  }
  return (
    <DirtyProvider>
      <ProjectPage key={project.id} project={project} />
    </DirtyProvider>
  );
}
