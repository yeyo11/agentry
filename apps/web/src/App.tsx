import {
  BookOpen,
  FolderGit2,
  House,
  Menu,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  SearchX,
  Settings2,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useOverview } from './api';
import { CommandPalette, CommandPaletteTrigger, RUN_WORKFLOW_EVENT } from './components/CommandPalette';
import { DetailHost } from './components/DetailHost';
import { Tooltip } from './components/controls/Tooltip';
import { BrandMark, ICON } from './components/icons';
import { NotificationBell, NotificationHost } from './components/Notifications';
import { AnimatePresence, motion, PageTransition, SlidingIndicator, StatusDot, useReducedMotion } from './components/motion';
import { ProjectSelector } from './components/ProjectSelector';
import { Empty, Skeleton } from './components/ui';
import { useEventFeed } from './lib/events';
import { ProjectScopeProvider, useProjectScope } from './lib/project-scope';
import { ThemeToggle } from './lib/theme';
import { Home } from './pages/Home';

// Only the landing pages ship in the main bundle; everything else loads on first visit
const Accounts = lazy(() => import('./pages/Accounts').then((m) => ({ default: m.Accounts })));
const ChatView = lazy(() => import('./pages/ChatView').then((m) => ({ default: m.ChatView })));
const Chats = lazy(() => import('./pages/Chats').then((m) => ({ default: m.Chats })));
const NewChat = lazy(() => import('./pages/NewChat').then((m) => ({ default: m.NewChat })));
const Orchestration = lazy(() => import('./pages/Orchestration').then((m) => ({ default: m.Orchestration })));
const OrchestrationDetail = lazy(() => import('./pages/OrchestrationDetail').then((m) => ({ default: m.OrchestrationDetail })));
const Projects = lazy(() => import('./pages/Projects').then((m) => ({ default: m.Projects })));
const RunWorkflowDialog = lazy(() => import('./components/RunWorkflowDialog').then((m) => ({ default: m.RunWorkflowDialog })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** What the badge counts, for the screen reader */
  count?: { value: number | undefined; what: string };
}

const RAIL_KEY = 'cw:sidebar-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

function isActive(item: NavItem, pathname: string): boolean {
  if (item.to === '/') return pathname === '/';
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

export function App() {
  // The project selector scopes pages far from the top bar, so it lives above all of them
  return (
    <ProjectScopeProvider>
      <Shell />
    </ProjectScopeProvider>
  );
}

function Shell() {
  const navigate = useNavigate();
  const { project } = useProjectScope();
  const { pathname } = useLocation();
  const reduced = useReducedMotion();
  const overview = useOverview();
  // The one connection that keeps every page current; the sidebar footer shows when it is down
  const feed = useEventFeed();
  const counts = overview.data?.counts;
  const auth = overview.data?.system.auth;
  const cli = overview.data?.system.cli;
  const healthy = cli?.installed === true && auth?.loggedIn === true;
  const feedDown = feed !== 'open' && overview.data !== undefined;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileNav, setMobileNav] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
    } catch {
      // private mode: the preference just does not persist
    }
  }, [collapsed]);

  // The slide-over closes itself on navigation
  useEffect(() => setMobileNav(false), [pathname]);

  // The palette asks for the workflow dialog it cannot host itself
  useEffect(() => {
    const open = () => setWorkflowOpen(true);
    window.addEventListener(RUN_WORKFLOW_EVENT, open);
    return () => window.removeEventListener(RUN_WORKFLOW_EVENT, open);
  }, []);

  const items: NavItem[] = [
    { to: '/', label: 'Home', icon: House, count: { value: counts?.chatsWaiting, what: 'waiting for you' } },
    { to: '/chats', label: 'Chats', icon: MessagesSquare, count: { value: counts?.chatsWorking, what: 'working' } },
    { to: '/orchestration', label: 'Orchestrations', icon: Workflow, count: { value: counts?.orchestrationsRunning, what: 'running' } },
    { to: '/projects', label: 'Projects', icon: FolderGit2 },
    { to: '/accounts', label: 'Accounts', icon: Users },
    { to: '/settings', label: 'Settings', icon: Settings2 },
  ];

  const current = items.find((item) => isActive(item, pathname));

  const statusTone = overview.isError ? 'bad' : healthy && !feedDown ? 'ok' : 'warn';
  const statusTitle = overview.isError
    ? 'API unreachable'
    : !overview.data
      ? 'Connecting…'
      : healthy
        ? `Claude Code ${cli?.version ?? ''}`
        : !cli?.installed
          ? 'CLI not detected'
          : 'Not logged in';
  const statusDetail = healthy
    ? feedDown
      ? 'Live updates paused, retrying'
      : [auth?.subscriptionType ?? auth?.authMethod, auth?.email].filter(Boolean).join(' · ') || 'logged in'
    : overview.isError
      ? 'Check that the wrapper is running'
      : !overview.data
        ? ''
        : !cli?.installed
          ? 'Install it or set CLAUDE_BIN'
          : 'Add a credential in Settings';

  // In the icon rail the labels are hidden, so they move into tooltips
  const railTip = (label: string) => (collapsed ? label : undefined);

  return (
    <div className={`shell ${collapsed ? 'shell-rail' : ''} ${mobileNav ? 'shell-nav-open' : ''}`}>
      <AnimatePresence>
        {mobileNav && (
          <motion.div
            className="nav-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.18 }}
            onClick={() => setMobileNav(false)}
          />
        )}
      </AnimatePresence>

      <aside className="sidebar" aria-label="Sidebar">
        <div className="sidebar-head">
          <Tooltip content={railTip('Agentry')} side="right">
            <NavLink to="/" className="brand" aria-label="Agentry">
              <BrandMark />
              <span className="brand-name">Agentry</span>
            </NavLink>
          </Tooltip>
          <Tooltip content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} side="right">
            <button
              type="button"
              className="icon-btn sidebar-collapse"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={() => setCollapsed((v) => !v)}
            >
              {collapsed ? <PanelLeftOpen {...ICON} /> : <PanelLeftClose {...ICON} />}
            </button>
          </Tooltip>
          <button type="button" className="icon-btn sidebar-close" aria-label="Close navigation" onClick={() => setMobileNav(false)}>
            <X {...ICON} />
          </button>
        </div>

        <nav className="nav" aria-label="Main">
          <div className="nav-group">
            {items.map((item) => {
              const active = isActive(item, pathname);
              const Icon = item.icon;
              const badge = item.count?.value;
              return (
                <Tooltip key={item.to} content={railTip(item.label)} side="right">
                  <NavLink to={item.to} end={item.to === '/'} className={`nav-link ${active ? 'is-active' : ''}`}>
                    {active && <SlidingIndicator layoutId="nav-pill" className="nav-pill" />}
                    <span className="nav-icon">
                      <Icon {...ICON} />
                    </span>
                    <span className="nav-label">{item.label}</span>
                    {badge ? (
                      <span className="nav-count" aria-label={`${badge} ${item.count?.what}`}>
                        <span className="nav-count-ping" aria-hidden />
                        {badge}
                      </span>
                    ) : null}
                  </NavLink>
                </Tooltip>
              );
            })}
          </div>
        </nav>

        <Tooltip content={railTip('API reference')} side="right">
          <a href="/docs" target="_blank" rel="noopener noreferrer" className="nav-link nav-link-ext">
            <span className="nav-icon">
              <BookOpen {...ICON} />
            </span>
            <span className="nav-label">API reference</span>
          </a>
        </Tooltip>

        <Tooltip content={`${statusTitle}${statusDetail ? ` · ${statusDetail}` : ''}`} side="right">
          <NavLink to="/settings?tab=account" className="sidebar-foot">
            <StatusDot tone={statusTone} live={healthy && !feedDown} />
            <span className="sidebar-foot-text">
              <span className="sidebar-foot-title ellipsis">{statusTitle}</span>
              {statusDetail && <span className="sidebar-foot-detail ellipsis">{statusDetail}</span>}
            </span>
          </NavLink>
        </Tooltip>
      </aside>

      <div className="content">
        <header className="topbar">
          <button type="button" className="icon-btn topbar-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}>
            <Menu {...ICON} />
          </button>
          <div className="crumbs" aria-label="Breadcrumb">
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
            <ThemeToggle />
            <button className="btn topbar-workflow" onClick={() => setWorkflowOpen(true)} aria-label="Run a saved workflow">
              <Play {...ICON} />
              <span className="topbar-new-label">Run workflow</span>
            </button>
            <button
              className="btn btn-primary topbar-new"
              onClick={() => navigate(project?.exists ? `/chats/new?cwd=${encodeURIComponent(project.path)}` : '/chats/new')}
            >
              <Plus {...ICON} />
              <span className="topbar-new-label">New chat</span>
            </button>
          </div>
        </header>

        <main className="main">
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
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Empty icon={SearchX} title="Page not found" />} />
            </Routes>
            </Suspense>
          </PageTransition>
        </main>
      </div>

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
