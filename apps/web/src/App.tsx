import {
  BookOpen,
  CalendarClock,
  ChartColumn,
  FolderGit2,
  House,
  Menu,
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
  X,
  type LucideIcon,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useOverview } from './api';
import { CommandPalette, CommandPaletteTrigger, RUN_WORKFLOW_EVENT } from './components/CommandPalette';
import { DetailHost } from './components/DetailHost';
import { LanguageSwitch } from './components/LanguageSwitch';
import { Tooltip } from './components/controls/Tooltip';
import { BrandMark, ICON } from './components/icons';
import { NotificationBell, NotificationHost } from './components/Notifications';
import { AnimatePresence, motion, PageTransition, SlidingIndicator, StatusDot, useReducedMotion } from './components/motion';
import { ProjectSelector } from './components/ProjectSelector';
import { SignIn } from './components/SignIn';
import { Empty, Skeleton } from './components/ui';
import { useAuthChallenge } from './lib/auth';
import { useEventFeed } from './lib/events';
import { ProjectScopeProvider, useProjectScope } from './lib/project-scope';
import { ThemeToggle } from './lib/theme';
import { Home } from './pages/Home';

// Only the landing pages ship in the main bundle; everything else loads on first visit
const Accounts = lazy(() => import('./pages/Accounts').then((m) => ({ default: m.Accounts })));
const ChatView = lazy(() => import('./pages/ChatView').then((m) => ({ default: m.ChatView })));
const Connectors = lazy(() => import('./pages/Connectors').then((m) => ({ default: m.Connectors })));
const Chats = lazy(() => import('./pages/Chats').then((m) => ({ default: m.Chats })));
const NewChat = lazy(() => import('./pages/NewChat').then((m) => ({ default: m.NewChat })));
const Orchestration = lazy(() => import('./pages/Orchestration').then((m) => ({ default: m.Orchestration })));
const OrchestrationDetail = lazy(() => import('./pages/OrchestrationDetail').then((m) => ({ default: m.OrchestrationDetail })));
const Projects = lazy(() => import('./pages/Projects').then((m) => ({ default: m.Projects })));
const RunWorkflowDialog = lazy(() => import('./components/RunWorkflowDialog').then((m) => ({ default: m.RunWorkflowDialog })));
const Schedules = lazy(() => import('./pages/Schedules').then((m) => ({ default: m.Schedules })));
const Usage = lazy(() => import('./pages/Usage').then((m) => ({ default: m.Usage })));
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
  const { project } = useProjectScope();
  const { pathname } = useLocation();
  const reduced = useReducedMotion();
  const { t } = useTranslation(['components', 'connectors']);
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

  // The slide-over is a dialog in effect: focus goes in, Escape closes it and focus comes back
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!mobileNav) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileNav(false);
    };
    document.addEventListener('keydown', onKeyDown);
    const menu = menuRef.current;
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Navigating away moves focus to the page; only a plain close returns it to the menu button
      if (!mainRef.current?.contains(document.activeElement)) menu?.focus();
    };
  }, [mobileNav]);

  // The palette asks for the workflow dialog it cannot host itself
  useEffect(() => {
    const open = () => setWorkflowOpen(true);
    window.addEventListener(RUN_WORKFLOW_EVENT, open);
    return () => window.removeEventListener(RUN_WORKFLOW_EVENT, open);
  }, []);

  const items: NavItem[] = [
    { to: '/', label: t('nav.home'), icon: House, count: { value: counts?.chatsWaiting, what: t('nav.badge.waiting') } },
    { to: '/chats', label: t('nav.chats'), icon: MessagesSquare, count: { value: counts?.chatsWorking, what: t('nav.badge.working') } },
    { to: '/orchestration', label: t('nav.orchestrations'), icon: Workflow, count: { value: counts?.orchestrationsRunning, what: t('nav.badge.running') } },
    { to: '/projects', label: t('nav.projects'), icon: FolderGit2 },
    { to: '/accounts', label: t('nav.accounts'), icon: Users },
    { to: '/schedules', label: t('nav.schedules'), icon: CalendarClock },
    { to: '/usage', label: t('nav.usage'), icon: ChartColumn },
    { to: '/connectors', label: t('connectors:nav'), icon: Plug },
    { to: '/settings', label: t('nav.settings'), icon: Settings2 },
  ];

  const current = items.find((item) => isActive(item, pathname));

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

  // In the icon rail the labels are hidden, so they move into tooltips
  const railTip = (label: string) => (collapsed ? label : undefined);

  return (
    <div className={`shell ${collapsed ? 'shell-rail' : ''} ${mobileNav ? 'shell-nav-open' : ''}`}>
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
      <AnimatePresence>
        {mobileNav && (
          <motion.div
            className="nav-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.18 }}
            aria-hidden
            onClick={() => setMobileNav(false)}
          />
        )}
      </AnimatePresence>

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
          <button ref={closeRef} type="button" className="icon-btn sidebar-close" aria-label={t('shell.closeNavigation')} onClick={() => setMobileNav(false)}>
            <X {...ICON} />
          </button>
        </div>

        <nav className="nav" aria-label={t('shell.mainNavigation')}>
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
                      <span className="nav-count">
                        <span className="nav-count-ping" aria-hidden />
                        {badge}
                        <span className="sr-only"> {item.count?.what}</span>
                      </span>
                    ) : null}
                  </NavLink>
                </Tooltip>
              );
            })}
          </div>
        </nav>

        <Tooltip content={railTip(t('nav.apiReference'))} side="right">
          <a href="/docs" target="_blank" rel="noopener noreferrer" className="nav-link nav-link-ext">
            <span className="nav-icon">
              <BookOpen {...ICON} />
            </span>
            <span className="nav-label">{t('nav.apiReference')}</span>
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

      <div className="content" inert={mobileNav}>
        <header className="topbar">
          <button
            ref={menuRef}
            type="button"
            className="icon-btn topbar-menu"
            aria-label={t('shell.openNavigation')}
            aria-expanded={mobileNav}
            aria-controls="sidebar"
            onClick={() => setMobileNav(true)}
          >
            <Menu {...ICON} />
          </button>
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
            <LanguageSwitch />
            <ThemeToggle />
            <button type="button" className="btn topbar-workflow" onClick={() => setWorkflowOpen(true)}>
              <Play {...ICON} aria-hidden />
              <span className="topbar-new-label">{t('shell.runWorkflow')}</span>
            </button>
            <button
              type="button"
              className="btn btn-primary topbar-new"
              onClick={() => navigate(project?.exists ? `/chats/new?cwd=${encodeURIComponent(project.path)}` : '/chats/new')}
            >
              <Plus {...ICON} aria-hidden />
              <span className="topbar-new-label">{t('shell.newChat')}</span>
            </button>
          </div>
        </header>

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
              <Route path="/usage" element={<Usage />} />
              <Route path="/connectors" element={<Connectors />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Empty icon={SearchX} title={t('shell.pageNotFound')} />} />
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
