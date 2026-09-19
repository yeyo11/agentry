import type { ProjectSummary, SessionSummary } from '@agentry/shared';
import { ArrowUpRight, ChevronRight, GitBranch, History, Network, Play, Radio, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useProjects, useSessions } from '../api';
import { Checkbox, Select, Tooltip } from '../components/controls';
import { ICON_SM, Monogram } from '../components/icons';
import { Collapse, StatusDot } from '../components/motion';
import { useDeleteSession } from '../components/SessionDelete';
import { isTemporarySession, ORIGIN_META, OriginBadge, originOf, type OriginKind } from '../components/SessionOrigin';
import { Card, Empty, ErrorBox, PageHeader, Segmented, Skeleton, StatusBadge } from '../components/ui';
import { formatBytes, formatDateTime, shortPath, timeAgo } from '../lib/format';

type Show = 'active' | 'all';
type View = 'grouped' | 'flat';
type Sort = 'activity' | 'started' | 'messages';
const SORT_OPTIONS: ReadonlyArray<{ value: Sort; label: string }> = [
  { value: 'activity', label: 'Recent activity' },
  { value: 'started', label: 'Recently started' },
  { value: 'messages', label: 'Most messages' },
];

const FILTERABLE_ORIGINS: OriginKind[] = ['cli', 'run', 'orchestration'];
const ORIGIN_CHIP_LABEL: Record<string, string> = { cli: 'CLI', run: 'Agentry runs', orchestration: 'Orchestrations' };
const COLLAPSE_KEY = 'cw:sessions-collapsed';
const SYNTHESIS = '__synthesis__';

const SORTERS: Record<Sort, (a: SessionSummary, b: SessionSummary) => number> = {
  activity: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  started: (a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''),
  messages: (a, b) => b.messageCount - a.messageCount,
};

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Explicit open/closed choices per section, remembered across visits. */
function useCollapseMemory() {
  const [state, setState] = useState<Record<string, boolean>>(readCollapsed);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state));
    } catch {
      // storage unavailable: the choice lasts for this visit only
    }
  }, [state]);
  return {
    isOpen: (key: string, fallback: boolean) => (key in state ? !state[key] : fallback),
    toggle: (key: string, currentlyOpen: boolean) => setState((s) => ({ ...s, [key]: currentlyOpen })),
  };
}

function SessionItem({
  session,
  label,
  onDelete,
  deleting,
}: {
  session: SessionSummary;
  /** Replaces the title for orchestration workers (their task name) */
  label?: string;
  onDelete: (session: SessionSummary) => void;
  deleting: boolean;
}) {
  const navigate = useNavigate();
  const origin = originOf(session);
  const liveRunId = session.live?.source === 'wrapper' ? (session.live.runId ?? origin.runId) : undefined;
  const title = label ?? session.title;
  const subtitle = session.firstPrompt && session.firstPrompt.split('\n')[0]?.slice(0, 100) !== session.title ? session.firstPrompt : null;
  return (
    <div className={`srow ${session.live ? 'is-live' : ''}`}>
      <Link to={`/sessions/${session.id}`} className="srow-link">
        <span className="srow-status">
          {session.live ? <StatusDot tone="active" live title={`live via ${session.live.source}`} /> : <StatusDot tone="muted" />}
        </span>
        <span className="srow-main">
          <span className="srow-title">
            {session.live && <StatusBadge status={session.live.status} />}
            <Tooltip content={session.title}>
              <span className="srow-title-text">{title}</span>
            </Tooltip>
          </span>
          {label && label !== session.title && <span className="srow-sub">{session.title}</span>}
          {!label && subtitle && <span className="srow-sub">{subtitle}</span>}
          <span className="meta">
            <OriginBadge session={session} />
            {/* Grouped under the repository, so the branch is what tells a worktree session apart */}
            {session.worktree && (
              <span className="chip chip-static mono" title={session.worktree.path}>
                <GitBranch size={12} strokeWidth={1.75} aria-hidden /> {session.worktree.branch ?? session.worktree.name}
              </span>
            )}
            {session.model && <span className="chip chip-static mono">{session.model}</span>}
            <span>{session.messageCount} msgs</span>
            <span>{formatBytes(session.sizeBytes)}</span>
          </span>
        </span>
        <span className="srow-time muted small nowrap" title={formatDateTime(session.updatedAt)}>
          {timeAgo(session.updatedAt)}
        </span>
      </Link>
      <div className="srow-actions">
        <Tooltip content="Open transcript">
          <Link to={`/sessions/${session.id}`} className="btn btn-small">
            Open <ArrowUpRight {...ICON_SM} />
          </Link>
        </Tooltip>
        {liveRunId ? (
          <Link to={`/runs/${liveRunId}`} className="btn btn-small btn-primary">
            <Radio {...ICON_SM} /> Open run
          </Link>
        ) : (
          <button className="btn btn-small" onClick={() => navigate(`/sessions/${session.id}?resume=1`)}>
            <Play {...ICON_SM} /> Resume in a run
          </button>
        )}
        {/* The wrapper keeps the tooltip working while the button is disabled */}
        <Tooltip content={session.live ? 'Live sessions cannot be deleted' : 'Delete session'}>
          <span className="tooltip-anchor">
            <button
              className="icon-btn"
              aria-label={`Delete session ${session.title}`}
              disabled={Boolean(session.live) || deleting}
              onClick={() => onDelete(session)}
            >
              {deleting ? <span className="spinner" /> : <Trash2 {...ICON_SM} />}
            </button>
          </span>
        </Tooltip>
      </div>
    </div>
  );
}

interface OrchestrationGroup {
  id: string;
  name: string;
  sessions: SessionSummary[];
}

type SectionItem = { kind: 'session'; session: SessionSummary } | { kind: 'orchestration'; group: OrchestrationGroup };

/** Standalone sessions stay rows; orchestration workers collapse under one parent per orchestration. */
function buildItems(sessions: SessionSummary[]): SectionItem[] {
  const groups = new Map<string, OrchestrationGroup>();
  const items: SectionItem[] = [];
  for (const session of sessions) {
    const origin = originOf(session);
    if (origin.kind === 'orchestration' && origin.orchestrationId) {
      let group = groups.get(origin.orchestrationId);
      if (!group) {
        group = { id: origin.orchestrationId, name: origin.orchestrationName ?? 'orchestration', sessions: [] };
        groups.set(group.id, group);
        items.push({ kind: 'orchestration', group }); // positioned where its best-ranked worker sorts
      }
      group.sessions.push(session);
    } else {
      items.push({ kind: 'session', session });
    }
  }
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => {
      const synthA = originOf(a).taskId === SYNTHESIS ? 1 : 0;
      const synthB = originOf(b).taskId === SYNTHESIS ? 1 : 0;
      return synthA - synthB || (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
    });
  }
  return items;
}

function OrchestrationRow({
  group,
  open,
  onToggle,
  onDelete,
  pendingId,
}: {
  group: OrchestrationGroup;
  open: boolean;
  onToggle: () => void;
  onDelete: (session: SessionSummary) => void;
  pendingId?: string;
}) {
  const liveCount = group.sessions.filter((s) => s.live).length;
  const last = group.sessions.map((s) => s.updatedAt ?? '').sort().at(-1) ?? null;
  return (
    <div className="sorch">
      <div className="sorch-head">
        <button type="button" className="sorch-toggle" aria-expanded={open} onClick={onToggle}>
          <ChevronRight size={13} strokeWidth={2} className={`tree-chevron ${open ? 'is-open' : ''}`} aria-hidden />
          <span className="sorch-icon">
            <Network {...ICON_SM} />
          </span>
          <span className="sorch-title ellipsis">
            <span className="muted">Orchestration ·</span> {group.name}
          </span>
          <span className="count">{group.sessions.length} workers</span>
          {liveCount > 0 && (
            <span className="badge badge-active">
              <StatusDot tone="active" live /> {liveCount} live
            </span>
          )}
        </button>
        <span className="muted small nowrap" title={formatDateTime(last)}>
          {timeAgo(last)}
        </span>
        <Tooltip content="Open the orchestration board">
          <Link to={`/orchestration/${group.id}`} className="btn btn-small">
            Board <ArrowUpRight {...ICON_SM} />
          </Link>
        </Tooltip>
      </div>
      <Collapse open={open}>
        <div className="sorch-children">
          {group.sessions.map((session) => {
            const origin = originOf(session);
            return (
              <SessionItem
                key={session.id}
                session={session}
                label={origin.taskId === SYNTHESIS ? 'Synthesis' : (origin.taskName ?? origin.taskId)}
                onDelete={onDelete}
                deleting={pendingId === session.id}
              />
            );
          })}
        </div>
      </Collapse>
    </div>
  );
}

export function Sessions() {
  const [params, setParams] = useSearchParams();
  const projects = useProjects();
  const sessions = useSessions();
  const collapse = useCollapseMemory();
  const { requestDelete, pendingId } = useDeleteSession();
  const [search, setSearch] = useState('');

  const show: Show = params.get('show') === 'all' ? 'all' : 'active';
  const view: View = params.get('view') === 'flat' ? 'flat' : 'grouped';
  const sort: Sort = (['activity', 'started', 'messages'] as const).find((s) => s === params.get('sort')) ?? 'activity';
  const projectId = params.get('project') ?? '';
  const showTemporary = params.get('temp') === '1';
  const showInternal = params.get('internal') === '1';
  const originParam = params.get('origin');
  const origins = useMemo(
    () => new Set<OriginKind>(originParam ? (originParam.split(',').filter((o) => FILTERABLE_ORIGINS.includes(o as OriginKind)) as OriginKind[]) : FILTERABLE_ORIGINS),
    [originParam],
  );

  const patch = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const projectsById = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);
  const all = sessions.data ?? [];

  const { visible, withoutShowFilter } = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const base = all.filter((s) => {
      const origin = originOf(s);
      // A project's worktrees are part of it
      if (projectId && s.projectId !== projectId && projectsById.get(s.projectId)?.parentId !== projectId) return false;
      if (origin.kind === 'internal') {
        if (!showInternal) return false;
      } else if (!origins.has(origin.kind)) return false;
      // An explicitly selected project is never hidden for being temporary
      if (!showTemporary && !projectId && isTemporarySession(s, projectsById)) return false;
      if (!needle) return true;
      return [s.title, s.firstPrompt ?? '', s.projectPath, s.id, origin.orchestrationName ?? '', origin.taskName ?? ''].some((v) =>
        v.toLowerCase().includes(needle),
      );
    });
    const sorted = [...base].sort(SORTERS[sort]);
    return { withoutShowFilter: sorted, visible: show === 'active' ? sorted.filter((s) => s.live) : sorted };
  }, [all, search, projectId, showInternal, showTemporary, origins, projectsById, sort, show]);

  const filtersActive =
    Boolean(search.trim()) || Boolean(projectId) || showTemporary || showInternal || origins.size !== FILTERABLE_ORIGINS.length || sort !== 'activity';
  const forceOpen = Boolean(search.trim());

  const sections = useMemo(() => {
    const byProject = new Map<string, SessionSummary[]>();
    for (const s of visible) {
      // Sessions in a worktree go with the repository it belongs to, not in a group of their own
      const parent = projectsById.get(s.projectId)?.parentId;
      const key = parent && projectsById.has(parent) ? parent : s.projectId;
      const list = byProject.get(key) ?? [];
      list.push(s);
      byProject.set(key, list);
    }
    return [...byProject.entries()]
      .map(([id, list]) => {
        const project: ProjectSummary | undefined = projectsById.get(id);
        const path = project?.path ?? list.find((s) => s.projectPath)?.projectPath ?? id;
        return {
          id,
          name: project?.name ?? (path.split('/').filter(Boolean).pop() || id),
          path,
          temporary: project?.temporary ?? path.startsWith('/tmp/'),
          sessions: list,
          live: list.filter((s) => s.live).length,
          last: list.map((s) => s.updatedAt ?? '').sort().at(-1) ?? null,
        };
      })
      .sort((a, b) => Number(b.live > 0) - Number(a.live > 0) || (b.last ?? '').localeCompare(a.last ?? ''));
  }, [visible, projectsById]);

  const toggleOrigin = (kind: OriginKind) => {
    const next = new Set(origins);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    if (next.size === 0) return; // at least one origin stays on
    patch({ origin: next.size === FILTERABLE_ORIGINS.length ? null : [...next].join(',') });
  };

  return (
    <>
      <PageHeader
        title="Sessions"
        subtitle={
          <span className="meta">
            <span>
              {visible.length} of {all.length} sessions
            </span>
            {filtersActive && (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setSearch('');
                  setParams(show === 'all' ? { show: 'all' } : {}, { replace: true });
                }}
              >
                <RotateCcw size={11} strokeWidth={2} aria-hidden /> Reset filters
              </button>
            )}
          </span>
        }
        actions={
          <>
            <Segmented
              label="Which sessions to show"
              value={show}
              onChange={(v) => patch({ show: v === 'all' ? 'all' : null })}
              options={[
                { value: 'active', label: 'Active', title: 'Sessions with a live process right now' },
                { value: 'all', label: 'All' },
              ]}
            />
            <Segmented
              label="Layout"
              value={view}
              onChange={(v) => patch({ view: v === 'flat' ? 'flat' : null })}
              options={[
                { value: 'grouped', label: 'Grouped', title: 'By project, orchestration workers nested' },
                { value: 'flat', label: 'Flat' },
              ]}
            />
          </>
        }
      />

      <div className="filter-bar">
        <div className="search-field grow">
          <Search {...ICON_SM} />
          <input
            type="search"
            placeholder="Search title, first prompt, project, id…"
            aria-label="Search sessions"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          aria-label="Project"
          value={projectId}
          onChange={(v) => patch({ project: v || null })}
          options={[
            { value: '', label: 'All projects' },
            ...(projects.data ?? [])
              .filter((p) => showTemporary || !p.temporary || p.id === projectId)
              .map((p) => ({ value: p.id, label: `${p.name} (${p.sessionCount})` })),
          ]}
        />
        <Select<Sort>
          aria-label="Sort by"
          value={sort}
          onChange={(v) => patch({ sort: v === 'activity' ? null : v })}
          options={SORT_OPTIONS}
        />
        <div className="chips" role="group" aria-label="Origin">
          {FILTERABLE_ORIGINS.map((kind) => {
            const Icon = ORIGIN_META[kind].icon;
            return (
              <button
                key={kind}
                type="button"
                className={`chip chip-toggle ${origins.has(kind) ? 'chip-on' : ''}`}
                aria-pressed={origins.has(kind)}
                onClick={() => toggleOrigin(kind)}
              >
                <Icon size={12} strokeWidth={2} aria-hidden /> {ORIGIN_CHIP_LABEL[kind]}
              </button>
            );
          })}
        </div>
        <Checkbox
          checked={showTemporary}
          onChange={(on) => patch({ temp: on ? '1' : null })}
          tooltip="Sessions of projects under the OS temp directory"
        >
          Temporary projects
        </Checkbox>
        <Checkbox
          checked={showInternal}
          onChange={(on) => patch({ internal: on ? '1' : null })}
          tooltip="Housekeeping sessions of the wrapper itself (planner, auth check)"
        >
          Internal
        </Checkbox>
      </div>

      <ErrorBox error={sessions.error} />

      {sessions.isLoading ? (
        <Card>
          <Skeleton rows={8} height={20} />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          {show === 'active' ? (
            <Empty
              icon={Radio}
              title="No active sessions"
              action={
                withoutShowFilter.length > 0 && (
                  <button className="btn btn-primary" onClick={() => patch({ show: 'all' })}>
                    Show all sessions ({withoutShowFilter.length})
                  </button>
                )
              }
            >
              Nothing is running right now. Past sessions are one click away, or start a <Link to="/runs/new">new run</Link>.
            </Empty>
          ) : (
            <Empty icon={History} title="No sessions match">
              {filtersActive ? 'Try resetting the filters.' : 'Sessions appear here once Claude Code has run in a project.'}
            </Empty>
          )}
        </Card>
      ) : view === 'flat' ? (
        <Card className="scard">
          {visible.map((s) => (
            <SessionItem key={s.id} session={s} onDelete={requestDelete} deleting={pendingId === s.id} />
          ))}
        </Card>
      ) : (
        <div className="ssections">
          {sections.map((section, index) => {
            const key = `p:${section.id}`;
            const open = forceOpen || collapse.isOpen(key, section.live > 0 || index === 0 || sections.length <= 3);
            return (
              <section key={section.id} className={`card ssection ${section.live > 0 ? 'is-live' : ''}`}>
                <div className="ssection-head">
                  <button type="button" className="ssection-toggle" aria-expanded={open} onClick={() => collapse.toggle(key, open)}>
                    <ChevronRight size={14} strokeWidth={2} className={`tree-chevron ${open ? 'is-open' : ''}`} aria-hidden />
                    <Monogram name={section.name} size={30} />
                    <span className="ssection-text">
                      <span className="ssection-name ellipsis">
                        {section.name}
                        {section.temporary && <span className="badge">temporary</span>}
                      </span>
                      <span className="mono small muted ellipsis" title={section.path}>
                        {shortPath(section.path, 64)}
                      </span>
                    </span>
                  </button>
                  {section.live > 0 && (
                    <span className="badge badge-active">
                      <StatusDot tone="active" live /> {section.live} live
                    </span>
                  )}
                  <span className="count">{section.sessions.length}</span>
                  <span className="muted small nowrap ssection-time" title={formatDateTime(section.last)}>
                    {timeAgo(section.last)}
                  </span>
                </div>
                <Collapse open={open}>
                  <div className="ssection-body">
                    {buildItems(section.sessions).map((item) =>
                      item.kind === 'session' ? (
                        <SessionItem
                          key={item.session.id}
                          session={item.session}
                          onDelete={requestDelete}
                          deleting={pendingId === item.session.id}
                        />
                      ) : (
                        (() => {
                          const orchKey = `o:${item.group.id}`;
                          const orchOpen = forceOpen || collapse.isOpen(orchKey, item.group.sessions.some((s) => s.live));
                          return (
                            <OrchestrationRow
                              key={item.group.id}
                              group={item.group}
                              open={orchOpen}
                              onToggle={() => collapse.toggle(orchKey, orchOpen)}
                              onDelete={requestDelete}
                              pendingId={pendingId}
                            />
                          );
                        })()
                      ),
                    )}
                  </div>
                </Collapse>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
