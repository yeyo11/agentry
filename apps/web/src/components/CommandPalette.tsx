// ⌘K command palette: jump to any page, config section, project or live run, and run quick actions.
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BookOpen,
  Bot,
  Brain,
  CornerDownLeft,
  FolderGit2,
  FolderPlus,
  History,
  KeyRound,
  LayoutDashboard,
  ListTodo,
  MessageSquare,
  Monitor,
  Moon,
  Network,
  Play,
  Puzzle,
  Search,
  Settings2,
  SlidersHorizontal,
  Sun,
  Users,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, keys } from '../api';
import { setThemePreference } from '../lib/theme';
import { statusText } from './ui';
import '../palette.css';

const OPEN_EVENT = 'cw:open-command-palette';
const RECENT_KEY = 'agentry-palette-recent';
const MAX_RECENT = 5;
const MAX_RESULTS = 40;

type Group = 'actions' | 'theme' | 'goTo' | 'config' | 'liveRuns' | 'projects' | 'recentSessions' | 'recent';

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

export function CommandPaletteTrigger() {
  const { t } = useTranslation('components');
  return (
    <button type="button" className="palette-trigger" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}>
      <Search size={14} strokeWidth={1.75} aria-hidden />
      <span className="palette-trigger-label">{t('palette.trigger')}</span>
      <kbd className="palette-kbd">{isMac ? '⌘' : 'Ctrl'} K</kbd>
    </button>
  );
}

export function CommandPalette() {
  const navigate = useNavigate();
  const { t } = useTranslation('components');
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
  const runs = useQuery({ queryKey: keys.runs, queryFn: api.runs, enabled: open });
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
    const list: Command[] = [
      { id: 'act:new-run', group: 'actions', title: t('palette.newRun'), hint: t('palette.newRunHint'), keywords: 'chat prompt start', icon: Play, run: go('/runs/new') },
      { id: 'act:new-orchestration', group: 'actions', title: t('palette.newOrchestration'), hint: t('palette.newOrchestrationHint'), keywords: 'agents dag plan', icon: Network, run: go('/orchestration') },
      { id: 'act:new-project', group: 'actions', title: t('palette.newProject'), hint: t('palette.newProjectHint'), keywords: 'git clone folder', icon: FolderPlus, run: go('/projects') },
      { id: 'act:credential', group: 'actions', title: t('palette.credential'), hint: t('palette.credentialHint'), keywords: 'login auth token key', icon: KeyRound, run: go('/config?tab=account') },
      { id: 'act:api-docs', group: 'actions', title: t('palette.apiReference'), hint: t('palette.apiReferenceHint'), keywords: 'swagger openapi rest docs scalar', icon: BookOpen, run: () => window.open('/docs', '_blank', 'noopener') },
      { id: 'theme:light', group: 'theme', title: t('theme.light'), icon: Sun, run: () => setThemePreference('light') },
      { id: 'theme:dark', group: 'theme', title: t('theme.dark'), icon: Moon, run: () => setThemePreference('dark') },
      { id: 'theme:system', group: 'theme', title: t('theme.system'), icon: Monitor, run: () => setThemePreference('system') },
      { id: 'nav:/', group: 'goTo', title: t('nav.dashboard'), keywords: 'home overview status usage', icon: LayoutDashboard, run: go('/') },
      { id: 'nav:/agents', group: 'goTo', title: t('nav.agents'), keywords: 'runs subagents live', icon: Bot, run: go('/agents') },
      { id: 'nav:/tasks', group: 'goTo', title: t('nav.backgroundTasks'), keywords: 'bash jobs', icon: ListTodo, run: go('/tasks') },
      { id: 'nav:/workflows', group: 'goTo', title: t('nav.workflows'), keywords: 'workflow tool script agents saved run', icon: Waypoints, run: go('/workflows') },
      { id: 'nav:/sessions', group: 'goTo', title: t('nav.sessions'), keywords: 'history transcripts', icon: History, run: go('/sessions') },
      { id: 'nav:/projects', group: 'goTo', title: t('nav.projects'), keywords: 'workspace directories', icon: FolderGit2, run: go('/projects') },
      { id: 'nav:/orchestration', group: 'goTo', title: t('nav.orchestration'), keywords: 'multi agent', icon: Network, run: go('/orchestration') },
      { id: 'nav:/accounts', group: 'goTo', title: t('nav.accounts'), keywords: 'claude-swap multi account quota rotate switch limit', icon: Users, run: go('/accounts') },
      { id: 'nav:/memory', group: 'goTo', title: t('nav.memory'), keywords: 'facts feedback MEMORY.md', icon: Brain, run: go('/memory') },
      { id: 'nav:/plugins', group: 'goTo', title: t('nav.plugins'), keywords: 'marketplace install extensions', icon: Puzzle, run: go('/plugins') },
      { id: 'nav:/config', group: 'goTo', title: t('nav.config'), keywords: 'settings preferences', icon: Settings2, run: go('/config') },
    ];
    const tabs: Array<[string, string, string]> = [
      ['instructions', t('palette.configTabs.instructions'), 'CLAUDE.md'],
      ['settings', t('palette.configTabs.settings'), 'settings.json permissions hooks env model'],
      ['mcp', t('palette.configTabs.mcp'), 'connectors tools'],
      ['agents', t('palette.configTabs.agents'), 'subagents'],
      ['skills', t('palette.configTabs.skills'), 'SKILL.md'],
      ['commands', t('palette.configTabs.commands'), 'slash'],
      ['output-styles', t('palette.configTabs.outputStyles'), ''],
      ['rules', t('palette.configTabs.rules'), ''],
      ['files', t('palette.configTabs.files'), 'explorer hooks scripts keybindings'],
    ];
    for (const [tab, title, extra] of tabs) {
      list.push({ id: `config:${tab}`, group: 'config', title, hint: t('palette.userScope'), keywords: `config ${extra}`, icon: SlidersHorizontal, run: go(`/config?tab=${tab}`) });
    }
    for (const run of (runs.data ?? []).filter((r) => r.pid !== null).slice(0, 8)) {
      list.push({ id: `run:${run.id}`, group: 'liveRuns', title: run.name, hint: `${statusText(run.status)} · ${run.cwd}`, keywords: 'run live chat', icon: Activity, run: go(`/runs/${run.id}`) });
    }
    for (const project of (projects.data ?? []).slice(0, 30)) {
      const id = encodeURIComponent(project.id);
      const hint = project.path;
      list.push({ id: `project:sessions:${project.id}`, group: 'projects', title: t('palette.projectSessions', { name: project.name }), hint, icon: FolderGit2, run: go(`/sessions?project=${id}`) });
      if (project.exists) {
        list.push({ id: `project:run:${project.id}`, group: 'projects', title: t('palette.projectNewRun', { name: project.name }), hint, keywords: 'start', icon: Play, run: go(`/runs/new?cwd=${encodeURIComponent(project.path)}`) });
        list.push({ id: `project:config:${project.id}`, group: 'projects', title: t('palette.projectConfig', { name: project.name }), hint, keywords: 'settings mcp', icon: Settings2, run: go(`/config?project=${id}`) });
      }
      list.push({ id: `project:memory:${project.id}`, group: 'projects', title: t('palette.projectMemory', { name: project.name }), hint, icon: Brain, run: go(`/memory?project=${id}`) });
    }
    for (const session of overview.data?.recentSessions ?? []) {
      list.push({ id: `session:${session.id}`, group: 'recentSessions', title: session.title, hint: session.projectPath, keywords: 'session transcript', icon: MessageSquare, run: go(`/sessions/${session.id}`) });
    }
    return list;
  }, [navigate, t, projects.data, runs.data, overview.data]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) {
      // Idle state: recently used first, then the static entries; per-project noise stays out
      const byId = new Map(commands.map((c) => [c.id, c]));
      const recents = recent.flatMap((id) => (byId.has(id) ? [{ ...(byId.get(id) as Command), group: 'recent' as const }] : []));
      const rest = commands.filter((c) => c.group !== 'projects' && c.group !== 'config' && !recent.includes(c.id));
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
                    <div key={`${command.group}:${command.id}`}>
                      {showGroup && <div className="palette-group">{t(`palette.groups.${command.group}`)}</div>}
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
                    </div>
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
