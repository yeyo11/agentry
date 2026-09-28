import type { Project } from '@agentry/shared';
import { BookText, ChevronRight, FileText, FolderX, GitFork, LayoutDashboard, MessageCircle, Package, Plus, SlidersHorizontal, Sparkle, SquareKanban, Users, type LucideIcon } from 'lucide-react';
import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useDocuments, useOpenTaskCount, useTeam } from '../api';
import type { MenuEntry } from '../components/controls/Menu';
import { ICON, ICON_SM } from '../components/icons';
import { PhoneHeader } from '../components/shell/PhoneHeader';
import { Skeleton, TabPanel, Tabs, usePageTitle, useTabGroup } from '../components/ui';
import { DirtyProvider, useDirtyKeys, useLeaveGuard } from '../lib/dirty';
import { formatNumber } from '../lib/format';
import { NARROW, useMediaQuery } from '../lib/media';
import { NEW_TASK_PATH } from '../lib/work-items';
import { useProjectScope } from '../lib/project-scope';
import { Dashboard } from './dashboard/Dashboard';
import { HomeHero } from './dashboard/Hero';
import { defaultLayout } from './dashboard/registry';
import { usePendingProposalCount } from './home/memory/Proposals';
import { PhoneAssistantRow, PhoneHead, ProjectHead } from './home/ProjectHead';
import { useProjectResourceCount } from './home/resources/data';
import { assistantPath, projectPath } from './assistant/model';
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
 */
function useTabCounts(project: Project): Partial<Record<TabId, number>> {
  const open = useOpenTaskCount(project, true);
  const team = useTeam(project.modules.includes('team') ? project.id : null).data;
  const documents = useDocuments(project.modules.includes('documents') ? project.id : null).data?.fileCount;
  const proposals = usePendingProposalCount(project.id, project.modules.includes('memory'));
  const resources = useProjectResourceCount(project);
  return {
    board: open,
    team: team?.members.length || undefined,
    documents,
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

/**
 * On a phone a tab opens as its own screen (MobileMemoria, MobileDocumentos, MobileProyectoAjustes…),
 * headed by its name and the project it belongs to, with where it reads from when it reads a folder.
 * Its "⋯" starts work in the project, as the project's own head does; Ajustes is a form with its
 * own Save, and Recursos has its "+" and its assistant in its toolbar, so neither has one.
 */
function PhoneViewHead({ project, view }: { project: Project; view: ProjectViewId }) {
  const { t } = useTranslation(['home', 'projects']);
  const navigate = useNavigate();
  const root = useDocuments(view === 'documents' ? project.id : null).data?.root;
  const where = view === 'documents' && root ? `${root.replace(/\/?$/, '/')}` : view === 'resources' ? '.claude/' : null;
  const more: MenuEntry[] =
    view === 'settings' || view === 'resources'
      ? []
      : [
          { id: 'assistant', label: t('projects:head.assistant'), icon: Sparkle, onSelect: () => navigate(assistantPath(project.id)) },
          { id: 'chat', label: t('projects:worktrees.newChatHere'), icon: MessageCircle, disabled: !project.exists, onSelect: () => navigate(`/chats/new?cwd=${encodeURIComponent(project.path)}`) },
          ...(project.modules.includes('board') ? [{ id: 'task', label: t('projects:head.newTask'), icon: Plus, onSelect: () => navigate(NEW_TASK_PATH) }] : []),
        ];
  return (
    <PhoneHeader
      className="project-phone-head"
      title={t(`tabs.${view}`)}
      subtitle={where ? `${project.name} · ${where}` : project.name}
      back={{ label: t('dashboard.back'), fallback: projectPath(project.id) }}
      more={more}
    />
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
        <PhoneHead project={project} />
        <MissingAlert project={project} />
        {/* The cells are how a phone reaches the board and the settings: under the whole dashboard
            they sat a dozen widgets down, where the reference has them near the top */}
        <PhoneAssistantRow project={project} />
        <PhoneTabCells views={views} counts={counts} />
        <ProjectDashboard project={project} />
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
      <ProjectHead project={project} primaryTask={tab === 'summary'} actions={!FORM_TABS.has(tab)} />
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
