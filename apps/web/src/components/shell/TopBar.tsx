import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router-dom';
import { AssistantCrumbs, assistantProjectOf } from '../../pages/assistant/crumbs';
import { asProjectView } from '../../pages/dashboard/views';
import { useProjectScope } from '../../lib/project-scope';
import type { LiveSummary } from '../../lib/shell-live';
import { normalizeKey, TASKS_PATH } from '../../lib/work-items';
import { CommandPaletteTrigger } from '../CommandPalette';
import type { MenuItem } from '@agentry/ui/components/controls/Menu';
import { BrandMark } from '@agentry/ui/components/icons';
import { NotificationBell } from '../Notifications';
import { ProjectSelector } from '../ProjectSelector';
import { SplitButton } from '@agentry/ui/components/SplitButton';
import { LiveChip } from './live';
import { TeamCrumbs } from './TeamCrumbs';

/**
 * The top bar: the project scope as the crumb's root, where the page is below it, and what is live,
 * the bell and "New chat ▾". A phone's detail screens drop it for their own header (hidesTopBar).
 */
export function TopBar({
  pathname,
  search,
  projectsLabel,
  currentLabel,
  live,
  startEntries,
  onNewChat,
}: {
  pathname: string;
  search: string;
  projectsLabel: string;
  /** The current section's name, from the sidebar */
  currentLabel: string | undefined;
  live: LiveSummary & { any: boolean };
  startEntries: MenuItem[];
  onNewChat: () => void;
}) {
  const { t } = useTranslation(['components', 'home']);
  const { project } = useProjectScope();
  // A project's page reads "Projects / <name> / <tab>", as every project tab of the reference does.
  // A tab its modules hide lands on Summary, so the crumb may name it for a moment before that
  const projectTab = pathname === '/' && project ? (asProjectView(new URLSearchParams(search).get('view')) ?? 'summary') : null;
  const assistantProject = assistantProjectOf(pathname);
  // A work item's page, and the review of its changes, add its key to the crumb: "Tasks / AGN-12"
  const taskKey = pathname.startsWith(`${TASKS_PATH}/`) ? normalizeKey(decodeURIComponent(pathname.slice(TASKS_PATH.length + 1).split('/')[0] ?? '')) : null;
  // In the desktop app this bar is also the window's title bar (lib/desktop.ts, styles/shell.css)
  return (
    <header className="topbar">
      {/* A phone has no sidebar, so the bar carries the mark that leads home */}
      <NavLink to="/" className="brand topbar-brand" aria-label="Agentry">
        <BrandMark size={28} />
      </NavLink>
      {/* The scope is the crumb's root: every page below it is about that project */}
      <div className="crumbs">
        <ProjectSelector />
        <span className="crumb-sep" aria-hidden>
          /
        </span>
        {projectTab && project ? (
          <>
            <Link to="/projects" className="crumb-page muted ellipsis">
              {projectsLabel}
            </Link>
            <span className="crumb-sep" aria-hidden>
              /
            </span>
            <span className="crumb-page muted ellipsis">{project.name}</span>
            <span className="crumb-sep" aria-hidden>
              /
            </span>
            {projectTab === 'team' ? <TeamCrumbs projectId={project.id} search={search} /> : <span className="crumb-page ellipsis">{t(`home:tabs.${projectTab}`)}</span>}
          </>
        ) : assistantProject ? (
          <AssistantCrumbs projectId={assistantProject} projectsLabel={projectsLabel} />
        ) : taskKey ? (
          <>
            <Link to={TASKS_PATH} className="crumb-page muted ellipsis">
              {currentLabel}
            </Link>
            <span className="crumb-sep" aria-hidden>
              /
            </span>
            <span className="crumb-page mono">{taskKey}</span>
          </>
        ) : (
          <span className="crumb-page ellipsis">{currentLabel ?? 'Agentry'}</span>
        )}
      </div>
      <div className="topbar-actions">
        <CommandPaletteTrigger className="topbar-search" />
        <LiveChip live={live} />
        <NotificationBell />
        <SplitButton className="topbar-new" label={t('shell.newChat')} icon={Plus} onClick={onNewChat} entries={startEntries} />
      </div>
    </header>
  );
}
