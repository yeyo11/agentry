import {
  BookOpen,
  CalendarClock,
  ChartColumn,
  FolderGit2,
  House,
  MessageSquarePlus,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plug,
  Plus,
  SearchX,
  Settings2,
  Users,
  Workflow,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, chatListQuery, keys, useOverview } from './api';
import { CommandPalette, CommandPaletteTrigger, NEW_ORCHESTRATION_PATH, RUN_WORKFLOW_EVENT } from './components/CommandPalette';
import type { MenuEntry } from './components/controls/Menu';
import { Tooltip } from './components/controls/Tooltip';
import { DetailHost } from './components/DetailHost';
import { BrandMark, ICON } from './components/icons';
import { NotificationBell, NotificationHost } from './components/Notifications';
import { PageTransition, SlidingIndicator, StatusDot } from './components/motion';
import { ProjectSelector } from './components/ProjectSelector';
import { lazyPage, ReloadBanner } from './components/ReloadOffer';
import { LiveChip, LiveSection, useLive } from './components/shell/live';
import { isActive, NavDot, navTarget, TabBar, type NavItem } from './components/shell/TabBar';
import { SignIn } from './components/SignIn';
import { SplitButton } from './components/SplitButton';
import { Empty, Skeleton } from './components/ui';
import { useAuthChallenge } from './lib/auth';
import { listRequest } from './lib/chat-model';
import { useDesktopNavigation } from './lib/desktop';
import { useKeyboardInset } from './lib/viewport';
import { useEventFeed } from './lib/events';
import { ProjectScopeProvider, useProjectScope } from './lib/project-scope';
import { hidesTabBar } from './lib/shell-live';
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
  if (challenge) return <SignIn mode={challenge} />;
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
  const overview = useOverview();
  // The one connection that keeps every page current; the sidebar footer shows when it is down
  const feed = useEventFeed();
  useDesktopNavigation();
  useKeyboardInset();
  const counts = overview.data?.counts;
  const auth = overview.data?.system.auth;
  const cli = overview.data?.system.cli;
  const healthy = cli?.installed === true && auth?.loggedIn === true;
  const feedDown = feed !== 'open' && overview.data !== undefined;
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

  const items: NavItem[] = [
    { to: '/', label: t('nav.home'), icon: House, count: { value: counts?.chatsWaiting, what: t('nav.badge.waiting') } },
    { to: '/chats', label: t('nav.chats'), icon: MessagesSquare, count: { value: counts?.chatsWorking, what: t('nav.badge.working') } },
    { to: '/orchestration', label: t('nav.orchestrations'), icon: Workflow, count: { value: counts?.orchestrationsRunning, what: t('nav.badge.running') } },
    { to: '/projects', label: t('nav.projects'), icon: FolderGit2 },
    { to: '/accounts', label: t('nav.accounts'), icon: Users },
    { to: '/schedules', label: t('nav.schedules'), icon: CalendarClock },
    { to: '/usage', label: t('nav.usage'), icon: ChartColumn },
    { to: '/connectors', label: t('connectors:nav'), icon: Plug },
    {
      to: '/settings',
      label: t('nav.settings'),
      icon: Settings2,
      // The Updates card is on the account tab: the dot leads straight to it
      ...(updateAvailable ? { dot: t('nav.badge.update'), search: '?tab=account' } : {}),
    },
  ];

  const current = items.find((item) => isActive(item, pathname));

  const newChat = () => navigate(project?.exists ? `/chats/new?cwd=${encodeURIComponent(project.path)}` : '/chats/new');
  // What else a person can start: behind "New chat ▾" in the top bar, and in the phone's "New" tab
  const startEntries: MenuEntry[] = [
    { id: 'run-workflow', label: t('shell.runWorkflow'), icon: Play, onSelect: () => setWorkflowOpen(true) },
    { id: 'new-orchestration', label: t('shell:topbar.newOrchestration'), icon: Workflow, onSelect: () => navigate(NEW_ORCHESTRATION_PATH) },
  ];

  const statusTone = overview.isError ? 'bad' : healthy && !feedDown ? 'ok' : 'warn';
  const statusTitle = overview.isError
    ? t('shell.apiUnreachable')
    : !overview.data
      ? t('shell.connecting')
      : healthy
        ? t('shell.claudeCode', { version: cli?.version ?? '' })
        : !cli?.installed
          ? t('shell.cliNotDetected')
          : t('shell.notLoggedIn');
  const statusDetail = healthy
    ? feedDown
      ? t('shell.liveUpdatesPaused')
      : [auth?.subscriptionType ?? auth?.authMethod, auth?.email].filter(Boolean).join(' · ') || t('shell.loggedIn')
    : overview.isError
      ? t('shell.checkWrapper')
      : !overview.data
        ? ''
        : !cli?.installed
          ? t('shell.installCli')
          : t('shell.addCredential');
  const connection = (
    <NavLink to="/settings?tab=account" className="sidebar-foot">
      <StatusDot tone={statusTone} live={healthy && !feedDown} />
      <span className="sidebar-foot-text">
        <span className="sidebar-foot-title ellipsis">{statusTitle}</span>
        {statusDetail && <span className="sidebar-foot-detail ellipsis">{statusDetail}</span>}
      </span>
    </NavLink>
  );

  const tabBar = !hidesTabBar(pathname);

  // In the icon rail the labels are hidden, so they move into tooltips
  const railTip = (label: string) => (collapsed ? label : undefined);

  return (
    <div className={`shell ${collapsed ? 'shell-rail' : ''} ${tabBar ? 'shell-has-tabbar' : ''}`}>
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

        <nav className="nav" aria-label={t('shell.mainNavigation')}>
          <div className="nav-group">
            {items.map((item) => {
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
                      <span className="nav-count">
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

        <Tooltip content={`${statusTitle}${statusDetail ? ` · ${statusDetail}` : ''}`} side="right">
          {connection}
        </Tooltip>
      </aside>

      <div className="content">
        {/* In the desktop app this bar is also the window's title bar (lib/desktop.ts, styles/shell.css) */}
        <header className="topbar">
          {/* A phone has no sidebar, so the bar carries the mark that leads home */}
          <NavLink to="/" className="brand topbar-brand" aria-label="Agentry">
            <BrandMark size={24} />
          </NavLink>
          <div className="crumbs">
            <span className="crumb-page">{current?.label ?? 'Agentry'}</span>
            {current?.to === '/' && project && (
              <>
                <span className="crumb-sep" aria-hidden>
                  /
                </span>
                <span className="crumb-group ellipsis">{project.name}</span>
              </>
            )}
          </div>
          <div className="topbar-actions">
            <ProjectSelector />
            <CommandPaletteTrigger />
            <NotificationBell />
            <LiveChip live={live} />
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
              <Route path="*" element={<Empty icon={SearchX} title={t('shell.pageNotFound')} />} />
            </Routes>
            </Suspense>
          </PageTransition>
        </main>
      </div>

      {tabBar && (
        <TabBar
          pathname={pathname}
          tabs={items.slice(0, 3)}
          more={items.slice(3)}
          newEntries={[{ id: 'new-chat', label: t('shell.newChat'), icon: MessageSquarePlus, onSelect: newChat }, ...startEntries]}
          connection={connection}
        />
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
