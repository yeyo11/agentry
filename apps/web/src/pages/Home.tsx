import type { Project } from '@agentry/shared';
import { BookText, ChevronRight, FileText, FolderX, GitFork, LayoutDashboard, Package, Pencil, SlidersHorizontal, SquareKanban, Users, type LucideIcon } from 'lucide-react';
import { ALL_PROJECTS_LAYOUT } from '@agentry/shared';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useDocuments, useOpenTaskCount, useTeam } from '../api';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { Skeleton, TabPanel, Tabs, usePageTitle, useTabGroup } from '@agentry/ui/components/ui';
import { DirtyProvider, useDirtyKeys, useLeaveGuard } from '../lib/dirty';
import { formatNumber } from '@agentry/ui/lib/format';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { useProjectScope } from '../lib/project-scope';
import { Dashboard } from './dashboard/Dashboard';
import { HomeHero } from './dashboard/Hero';
import { EditableDashboard } from './dashboard/DashboardEditor';
import { useHomeLayout } from './dashboard/useHomeLayout';
import { usePendingProposalCount } from './home/memory/Proposals';
import { PhoneAssistantRow, PhoneHead, PhoneViewHead, ProjectHead } from './home/ProjectHead';
import { useProjectResourceCount } from './home/resources/data';
import { asProjectView, legacyTabRedirect, projectViews, type ProjectViewId } from './dashboard/views';

// The dashboard is what most visits are for; the project's other tabs load when opened
const ProjectSettings = lazy(() => import('./home/ProjectSettings').then((m) => ({ default: m.ProjectSettings })));
const ProjectMemory = lazy(() => import('./home/ProjectMemory').then((m) => ({ default: m.ProjectMemory })));
const ProjectResources = lazy(() => import('./home/ProjectResources').then((m) => ({ default: m.ProjectResources })));
const ProjectDocuments = lazy(() => import('./documents/Documents').then((m) => ({ default: m.ProjectDocuments })));
const ProjectWorktrees = lazy(() => import('./home/ProjectWorktrees').then((m) => ({ default: m.ProjectWorktrees })));
// The Tasks board itself: it reads the selected project, which on this page is the one shown
const ProjectBoard = lazy(() => import('./tasks/Board').then((m) => ({ default: m.Board })));
const ProjectTeam = lazy(() => import('./team/Team').then((m) => ({ default: m.ProjectTeam })));

type TabId = 'summary' | ProjectViewId;

const TAB_ICON: Record<TabId, LucideIcon> = {
  summary: LayoutDashboard,
  board: SquareKanban,
  team: Users,
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
 * The figure each tab carries, neutral: open tasks on the board, the team's members, the documents,
 * the worktrees. Memory's is the proposals waiting for the person, which `IDLE_COUNT` draws in idle.
 * A zero is left out, as the reference does: an empty tab says so once opened.
 */
function useTabCounts(project: Project): Partial<Record<TabId, number>> {
  const open = useOpenTaskCount(project, true);
  const team = useTeam(project.modules.includes('team') ? project.id : null).data;
  const documents = useDocuments(project.modules.includes('documents') ? project.id : null).data?.fileCount;
  const proposals = usePendingProposalCount(project.id, project.modules.includes('memory'));
  const resources = useProjectResourceCount(project);
  return {
    board: open || undefined,
    team: team?.members.length || undefined,
    documents: documents || undefined,
    memory: proposals || undefined,
    resources: resources || undefined,
    worktrees: project.worktrees.length || undefined,
  };
}

/** Tabs that are a form with their own primary (Save, Create): the header leaves its actions out there. */
const FORM_TABS: ReadonlySet<TabId> = new Set(['settings', 'resources']);

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

/**
 * A Home's dashboard: its stored layout (or the default), and in edit mode the same widgets in
 * their frames. A project's layout is its own; All projects has one of its own too.
 */
function HomeDashboard({ project, editing, onDone, page }: { project: Project | null; editing: boolean; onDone: () => void; page?: boolean }) {
  const { t } = useTranslation('home');
  const scope = project ? 'project' : 'global';
  const home = useHomeLayout(project ? project.id : ALL_PROJECTS_LAYOUT, scope);
  const label = project ? t('dashboard.label', { name: project.name }) : t('dashboard.labelAll');
  // Drawing the default while the stored layout is on its way would show one Home and then another
  if (home.loading) return <Skeleton rows={5} height={18} />;
  return editing ? (
    <EditableDashboard layout={home.layout} project={project} scope={scope} label={label} stored={home.stored} save={home.save} reset={home.reset} onDone={onDone} page={page} />
  ) : (
    <Dashboard layout={home.layout} project={project} label={label} />
  );
}

function TabBody({ project, tab }: { project: Project; tab: ProjectViewId }) {
  return (
    <Suspense fallback={<Skeleton rows={4} height={18} />}>
      {tab === 'board' && <ProjectBoard />}
      {tab === 'team' && <ProjectTeam project={project} />}
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
  const [editing, setEditing] = useState(false);
  const views = projectViews(project.modules);
  const asked = asProjectView(params.get('view'));
  const view = asked && views.includes(asked) ? asked : null;
  const tab: TabId = view ?? 'summary';
  // Edit mode belongs to Resumen: leaving it for another tab ends it (each change is already saved)
  useEffect(() => {
    if (tab !== 'summary') setEditing(false);
  }, [tab]);

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
        {/* Team heads its own screens, and so does a document open on a phone, with its way back */}
        {view !== 'team' && !(view === 'documents' && params.has('doc')) && (
          <PhoneViewHead project={project} view={view} />
        )}
        <MissingAlert project={project} />
        <div className="tab-panel">
          <TabBody project={project} tab={view} />
        </div>
      </>
    ) : (
      <>
        <PhoneHead project={project} onEditHome={editing ? undefined : () => setEditing(true)} />
        <MissingAlert project={project} />
        {/* The cells are how a phone reaches the board and the settings: under the whole dashboard
            they sat a dozen widgets down, where the reference has them near the top. While the
            Home is being arranged the screen is the list alone, as MobileInicioEditar draws it */}
        {!editing && (
          <>
            <PhoneAssistantRow project={project} />
            <PhoneTabCells views={views} counts={counts} />
          </>
        )}
        <HomeDashboard project={project} editing={editing} onDone={() => setEditing(false)} />
      </>
    );
  }

  // A member is a page of its own, as its reference draws it: the crumb says where it is, its back
  // button leads to the team, and the project's head and tabs would only push its editor down
  if (view === 'team' && params.has('member')) {
    return (
      <>
        <MissingAlert project={project} />
        <div className="tab-panel">
          <TabBody project={project} tab={view} />
        </div>
      </>
    );
  }

  const tabs: TabId[] = ['summary', ...views];
  return (
    <>
      <ProjectHead
        project={project}
        primaryTask={tab === 'summary'}
        actions={!FORM_TABS.has(tab)}
        onEditHome={tab === 'summary' && !editing ? () => setEditing(true) : undefined}
      />
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
        {view ? <TabBody project={project} tab={view} /> : <HomeDashboard project={project} editing={editing} onDone={() => setEditing(false)} />}
      </TabPanel>
    </>
  );
}

/**
 * Home is a dashboard of widgets across every project, or, with a project selected, that project's
 * page: its tabs, Resumen (its dashboard) first. The tabs mean nothing without a project, so All
 * projects has only the dashboard.
 */
function AllProjectsHome() {
  const { t } = useTranslation('home');
  const [editing, setEditing] = useState(false);
  // While editing, the edit head takes the hero's place (DesktopInicioEditar), so the title is kept here
  usePageTitle(t('page.title'));
  return (
    <>
      {!editing && (
        <HomeHero
          project={null}
          actions={
            <button type="button" className="btn btn-quiet" onClick={() => setEditing(true)}>
              <Pencil {...ICON_SM} />
              {t('edit.enter')}
            </button>
          }
        />
      )}
      <HomeDashboard project={null} editing={editing} onDone={() => setEditing(false)} page />
    </>
  );
}

export function Home() {
  const [params] = useSearchParams();
  const { project, ready } = useProjectScope();
  const redirect = legacyTabRedirect(params);
  if (redirect !== null) return <Navigate to={{ pathname: '/', search: redirect }} replace />;
  if (!ready) return <Skeleton rows={5} height={18} />;
  if (!project) return <AllProjectsHome />;
  return (
    <DirtyProvider>
      <ProjectPage key={project.id} project={project} />
    </DirtyProvider>
  );
}
