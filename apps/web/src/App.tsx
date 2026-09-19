import {
  Activity,
  BookOpen,
  Brain,
  FolderGit2,
  History,
  LayoutDashboard,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Puzzle,
  SearchX,
  Settings2,
  Timer,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useOverview } from './api';
import { CommandPalette, CommandPaletteTrigger } from './components/CommandPalette';
import { Tooltip } from './components/controls/Tooltip';
import { BrandMark, ICON } from './components/icons';
import { AnimatePresence, motion, PageTransition, SlidingIndicator, StatusDot, useReducedMotion } from './components/motion';
import { Empty, Skeleton } from './components/ui';
import { ThemeToggle } from './lib/theme';
import { Agents } from './pages/Agents';
import { Dashboard } from './pages/Dashboard';
import { RunView } from './pages/RunView';

// Only the landing pages ship in the main bundle; everything else loads on first visit
const Accounts = lazy(() => import('./pages/Accounts').then((m) => ({ default: m.Accounts })));
const Config = lazy(() => import('./pages/Config').then((m) => ({ default: m.Config })));
const Memory = lazy(() => import('./pages/Memory').then((m) => ({ default: m.Memory })));
const Orchestration = lazy(() => import('./pages/Orchestration').then((m) => ({ default: m.Orchestration })));
const OrchestrationDetail = lazy(() => import('./pages/OrchestrationDetail').then((m) => ({ default: m.OrchestrationDetail })));
const Plugins = lazy(() => import('./pages/Plugins').then((m) => ({ default: m.Plugins })));
const Projects = lazy(() => import('./pages/Projects').then((m) => ({ default: m.Projects })));
const SessionView = lazy(() => import('./pages/SessionView').then((m) => ({ default: m.SessionView })));
const Sessions = lazy(() => import('./pages/Sessions').then((m) => ({ default: m.Sessions })));
const Tasks = lazy(() => import('./pages/Tasks').then((m) => ({ default: m.Tasks })));
const NewRun = lazy(() => import('./pages/NewRun').then((m) => ({ default: m.NewRun })));

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  count?: number;
}

interface NavGroup {
  label: string;
  items: NavItem[];
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
  if (item.to === '/agents' && pathname.startsWith('/runs')) return true;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

export function App() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const reduced = useReducedMotion();
  const overview = useOverview();
  const counts = overview.data?.counts;
  const auth = overview.data?.system.auth;
  const cli = overview.data?.system.cli;
  const healthy = cli?.installed === true && auth?.loggedIn === true;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
    } catch {
      // private mode: the preference just does not persist
    }
  }, [collapsed]);

  // The slide-over closes itself on navigation
  useEffect(() => setMobileNav(false), [pathname]);

  const groups: NavGroup[] = [
    {
      label: 'Monitor',
      items: [
        { to: '/', label: 'Dashboard', icon: LayoutDashboard },
        { to: '/agents', label: 'Agents', icon: Activity, count: (counts?.activeRuns ?? 0) + (counts?.subagents ?? 0) },
        { to: '/tasks', label: 'Background tasks', icon: Timer, count: counts?.backgroundTasks },
      ],
    },
    {
      label: 'Work',
      items: [
        { to: '/sessions', label: 'Sessions', icon: History },
        { to: '/projects', label: 'Projects', icon: FolderGit2 },
        { to: '/orchestration', label: 'Orchestration', icon: Workflow, count: counts?.orchestrationsRunning },
      ],
    },
    {
      label: 'Configure',
      items: [
        { to: '/accounts', label: 'Accounts', icon: Users },
        { to: '/memory', label: 'Memory', icon: Brain },
        { to: '/plugins', label: 'Plugins', icon: Puzzle },
        { to: '/config', label: 'Config', icon: Settings2 },
      ],
    },
  ];

  const current = groups.flatMap((g) => g.items.map((item) => ({ group: g.label, item }))).find(({ item }) => isActive(item, pathname));

  const statusTone = overview.isError ? 'bad' : healthy ? 'ok' : 'warn';
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
    ? [auth?.subscriptionType ?? auth?.authMethod, auth?.email].filter(Boolean).join(' · ') || 'logged in'
    : overview.isError
      ? 'Check that the wrapper is running'
      : !overview.data
        ? ''
        : !cli?.installed
          ? 'Install it or set CLAUDE_BIN'
          : 'Add a credential in Config';

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
          {groups.map((group) => (
            <div key={group.label} className="nav-group">
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => {
                const active = isActive(item, pathname);
                const Icon = item.icon;
                return (
                  <Tooltip key={item.to} content={railTip(item.label)} side="right">
                    <NavLink to={item.to} end={item.to === '/'} className={`nav-link ${active ? 'is-active' : ''}`}>
                      {active && <SlidingIndicator layoutId="nav-pill" className="nav-pill" />}
                      <span className="nav-icon">
                        <Icon {...ICON} />
                      </span>
                      <span className="nav-label">{item.label}</span>
                      {item.count ? (
                        <span className="nav-count" aria-label={`${item.count} active`}>
                          <span className="nav-count-ping" aria-hidden />
                          {item.count}
                        </span>
                      ) : null}
                    </NavLink>
                  </Tooltip>
                );
              })}
            </div>
          ))}
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
          <NavLink to="/config?tab=account" className="sidebar-foot">
            <StatusDot tone={statusTone} live={healthy} />
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
            {current ? (
              <>
                <span className="crumb-group">{current.group}</span>
                <span className="crumb-sep" aria-hidden>
                  /
                </span>
                <span className="crumb-page">{current.item.label}</span>
              </>
            ) : (
              <span className="crumb-page">Agentry</span>
            )}
          </div>
          <div className="topbar-actions">
            <CommandPaletteTrigger />
            <ThemeToggle />
            <button className="btn btn-primary topbar-new" onClick={() => navigate('/runs/new')}>
              <Plus {...ICON} />
              <span className="topbar-new-label">New run</span>
            </button>
          </div>
        </header>

        <main className="main">
          {/* Keyed by pathname only: tab and scope switches (query string) must not replay the transition */}
          <PageTransition key={pathname} className="page">
            <Suspense fallback={<Skeleton rows={5} height={18} />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/sessions" element={<Sessions />} />
              <Route path="/sessions/:id" element={<SessionView />} />
              <Route path="/runs/new" element={<NewRun />} />
              <Route path="/runs/:id" element={<RunView />} />
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/orchestration" element={<Orchestration />} />
              <Route path="/orchestration/:id" element={<OrchestrationDetail />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/memory" element={<Memory />} />
              <Route path="/plugins" element={<Plugins />} />
              <Route path="/config" element={<Config />} />
              <Route path="*" element={<Empty icon={SearchX} title="Page not found" />} />
            </Routes>
            </Suspense>
          </PageTransition>
        </main>
      </div>

      <CommandPalette />
    </div>
  );
}
