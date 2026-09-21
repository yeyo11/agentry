import type { Project } from '@agentry/shared';
import { ArrowLeft, FolderX, Settings } from 'lucide-react';
import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ICON_SM } from '../components/icons';
import { PageHeader, PathLabel, Skeleton, TabPanel, Tabs, useTabGroup } from '../components/ui';
import { DirtyProvider, useDirtyKeys, useLeaveGuard } from '../lib/dirty';
import { useProjectScope } from '../lib/project-scope';
import { Dashboard } from './dashboard/Dashboard';
import { defaultLayout } from './dashboard/registry';
import { asProjectView, legacyTabRedirect, PROJECT_VIEWS, type ProjectViewId } from './dashboard/views';

// The dashboard is what most visits are for; the project's full views load when opened
const ProjectSettings = lazy(() => import('./home/ProjectSettings').then((m) => ({ default: m.ProjectSettings })));
const ProjectMemory = lazy(() => import('./home/ProjectMemory').then((m) => ({ default: m.ProjectMemory })));
const ProjectResources = lazy(() => import('./home/ProjectResources').then((m) => ({ default: m.ProjectResources })));
const ProjectWorktrees = lazy(() => import('./home/ProjectWorktrees').then((m) => ({ default: m.ProjectWorktrees })));

function ProjectHeader({ project, actions }: { project: Project; actions?: ReactNode }) {
  const { t } = useTranslation('home');
  return (
    <>
      <PageHeader docTitle={project.name} title={project.name} subtitle={<PathLabel path={project.path} />} actions={actions} />
      {!project.exists && (
        <div className="alert alert-warn" role="alert">
          <FolderX size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
          <div className="alert-body">
            <strong>{t('page.missing')}</strong>
            <div>{t('page.missingHint')}</div>
          </div>
        </div>
      )}
    </>
  );
}

function ProjectView({ project, view }: { project: Project; view: ProjectViewId }) {
  const { t } = useTranslation('home');
  const [, setParams] = useSearchParams();
  const dirtyKeys = useDirtyKeys();
  const guard = useLeaveGuard();
  const group = useTabGroup();
  // Each view keeps its own sections in the address, so switching starts the next one clean
  const open = (next: ProjectViewId | null) => void guard().then((ok) => ok && setParams(next ? { view: next } : {}, { replace: next !== null }));

  return (
    <>
      <ProjectHeader
        project={project}
        actions={
          <button type="button" className="btn btn-small" onClick={() => open(null)}>
            <ArrowLeft {...ICON_SM} />
            {t('dashboard.back')}
          </button>
        }
      />
      <Tabs
        label={t('page.sections')}
        group={group}
        value={view}
        tabs={PROJECT_VIEWS.map((id) => ({ id, label: t(`tabs.${id}`), dirty: dirtyKeys.size > 0 && id === view }))}
        onChange={open}
      />
      <TabPanel group={group} tab={view} className="tab-panel" key={`${project.id}:${view}`}>
        <Suspense fallback={<Skeleton rows={4} height={18} />}>
          {view === 'settings' && <ProjectSettings project={project} />}
          {view === 'memory' && <ProjectMemory project={project} />}
          {view === 'resources' && <ProjectResources project={project} />}
          {view === 'worktrees' && <ProjectWorktrees project={project} />}
        </Suspense>
      </TabPanel>
    </>
  );
}

function ProjectDashboard({ project }: { project: Project }) {
  const { t } = useTranslation('home');
  const layout = useMemo(() => defaultLayout('project'), []);
  return (
    <>
      <ProjectHeader
        project={project}
        actions={
          <Link to="/?view=settings" className="btn btn-small" aria-label={t('dashboard.projectSettings', { name: project.name })}>
            <Settings {...ICON_SM} />
          </Link>
        }
      />
      <Dashboard layout={layout} project={project} label={t('dashboard.label', { name: project.name })} />
    </>
  );
}

function ProjectPage({ project }: { project: Project }) {
  const [params] = useSearchParams();
  const view = asProjectView(params.get('view'));
  return view ? <ProjectView project={project} view={view} /> : <ProjectDashboard project={project} />;
}

/**
 * Home is a dashboard of widgets: the selected project's, or one across every project. A project's
 * settings, memory, resources and worktrees are full views of the same page, reached from its ⚙ and
 * from their widgets; they mean nothing without a project, so All projects has only the dashboard.
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
        <PageHeader title={t('page.title')} subtitle={t('page.subtitle')} />
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
