import {
  BookOpen,
  CalendarClock,
  ChartColumn,
  FolderGit2,
  House,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plug,
  Settings2,
  Sparkle,
  SquareCheck,
  Workflow,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, chatListQuery, keys, useOpenTaskCount } from './api';
import { CommandPalette, CommandPaletteTrigger, NEW_ORCHESTRATION_PATH, RUN_WORKFLOW_EVENT } from './components/CommandPalette';
import type { MenuItem } from '@agentry/ui/components/controls/Menu';
import { Tooltip } from '@agentry/ui/components/controls/Tooltip';
import { DetailHost } from './components/DetailHost';
import { BrandMark, ICON } from '@agentry/ui/components/icons';
import { NotificationHost } from './components/Notifications';
import { PageTransition, SlidingIndicator, StatusDot } from '@agentry/ui/components/motion';
import { lazyPage, ReloadBanner } from './components/ReloadOffer';
import { Fab } from './components/shell/Fab';
import { useOwnPhoneHeader, usePhoneHeaderMark } from './components/shell/PhoneHeader';
import { LiveSection, useLive } from './components/shell/live';
import { ProviderCard, StatusBar, useConnection } from './components/shell/StatusBar';
import { useRailCollapsed } from './components/shell/rail';
import { TopBar } from './components/shell/TopBar';
import { isActive, NavDot, navTarget, TabBar, type NavItem } from './components/shell/TabBar';
import { ProvidersStep } from './components/ProvidersStep';
import { SignIn } from './components/SignIn';
import { useFirstRun } from './lib/first-run';
import { Empty, Skeleton } from '@agentry/ui/components/ui';
import { useUsageNow } from './lib/usage-now';
import { useAuthChallenge, useAuthSettled } from './lib/auth';
import { listRequest } from '@agentry/chat-ui/lib/chat-model';
import { useDesktopNavigation } from './lib/desktop';
import { useKeyboardInset } from './lib/viewport';
import { useEventFeed } from './lib/events';
import { ProjectScopeProvider, useProjectScope } from './lib/project-scope';
import { fabFor, hidesTabBar } from './lib/shell-live';
import { NEW_TASK_PATH, TASKS_PATH } from './lib/work-items';
import { Home } from './pages/Home';
import { AGENTRY_ASSISTANT_PATH } from './pages/agentry-assistant/model';

// Only the landing pages ship in the main bundle; everything else loads on first visit
const ChatView = lazyPage(() => import('./pages/ChatView').then((m) => m.ChatView));
const loadChangesReview = () => import('./pages/ChangesReview');
const ChatChangesReview = lazyPage(() => loadChangesReview().then((m) => m.ChatChangesReview));
const TaskChangesReview = lazyPage(() => loadChangesReview().then((m) => m.TaskChangesReview));
const IntegrationChangesReview = lazyPage(() => loadChangesReview().then((m) => m.IntegrationChangesReview));
const WorkItemChangesReview = lazyPage(() => loadChangesReview().then((m) => m.WorkItemChangesReview));
const Connectors = lazyPage(() => import('./pages/Connectors').then((m) => m.Connectors));
// Loaded ahead of a visit too: the list is where most visits go after the landing page
const loadChats = () => import('./pages/Chats');
const Chats = lazyPage(() => loadChats().then((m) => m.Chats));
const NewChat = lazyPage(() => import('./pages/NewChat').then((m) => m.NewChat));
const Orchestration = lazyPage(() => import('./pages/Orchestration').then((m) => m.Orchestration));
const OrchestrationDetail = lazyPage(() => import('./pages/OrchestrationDetail').then((m) => m.OrchestrationDetail));
const Projects = lazyPage(() => import('./pages/Projects').then((m) => m.Projects));
const NewProject = lazyPage(() => import('./pages/projects/NewProject').then((m) => m.NewProject));
const AgentryAssistant = lazyPage(() => import('./pages/agentry-assistant/Entry').then((m) => m.AgentryAssistant));
const AssistantPage = lazyPage(() => import('./pages/assistant/Assistant').then((m) => m.AssistantPage));
const TasksBoard = lazyPage(() => import('./pages/tasks/Board').then((m) => m.Board));
const Milestones = lazyPage(() => import('./pages/tasks/Milestones').then((m) => m.Milestones));
const WorkItemPage = lazyPage(() => import('./pages/tasks/WorkItem').then((m) => m.WorkItemPage));
const RunWorkflowDialog = lazyPage(
  () => import('./components/RunWorkflowDialog').then((m) => m.RunWorkflowDialog),
  // A dialog has no page to stand in for: the banner alone says what happened
  () => null,
);
const Schedules = lazyPage(() => import('./pages/Schedules').then((m) => m.Schedules));
const ScheduleEditor = lazyPage(() => import('./pages/ScheduleEditor').then((m) => m.ScheduleEditor));
const Usage = lazyPage(() => import('./pages/Usage').then((m) => m.Usage));
const Settings = lazyPage(() => import('./pages/Settings').then((m) => m.Settings));

/** A list prefetched on hover is used as it is if the click comes within this long. */
const PREFETCH_FRESH_MS = 10_000;


export function App() {
  // A guarded wrapper reached without a credential answers 401 to everything, so the shell is not
  // mounted at all: one screen that asks, instead of every page failing on its own
  const challenge = useAuthChallenge();
  const settled = useAuthSettled();
  if (challenge) return <SignIn mode={challenge} />;
  if (!settled) return null;
  return <FirstRunGate />;
}

/** The first-run Providers step in place of the app, until it is answered or skipped */
function FirstRunGate() {
  const firstRun = useFirstRun();
  // Held back for the two reads, as the sign-in is, so the shell does not flash and then vanish
  if (firstRun.state === 'pending') return null;
  if (firstRun.state === 'shown') return <ProvidersStep statuses={firstRun.statuses} onFinish={firstRun.finish} />;
  // The project selector scopes pages far from the top bar, so it lives above all of them
  return (
    <ProjectScopeProvider>
      <Shell />
    </ProjectScopeProvider>
  );
}

function Shell() {
  const navigate = useNavigate();
  const { project, settled } = useProjectScope();
  const { pathname, search } = useLocation();
  // A phone's detail screens are headed by the page itself, by route (components/shell/phone-header.ts).
  // `bare` is `useOwnPhoneHeader`, the condition PhoneHeader.tsx defines for a page heading itself, so
  // the shell hiding its top bar and a page drawing its own cannot drift apart.
  const phoneHeader = usePhoneHeaderMark();
  const bare = useOwnPhoneHeader();
  const { t } = useTranslation(['components', 'connectors', 'shell', 'home']);
  // The same queries the Home usage widgets read, so the status bar never fetches its own
  const now = useUsageNow();
  const overview = now.overview;
  // The one connection that keeps every page current; the status bar shows when it is down
  const feed = useEventFeed();
  useDesktopNavigation();
  useKeyboardInset();
  const counts = overview.data?.counts;
  const connection = useConnection(overview, feed === 'open');
  const live = useLive(counts);
  const openTasks = useOpenTaskCount(project, settled);
  const [collapsed, setCollapsed] = useRailCollapsed();
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const queryClient = useQueryClient();

  // Pointing at Chats is a good sign of a click: its code and the list it opens on (no filters, the
  // top bar's project) start loading then, so the page opens with its rows instead of a skeleton.
  // The code alone is also fetched once the browser is idle; the list is not, being the heaviest read.
  const warmChats = useCallback(() => {
    void loadChats();
    // Before the scope is known the page would not read this entry, but the one of its project
    if (!settled) return;
    const filter = { ...listRequest({ internal: false, workers: false }), ...(project ? { project: project.id } : {}) };
    void queryClient.prefetchQuery({ ...chatListQuery(filter), staleTime: PREFETCH_FRESH_MS });
  }, [queryClient, project, settled]);
  useEffect(() => {
    const load = () => void loadChats();
    if (typeof requestIdleCallback === 'function') {
      const idle = requestIdleCallback(load, { timeout: 5000 });
      return () => cancelIdleCallback(idle);
    }
    const timer = setTimeout(load, 2000);
    return () => clearTimeout(timer);
  }, []);

  // A route change is silent to a screen reader and leaves keyboard focus on a link that may no
  // longer be there, so focus moves to the page, unless the page already took it (an autofocus).
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const main = mainRef.current;
    if (main && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
  }, [pathname]);

  // The palette asks for the workflow dialog it cannot host itself
  useEffect(() => {
    const open = () => setWorkflowOpen(true);
    window.addEventListener(RUN_WORKFLOW_EVENT, open);
    return () => window.removeEventListener(RUN_WORKFLOW_EVENT, open);
  }, []);

  // Read from release.json, never from GitHub; `system.release` refetches it (lib/events.ts)
  const release = useQuery({ queryKey: keys.release, queryFn: () => api.release() });
  const updateAvailable = release.data?.updateAvailable === true;

  const home: NavItem = { to: '/', label: t('nav.home'), icon: House, count: { value: counts?.chatsWaiting, what: t('nav.badge.waiting') } };
  // The global assistant: the sparkle is its mark, never the gradient, so the entry costs no gradient slot
  const assistant: NavItem = { to: AGENTRY_ASSISTANT_PATH, label: t('nav.assistant'), icon: Sparkle };
  const chats: NavItem = { to: '/chats', label: t('nav.chats'), icon: MessagesSquare, count: { value: counts?.chatsWorking, what: t('nav.badge.working'), live: true } };
  // The open items of the scope: neutral, since an item waiting in a column is not something running
  const tasks: NavItem = { to: TASKS_PATH, label: t('shell:nav.tasks'), icon: SquareCheck, count: { value: openTasks, what: t('shell:nav.open', { count: openTasks ?? 0 }) } };
  const orchestrations: NavItem = {
    to: '/orchestration',
    label: t('nav.orchestrations'),
    icon: Workflow,
    count: { value: counts?.orchestrationsRunning, what: t('nav.badge.running'), live: true },
  };
  const schedules: NavItem = { to: '/schedules', label: t('nav.schedules'), icon: CalendarClock };
  const projects: NavItem = { to: '/projects', label: t('nav.projects'), icon: FolderGit2 };
  const connectors: NavItem = { to: '/connectors', label: t('connectors:nav'), icon: Plug };
  const usage: NavItem = { to: '/usage', label: t('nav.usage'), icon: ChartColumn };
  const settings: NavItem = {
    to: '/settings',
    label: t('nav.settings'),
    icon: Settings2,
    // The Updates card is on the account tab: the dot leads straight to it
    ...(updateAvailable ? { dot: t('nav.badge.update'), search: '?tab=account' } : {}),
  };
  // What a person does, then where it happens: the sidebar's two groups
  const groups = [
    { id: 'work', label: t('shell:nav.work'), items: [home, assistant, chats, tasks, orchestrations, schedules] },
    { id: 'space', label: t('shell:nav.space'), items: [projects, connectors, usage, settings] },
  ];
  const items = groups.flatMap((group) => group.items);

  // A project's page lives at `/`: the sidebar and the tab bar mark Projects there, not Home
  const projectPage = pathname === '/' && Boolean(project);
  const current = items.find((item) => isActive(item, pathname, projectPage));

  const newChat = () => navigate(project?.exists ? `/chats/new?cwd=${encodeURIComponent(project.path)}` : '/chats/new');
  const newOrchestration = () => navigate(NEW_ORCHESTRATION_PATH);
  const newTask = () => navigate(NEW_TASK_PATH);
  // What else a person can start: behind "New chat ▾" in the top bar, and in the phone's More sheet
  const startEntries: MenuItem[] = [
    { id: 'run-workflow', label: t('shell.runWorkflow'), icon: Play, onSelect: () => setWorkflowOpen(true) },
    { id: 'new-orchestration', label: t('shell:topbar.newOrchestration'), icon: Workflow, onSelect: newOrchestration },
  ];

  // The phone has no status bar: its More sheet says the same, in two lines
  const connectionLink = (
    <NavLink to="/settings?tab=account" className="more-connection">
      <StatusDot tone={connection.tone} live={connection.live} />
      <span className="more-connection-text">
        <span className="more-connection-title ellipsis">{connection.title}</span>
        {connection.detail && <span className="more-connection-detail ellipsis">{connection.detail}</span>}
      </span>
    </NavLink>
  );

  const tabBar = !hidesTabBar(pathname, search);
  const fab = fabFor(pathname, search) !== null;

  // In the icon rail the labels are hidden, so they move into tooltips
  const railTip = (label: string) => (collapsed ? label : undefined);

  return (
    <div className={`shell ${collapsed ? 'shell-rail' : ''} ${tabBar ? 'shell-has-tabbar' : ''} ${fab ? 'shell-has-fab' : ''} ${bare ? 'shell-bare' : ''}`} data-phone-header={phoneHeader}>
      <a
        href="#main"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        {t('shell.skipToContent')}
      </a>

      <aside id="sidebar" className="sidebar" aria-label={t('shell.sidebar')}>
        <div className="sidebar-head">
          <Tooltip content={railTip('Agentry')} side="right">
            <NavLink to="/" className="brand" aria-label="Agentry">
              <BrandMark />
              <span className="brand-name">Agentry</span>
            </NavLink>
          </Tooltip>
          <Tooltip content={collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')} side="right">
            <button
              type="button"
              className="icon-btn sidebar-collapse"
              aria-label={collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')}
              onClick={() => setCollapsed((v) => !v)}
            >
              {collapsed ? <PanelLeftOpen {...ICON} /> : <PanelLeftClose {...ICON} />}
            </button>
          </Tooltip>
        </div>

        <CommandPaletteTrigger className="sidebar-search" />

        <nav className="nav" aria-label={t('shell.mainNavigation')}>
          {groups.map((group) => (
            <div key={group.id} className="nav-group" role="group" aria-labelledby={`nav-group-${group.id}`}>
              {/* Work is where the sidebar starts, so only Space shows its name; both have one */}
              <span id={`nav-group-${group.id}`} className={`nav-group-label ${group.id === 'work' ? 'sr-only' : ''}`.trim()}>
                {group.label}
              </span>
              {group.items.map((item) => {
                const active = isActive(item, pathname, projectPage);
                const Icon = item.icon;
                const badge = item.count?.value;
                return (
                  <Tooltip key={item.to} content={railTip(item.label)} side="right">
                    <Link
                      to={navTarget(item)}
                      aria-current={active ? 'page' : undefined}
                      className={`nav-link ${active ? 'is-active' : ''}`}
                      {...(item.to === '/chats' && !active ? { onPointerEnter: warmChats, onFocus: warmChats } : {})}
                    >
                      {active && <SlidingIndicator layoutId="nav-pill" className="nav-pill" />}
                      <span className="nav-icon">
                        <Icon {...ICON} />
                      </span>
                      <span className="nav-label">{item.label}</span>
                      {badge ? (
                        <span className={`nav-count ${item.count?.live ? 'is-live' : ''}`.trim()}>
                          {badge}
                          <span className="sr-only"> {item.count?.what}</span>
                        </span>
                      ) : null}
                      <NavDot label={item.dot} />
                    </Link>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </nav>

        <LiveSection live={live} rail={collapsed} />

        <Tooltip content={railTip(t('nav.apiReference'))} side="right">
          <a href="/docs" target="_blank" rel="noopener noreferrer" className="nav-link nav-link-ext">
            <span className="nav-icon">
              <BookOpen {...ICON} />
            </span>
            <span className="nav-label">{t('nav.apiReference')}</span>
          </a>
        </Tooltip>
      </aside>

      <div className="content">
        <TopBar pathname={pathname} search={search} projectsLabel={projects.label} currentLabel={current?.label} live={live} startEntries={startEntries} onNewChat={newChat} />

        <ReloadBanner />

        <main id="main" ref={mainRef} tabIndex={-1} className="main">
          {/* Keyed by pathname only: tab and scope switches (query string) must not replay the transition */}
          <PageTransition key={pathname} className="page">
            <Suspense fallback={<Skeleton rows={5} height={18} />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/assistant" element={<AgentryAssistant />} />
              <Route path="/chats" element={<Chats />} />
              <Route path="/chats/new" element={<NewChat />} />
              <Route path="/chats/:id" element={<ChatView />} />
              <Route path="/chats/:id/changes" element={<ChatChangesReview />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/projects/new" element={<NewProject />} />
              <Route path="/projects/:id/assistant" element={<AssistantPage />} />
              <Route path="/tasks" element={<TasksBoard />} />
              <Route path="/tasks/milestones" element={<Milestones />} />
              <Route path="/tasks/:key" element={<WorkItemPage />} />
              <Route path="/tasks/:key/changes" element={<WorkItemChangesReview />} />
              <Route path="/orchestration" element={<Orchestration />} />
              <Route path="/orchestration/:id" element={<OrchestrationDetail />} />
              <Route path="/orchestration/:id/changes" element={<IntegrationChangesReview />} />
              <Route path="/orchestration/:id/tasks/:taskId/changes" element={<TaskChangesReview />} />
              <Route path="/accounts" element={<Navigate to="/settings?tab=providers" replace />} />
              <Route path="/schedules" element={<Schedules />} />
              <Route path="/schedules/new" element={<ScheduleEditor />} />
              <Route path="/schedules/:id/edit" element={<ScheduleEditor />} />
              <Route path="/usage" element={<Usage />} />
              <Route path="/connectors" element={<Connectors />} />
              <Route path="/settings" element={<Settings />} />
              <Route
                path="*"
                element={
                  <Empty
                    illustration="not-found"
                    size="md"
                    title={t('shell.pageNotFound')}
                    action={
                      <Link to="/" className="btn btn-primary">
                        {t('shell:notFound.home')}
                      </Link>
                    }
                  >
                    {t('shell:notFound.body')}
                  </Empty>
                }
              />
            </Routes>
            </Suspense>
          </PageTransition>
        </main>

        <StatusBar now={now} connection={connection} agents={live.working || live.running} />
      </div>

      {tabBar && (
        <>
          <Fab pathname={pathname} search={search} scroller={mainRef} onNewChat={newChat} onNewOrchestration={newOrchestration} onNewTask={newTask} />
          <TabBar
            pathname={pathname}
            projectPage={projectPage}
            tabs={[home, chats, orchestrations]}
            more={[assistant, tasks, projects, schedules, usage, connectors, settings]}
            start={startEntries}
            account={<ProviderCard now={now} connection={connection} />}
            connection={connectionLink}
          />
        </>
      )}

      {workflowOpen && (
        <Suspense fallback={null}>
          <RunWorkflowDialog cwd={project?.exists ? project.path : undefined} onClose={() => setWorkflowOpen(false)} />
        </Suspense>
      )}
      <CommandPalette />
      <NotificationHost />
      <DetailHost />
    </div>
  );
}
