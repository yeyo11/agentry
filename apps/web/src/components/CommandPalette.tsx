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
  Sun,
  Users,
  Waypoints,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, keys } from '../api';
import { LANGUAGES, setLanguage } from '../i18n';
import { displayTitle } from '../lib/chat-model';
import { setMotionPreference, type MotionLevel } from '../lib/motion';
import { useProjectScope } from '../lib/project-scope';
import { liveSummary } from '../lib/shell-live';
import { setThemePreference } from '../lib/theme';
import { statusText } from './ui';
import '../palette.css';

const OPEN_EVENT = 'cw:open-command-palette';
/** The workflow dialog lives in the shell, beside "New chat": the palette only asks for it. */
export const RUN_WORKFLOW_EVENT = 'agentry:run-workflow';
/** Opens the Orchestrations page with its "New orchestration" form already open. */
export const NEW_ORCHESTRATION_PATH = '/orchestration?new=1';
const RECENT_KEY = 'agentry-palette-recent';
const MAX_RECENT = 5;
const MAX_RESULTS = 40;

type Group = 'live' | 'actions' | 'theme' | 'language' | 'motion' | 'goTo' | 'settings' | 'projects' | 'recentChats' | 'recent';

const MOTION_LEVELS: MotionLevel[] = ['full', 'subtle', 'off'];

interface Command {
  id: string;
  group: Group;
  title: string;
  hint?: string;
  keywords?: string;
  icon: LucideIcon;
  run: () => void;
}

const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform);

/** Subsequence match with a bonus for word starts and contiguous runs; -1 when it does not match. */
function score(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct - (t.length - q.length) * 0.1;
  let total = 0;
  let from = 0;
  let streak = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at < 0) return -1;
    streak = at === from ? streak + 1 : 0;
    total += 10 + streak * 5 + (at === 0 || /[\s/\-_.]/.test(t[at - 1] ?? '') ? 8 : 0) - (at - from);
    from = at + 1;
  }
  return total;
}

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

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
  const { t } = useTranslation(['components', 'connectors', 'shell']);
  const { project: selected } = useProjectScope();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  // Data is only fetched while the palette is open; the pages keep their own polling.
  const projects = useQuery({ queryKey: keys.projects, queryFn: api.projects, enabled: open });
  const working = useQuery({ queryKey: keys.chatList({ state: 'working' }), queryFn: ({ signal }) => api.chats({ state: 'working' }, { signal }), enabled: open });
  const waiting = useQuery({ queryKey: keys.chatList({ state: 'waiting' }), queryFn: ({ signal }) => api.chats({ state: 'waiting' }, { signal }), enabled: open });
  const orchestrations = useQuery({ queryKey: keys.orchestrations, queryFn: api.orchestrations, enabled: open });
  const overview = useQuery({ queryKey: keys.overview, queryFn: api.overview, enabled: open });

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
      { id: 'act:new-chat', group: 'actions', title: t('palette.newChat'), hint: selected?.exists ? t('palette.newChatIn', { name: selected.name }) : t('palette.newChatHint'), keywords: 'run prompt start', icon: Play, run: go(newChat) },
      { id: 'act:run-workflow', group: 'actions', title: t('palette.runWorkflow'), hint: t('palette.runWorkflowHint'), keywords: 'workflow script', icon: Waypoints, run: () => window.dispatchEvent(new Event(RUN_WORKFLOW_EVENT)) },
      { id: 'act:new-orchestration', group: 'actions', title: t('palette.newOrchestration'), hint: t('palette.newOrchestrationHint'), keywords: 'agents dag plan', icon: Network, run: go(NEW_ORCHESTRATION_PATH) },
      { id: 'act:new-project', group: 'actions', title: t('palette.newProject'), hint: t('palette.newProjectHint'), keywords: 'import git clone folder directory', icon: FolderPlus, run: go('/projects') },
      { id: 'act:credential', group: 'actions', title: t('palette.credential'), hint: t('palette.credentialHint'), keywords: 'login auth token key', icon: KeyRound, run: go('/settings?tab=account') },
      { id: 'act:api-docs', group: 'actions', title: t('palette.apiReference'), hint: t('palette.apiReferenceHint'), keywords: 'swagger openapi rest docs scalar', icon: BookOpen, run: () => window.open('/docs', '_blank', 'noopener') },
      { id: 'theme:light', group: 'theme', title: t('theme.light'), icon: Sun, run: () => setThemePreference('light') },
      { id: 'theme:dark', group: 'theme', title: t('theme.dark'), icon: Moon, run: () => setThemePreference('dark') },
      { id: 'theme:system', group: 'theme', title: t('theme.system'), icon: Monitor, run: () => setThemePreference('system') },
      ...LANGUAGES.map(({ code, name }): Command => ({ id: `language:${code}`, group: 'language', title: t('palette.language', { name }), keywords: 'idioma language english español', icon: Languages, run: () => setLanguage(code) })),
      ...MOTION_LEVELS.map((level): Command => ({ id: `motion:${level}`, group: 'motion', title: t('palette.motion', { level: t(`shell:appearance.motionOptions.${level}`) }), hint: t(`shell:appearance.motionDescriptions.${level}`), keywords: 'motion animation reduce spinner appearance', icon: Gauge, run: () => setMotionPreference(level) })),
      { id: 'nav:/', group: 'goTo', title: t('nav.home'), keywords: 'inbox activity waiting overview status usage', icon: House, run: go('/') },
      { id: 'nav:/chats', group: 'goTo', title: t('nav.chats'), keywords: 'sessions history transcripts conversations', icon: MessagesSquare, run: go('/chats') },
      { id: 'nav:/orchestration', group: 'goTo', title: t('nav.orchestrations'), keywords: 'multi agent graph', icon: Network, run: go('/orchestration') },
      { id: 'nav:/projects', group: 'goTo', title: t('nav.projects'), keywords: 'import workspace directories', icon: FolderGit2, run: go('/projects') },
      { id: 'nav:/accounts', group: 'goTo', title: t('nav.accounts'), keywords: 'claude-swap multi account quota rotate switch limit', icon: Users, run: go('/accounts') },
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
    ];
    for (const [tab, title, extra, icon] of tabs) {
      list.push({ id: `settings:${tab}`, group: 'settings', title, hint: t('palette.userScope'), keywords: `settings config ${extra}`, icon, run: go(`/settings?tab=${tab}`) });
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
    return commands
      .map((command) => ({
        command,
        rank: Math.max(score(q, command.title), score(q, `${t(`palette.groups.${command.group}`)} ${command.title}`) - 5, score(q, command.keywords ?? '') - 20, score(q, command.hint ?? '') - 30),
      }))
      .filter((r) => r.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, MAX_RESULTS)
      .map((r) => r.command);
  }, [commands, query, recent, t]);

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
