import type { ChatOrigin, ChatState, ChatSummary } from '@agentry/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CheckSquare, Cog, Download, GitBranch, GitFork, Lock, MessageSquare, Network, Play, Terminal, Trash2, X, Zap, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, keys, useChats } from '../api';
import { ActivityTicker } from '../components/ActivityTicker';
import { ContextRing } from '../components/ContextRing';
import { Checkbox, hasOpenLayer } from '../components/controls';
import { useConfirm } from '../components/Dialog';
import { ICON_SM } from '../components/icons';
import { ListToolbar, type ListFilterChip } from '../components/ListToolbar';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { Card, Empty, ErrorBox, PageHeader, Skeleton } from '../components/ui';
import {
  ALL_ORIGINS,
  deleteBlocker,
  facetOptions,
  formatUsd,
  groupByDay,
  lastEnded,
  matchesFilters,
  originsToFetch,
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

const ORIGIN_ICON: Record<ChatOrigin, LucideIcon> = { agentry: Play, external: Terminal, orchestration: Network, internal: Cog };
const TAG_ICON: Record<RowTag, LucideIcon> = { interactive: Zap, readOnly: Lock, fork: GitFork, worktree: GitBranch };

/** A URL list parameter as a set; absent is empty, which every facet reads as "all". */
const listParam = (value: string | null): Set<string> => new Set(value ? value.split(',').filter(Boolean) : []);

/** Where the chat came from, with the orchestration named when it works for one. */
function originLabel(chat: ChatSummary): string {
  if (chat.origin !== 'orchestration' || !chat.orchestration) return ORIGIN_LABEL[chat.origin];
  return `${chat.orchestration.name} · ${chat.orchestration.taskName ?? i18n.t('chats:list.synthesis')}`;
}

/** The word next to the dot: the state, or how the last execution ended when that went wrong. */
function StateMark({ chat }: { chat: ChatSummary }) {
  const { t } = useTranslation('chats');
  const ended = chat.state === 'idle' && !chat.execution ? lastEnded(chat) : null;
  const bad = ended?.outcome && ended.outcome !== 'completed' ? ended.outcome : null;
  const tone = chat.state === 'working' ? 'live' : chat.state === 'waiting' ? 'warn' : bad ? 'bad' : 'idle';
  return (
    <span className={`crow-state is-${tone}`}>
      {chat.state === 'working' ? <Spinner className="crow-spinner" /> : <span className="crow-dot" aria-hidden />}
      {/* Idle is what most rows are: said to a screen reader, not printed on every line */}
      <span className={chat.state === 'idle' && !bad ? 'sr-only' : 'crow-state-word'}>{bad ? t(`list.outcome.${bad}`) : STATE_LABEL[chat.state]}</span>
    </span>
  );
}

function ChatRow({
  chat,
  index,
  cursor,
  selected,
  onSelect,
  onFocus,
}: {
  chat: ChatSummary;
  index: number;
  cursor: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onFocus: () => void;
}) {
  const { t } = useTranslation(['chats', 'chat']);
  const firstLine = chat.firstPrompt?.split('\n')[0]?.trim() ?? '';
  const prompt = firstLine && firstLine.slice(0, 100) !== chat.title ? firstLine : null;
  const OriginIcon = ORIGIN_ICON[chat.origin];
  const live = chat.state === 'working' && chat.activity;
  const place = chat.origin === 'orchestration' && chat.orchestration ? originLabel(chat) : (chat.project?.name ?? t('list.noProject'));
  return (
    <li
      className={`crow is-${chat.state} ${chat.state === 'working' ? 'live-rail' : ''} ${cursor ? 'is-cursor' : ''} ${selected ? 'is-selected' : ''}`}
      data-row={index}
    >
      <span className="crow-select">
        <Checkbox checked={selected} onChange={onSelect} aria-label={t('list.selectChat', { title: chat.title })} />
      </span>
      <Link to={`/chats/${chat.id}`} className="crow-link" onFocus={onFocus}>
        <span className="crow-main">
          <span className="crow-line">
            <StateMark chat={chat} />
            <span className="crow-title-text">{chat.title}</span>
          </span>
          <span className="crow-line crow-sub">
            {live ? (
              <ActivityTicker activity={chat.activity} className="crow-ticker" />
            ) : (
              prompt && <span className="crow-prompt">{prompt}</span>
            )}
            <span className="crow-place">
              <OriginIcon size={11} strokeWidth={2} aria-hidden />
              {chat.origin !== 'orchestration' && <span className="sr-only">{ORIGIN_LABEL[chat.origin]}</span>}
              <span className="crow-place-name">{place}</span>
            </span>
            {rowTags(chat).map((tag) => {
              const Icon = TAG_ICON[tag];
              return (
                <span key={tag} className={`crow-tag is-${tag}`}>
                  <Icon size={11} strokeWidth={2} aria-hidden />
                  {tag === 'worktree' ? (chat.worktree?.branch ?? chat.worktree?.name ?? t('list.worktree')) : tag === 'fork' ? t('list.fork') : t(`list.tag.${tag}`)}
                </span>
              );
            })}
            {/* What the chat itself says in full, here only for whoever points at the row */}
            <span className="crow-extra">
              {chat.model && <span className="mono">{chat.model}</span>}
              {chat.worktree?.branch && !rowTags(chat).includes('worktree') && <span className="mono">{chat.worktree.branch}</span>}
              <span>{t('list.messages', { n: formatNumber(chat.messageCount) })}</span>
            </span>
          </span>
        </span>
        <span className="crow-side">
          <time className="crow-time" dateTime={chat.updatedAt ?? undefined}>
            <span className="sr-only">{formatDateTime(chat.updatedAt)}</span>
            <span aria-hidden>{timeAgo(chat.updatedAt)}</span>
          </time>
          <span className="crow-numbers">
            <ContextRing chat={chat} />
            <span className="crow-cost">
              {chat.cost.usd === null ? (
                <>
                  <span aria-hidden>—</span>
                  <span className="sr-only">{t('list.cost', { cost: formatUsd(null) })}</span>
                </>
              ) : (
                formatUsd(chat.cost.usd)
              )}
            </span>
          </span>
        </span>
      </Link>
    </li>
  );
}

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
  const [shown, setShown] = useState(PAGE);
  const [cursor, setCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const focusCursor = useRef(false);

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
  // The project chosen in the top bar; `loose` is the chats under no project
  const scope = params.get('project');
  const project = scope === null ? undefined : scope === 'loose' ? null : scope;
  // With one project chosen above, a project facet could only ever say that project
  const byProject = project === undefined;

  const filters: ChatFilters = useMemo(
    () => ({ origins, state, workers, internal, search, ...(byProject ? { projects } : {}), models }),
    [origins, state, workers, internal, search, byProject, projects, models],
  );
  const chats = useChats({ origin: originsToFetch(filters), ...(project !== undefined ? { project } : {}) });

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
  const counts = stateCounts(all, filters);
  const page = visible.slice(0, shown);
  const groups = sort === 'activity' ? groupByDay(page) : [{ group: null, chats: page }];
  const projectOptions: FacetOption[] = byProject ? facetOptions(all, 'project', t('list.noProject')) : [];
  const modelOptions = facetOptions(all, 'model');
  const selectedChats = visible.filter((chat) => selected.has(chat.id));

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
    setParams(scope ? { project: scope } : {}, { replace: true });
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
    const link = listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"] .crow-link`);
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
        const next = stepCursor(visible.length, cursor, action === 'next' ? 1 : -1);
        if (next === null) return;
        if (next >= shown) setShown((n) => Math.max(n + PAGE, next + 1));
        focusCursor.current = true;
        setCursor(next);
        return;
      }
      const chat = cursor === null ? undefined : visible[cursor];
      if (!chat) return;
      event.preventDefault();
      if (action === 'select') toggleSelected(chat.id, !selected.has(chat.id));
      else navigate(`/chats/${chat.id}`);
    },
    () => hasOpenLayer() || document.querySelector('[role=dialog], [role=alertdialog]') !== null,
  );

  const stateTabs = [
    { id: 'all' as const, label: t('list.stateAll'), count: counts.all, title: t('list.stateAllHint') },
    { id: 'working' as const, label: STATE_LABEL.working, count: counts.working, title: t('list.stateWorkingHint') },
    { id: 'waiting' as const, label: STATE_LABEL.waiting, count: counts.waiting, title: t('list.stateWaitingHint') },
    { id: 'idle' as const, label: STATE_LABEL.idle, count: counts.idle },
  ];

  let rowIndex = 0;

  return (
    <>
      <PageHeader
        title={t('list.title')}
        subtitle={
          <span role="status">
            {t('list.count', { shown: formatNumber(visible.length), total: formatNumber(all.length) })}
          </span>
        }
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
          filtersActive && chips.length === 0 ? (
            <button type="button" className="link-btn" onClick={reset}>
              {t('list.resetFilters')}
            </button>
          ) : undefined
        }
      />

      <ErrorBox error={chats.error} />

      {chats.isLoading ? (
        <Card>
          <Skeleton rows={8} height={20} />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <Empty
            icon={MessageSquare}
            title={filtersActive ? t('list.emptyFiltered') : t('list.empty')}
            action={
              !filtersActive && (
                <Link to="/chats/new" className="btn btn-primary">
                  {t('list.newChat')}
                </Link>
              )
            }
          >
            {filtersActive ? t('list.emptyFilteredBody') : t('list.emptyBody')}
          </Empty>
        </Card>
      ) : (
        <div className={`scard crow-list ${selected.size > 0 ? 'is-selecting' : ''}`} ref={listRef}>
          {groups.map(({ group, chats: rows }) => (
            <div key={group ?? 'all'} className="crow-group">
              {group && (
                <h2 className="crow-group-head">
                  {t(`list.day.${group as DayGroup}`)}
                  <span className="crow-group-count">{formatNumber(rows.length)}</span>
                </h2>
              )}
              <ul className="list-plain">
                {rows.map((chat) => {
                  const index = rowIndex++;
                  return (
                    <ChatRow
                      key={chat.id}
                      chat={chat}
                      index={index}
                      cursor={cursor === index}
                      selected={selected.has(chat.id)}
                      onSelect={(on) => toggleSelected(chat.id, on)}
                      onFocus={() => setCursor(index)}
                    />
                  );
                })}
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

      {selectedChats.length > 0 && (
        <div className="bulk-bar" role="region" aria-label={t('bulk.region')}>
          <span className="bulk-count" role="status">
            <CheckSquare {...ICON_SM} aria-hidden /> {t('bulk.selected', { count: selectedChats.length })}
          </span>
          <button type="button" className="btn btn-small" onClick={() => exportMarkdown(selectedChats)}>
            <Download {...ICON_SM} /> {t('bulk.exportMarkdown')}
          </button>
          <button type="button" className="btn btn-small btn-danger" disabled={bulkDelete.busy} onClick={() => bulkDelete.run(selectedChats)}>
            <Trash2 {...ICON_SM} /> {bulkDelete.busy ? t('bulk.deleting') : t('bulk.delete')}
          </button>
          <button type="button" className="icon-btn" onClick={clearSelection} aria-label={t('bulk.clear')}>
            <X {...ICON_SM} />
          </button>
        </div>
      )}
    </>
  );
}
