import type { ChatState, ChatSummary } from '@agentry/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Download, GitBranch, GitFork, Lock, Plus, Trash2, Zap, type LucideIcon } from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, keys, useChats, useProjects } from '../api';
import { ActivityTicker } from '../components/ActivityTicker';
import { ContextBar } from '../components/ChatBadges';
import { Checkbox, hasOpenLayer } from '../components/controls';
import { useConfirm } from '../components/Dialog';
import { ICON_SM } from '../components/icons';
import { ListToolbar, type ListFilterChip } from '../components/ListToolbar';
import { usageTone } from '../components/motion';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { Card, Empty, ErrorBox, PageHeader, Skeleton } from '../components/ui';
import { ProjectSelector } from '../components/ProjectSelector';
import {
  ALL_ORIGINS,
  contextShare,
  deleteBlocker,
  displayTitle,
  facetOptions,
  formatPercent,
  formatUsd,
  groupByDay,
  lastEnded,
  matchesFilters,
  listRequest,
  ORIGIN_LABEL,
  rowTags,
  SORT_LABEL,
  SORTERS,
  STATE_LABEL,
  stateCounts,
  stepCursor,
  type ChatFilters,
  type ChatOriginFilter,
  type ChatSort,
  type DayGroup,
  type FacetOption,
  type RowTag,
} from '../lib/chat-model';
import { formatDateTime, formatNumber, timeAgo } from '../lib/format';
import { useListKeys } from '../lib/list-keys';
import { COARSE, COMPACT, NARROW, useMediaQuery } from '../lib/media';
import { useMinute } from '../lib/minute';
import { ALL_PROJECTS, useProjectScope } from '../lib/project-scope';
import i18n from '../i18n';

/*
 * Paging stays instead of `VirtualList`: that list is built for a transcript (anchored to its end,
 * following appends), and a windowed list unmounts a group's header once its first rows scroll
 * away, which is exactly when a sticky header has to stay. A hundred rows at a time is cheap, and
 * `j` past the last one shown reads the next hundred.
 */
const PAGE = 100;
const STATES: readonly ChatState[] = ['working', 'waiting', 'idle'];
const SORTS = Object.keys(SORT_LABEL) as ChatSort[];
/** Browsers let a page start a burst of downloads when they come a little apart. */
const DOWNLOAD_GAP_MS = 250;

/** A long press on a touch screen picks the row, as the box does under a pointer. */
const LONG_PRESS_MS = 500;
/** How far a finger may drift before the press is a scroll rather than a hold. */
const LONG_PRESS_SLOP = 10;

const TAG_ICON: Record<RowTag, LucideIcon> = { interactive: Zap, readOnly: Lock, fork: GitFork, worktree: GitBranch };

/** A URL list parameter as a set; absent is empty, which every facet reads as "all". */
const listParam = (value: string | null): Set<string> => new Set(value ? value.split(',').filter(Boolean) : []);

/** Where the chat came from, with the orchestration named when it works for one. */
function originLabel(chat: ChatSummary): string {
  if (chat.origin !== 'orchestration' || !chat.orchestration) return ORIGIN_LABEL[chat.origin];
  return `${chat.orchestration.name} · ${chat.orchestration.taskName ?? i18n.t('chats:list.synthesis')}`;
}

/** How the last execution ended, when an idle chat's last run went wrong. */
function badOutcome(chat: ChatSummary) {
  const ended = chat.state === 'idle' && !chat.execution ? lastEnded(chat) : null;
  return ended?.outcome && ended.outcome !== 'completed' ? ended.outcome : null;
}

/**
 * The first column: the braille spinner while an agent works, and otherwise a dot — a hollow violet
 * ring waiting for the person, a red one after a run that went wrong, a faint ring at rest. It is
 * decoration: the word it stands for is on the line under the title.
 */
function StateMark({ chat }: { chat: ChatSummary }) {
  if (chat.state === 'working') return <Spinner className="crow-spinner" />;
  const tone = chat.state === 'waiting' ? 'dot-idle' : badOutcome(chat) ? 'dot-bad' : 'crow-dot-rest';
  return <span className={`dot ${tone}`} aria-hidden />;
}

/** The state in words, at the start of the line under the title. Idle, what most rows are, is said to a screen reader only. */
function StateWord({ chat }: { chat: ChatSummary }) {
  const { t } = useTranslation('chats');
  const bad = badOutcome(chat);
  // A working chat with an activity has its ticker here instead, verb included
  if (chat.state === 'working' && chat.activity) return <ActivityTicker activity={chat.activity} className="crow-ticker" />;
  if (chat.state === 'working') return <span className="crow-word is-live">{STATE_LABEL.working}</span>;
  if (chat.state === 'waiting') return <span className="crow-word is-idle">{STATE_LABEL.waiting}</span>;
  if (bad) return <span className="badge badge-bad crow-outcome">{t(`list.outcome.${bad}`)}</span>;
  return <span className="sr-only">{STATE_LABEL.idle}</span>;
}

/** How long ago, kept current by the shared minute clock rather than by whatever re-renders the row. */
function Ago({ iso }: { iso: string | null }) {
  useMinute();
  return <>{timeAgo(iso)}</>;
}

/** What the chat cost, or that the CLI reported nothing: a dash would read as zero. */
function Cost({ usd }: { usd: number | null }) {
  const { t } = useTranslation('chats');
  if (usd !== null) return <>{formatUsd(usd)}</>;
  return (
    <>
      <span className="crow-no-cost" aria-hidden>
        {t('list.noCost')}
      </span>
      <span className="sr-only">{t('list.cost', { cost: formatUsd(null) })}</span>
    </>
  );
}

/**
 * Memoized, and handed callbacks that take the chat's id, so a keystroke in the search, a cursor
 * move or one row's live numbers re-render the rows that changed rather than a hundred of them.
 *
 * One row is a table line on a wide list and a two-line card on a narrow one: which of the two
 * lines under the title shows is the stylesheet's business (a container query on the list), so
 * the row never waits for a resize to re-render.
 */
const ChatRow = memo(function ChatRow({
  chat,
  index,
  cursor,
  selected,
  tapSelects,
  onSelect,
  onFocus,
}: {
  chat: ChatSummary;
  index: number;
  cursor: boolean;
  selected: boolean;
  /** In select mode on a touch screen a tap picks the row instead of opening it */
  tapSelects: boolean;
  onSelect: (id: string, on: boolean) => void;
  onFocus: (id: string) => void;
}) {
  const { t } = useTranslation(['chats', 'chat', 'common']);
  const place = chat.origin === 'orchestration' && chat.orchestration ? originLabel(chat) : (chat.project?.name ?? t('list.noProject'));
  const tags = rowTags(chat);
  const working = chat.state === 'working';
  const share = contextShare(chat);
  const contextTone = share === null ? 'neutral' : usageTone(Math.round(share * 100));

  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const release = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => release, []);

  return (
    <li
      className={`crow is-${chat.state} ${working ? 'live-rail' : ''} ${cursor ? 'is-cursor' : ''} ${selected ? 'is-selected' : ''}`}
      data-row={index}
      data-id={chat.id}
    >
      <span className="crow-select">
        <Checkbox checked={selected} onChange={(on) => onSelect(chat.id, on)} aria-label={t('list.selectChat', { title: displayTitle(chat) })} />
      </span>
      <Link
        to={`/chats/${chat.id}`}
        className="crow-link"
        onFocus={() => onFocus(chat.id)}
        onPointerDown={(event) => {
          pressed.current = false;
          if (event.pointerType === 'mouse') return;
          release();
          press.current = {
            x: event.clientX,
            y: event.clientY,
            timer: window.setTimeout(() => {
              press.current = null;
              pressed.current = true;
              onSelect(chat.id, true);
            }, LONG_PRESS_MS),
          };
        }}
        onPointerMove={(event) => {
          const start = press.current;
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP) release();
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onContextMenu={(event) => {
          // The press that picked the row must not also open the browser's menu for the link
          if (pressed.current || press.current) event.preventDefault();
        }}
        onClick={(event) => {
          if (pressed.current) {
            pressed.current = false;
            event.preventDefault();
            return;
          }
          if (tapSelects) {
            event.preventDefault();
            onSelect(chat.id, !selected);
          }
        }}
      >
        <span className="crow-mark">
          <StateMark chat={chat} />
        </span>
        <span className="crow-main">
          <span className="crow-title-text">{displayTitle(chat)}</span>
          <span className="crow-sub">
            <StateWord chat={chat} />
            {/* The table's line: the id, how the chat can be driven, and on demand its model */}
            <span className="crow-sub-wide">
              <span className="crow-id">{chat.id.slice(0, 6)}</span>
              {tags.map((tag) => {
                const Icon = TAG_ICON[tag];
                return (
                  <span key={tag} className={`crow-tag is-${tag}`}>
                    <Icon size={11} strokeWidth={2} aria-hidden />
                    {tag === 'worktree' ? (chat.worktree?.branch ?? chat.worktree?.name ?? t('list.worktree')) : tag === 'fork' ? t('list.fork') : t(`list.tag.${tag}`)}
                  </span>
                );
              })}
              <span className="crow-extra">
                {chat.model && <span>{chat.model}</span>}
                {chat.worktree?.branch && !tags.includes('worktree') && <span>{chat.worktree.branch}</span>}
                <span>{t('list.messages', { n: formatNumber(chat.messageCount) })}</span>
              </span>
            </span>
            {/* The card's line, where there are no columns: where it runs, the context and the cost */}
            <span className="crow-sub-narrow">
              {chat.origin !== 'agentry' && <span className="badge crow-origin-badge">{ORIGIN_LABEL[chat.origin]}</span>}
              <span className="crow-meta-place">{place}</span>
              {share !== null && (
                <span className={`crow-meta-context is-${contextTone}`}>
                  {formatPercent(share)}
                  {contextTone !== 'neutral' && ` ${t('list.contextShort')}`}
                </span>
              )}
              <span className="crow-meta-cost">
                <Cost usd={chat.cost.usd} />
              </span>
            </span>
          </span>
        </span>
        <span className="crow-cell crow-project" title={place}>
          {place}
        </span>
        <span className="crow-cell crow-origin">
          <span className={`badge ${chat.origin === 'agentry' ? 'is-agentry' : ''}`.trim()}>{ORIGIN_LABEL[chat.origin]}</span>
        </span>
        <span className="crow-cell crow-context">
          <ContextBar chat={chat} />
        </span>
        <span className="crow-cell crow-cost">
          <Cost usd={chat.cost.usd} />
        </span>
        <time className={`crow-time ${working ? 'is-live' : ''}`.trim()} dateTime={chat.updatedAt ?? undefined}>
          <span className="sr-only">{formatDateTime(chat.updatedAt)}</span>
          <span aria-hidden>{working ? t('common:time.now') : <Ago iso={chat.updatedAt} />}</span>
        </time>
      </Link>
    </li>
  );
});

function Facet({
  legend,
  options,
  chosen,
  onChange,
}: {
  legend: string;
  options: ReadonlyArray<{ value: string; label: string; count?: number; hint?: string }>;
  chosen: (value: string) => boolean;
  onChange: (value: string, on: boolean) => void;
}) {
  if (options.length === 0) return null;
  return (
    <fieldset className="facet">
      <legend className="facet-legend">{legend}</legend>
      {options.map((option) => (
        <Checkbox key={option.value} checked={chosen(option.value)} onChange={(on) => onChange(option.value, on)} tooltip={option.hint}>
          <span className="facet-label">{option.label}</span>
          {option.count !== undefined && <span className="facet-count">{formatNumber(option.count)}</span>}
        </Checkbox>
      ))}
    </fieldset>
  );
}

/** Deletes chats one by one with the route the chat page uses, after one confirmation for all of them. */
function useBulkDelete(onDone: () => void) {
  const { t } = useTranslation('chats');
  const confirm = useConfirm();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const run = async (chats: ChatSummary[]) => {
    const skipped = chats.flatMap((chat) => {
      const why = deleteBlocker(chat);
      return why ? [{ chat, why }] : [];
    });
    const doomed = chats.filter((chat) => !deleteBlocker(chat));
    const skippedList = skipped.length > 0 && (
      <>
        <p>{t('bulk.skipIntro', { count: skipped.length })}</p>
        <ul className="bulk-skipped">
          {skipped.map(({ chat, why }) => (
            <li key={chat.id}>
              <span className="strong break">{chat.title}</span> <span className="muted">— {t(`bulk.why.${why}`)}</span>
            </li>
          ))}
        </ul>
      </>
    );
    if (doomed.length === 0) {
      await confirm({ title: t('bulk.nothingTitle'), body: skippedList, confirmLabel: t('bulk.ok') });
      return;
    }
    const ok = await confirm({
      title: t('bulk.deleteTitle', { count: doomed.length }),
      body: (
        <>
          <p>{t('bulk.deleteBody', { count: doomed.length })}</p>
          {skippedList}
        </>
      ),
      confirmLabel: t('bulk.deleteConfirm', { count: doomed.length }),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    const failed: Array<{ chat: ChatSummary; error: unknown }> = [];
    for (const chat of doomed) {
      try {
        await api.deleteChat(chat.id);
        queryClient.removeQueries({ queryKey: keys.chatScope(chat.id) });
      } catch (error) {
        failed.push({ chat, error });
      }
    }
    setBusy(false);
    void queryClient.invalidateQueries({ queryKey: keys.chats });
    const deleted = doomed.length - failed.length;
    if (deleted > 0) {
      toast.success(
        t('bulk.deleted', { count: deleted }),
        skipped.length > 0 ? t('bulk.skippedNote', { count: skipped.length, titles: skipped.map((s) => s.chat.title).join(', ') }) : undefined,
      );
    }
    for (const { chat, error } of failed) toast.error(t('bulk.failed', { title: chat.title }), error);
    onDone();
  };

  return { run: (chats: ChatSummary[]) => void run(chats), busy };
}

/** Each chat's Markdown export, fetched by the browser as a download of its own. */
function exportMarkdown(chats: ChatSummary[]) {
  chats.forEach((chat, i) => {
    setTimeout(() => {
      const link = document.createElement('a');
      link.href = api.chatExportUrl(chat.id, 'markdown');
      link.download = '';
      document.body.append(link);
      link.click();
      link.remove();
    }, i * DOWNLOAD_GAP_MS);
  });
}

export function Chats() {
  const { t } = useTranslation(['chats', 'chat']);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  // Typing stays instant; the filtering of a few thousand rows follows when the browser has time
  const deferredSearch = useDeferredValue(search);
  const [shown, setShown] = useState(PAGE);
  // The row's id, not its position: a list re-sorted by a live update must not move the cursor to
  // another chat under the person's Enter or x
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const focusCursor = useRef(false);
  const minute = useMinute();
  const coarse = useMediaQuery(COARSE);
  const compact = useMediaQuery(COMPACT);
  // On a phone the scope is a chip in this header and the top bar leaves its own out (`pageHoldsScope`)
  const phone = useMediaQuery(NARROW);

  const state = STATES.find((s) => s === params.get('state')) ?? null;
  const sort = SORTS.find((s) => s === params.get('sort')) ?? 'activity';
  const workers = params.get('workers') === '1';
  const internal = params.get('internal') === '1';
  const originParam = params.get('origin');
  const origins = useMemo(
    () => new Set<ChatOriginFilter>(originParam ? ALL_ORIGINS.filter((o) => originParam.split(',').includes(o)) : ALL_ORIGINS),
    [originParam],
  );
  const projectsParam = params.get('projects');
  const modelsParam = params.get('models');
  const projects = useMemo(() => listParam(projectsParam), [projectsParam]);
  const models = useMemo(() => listParam(modelsParam), [modelsParam]);
  // The project chosen in the top bar, as every page it scopes reads it. A `?project=` link is what
  // the scope reads first; `loose`, the chats under no project, is a link the top bar has no entry for.
  const { projectId, settled } = useProjectScope();
  // Read for its failure only: without projects the scope never settles, and the list is read unscoped
  const projectsFailed = useProjects(false).isError;
  const linked = params.get('project');
  // A chosen project is kept even while a refresh of the projects fails, so the list never widens
  // to every project behind the person's back
  const project: string | null | undefined =
    linked === 'loose' ? null : (projectId ?? (!settled && linked && linked !== ALL_PROJECTS ? linked : undefined));
  // With one project chosen above, a project facet could only ever say that project
  const byProject = project === undefined;

  const filters: ChatFilters = useMemo(
    () => ({ origins, state, workers, internal, search: deferredSearch, ...(byProject ? { projects } : {}), models }),
    [origins, state, workers, internal, deferredSearch, byProject, projects, models],
  );
  const chats = useChats({
    ...listRequest(filters),
    ...(project !== undefined ? { project } : {}),
    // A project remembered from last time is only known once the projects are: until then the list
    // would be read for every project, then again for that one
    enabled: settled || linked !== null || projectsFailed,
  });

  const patch = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
    setShown(PAGE);
    setCursor(null);
  };

  const all = useMemo(() => chats.data ?? [], [chats.data]);
  const visible = useMemo(() => all.filter((chat) => matchesFilters(chat, filters)).sort(SORTERS[sort]), [all, filters, sort]);
  const counts = useMemo(() => stateCounts(all, filters), [all, filters]);
  const page = useMemo(() => visible.slice(0, shown), [visible, shown]);
  // The minute is a dependency so that rows move under "Yesterday" when the day turns over
  const groups = useMemo(() => (sort === 'activity' ? groupByDay(page, new Date(minute * 60_000)) : [{ group: null, chats: page }]), [sort, page, minute]);
  const noProject = t('list.noProject');
  const projectOptions: FacetOption[] = useMemo(() => (byProject ? facetOptions(all, 'project', noProject) : []), [byProject, all, noProject]);
  const modelOptions = useMemo(() => facetOptions(all, 'model'), [all]);
  // Chats picked and then hidden by a filter stay picked for when they come back, but the bar and
  // the list both speak of the ones on screen: nothing is deleted that cannot be seen
  const selectedChats = useMemo(() => visible.filter((chat) => selected.has(chat.id)), [visible, selected]);
  const selecting = selectedChats.length > 0;
  const cursorIndex = cursor === null ? null : visible.findIndex((chat) => chat.id === cursor);

  // ---------- filters said as chips ----------
  const setFacet = (key: 'projects' | 'models', held: ReadonlySet<string>, value: string, on: boolean) => {
    const next = new Set(held);
    if (on) next.add(value);
    else next.delete(value);
    patch({ [key]: next.size ? [...next].join(',') : null });
  };
  const toggleOrigin = (origin: ChatOriginFilter, on: boolean) => {
    const next = new Set(origins);
    if (on) next.add(origin);
    else next.delete(origin);
    // At least one origin stays on: an empty list explains nothing
    if (next.size === 0) return;
    patch({ origin: next.size === ALL_ORIGINS.length ? null : [...next].join(',') });
  };
  const originName = (origin: ChatOriginFilter) => (origin === 'orchestration' ? t('list.orchestrationSyntheses') : ORIGIN_LABEL[origin]);
  const labelsOf = (options: FacetOption[], held: ReadonlySet<string>) => [...held].map((v) => options.find((o) => o.value === v)?.label ?? v).join(', ');

  const chips: ListFilterChip[] = [];
  if (origins.size !== ALL_ORIGINS.length) {
    chips.push({ id: 'origin', label: t('list.chipOrigin', { values: [...origins].map(originName).join(', ') }), onRemove: () => patch({ origin: null }) });
  }
  if (byProject && projects.size > 0) {
    chips.push({ id: 'projects', label: t('list.chipProject', { values: labelsOf(projectOptions, projects) }), onRemove: () => patch({ projects: null }) });
  }
  if (models.size > 0) chips.push({ id: 'models', label: t('list.chipModel', { values: labelsOf(modelOptions, models) }), onRemove: () => patch({ models: null }) });
  if (workers) chips.push({ id: 'workers', label: t('list.workers'), onRemove: () => patch({ workers: null }) });
  if (internal) chips.push({ id: 'internal', label: t('list.internal'), onRemove: () => patch({ internal: null }) });
  const filtersActive = Boolean(search.trim()) || state !== null || chips.length > 0 || sort !== 'activity';

  const reset = () => {
    setSearch('');
    setShown(PAGE);
    setCursor(null);
    setParams(linked ? { project: linked } : {}, { replace: true });
  };

  // ---------- selection and keyboard ----------
  const toggleSelected = useCallback((id: string, on: boolean) => {
    setSelected((held) => {
      const next = new Set(held);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const clearSelection = () => setSelected(new Set());
  const bulkDelete = useBulkDelete(clearSelection);

  useEffect(() => {
    if (!focusCursor.current || cursor === null) return;
    focusCursor.current = false;
    const link = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(cursor)}"] .crow-link`);
    link?.focus({ preventScroll: true });
    link?.scrollIntoView({ block: 'nearest' });
  }, [cursor, shown]);

  useListKeys(
    visible.length > 0,
    (action, event) => {
      if (action === 'search') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('main .list-toolbar-search input')?.focus();
        return;
      }
      if (action === 'clear') {
        if (selected.size > 0) clearSelection();
        return;
      }
      if (action === 'next' || action === 'previous') {
        event.preventDefault();
        const next = stepCursor(visible.length, cursorIndex, action === 'next' ? 1 : -1);
        const target = next === null ? undefined : visible[next];
        if (next === null || !target) return;
        if (next >= shown) setShown((n) => Math.max(n + PAGE, next + 1));
        focusCursor.current = true;
        setCursor(target.id);
        return;
      }
      const chat = cursorIndex === null ? undefined : visible[cursorIndex];
      if (!chat) return;
      event.preventDefault();
      if (action === 'select') toggleSelected(chat.id, !selected.has(chat.id));
      else navigate(`/chats/${chat.id}`);
    },
    () => hasOpenLayer() || document.querySelector('[role=dialog], [role=alertdialog]') !== null,
  );

  const stateTabs = [
    { id: 'all' as const, label: t('list.stateAll'), count: counts.all, title: t('list.stateAllHint') },
    { id: 'working' as const, label: STATE_LABEL.working, count: counts.working, title: t('list.stateWorkingHint'), live: true },
    { id: 'waiting' as const, label: STATE_LABEL.waiting, count: counts.waiting, title: t('list.stateWaitingHint') },
    { id: 'idle' as const, label: STATE_LABEL.idle, count: counts.idle },
  ];

  // Nothing to count or to call empty until a list has arrived: a failed first read is its error alone
  const loading = chats.isPending && !chats.error;
  const answered = chats.data !== undefined;

  let rowIndex = 0;

  return (
    <div className="chats-page">
      <PageHeader
        docTitle={t('list.title')}
        title={
          <>
            {t('list.title')}
            {answered && <span className="chats-title-count">{formatNumber(all.length)}</span>}
          </>
        }
        subtitle={
          <span role="status">
            {answered && (
              <>
                {t('list.count', { shown: formatNumber(visible.length), total: formatNumber(all.length) })}
                {' · '}
                {t('list.summary', { count: counts.working, waiting: formatNumber(counts.waiting) })}
              </>
            )}
          </span>
        }
        actions={phone ? <ProjectSelector chip /> : undefined}
      />

      <ListToolbar
        className="chats-toolbar"
        search={{
          value: search,
          onChange: (value) => {
            setSearch(value);
            setShown(PAGE);
            setCursor(null);
          },
          placeholder: t('list.searchPlaceholder'),
          label: t('list.searchLabel'),
          shortcut: '/',
        }}
        tabs={{ value: state ?? 'all', options: stateTabs, onChange: (v) => patch({ state: v === 'all' ? null : v }), label: t('list.stateLabel') }}
        sort={{ value: sort, options: SORTS.map((value) => ({ value, label: SORT_LABEL[value] })), onChange: (v) => patch({ sort: v === 'activity' ? null : v }), label: t('list.sortLabel') }}
        filters={{
          count: chips.length,
          title: t('list.filtersTitle'),
          children: (
            <div className="facets">
              <Facet
                legend={t('list.originLabel')}
                options={ALL_ORIGINS.map((origin) => ({ value: origin, label: originName(origin) }))}
                chosen={(v) => origins.has(v as ChatOriginFilter)}
                onChange={(v, on) => toggleOrigin(v as ChatOriginFilter, on)}
              />
              <Facet legend={t('list.projectLabel')} options={projectOptions} chosen={(v) => projects.has(v)} onChange={(v, on) => setFacet('projects', projects, v, on)} />
              <Facet legend={t('list.modelLabel')} options={modelOptions} chosen={(v) => models.has(v)} onChange={(v, on) => setFacet('models', models, v, on)} />
              <Facet
                legend={t('list.includeLabel')}
                options={[
                  { value: 'workers', label: t('list.workers'), hint: t('list.workersHint') },
                  { value: 'internal', label: t('list.internal'), hint: t('list.internalHint') },
                ]}
                chosen={(v) => (v === 'workers' ? workers : internal)}
                onChange={(v, on) => patch({ [v]: on ? '1' : null })}
              />
            </div>
          ),
        }}
        chips={chips}
        onReset={reset}
        actions={
          filtersActive && chips.length === 0 && visible.length > 0 ? (
            <button type="button" className="link-btn" onClick={reset}>
              {t('list.resetFilters')}
            </button>
          ) : undefined
        }
      />

      <ErrorBox error={chats.error} />

      {loading ? (
        <Card>
          <Skeleton rows={8} height={20} />
        </Card>
      ) : !answered ? null : visible.length === 0 ? (
        filtersActive ? (
          <Card>
            <Empty
              illustration="no-results"
              size={compact ? 'sm' : 'md'}
              title={t('list.emptyFiltered')}
              action={
                <button type="button" className="btn" onClick={reset}>
                  {t('list.resetFilters')}
                </button>
              }
            >
              {t('list.emptyFilteredBody')}
            </Empty>
          </Card>
        ) : (
          // Nothing to list at all: the page is the empty state, the one place the halo goes
          <section className="card glow-top chats-empty">
            <Empty
              illustration="chats"
              size={compact ? 'md' : 'lg'}
              title={t('list.empty')}
              action={
                <>
                  <Link to="/chats/new" className="btn btn-primary">
                    <Plus {...ICON_SM} aria-hidden />
                    {t('list.newChat')}
                  </Link>
                  <Link to="/projects" className="btn">
                    {t('list.importProject')}
                  </Link>
                </>
              }
            >
              {t('list.emptyBody')}
            </Empty>
          </section>
        )
      ) : (
        <div className={`card scard crow-list ${selecting ? 'is-selecting' : ''}`} ref={listRef}>
          {/* The column heads: every cell they name also says what it is to a screen reader */}
          <div className="crow-cols" aria-hidden>
            <span />
            <span>{t('list.columns.chat')}</span>
            <span>{t('list.columns.project')}</span>
            <span>{t('list.columns.origin')}</span>
            <span>{t('list.columns.context')}</span>
            <span className="is-end">{t('list.columns.cost')}</span>
            <span className="is-end">{t('list.columns.activity')}</span>
          </div>
          {groups.map(({ group, chats: rows }) => (
            <div key={group ?? 'all'} className="crow-group">
              {group && (
                <h2 className="crow-group-head">
                  {t(`list.day.${group as DayGroup}`)}
                  <span className="crow-group-count">{formatNumber(rows.length)}</span>
                </h2>
              )}
              <ul className="list-plain">
                {rows.map((chat) => (
                  <ChatRow
                    key={chat.id}
                    chat={chat}
                    index={rowIndex++}
                    cursor={cursor === chat.id}
                    selected={selected.has(chat.id)}
                    tapSelects={selecting && coarse}
                    onSelect={toggleSelected}
                    onFocus={setCursor}
                  />
                ))}
              </ul>
            </div>
          ))}
          {visible.length > shown && (
            <div className="crow-more">
              <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>
                {t('list.showMore', { n: formatNumber(visible.length - shown) })}
              </button>
            </div>
          )}
          <p className="crow-keys small muted" aria-hidden>
            {t('list.keysHint')}
          </p>
        </div>
      )}

      {selecting && (
        <div className="toast bulk-bar" role="region" aria-label={t('bulk.region')}>
          <span className="bulk-count" role="status">
            <Check {...ICON_SM} aria-hidden /> {t('bulk.selected', { count: selectedChats.length })}
          </span>
          <button type="button" className="btn btn-small bulk-quiet" onClick={() => exportMarkdown(selectedChats)}>
            <Download {...ICON_SM} /> {t('bulk.exportMarkdown')}
          </button>
          <button type="button" className="btn btn-small bulk-quiet" onClick={clearSelection} aria-label={t('bulk.clear')}>
            {t('bulk.cancel')}
          </button>
          <button type="button" className="btn btn-small btn-danger" disabled={bulkDelete.busy} onClick={() => bulkDelete.run(selectedChats)}>
            <Trash2 {...ICON_SM} /> {bulkDelete.busy ? t('bulk.deleting') : t('bulk.delete')}
          </button>
        </div>
      )}
    </div>
  );
}
