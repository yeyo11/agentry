// ⌘K command palette: jump to any page, settings tab, project or chat, and run quick actions.
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BookOpen,
  Brain,
  CalendarClock,
  ChartColumn,
  CornerDownLeft,
  FolderGit2,
  FolderPlus,
  Gauge,
  GitBranch,
  Globe,
  House,
  KeyRound,
  Languages,
  Library,
  LoaderCircle,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Moon,
  Network,
  Play,
  Plug,
  Puzzle,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkle,
  SquareCheck,
  SquarePlus,
  Sun,
  Waypoints,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentName } from '@agentry/chat-ui/lib/agent';
import { useNavigate } from 'react-router-dom';
import { api, keys } from '../api';
import { LANGUAGES, setLanguage } from '../i18n';
import { displayTitle } from '@agentry/chat-ui/lib/chat-model';
import { assistantPath } from '../pages/assistant/model';
import { setMotionPreference } from '@agentry/ui/lib/motion';
import { useProjectScope } from '../lib/project-scope';
import { liveSummary } from '../lib/shell-live';
import { setThemePreference } from '../lib/theme';
import { NEW_PROJECT_PATH, NEW_TASK_PATH, TASKS_PATH } from '../lib/work-items';
import { statusText } from '@agentry/ui/components/ui';
import '../palette.css';
import { createPaletteReporter, MAX_RECENT, MAX_RESULTS, MOTION_LEVELS, readRecent, RECENT_KEY, score, type Command, type Group } from './palette-model';

const OPEN_EVENT = 'cw:open-command-palette';
/** The workflow dialog lives in the shell, beside "New chat": the palette only asks for it. */
export const RUN_WORKFLOW_EVENT = 'agentry:run-workflow';
/** Opens the Orchestrations page with its "New orchestration" form already open. */
export const NEW_ORCHESTRATION_PATH = '/orchestration?new=1';
/** A query whose best local rank is under this matched no title, group, keyword or hint as a substring. */
const INTENT_FLOOR = 500;
const INTENT_MIN_CHARS = 3;
/** Typing is never held up: the model is asked only once the person pauses. */
const INTENT_DELAY_MS = 350;
/** The commands worth routing to: pages, actions and settings tabs, not every project and chat. */
const INTENT_GROUPS: readonly Group[] = ['actions', 'goTo', 'settings'];
const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform);

/** A search field in the sidebar on a desktop, an icon in the top bar on a phone: `className` says which. */
export function CommandPaletteTrigger({ className = '' }: { className?: string }) {
  const { t } = useTranslation('components');
  return (
    <button type="button" className={`palette-trigger ${className}`.trim()} onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}>
      <Search size={14} strokeWidth={1.75} aria-hidden />
      <span className="palette-trigger-label">{t('palette.trigger')}</span>
      <kbd className="palette-kbd">{isMac ? '⌘' : 'Ctrl'} K</kbd>
    </button>
  );
}

export function CommandPalette() {
  const navigate = useNavigate();
  const { t } = useTranslation(['components', 'connectors', 'shell', 'decisions']);
  const agent = useAgentName();
  const { project: selected } = useProjectScope();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [settled, setSettled] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  // Data is only fetched while the palette is open; the pages keep their own polling.
  const projects = useQuery({ queryKey: keys.projects, queryFn: api.projects, enabled: open });
  const working = useQuery({ queryKey: keys.chatList({ state: 'working' }), queryFn: ({ signal }) => api.chats({ state: 'working' }, { signal }), enabled: open });
  const waiting = useQuery({ queryKey: keys.chatList({ state: 'waiting' }), queryFn: ({ signal }) => api.chats({ state: 'waiting' }, { signal }), enabled: open });
  const orchestrations = useQuery({ queryKey: keys.orchestrations, queryFn: api.orchestrations, enabled: open });
  const overview = useQuery({ queryKey: keys.overview, queryFn: api.overview, enabled: open });

  // `palette.intent` asks in shadow and active, on Jev only: the local ranking answers first either way, and
  // in shadow the answer is never shown, the row only waits for what the person does
  const points = useQuery({ queryKey: keys.decisionPoints, queryFn: ({ signal }) => api.decisionPoints({ signal }), enabled: open });
  const intentOn = (points.data ?? []).some((p) => p.id === 'palette.intent' && (p.effective.mode === 'active' || p.effective.mode === 'shadow') && !p.effective.limited && p.effective.provider === 'jev');

  const close = useCallback(() => {
    setOpen(false);
    restoreFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    const show = () => {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      setQuery('');
      setActive(0);
      setOpen(true);
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => {
          if (current) return false;
          show();
          return true;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => navigate(to);
    const newChat = selected?.exists ? `/chats/new?cwd=${encodeURIComponent(selected.path)}` : '/chats/new';
    const list: Command[] = [
      { id: 'act:new-chat', group: 'actions', title: t('palette.newChat'), hint: selected?.exists ? t('palette.newChatIn', { name: selected.name }) : t('palette.newChatHint', { agent }), keywords: 'run prompt start', icon: Play, run: go(newChat) },
      { id: 'act:run-workflow', group: 'actions', title: t('palette.runWorkflow'), hint: t('palette.runWorkflowHint'), keywords: 'workflow script', icon: Waypoints, run: () => window.dispatchEvent(new Event(RUN_WORKFLOW_EVENT)) },
      { id: 'act:new-orchestration', group: 'actions', title: t('palette.newOrchestration'), hint: t('palette.newOrchestrationHint'), keywords: 'agents dag plan', icon: Network, run: go(NEW_ORCHESTRATION_PATH) },
      { id: 'act:new-task', group: 'actions', title: t('shell:tasks.newTask'), hint: selected ? t('shell:tasks.newTaskIn', { name: selected.name }) : t('shell:tasks.newTaskHint'), keywords: 'work item board backlog issue ticket bug story epic', icon: SquarePlus, run: go(NEW_TASK_PATH) },
      ...(selected
        ? [{ id: 'act:assistant', group: 'actions' as const, title: t('palette.assistant'), hint: t('palette.assistantOf', { name: selected.name }), keywords: 'assistant ai suggest propose team resources tasks asistente', icon: Sparkle, run: go(assistantPath(selected.id)) }]
        : []),
      { id: 'act:new-project', group: 'actions', title: t('palette.newProject'), hint: t('palette.newProjectHint'), keywords: 'import git clone folder directory template modules', icon: FolderPlus, run: go(NEW_PROJECT_PATH) },
      { id: 'act:credential', group: 'actions', title: t('palette.credential'), hint: t('palette.credentialHint'), keywords: 'login auth token key', icon: KeyRound, run: go('/settings?tab=account') },
      { id: 'act:api-docs', group: 'actions', title: t('palette.apiReference'), hint: t('palette.apiReferenceHint'), keywords: 'swagger openapi rest docs scalar', icon: BookOpen, run: () => window.open('/docs', '_blank', 'noopener') },
      { id: 'theme:light', group: 'theme', title: t('theme.light'), icon: Sun, run: () => setThemePreference('light') },
      { id: 'theme:dark', group: 'theme', title: t('theme.dark'), icon: Moon, run: () => setThemePreference('dark') },
      { id: 'theme:system', group: 'theme', title: t('theme.system'), icon: Monitor, run: () => setThemePreference('system') },
      ...LANGUAGES.map(({ code, name }): Command => ({ id: `language:${code}`, group: 'language', title: t('palette.language', { name }), keywords: 'idioma language english español', icon: Languages, run: () => setLanguage(code) })),
      ...MOTION_LEVELS.map((level): Command => ({ id: `motion:${level}`, group: 'motion', title: t('palette.motion', { level: t(`shell:appearance.motionOptions.${level}`) }), hint: t(`shell:appearance.motionDescriptions.${level}`), keywords: 'motion animation reduce spinner appearance', icon: Gauge, run: () => setMotionPreference(level) })),
      { id: 'nav:/', group: 'goTo', title: t('nav.home'), keywords: 'inbox activity waiting overview status usage', icon: House, run: go('/') },
      { id: 'nav:/chats', group: 'goTo', title: t('nav.chats'), keywords: 'sessions history transcripts conversations', icon: MessagesSquare, run: go('/chats') },
      { id: `nav:${TASKS_PATH}`, group: 'goTo', title: t('shell:nav.tasks'), hint: t('shell:tasks.goToHint'), keywords: 'board work items backlog kanban milestones issues', icon: SquareCheck, run: go(TASKS_PATH) },
      { id: 'nav:/orchestration', group: 'goTo', title: t('nav.orchestrations'), keywords: 'multi agent graph', icon: Network, run: go('/orchestration') },
      { id: 'nav:/projects', group: 'goTo', title: t('nav.projects'), keywords: 'import workspace directories', icon: FolderGit2, run: go('/projects') },
      { id: 'nav:/schedules', group: 'goTo', title: t('nav.schedules'), keywords: 'cron recurring timetable automatic every', icon: CalendarClock, run: go('/schedules') },
      { id: 'nav:/usage', group: 'goTo', title: t('nav.usage'), keywords: 'cost spend tokens money chart model project', icon: ChartColumn, run: go('/usage') },
      { id: 'nav:/connectors', group: 'goTo', title: t('connectors:nav'), keywords: 'claude.ai docs gmail calendar mcp authorise', icon: Plug, run: go('/connectors') },
      { id: 'nav:/settings', group: 'goTo', title: t('nav.settings'), keywords: 'config preferences', icon: Settings2, run: go('/settings') },
    ];
    const tabs: Array<[string, string, string, LucideIcon]> = [
      ['appearance', t('shell:appearance.tab'), 'theme language motion dark light', SlidersHorizontal],
      ['instructions', t('palette.settingsTabs.instructions'), 'CLAUDE.md', SlidersHorizontal],
      ['settings', t('palette.settingsTabs.settings'), 'settings.json permissions hooks env model', SlidersHorizontal],
      ['mcp', t('palette.settingsTabs.mcp'), 'connectors tools', SlidersHorizontal],
      ['agents', t('palette.settingsTabs.agents'), 'subagents', SlidersHorizontal],
      ['skills', t('palette.settingsTabs.skills'), 'SKILL.md', SlidersHorizontal],
      ['commands', t('palette.settingsTabs.commands'), 'slash', SlidersHorizontal],
      ['output-styles', t('palette.settingsTabs.outputStyles'), '', SlidersHorizontal],
      ['rules', t('palette.settingsTabs.rules'), '', SlidersHorizontal],
      ['workflows', t('palette.settingsTabs.workflows'), 'saved script', SlidersHorizontal],
      ['files', t('palette.settingsTabs.files'), 'explorer hooks scripts keybindings', SlidersHorizontal],
      ['memory', t('palette.settingsTabs.memory'), 'facts feedback MEMORY.md projects', Brain],
      ['plugins', t('palette.settingsTabs.plugins'), 'marketplace install extensions', Puzzle],
      ['remote', t('palette.settingsTabs.remote'), 'tunnel tailscale tailnet serve phone address qr', Globe],
    ];
    for (const [tab, title, extra, icon] of tabs) {
      // Remote access is Agentry's own, not a file in ~/.claude
      list.push({ id: `settings:${tab}`, group: 'settings', title, hint: tab === 'remote' ? undefined : t('palette.userScope'), keywords: `settings config ${extra}`, icon, run: go(`/settings?tab=${tab}`) });
    }
    // What is live goes first: it is what a person most often jumps to
    const live = liveSummary({ chats: [...(working.data ?? []), ...(waiting.data ?? [])], orchestrations: orchestrations.data ?? [] });
    list.unshift(
      ...live.items.slice(0, 10).map((item): Command => {
        const hint =
          item.kind === 'orchestration'
            ? `${t('shell:live.groups.orchestrations')} · ${t('shell:live.progress', { done: item.done, total: item.total })}`
            : `${item.state === 'waiting' ? t('shell:live.stateWaiting') : t('shell:live.stateWorking')} · ${item.project ?? t('palette.noProject')}`;
        const icon = item.kind === 'orchestration' ? Workflow : item.state === 'waiting' ? Activity : LoaderCircle;
        return { id: `live:${item.kind}:${item.id}`, group: 'live', title: item.title, hint, keywords: 'live running working waiting', icon, run: go(item.href) };
      }),
    );
    for (const project of (projects.data ?? []).slice(0, 30)) {
      const id = encodeURIComponent(project.id);
      const hint = project.path;
      // The project page is Home with the project selected; the deep link selects it on the way
      const page = (tab: 'activity' | 'settings' | 'memory' | 'resources' | 'worktrees', icon: LucideIcon, keywords = '') =>
        list.push({ id: `project:${tab}:${project.id}`, group: 'projects', title: t('palette.projectPage', { name: project.name, page: t(`palette.projectPages.${tab}`) }), hint, keywords, icon, run: go(`/?project=${id}${tab === 'activity' ? '' : `&tab=${tab}`}`) });
      page('activity', House, 'home inbox');
      page('settings', Settings2, 'config instructions CLAUDE.md mcp files');
      page('memory', Brain, 'facts');
      page('resources', Library, 'agents skills commands workflows');
      page('worktrees', GitBranch, 'branches');
      list.push({ id: `project:assistant:${project.id}`, group: 'projects', title: t('palette.projectAssistant', { name: project.name }), hint, keywords: 'assistant ai suggest propose asistente', icon: Sparkle, run: go(assistantPath(project.id)) });
      list.push({ id: `project:chats:${project.id}`, group: 'projects', title: t('palette.projectChats', { name: project.name }), hint, keywords: 'sessions history', icon: MessagesSquare, run: go(`/chats?project=${id}`) });
      if (project.exists) {
        list.push({ id: `project:new-chat:${project.id}`, group: 'projects', title: t('palette.projectNewChat', { name: project.name }), hint, keywords: 'start run', icon: Play, run: go(`/chats/new?cwd=${encodeURIComponent(project.path)}`) });
      }
    }
    for (const chat of overview.data?.recentChats ?? []) {
      list.push({ id: `recent:${chat.id}`, group: 'recentChats', title: displayTitle(chat), hint: chat.cwd, keywords: 'chat transcript', icon: MessageSquare, run: go(`/chats/${encodeURIComponent(chat.id)}`) });
    }
    return list;
  }, [navigate, t, selected, projects.data, working.data, waiting.data, orchestrations.data, overview.data]);

  const ranked = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    return commands
      .map((command) => ({
        command,
        rank: Math.max(score(q, command.title), score(q, `${t(`palette.groups.${command.group}`)} ${command.title}`) - 5, score(q, command.keywords ?? '') - 20, score(q, command.hint ?? '') - 30),
      }))
      .filter((r) => r.rank > 0)
      .sort((a, b) => b.rank - a.rank);
  }, [commands, query, t]);

  const trimmed = query.trim();
  useEffect(() => {
    if (!intentOn || trimmed.length < INTENT_MIN_CHARS) return setSettled('');
    const timer = window.setTimeout(() => setSettled(trimmed), INTENT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [intentOn, trimmed]);
  const intentCommands = useMemo(() => commands.filter((c) => INTENT_GROUPS.includes(c.group)).map((c) => ({ id: c.id, title: c.title })), [commands]);
  const wantsIntent = intentOn && settled !== '' && settled === trimmed && (ranked[0]?.rank ?? 0) < INTENT_FLOOR;
  const intent = useQuery({
    queryKey: ['decisions', 'palette', settled, intentCommands.length],
    queryFn: ({ signal }) => api.decisionPalette(settled, intentCommands, { signal }),
    enabled: open && wantsIntent,
    staleTime: 60_000,
    retry: false,
  });
  const proposedId = wantsIntent ? intent.data?.commandId ?? null : null;
  const decisionId = wantsIntent ? intent.data?.decisionId ?? null : null;
  const decisionRef = useRef<string | null>(null);
  decisionRef.current = decisionId;
  const report = useRef(createPaletteReporter((id, commandId) => api.decisionPaletteAction(id, commandId))).current;
  // Every way of closing lands here (Escape, a click outside, the shortcut, a command that ran): one report, the first one kept
  useEffect(() => {
    if (!open) report(decisionRef.current, null);
  }, [open, report]);
  const proposed = proposedId ? commands.find((c) => c.id === proposedId) : undefined;

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) {
      // Idle state: recently used first, then the static entries; per-project noise stays out
      const byId = new Map(commands.map((c) => [c.id, c]));
      const recents = recent.flatMap((id) => (byId.has(id) ? [{ ...(byId.get(id) as Command), group: 'recent' as const }] : []));
      const idle = new Set<Group>(['projects', 'settings', 'language', 'motion']);
      const rest = commands.filter((c) => !idle.has(c.group) && !recent.includes(c.id));
      return [...recents, ...rest].slice(0, MAX_RESULTS);
    }
    const local = ranked.map((r) => r.command);
    // The proposed command leads; whatever the local search found follows
    return (proposed ? [proposed, ...local.filter((c) => c.id !== proposed.id)] : local).slice(0, MAX_RESULTS);
  }, [commands, query, recent, ranked, proposed]);

  // While searching, results are ranked globally; grouping only applies to the idle list
  const grouped = !query.trim();

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  const execute = (command: Command | undefined) => {
    if (!command) return;
    const base = command.id;
    const next = [base, ...recent.filter((id) => id !== base)].slice(0, MAX_RECENT);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // recents are a convenience only
    }
    report(decisionId, command.id);
    setOpen(false);
    command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(results.length - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      execute(results[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="palette-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(event) => event.target === event.currentTarget && close()}
        >
          <motion.div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label={t('palette.label')}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -4 }}
            transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }}
            onKeyDown={onKeyDown}
          >
            <div className="palette-input-row">
              <Search size={17} strokeWidth={1.75} aria-hidden />
              <input
                ref={inputRef}
                className="palette-input"
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-list"
                aria-activedescendant={results[active] ? `palette-option-${active}` : undefined}
                aria-autocomplete="list"
                aria-label={t('palette.placeholderLabel')}
                placeholder={t('palette.placeholder')}
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <kbd className="palette-kbd">Esc</kbd>
            </div>

            <div className="palette-list" id="palette-list" role="listbox" aria-label={t('palette.commands')} ref={listRef}>
              {results.length === 0 ? (
                <div className="palette-empty">
                  {t('palette.noMatches')} “<strong>{query}</strong>”
                </div>
              ) : (
                results.map((command, index) => {
                  const Icon = command.icon;
                  const selected = index === active;
                  const showGroup = grouped && command.group !== results[index - 1]?.group;
                  return (
                    <Fragment key={`${command.group}:${command.id}`}>
                      {showGroup && (
                        <div className="palette-group" role="presentation">
                          {t(`palette.groups.${command.group}`)}
                        </div>
                      )}
                      <div
                        id={`palette-option-${index}`}
                        role="option"
                        aria-selected={selected}
                        className={`palette-option ${selected ? 'palette-option-on' : ''}`}
                        onMouseMove={() => !selected && setActive(index)}
                        onClick={() => execute(command)}
                      >
                        {selected && (
                          <motion.span
                            layoutId="palette-highlight"
                            className="palette-highlight"
                            transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 700, damping: 45 }}
                          />
                        )}
                        <span className="palette-option-icon">
                          <Icon size={16} strokeWidth={1.75} aria-hidden />
                        </span>
                        <span className="palette-option-text">
                          <span className="palette-option-title">{command.title}</span>
                          {command.hint && <span className="palette-option-hint">{command.hint}</span>}
                        </span>
                        {command.id === proposedId && intent.data?.confidence != null && (
                          <span className="decided-face palette-decided">{t('decisions:mark.decided', { confidence: intent.data.confidence.toFixed(2) })}</span>
                        )}
                        {!grouped && <span className="palette-option-group">{t(`palette.groups.${command.group}`)}</span>}
                        {selected && <CornerDownLeft className="palette-option-enter" size={14} strokeWidth={1.75} aria-hidden />}
                      </div>
                    </Fragment>
                  );
                })
              )}
            </div>

            <div className="palette-foot">
              <span>
                <kbd className="palette-kbd">↑</kbd>
                <kbd className="palette-kbd">↓</kbd> {t('palette.navigate')}
              </span>
              <span>
                <kbd className="palette-kbd">↵</kbd> {t('palette.open')}
              </span>
              <span className="palette-foot-right">
                <kbd className="palette-kbd">{isMac ? '⌘' : 'Ctrl'} K</kbd> {t('palette.toggle')}
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
