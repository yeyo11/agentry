import type { BoardColumn, WorkItem, WorkItemStatus } from '@agentry/shared';
import { WORK_ITEM_STATUSES } from '@agentry/shared';
import { Info, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useWorkItemBoard } from '../../api';
import { ICON_SM } from '../../components/icons';
import { Card, Empty, ErrorBox, Skeleton } from '../../components/ui';
import { NARROW, useMediaQuery } from '../../lib/media';
import { boardColumns, filtersToSearch, firstKey, NEW_TASK_PARAM, openCount, taskPath, TASKS_PATH, VIEW_PARAM, viewFromSearch } from '../../lib/work-items';
import { BoardColumns, type BoardSelection } from './board/BoardColumns';
import { useLiveSources } from './board/LiveLine';
import { BoardTeamProvider, FlowButton, useBoardTeamData } from './board/team';
import { boardItems, epicProgress, notSelectable } from './board/model';
import { PhoneBoard } from './board/PhoneBoard';
import { PhoneSelectionFoot, SelectionBar, SelectionNote } from './board/SelectionBar';
import { List } from './List';
import { itemPanelSearch, WorkItemPanelHost } from './item/Panel';
import { NewTask } from './NewTask';
import { useFacets } from './toolbar/facets';
import { ActiveFilterChips, FacetChips, FilterSheetButton, SearchField } from './toolbar/Filters';
import { useScopeMilestones, useTasksScope } from './toolbar/scope';
import { NewTaskButton, PhoneTasksHeader, SelectButton, TasksHeader } from './toolbar/TasksHeader';
import { useTaskFilters } from './toolbar/useTaskFilters';

/** Keys a person may be typing into: a shortcut never fires from inside them. */
const TYPING = 'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]';

/**
 * `/tasks`: the board of the top bar's project, or of every project with a board, and the list at
 * `?view=list`. Both read one board answer (the columns in rank order), narrowed by the filters in
 * the address; the unfiltered board, which the sidebar's count already reads, gives the epics their
 * progress and the toolbar its options. On a phone there is no horizontal board: the columns are
 * sections of one list.
 */
export function Board() {
  const { t } = useTranslation('tasks');
  const phone = useMediaQuery(NARROW);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = viewFromSearch(params);
  const scope = useTasksScope();
  const filters = useTaskFilters();
  const enabled = scope.settled && !scope.boardOff;

  const full = useWorkItemBoard(scope.projectId, {}, enabled);
  const narrowed = useWorkItemBoard(scope.projectId, filters.query, enabled && filters.active);
  const answer = filters.active ? narrowed : full;
  const milestones = useScopeMilestones(scope.allProjects ? scope.boardProjects.map((p) => p.id) : scope.projectId && !scope.boardOff ? [scope.projectId] : []);

  // The previous scope's board stands in while a new one loads; its cards would belong elsewhere
  const stale = answer.isPlaceholderData && (answer.data?.projectId ?? null) !== scope.projectId;
  const columns: BoardColumn[] = useMemo(
    () => boardColumns(stale ? undefined : answer.data).map((column) => ({ ...column, items: filters.narrow(column.items) })),
    [answer.data, stale, filters],
  );
  const allItems = useMemo(() => boardItems(full.data), [full.data]);
  const shownItems = useMemo(() => columns.flatMap((column) => column.items), [columns]);
  const epics = useMemo(() => epicProgress(allItems), [allItems]);
  const live = useLiveSources(shownItems);
  // A project worked by a team: its columns' roles, the runs on its cards, and the way to its flow
  const team = useBoardTeamData(scope.allProjects || scope.boardOff ? null : scope.project);
  const facets = useFacets({ allProjects: scope.allProjects, projects: scope.boardProjects, items: allItems, milestones: milestones.milestones });

  // ---- selection, for "Orchestrate" ----
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const selectedItems = useMemo(() => picked.map((id) => shownItems.find((item) => item.id === id)).filter((item): item is WorkItem => Boolean(item)), [picked, shownItems]);
  const selectionProject = scope.projectId ?? selectedItems[0]?.projectId ?? null;
  const stopSelecting = useCallback(() => {
    setSelecting(false);
    setPicked([]);
  }, []);
  useEffect(stopSelecting, [scope.projectId, stopSelecting]);
  const selection: BoardSelection | null = selecting
    ? {
        selected: new Set(picked),
        blockedReason: (item) => notSelectable(item, picked.length ? selectionProject : null),
        toggle: (item) => setPicked((now) => (now.includes(item.id) ? now.filter((id) => id !== item.id) : [...now, item.id])),
      }
    : null;

  // ---- New task: `?new=1` (the palette, the phone's button), a column's "+", the header and N ----
  const [newIn, setNewIn] = useState<{ projectId: string | null; status?: WorkItemStatus } | null>(null);
  const linked = params.get(NEW_TASK_PARAM) === '1';
  const linkedStatus = params.get('status');
  const creating = newIn ?? (linked ? { projectId: scope.projectId, ...(isStatus(linkedStatus) ? { status: linkedStatus } : {}) } : null);
  const openNew = useCallback((projectId: string | null, status?: WorkItemStatus) => setNewIn({ projectId: projectId ?? scope.projectId, ...(status ? { status } : {}) }), [scope.projectId]);
  const closeNew = () => {
    setNewIn(null);
    if (linked)
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete(NEW_TASK_PARAM);
          next.delete('status');
          return next;
        },
        { replace: true },
      );
  };

  useEffect(() => {
    if (phone) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'n' || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement | null)?.closest(TYPING) || scope.boardOff) return;
      event.preventDefault();
      openNew(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, openNew, scope.boardOff]);

  // A desktop reads a card in the panel beside the board, so the board stays where it was; a phone has
  // no room beside it and opens the item's page
  const onOpen = (item: WorkItem) => (phone ? navigate(taskPath(item.key)) : setParams(itemPanelSearch(item.key, params)));
  const moreTo = `${TASKS_PATH}?${filtersToSearch({ ...filters.filters, status: ['done'] }, new URLSearchParams({ [VIEW_PARAM]: 'list' })).toString()}`;

  // ---- what the header says ----
  const total = allItems.length;
  const open = openCount(full.data) ?? 0;
  const empty = full.isSuccess && total === 0 && !scope.allProjects;
  const withBoard = new Set(allItems.map((item) => item.projectId));
  const quiet = scope.boardProjects.filter((p) => !withBoard.has(p.id)).map((p) => p.name);
  const figures = scope.allProjects
    ? `${t('header.open', { count: open })} ${t('header.inProjects', { count: withBoard.size })}`
    : filters.active
      ? t('header.filtered', { shown: shownItems.length, total })
      : empty
        ? t('header.tasks', { count: 0 })
        : t('header.open', { count: open });
  const subtitle = (
    <>
      {scope.project?.name ?? t('header.allProjects')} · {figures}
      {scope.project && (
        <>
          {' · '}
          {t('header.key')} <span className="mono">{scope.project.key}</span>
        </>
      )}
    </>
  );
  const pickProjects = scope.allProjects ? scope.boardProjects.map((p) => ({ id: p.id, name: p.name })) : undefined;
  const newTask = <NewTaskButton primary={!selecting && !empty && !scope.allProjects} projects={pickProjects} onNew={(projectId) => openNew(projectId)} />;
  const canSelect = !empty && !scope.boardOff && total > 0;

  // ---- the body ----
  let body;
  if (scope.boardOff && scope.project) {
    body = (
      <section className="card glow-top workitem-empty">
        <Empty
          illustration="board"
          illustrationText={firstKey(scope.project)}
          size={phone ? 'md' : 'lg'}
          title={t('empty.offTitle')}
          action={
            <Link to="/projects" className="btn">
              {t('empty.offAction')}
            </Link>
          }
        >
          {t('empty.offBody', { project: scope.project.name })}
        </Empty>
      </section>
    );
  } else if (scope.allProjects && scope.settled && scope.boardProjects.length === 0) {
    body = (
      <section className="card glow-top workitem-empty">
        <Empty
          illustration="board"
          size={phone ? 'md' : 'lg'}
          title={t('empty.noneTitle')}
          action={
            <Link to="/projects" className="btn btn-primary">
              {t('empty.noneAction')}
            </Link>
          }
        >
          {t('empty.noneBody')}
        </Empty>
      </section>
    );
  } else if (answer.error && !answer.data) {
    body = <ErrorBox error={answer.error} />;
  } else if (!answer.data || stale) {
    body = (
      <Card>
        <Skeleton rows={8} height={20} />
      </Card>
    );
  } else if (empty) {
    body = (
      <section className="card glow-top workitem-empty">
        <Empty
          illustration="board"
          illustrationText={firstKey(scope.project)}
          size={phone ? 'md' : 'lg'}
          title={t('empty.title')}
          action={
            <button type="button" className="btn btn-primary workitem-empty-new" onClick={() => openNew(null)}>
              <Plus {...ICON_SM} />
              {t('empty.action')}
            </button>
          }
        >
          {t('empty.body', { project: scope.project?.name ?? '' })}
        </Empty>
        {!phone && (
          <p className="workitem-empty-hint">
            <kbd className="palette-kbd">N</kbd> {t('empty.hint')}
          </p>
        )}
      </section>
    );
  } else if (filters.active && shownItems.length === 0) {
    body = (
      <Card>
        <Empty
          illustration="no-results"
          size={phone ? 'sm' : 'md'}
          title={t('empty.filteredTitle')}
          action={
            <button type="button" className="btn" onClick={filters.clear}>
              {t('toolbar.reset')}
            </button>
          }
        >
          {t('empty.filteredBody')}
        </Empty>
      </Card>
    );
  } else if (view === 'list') {
    body = <List columns={columns} projectNames={scope.allProjects ? scope.projectNames : undefined} live={live} selection={selection} phone={phone} onOpen={onOpen} />;
  } else if (phone) {
    body = <PhoneBoard columns={columns} projectNames={scope.allProjects ? scope.projectNames : undefined} epics={epics} live={live} selection={selection} moreTo={moreTo} />;
  } else {
    body = (
      <BoardColumns
        columns={columns}
        projectNames={scope.allProjects ? scope.projectNames : undefined}
        epics={epics}
        live={live}
        selection={selection}
        moreTo={moreTo}
        onOpen={onOpen}
        onNewTask={scope.allProjects ? undefined : (status) => openNew(null, status)}
      />
    );
  }

  const allNote = scope.allProjects && total > 0 && (
    <p className="workitem-all-note">
      <Info size={13} strokeWidth={1.75} aria-hidden />
      <span>
        {t('all.note')}
        {quiet.length > 0 && ` ${t('all.noTasks', { count: quiet.length, names: quiet.join(', ') })}`}
      </span>
    </p>
  );
  const boardShown = view === 'board' && !phone && Boolean(answer.data) && !stale && !empty && shownItems.length > 0;

  return (
    <div className={`tasks-page ${boardShown ? 'is-board' : ''} ${selecting ? 'is-selecting' : ''}`.replace(/\s+/g, ' ').trim()}>
      {phone ? (
        <>
          <PhoneTasksHeader
            view={view}
            action={canSelect && view === 'board' ? <SelectButton icon on={selecting} onChange={(on) => (on ? setSelecting(true) : stopSelecting())} /> : undefined}
            selecting={selecting ? { count: picked.length, project: scope.project?.name ?? t('header.allProjects'), onClose: stopSelecting } : undefined}
          />
          {!selecting && !scope.boardOff && !empty && (
            <>
              <div className="workitem-mtools">
                <SearchField state={filters} short />
                <FilterSheetButton facets={facets} state={filters} shown={shownItems.length} />
              </div>
              <ActiveFilterChips facets={facets} state={filters} summary={filters.active ? t('header.shownOf', { shown: shownItems.length, total }) : undefined} />
              {scope.allProjects && total > 0 && (
                <div className="card workitem-all-card">
                  <Info size={16} strokeWidth={1.75} aria-hidden />
                  <span>
                    {`${t('header.open', { count: open })} ${t('header.inProjectsShort', { count: withBoard.size })}. ${t('all.noLimits')}`}
                  </span>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <TasksHeader
            view={view}
            subtitle={subtitle}
            actions={
              <>
                {team && scope.project && <FlowButton team={team} projectId={scope.project.id} />}
                {canSelect && <SelectButton on={selecting} onChange={(on) => (on ? setSelecting(true) : stopSelecting())} />}
                {!scope.boardOff && newTask}
              </>
            }
          />
          {!scope.boardOff && !empty && (
            <div className="workitem-toolbar">
              <SearchField state={filters} />
              <FacetChips facets={facets} state={filters} />
            </div>
          )}
          {allNote}
        </>
      )}

      <BoardTeamProvider value={team}>{body}</BoardTeamProvider>

      {selecting && phone && <SelectionNote selected={selectedItems} />}
      {selecting && (phone ? <PhoneSelectionFoot projectId={selectionProject} selected={selectedItems} /> : <SelectionBar projectId={selectionProject} selected={selectedItems} onCancel={stopSelecting} />)}

      <WorkItemPanelHost />

      {creating && (
        <NewTask
          projectId={creating.projectId}
          {...(creating.status ? { status: creating.status } : {})}
          onClose={closeNew}
          onCreated={() => closeNew()}
        />
      )}
    </div>
  );
}

const isStatus = (value: string | null): value is WorkItemStatus => (WORK_ITEM_STATUSES as readonly string[]).includes(value ?? '');
