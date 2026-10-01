import type { BoardColumn, WorkItem, WorkItemStatus } from '@agentry/shared';
import { WORK_ITEM_STATUSES } from '@agentry/shared';
import { Folder, Info } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useWorkItemBoard, useWorkItemPages } from '../../api';
import { FabStandIn } from '../../components/shell/Fab';
import { Card, ErrorBox, Skeleton } from '@agentry/ui/components/ui';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { DirtyScope } from '../../lib/dirty';
import {
  boardColumns,
  NEW_TASK_PARAM,
  openCount,
  returnState,
  staleFilters,
  taskPath,
  viewFromSearch,
} from '../../lib/work-items';
import { BoardColumns, type BoardSelection } from './board/BoardColumns';
import { BoardOff, EmptyBoard, NoBoards, NothingFiltered } from './board/EmptyBoards';
import { useLiveSources } from './board/LiveLine';
import { BoardReadinessProvider, CheckoutLine } from './board/PullRequest';
import { BoardTeamProvider, FlowButton, PhoneFlowRow, useBoardTeamData } from './board/team';
import { boardItems, boardTotal, DONE_SHOWN, doneLimitFor, holdsPart, NO_MILESTONE, nextDoneShown, notSelectable } from './board/model';
import { useEpicProgress } from './board/useEpicProgress';
import { PhoneBoard } from './board/PhoneBoard';
import { PhoneSelectionFoot, SelectionBar, SelectionNote } from './board/SelectionBar';
import { List } from './List';
import { itemPanelSearch, WorkItemPanelHost } from './item/Panel';
import { NewTask } from './NewTask';
import { useFacets } from './toolbar/facets';
import { ActiveFilterChips, FacetChips, FilterSheetButton, SearchField } from './toolbar/Filters';
import { useScopeMilestones, useTasksScope } from './toolbar/scope';
import { NewTaskButton, PhoneTasksHeader, SelectButton, SuggestButton, TasksHeader } from './toolbar/TasksHeader';
import { SUGGEST_PARAM } from './suggest/model';
import { SuggestTasks } from './suggest/SuggestTasks';
import { useTaskFilters } from './toolbar/useTaskFilters';

/** Keys a person may be typing into: a shortcut never fires from inside them. */
const TYPING = 'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]';

/**
 * `/tasks`: the board of the top bar's project, or of every project with a board, and the list at
 * `?view=list`. Both read one board answer (the columns in rank order, Done newest first), narrowed by the filters in
 * the address; the unfiltered board, which the sidebar's count already reads, gives the epics their
 * progress and the toolbar its options. On a phone there is no horizontal board: the columns are
 * sections of one list.
 */
export function Board() {
  // The item panel edits a description in place; closing the panel or leaving asks before losing it
  return (
    <DirtyScope>
      <TasksBoard />
    </DirtyScope>
  );
}

function TasksBoard() {
  const { t } = useTranslation('tasks');
  const phone = useMediaQuery(NARROW);
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const view = viewFromSearch(params);
  const scope = useTasksScope();
  const filters = useTaskFilters();
  const enabled = scope.settled && !scope.boardOff;

  // Done draws its first few cards, and each "and N more" the next page of them, asked of the server
  // once the board's own page runs out; a new scope starts folded again
  const [doneShown, setDoneShown] = useState(DONE_SHOWN);
  useEffect(() => setDoneShown(DONE_SHOWN), [scope.projectId]);
  const doneLimit = doneLimitFor(doneShown);
  const full = useWorkItemBoard(scope.projectId, {}, enabled, filters.active ? undefined : doneLimit);
  const narrowed = useWorkItemBoard(scope.projectId, filters.query, enabled && filters.active, doneLimit);
  const answer = filters.active ? narrowed : full;
  // The list reads its rows a page at a time, and the board above only for its columns' figures
  const pages = useWorkItemPages(scope.projectId, filters.query, enabled && view === 'list');
  const milestones = useScopeMilestones(scope.allProjects ? scope.boardProjects.map((p) => p.id) : scope.projectId && !scope.boardOff ? [scope.projectId] : []);

  // The previous scope's board stands in while a new one loads; its cards would belong elsewhere
  const stale = answer.isPlaceholderData && (answer.data?.projectId ?? null) !== scope.projectId;
  const columns: BoardColumn[] = useMemo(
    () => boardColumns(stale ? undefined : answer.data).map((column) => ({ ...column, items: filters.narrow(column.items) })),
    [answer.data, stale, filters],
  );
  const allItems = useMemo(() => boardItems(full.data), [full.data]);
  const shownItems = useMemo(() => columns.flatMap((column) => column.items), [columns]);
  const epics = useEpicProgress(full.data, allItems);
  const live = useLiveSources(shownItems);
  // A project worked by a team: its columns' roles, the runs on its cards, and the way to its flow
  const team = useBoardTeamData(scope.allProjects || scope.boardOff ? null : scope.project);
  const facets = useFacets({ allProjects: scope.allProjects, projects: scope.boardProjects, items: allItems, milestones: milestones.milestones });

  // An epic or a milestone the scope does not have (another project's, or deleted) has no chip to
  // take it off and leaves "0 of N": once the scope's own are known, it goes from the address. It
  // is judged only on fresh lists: one just created may not be in a cached answer yet. A board whose
  // Done column leaves items out may leave a closed epic out with them, so it judges no epic
  const epicsKnown = full.isSuccess && !full.isPlaceholderData && !full.isFetching && !holdsPart(full.data);
  const knownEpics = useMemo(() => (epicsKnown ? new Set(allItems.filter((item) => item.type === 'epic').map((item) => item.id)) : null), [epicsKnown, allItems]);
  const milestonesKnown = !milestones.loading && !milestones.fetching;
  const knownMilestones = useMemo(() => (milestonesKnown ? new Set(milestones.milestones.map((m) => m.id)) : null), [milestonesKnown, milestones.milestones]);
  const stray = staleFilters(filters.filters, { allProjects: scope.allProjects, epics: knownEpics, milestones: knownMilestones, noMilestone: NO_MILESTONE }).join(',');
  const { set: setFilters } = filters;
  useEffect(() => {
    if (stray) setFilters(Object.fromEntries(stray.split(',').map((field) => [field, undefined])));
  }, [stray, setFilters]);

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

  // Once the form closes, focus goes to the new card or row rather than back to the button: the
  // next thing to do with a new task is usually to open or move it
  const [created, setCreated] = useState<string | null>(null);
  const formOpen = creating !== null;
  useEffect(() => {
    if (!created || formOpen) return;
    const target = document.querySelector<HTMLElement>(`.tasks-page [data-item-id="${CSS.escape(created)}"]`);
    if (target) {
      const focusable = target.matches('[tabindex], a, button') ? target : target.querySelector<HTMLElement>('a, button');
      focusable?.focus();
      focusable?.scrollIntoView({ block: 'nearest' });
      setCreated(null);
    } else if (allItems.some((item) => item.id === created)) {
      // On the board but not in view (a filter hides it, or Done shows only its first few)
      setCreated(null);
    }
  }, [created, formOpen, shownItems, allItems]);

  // ---- Suggest tasks: `?suggest=1`, so the palette and a link reach it and a reload keeps it open ----
  const suggesting = params.get(SUGGEST_PARAM) === '1' && Boolean(scope.project) && !scope.boardOff;
  const setSuggesting = (on: boolean) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (on) next.set(SUGGEST_PARAM, '1');
        else next.delete(SUGGEST_PARAM);
        return next;
      },
      { replace: !on },
    );

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
  const here = `${location.pathname}${location.search}`;
  const onOpen = (item: WorkItem) => (phone ? navigate(taskPath(item.key), { state: returnState(here) }) : setParams(itemPanelSearch(item.key, params)));
  const moreDone = () => setDoneShown(nextDoneShown);
  // "Mostrar N más" asked the server for the next page of Done: its skeletons stand in until it lands
  const doneHeld = columns.find((column) => column.status === 'done')?.items.length ?? 0;
  const doneLoading = answer.isFetching && doneShown > doneHeld;

  // ---- what the header says ----
  // What Done leaves out counts too: the header speaks of the whole board
  const total = boardTotal(full.data);
  const shownTotal = boardTotal({ columns });
  const open = openCount(full.data) ?? 0;
  const empty = full.isSuccess && total === 0 && !scope.allProjects;
  const withBoard = new Set(allItems.map((item) => item.projectId));
  const quiet = scope.boardProjects.filter((p) => !withBoard.has(p.id)).map((p) => p.name);
  const figures = scope.allProjects
    ? `${t('header.open', { count: open })} ${t('header.inProjects', { count: withBoard.size })}`
    : filters.active
      ? t('header.filtered', { shown: shownTotal, total })
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
    body = <BoardOff project={scope.project} phone={phone} />;
  } else if (scope.allProjects && scope.settled && scope.boardProjects.length === 0) {
    body = <NoBoards phone={phone} />;
  } else if (answer.error && !answer.data) {
    body = <ErrorBox error={answer.error} />;
  } else if (!answer.data || stale) {
    body = (
      <Card>
        <Skeleton rows={8} height={20} />
      </Card>
    );
  } else if (empty) {
    body = <EmptyBoard project={scope.project} phone={phone} onNew={() => openNew(null)} />;
  } else if (filters.active && shownTotal === 0) {
    body = <NothingFiltered phone={phone} onReset={filters.clear} />;
  } else if (view === 'list') {
    body = (
      <List
        columns={columns}
        pages={pages}
        narrow={filters.narrow}
        projectNames={scope.allProjects ? scope.projectNames : undefined}
        live={live}
        selection={selection}
        phone={phone}
        onOpen={onOpen}
      />
    );
  } else if (phone) {
    body = (
      <PhoneBoard
        columns={columns}
        projectNames={scope.allProjects ? scope.projectNames : undefined}
        epics={epics}
        live={live}
        selection={selection}
        doneShown={doneShown}
        doneLoading={doneLoading}
        onMoreDone={moreDone}
      />
    );
  } else {
    body = (
      <BoardColumns
        columns={columns}
        projectNames={scope.allProjects ? scope.projectNames : undefined}
        epics={epics}
        live={live}
        selection={selection}
        doneShown={doneShown}
        doneLoading={doneLoading}
        onMoreDone={moreDone}
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
  // A project's board says whether approving opens a pull request, and how far its checkout is
  // behind the default branch; All projects says neither
  const projectBoard = !scope.allProjects && full.data?.projectId === scope.projectId ? full.data : undefined;
  const readiness = projectBoard?.pullRequestReadiness ?? null;
  const checkout = <CheckoutLine checkout={projectBoard?.checkout} />;
  const boardShown = view === 'board' && !phone && Boolean(answer.data) && !stale && !empty && shownTotal > 0;

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
                <FilterSheetButton facets={facets} state={filters} shown={shownTotal} />
              </div>
              <ActiveFilterChips facets={facets} state={filters} summary={filters.active ? t('header.shownOf', { shown: shownTotal, total }) : undefined} />
              {checkout}
              {team && scope.project && view === 'board' && <PhoneFlowRow team={team} projectId={scope.project.id} />}
              {scope.allProjects && total > 0 && (
                <div className="card workitem-all-card">
                  <Folder size={16} strokeWidth={1.75} aria-hidden />
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
            lead={team && scope.project ? <FlowButton team={team} projectId={scope.project.id} /> : undefined}
            actions={
              <>
                {canSelect && <SelectButton on={selecting} onChange={(on) => (on ? setSelecting(true) : stopSelecting())} />}
                {/* Beside the flow's button the row is full (DesktopTableroEquipo): Suggest keeps its sparkle and its name as a tooltip */}
                {scope.project && !scope.boardOff && <SuggestButton icon={Boolean(team)} onClick={() => setSuggesting(true)} />}
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
          {!scope.boardOff && checkout}
          {allNote}
        </>
      )}

      <BoardReadinessProvider value={readiness}>
        <BoardTeamProvider value={team}>{body}</BoardTeamProvider>
      </BoardReadinessProvider>

      {selecting && phone && <SelectionNote selected={selectedItems} />}
      {selecting && (phone ? <PhoneSelectionFoot projectId={selectionProject} selected={selectedItems} /> : <SelectionBar projectId={selectionProject} selected={selectedItems} onCancel={stopSelecting} />)}

      <WorkItemPanelHost />

      {suggesting && scope.project && <SuggestTasks project={scope.project} onClose={() => setSuggesting(false)} />}

      {/* The form is open: a button to open it again would float over it */}
      {creating && <FabStandIn />}
      {/* The form closes itself, or stays open for the next one with "Create another" */}
      {creating && (
        <NewTask
          projectId={creating.projectId}
          {...(creating.status ? { status: creating.status } : {})}
          onClose={closeNew}
          onCreated={(item) => setCreated(item.id)}
        />
      )}
    </div>
  );
}

const isStatus = (value: string | null): value is WorkItemStatus => (WORK_ITEM_STATUSES as readonly string[]).includes(value ?? '');
