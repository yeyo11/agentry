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
  Plus,
  Settings2,
  Users,
  Workflow,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, chatListQuery, keys } from './api';
import { CommandPalette, CommandPaletteTrigger, NEW_ORCHESTRATION_PATH, RUN_WORKFLOW_EVENT } from './components/CommandPalette';
import type { MenuItem } from './components/controls/Menu';
import { Tooltip } from './components/controls/Tooltip';
import { DetailHost } from './components/DetailHost';
import { BrandMark, ICON } from './components/icons';
import { NotificationBell, NotificationHost } from './components/Notifications';
import { PageTransition, SlidingIndicator, StatusDot } from './components/motion';
import { ProjectSelector } from './components/ProjectSelector';
import { lazyPage, ReloadBanner } from './components/ReloadOffer';
import { Fab } from './components/shell/Fab';
import { LiveChip, LiveSection, useLive } from './components/shell/live';
import { AccountCard, StatusBar, useConnection } from './components/shell/StatusBar';
import { isActive, NavDot, navTarget, TabBar, type NavItem } from './components/shell/TabBar';
import { SignIn } from './components/SignIn';
import { SplitButton } from './components/SplitButton';
import { Empty, Skeleton } from './components/ui';
import { useUsageNow } from './lib/usage-now';
import { useAuthChallenge, useAuthSettled } from './lib/auth';
import { listRequest } from './lib/chat-model';
import { useDesktopNavigation } from './lib/desktop';
import { useKeyboardInset } from './lib/viewport';
import { useEventFeed } from './lib/events';
import { ProjectScopeProvider, useProjectScope } from './lib/project-scope';
import { fabFor, hidesTabBar } from './lib/shell-live';
import { Home } from './pages/Home';

// Only the landing pages ship in the main bundle; everything else loads on first visit
const Accounts = lazyPage(() => import('./pages/Accounts').then((m) => m.Accounts));
const ChatView = lazyPage(() => import('./pages/ChatView').then((m) => m.ChatView));
const Connectors = lazyPage(() => import('./pages/Connectors').then((m) => m.Connectors));
// Loaded ahead of a visit too: the list is where most visits go after the landing page
const loadChats = () => import('./pages/Chats');
const Chats = lazyPage(() => loadChats().then((m) => m.Chats));
const NewChat = lazyPage(() => import('./pages/NewChat').then((m) => m.NewChat));
const Orchestration = lazyPage(() => import('./pages/Orchestration').then((m) => m.Orchestration));
const OrchestrationDetail = lazyPage(() => import('./pages/OrchestrationDetail').then((m) => m.OrchestrationDetail));
const Projects = lazyPage(() => import('./pages/Projects').then((m) => m.Projects));
const RunWorkflowDialog = lazyPage(
  () => import('./components/RunWorkflowDialog').then((m) => m.RunWorkflowDialog),
  // A dialog has no page to stand in for: the banner alone says what happened
  () => null,
);
const Schedules = lazyPage(() => import('./pages/Schedules').then((m) => m.Schedules));
const ScheduleEditor = lazyPage(() => import('./pages/ScheduleEditor').then((m) => m.ScheduleEditor));
const Usage = lazyPage(() => import('./pages/Usage').then((m) => m.Usage));
const Settings = lazyPage(() => import('./pages/Settings').then((m) => m.Settings));

const RAIL_KEY = 'cw:sidebar-collapsed';
/** A list prefetched on hover is used as it is if the click comes within this long. */
const PREFETCH_FRESH_MS = 10_000;

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

export function App() {
  // A guarded wrapper reached without a credential answers 401 to everything, so the shell is not
  // mounted at all: one screen that asks, instead of every page failing on its own
  const challenge = useAuthChallenge();
  const settled = useAuthSettled();
  if (challenge) return <SignIn mode={challenge} />;
  if (!settled) return null;
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
  const { pathname } = useLocation();
  const { t } = useTranslation(['components', 'connectors', 'shell']);
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
  const [collapsed, setCollapsed] = useState(readCollapsed);
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

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
    } catch {
      // private mode: the preference just does not persist
    }
  }, [collapsed]);

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
  const chats: NavItem = { to: '/chats', label: t('nav.chats'), icon: MessagesSquare, count: { value: counts?.chatsWorking, what: t('nav.badge.working'), live: true } };
  const orchestrations: NavItem = {
    to: '/orchestration',
    label: t('nav.orchestrations'),
    icon: Workflow,
    count: { value: counts?.orchestrationsRunning, what: t('nav.badge.running'), live: true },
  };
  const schedules: NavItem = { to: '/schedules', label: t('nav.schedules'), icon: CalendarClock };
  const projects: NavItem = { to: '/projects', label: t('nav.projects'), icon: FolderGit2 };
  const accounts: NavItem = { to: '/accounts', label: t('nav.accounts'), icon: Users };
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
    { id: 'work', label: t('shell:nav.work'), items: [home, chats, orchestrations, schedules] },
    { id: 'space', label: t('shell:nav.space'), items: [projects, accounts, connectors, usage, settings] },
  ];
  const items = groups.flatMap((group) => group.items);

  const current = items.find((item) => isActive(item, pathname));

  const newChat = () => navigate(project?.exists ? `/chats/new?cwd=${encodeURIComponent(project.path)}` : '/chats/new');
  const newOrchestration = () => navigate(NEW_ORCHESTRATION_PATH);
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

  const tabBar = !hidesTabBar(pathname);
  const fab = fabFor(pathname) !== null;

  // In the icon rail the labels are hidden, so they move into tooltips
  const railTip = (label: string) => (collapsed ? label : undefined);

  return (
    <div className={`shell ${collapsed ? 'shell-rail' : ''} ${tabBar ? 'shell-has-tabbar' : ''} ${fab ? 'shell-has-fab' : ''}`}>
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
                const active = isActive(item, pathname);
                const Icon = item.icon;
                const badge = item.count?.value;
                return (
                  <Tooltip key={item.to} content={railTip(item.label)} side="right">
                    <NavLink
                      to={navTarget(item)}
                      end={item.to === '/'}
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
                    </NavLink>
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
        {/* In the desktop app this bar is also the window's title bar (lib/desktop.ts, styles/shell.css) */}
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
            <span className="crumb-page ellipsis">{current?.label ?? 'Agentry'}</span>
          </div>
          <div className="topbar-actions">
            <CommandPaletteTrigger className="topbar-search" />
            <LiveChip live={live} />
            <NotificationBell />
            <SplitButton className="topbar-new" label={t('shell.newChat')} icon={Plus} onClick={newChat} entries={startEntries} />
          </div>
        </header>

        <ReloadBanner />

        <main id="main" ref={mainRef} tabIndex={-1} className="main">
          {/* Keyed by pathname only: tab and scope switches (query string) must not replay the transition */}
          <PageTransition key={pathname} className="page">
            <Suspense fallback={<Skeleton rows={5} height={18} />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/chats" element={<Chats />} />
              <Route path="/chats/new" element={<NewChat />} />
              <Route path="/chats/:id" element={<ChatView />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/orchestration" element={<Orchestration />} />
              <Route path="/orchestration/:id" element={<OrchestrationDetail />} />
              <Route path="/accounts" element={<Accounts />} />
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
          <Fab pathname={pathname} onNewChat={newChat} onNewOrchestration={newOrchestration} />
          <TabBar
            pathname={pathname}
            tabs={[home, chats, orchestrations]}
            more={[projects, accounts, schedules, usage, connectors, settings]}
            start={startEntries}
            account={<AccountCard now={now} connection={connection} />}
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
