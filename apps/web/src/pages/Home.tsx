import type { Project } from '@agentry/shared';
import { FolderX } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { PageHeader, PathLabel, Skeleton, TabPanel, Tabs, useTabGroup } from '../components/ui';
import { DirtyProvider, useDirtyKeys, useLeaveGuard } from '../lib/dirty';
import { useProjectScope } from '../lib/project-scope';
import { Activity } from './home/Activity';

// Only Activity is what most visits are for; the project's own screens load when opened
const ProjectSettings = lazy(() => import('./home/ProjectSettings').then((m) => ({ default: m.ProjectSettings })));
const ProjectMemory = lazy(() => import('./home/ProjectMemory').then((m) => ({ default: m.ProjectMemory })));
const ProjectResources = lazy(() => import('./home/ProjectResources').then((m) => ({ default: m.ProjectResources })));
const ProjectWorktrees = lazy(() => import('./home/ProjectWorktrees').then((m) => ({ default: m.ProjectWorktrees })));

const TABS = ['activity', 'settings', 'memory', 'resources', 'worktrees'] as const;

type TabId = (typeof TABS)[number];

function ProjectPage({ project }: { project: Project }) {
  const { t } = useTranslation('home');
  const [params, setParams] = useSearchParams();
  const dirtyKeys = useDirtyKeys();
  const guard = useLeaveGuard();
  const group = useTabGroup();
  const tab: TabId = TABS.find((id) => id === params.get('tab')) ?? 'activity';
  // Every tab keeps its own sections in the address, so switching starts the next one clean
  const open = (id: TabId) => void guard().then((ok) => ok && setParams(id === 'activity' ? {} : { tab: id }, { replace: true }));

  return (
    <>
      <PageHeader
        docTitle={project.name}
        title={project.name}
        subtitle={<PathLabel path={project.path} />}
      />
      {!project.exists && (
        <div className="alert alert-warn" role="alert">
          <FolderX size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
          <div className="alert-body">
            <strong>{t('page.missing')}</strong>
            <div>{t('page.missingHint')}</div>
          </div>
        </div>
      )}
      <Tabs
        label={t('page.sections')}
        group={group}
        value={tab}
        tabs={TABS.map((id) => ({ id, label: t(`tabs.${id}`), dirty: dirtyKeys.size > 0 && id === tab }))}
        onChange={open}
      />
      <TabPanel group={group} tab={tab} className="tab-panel" key={`${project.id}:${tab}`}>
        {tab === 'activity' && <Activity project={project} />}
        <Suspense fallback={<Skeleton rows={4} height={18} />}>
          {tab === 'settings' && <ProjectSettings project={project} />}
          {tab === 'memory' && <ProjectMemory project={project} />}
          {tab === 'resources' && <ProjectResources project={project} />}
          {tab === 'worktrees' && <ProjectWorktrees project={project} />}
        </Suspense>
      </TabPanel>
    </>
  );
}

/**
 * The home page is the selected project's page. With All projects only Activity remains: the rest
 * means nothing without a project.
 */
export function Home() {
  const { t } = useTranslation('home');
  const { project, ready } = useProjectScope();
  if (!ready) return <Skeleton rows={5} height={18} />;
  if (!project) {
    return (
      <>
        <PageHeader title={t('page.title')} subtitle={t('page.subtitle')} />
        <Activity project={null} />
      </>
    );
  }
  return (
    <DirtyProvider>
      <ProjectPage key={project.id} project={project} />
    </DirtyProvider>
  );
}
