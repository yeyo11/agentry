/**
 * The pure model of the Tasks screens: the board, the list, the milestones and a work item's page
 * all read their columns, marks, filters and live state from here, so the five columns are drawn in
 * one order, a filter reads the same from the address on every view, and "live" means one thing.
 * No React and no fetching: everything here is tested without a browser (test/work-items.test.ts).
 *
 * Label keys are in the `tasks` namespace: `t(column.label)` with `useTranslation('tasks')`, or
 * `t(\`tasks:${column.label}\`)` from a page that loads it beside its own.
 */
import {
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
  parseWorkItemKey,
  type Board,
  type BoardColumn,
  type Project,
  type WorkItem,
  type WorkItemFilter,
  type WorkItemPriority,
  type WorkItemStatus,
  type WorkItemType,
} from '@agentry/shared';

// ---------- where things are ----------

export const TASKS_PATH = '/tasks';
export const MILESTONES_PATH = '/tasks/milestones';
/** The wizard that creates or imports a project (web-projects) */
export const NEW_PROJECT_PATH = '/projects/new';
/**
 * `?new=1` on Tasks opens the New task form (a dialog on a desktop, a full screen on a phone); the
 * command palette and the phone's FAB lead here. `?new=1&status=todo` preselects its column.
 */
export const NEW_TASK_PARAM = 'new';
export const NEW_TASK_PATH = `${TASKS_PATH}?${NEW_TASK_PARAM}=1`;

/**
 * The key the empty board's illustration draws on its card: the project's own first one (`SHOP-1`),
 * so the drawing shows what the first task will be called. Undefined keeps the catalogue's `AGN-1`.
 */
export function firstKey(project: Pick<Project, 'key'> | null | undefined): string | undefined {
  return project?.key ? `${project.key}-1` : undefined;
}

/** A work item's page, by its key: `/tasks/AGN-12`. */
export function taskPath(key: string): string {
  return `${TASKS_PATH}/${encodeURIComponent(key)}`;
}

/**
 * The key as the API composes it (`AGN-12`), from whatever case it was typed or linked in; null for
 * anything that is not a key, which the page answers with its not-found state.
 */
export function normalizeKey(key: string): string | null {
  const parsed = parseWorkItemKey(key.trim());
  return parsed ? `${parsed.prefix}-${parsed.number}` : null;
}

/**
 * The key an open item goes by now, when it is no longer the one in the address: its project's
 * prefix changed while it was open. Null while the address still names it.
 */
export function renamedKey(wanted: string, current: string | null | undefined): string | null {
  if (!current) return null;
  return (normalizeKey(wanted) ?? wanted.toUpperCase()) === current.toUpperCase() ? null : current;
}

/**
 * The item an address goes on showing when its key changes: the same one, when the new key is the
 * one it goes by now (the address followed a new prefix), so its page is not dropped to a skeleton
 * and back, taking an edit in progress with it. Any other key starts over.
 */
export function followedItem(found: { key: string; id: string } | null, itemKey: string, shownKey: string | null | undefined): { key: string; id: string } | null {
  if (!found) return null;
  if (found.key === itemKey) return found;
  return shownKey && renamedKey(itemKey, shownKey) === null ? { key: itemKey, id: found.id } : null;
}

/**
 * Where an item's page goes back to, and where it lands after a delete: the board or list it was
 * opened from (with its view, filters and project tab, as `location.state.from` carries them), or
 * Tasks. Only a path of this app is taken, never an address from elsewhere.
 */
export const RETURN_STATE = 'from';

export function returnPath(state: unknown): string {
  const from = typeof state === 'object' && state !== null ? (state as Record<string, unknown>)[RETURN_STATE] : undefined;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : TASKS_PATH;
}

/** The router state that brings an item's page back to `from` (a path with its query). */
export function returnState(from: string): Record<string, string> {
  return { [RETURN_STATE]: from };
}

/**
 * The project New task files into without asking: the one given, as long as it has a board. The
 * palette and the FAB open the form on the top bar's project; when its Board is off the form asks
 * for one that has a board instead of standing there with nothing to pick and Create disabled.
 * Undefined while the projects are not known yet.
 */
export function newTaskProject(projectId: string | null, boards: ReadonlyArray<Pick<Project, 'id'>>, loaded: boolean): string | null | undefined {
  if (projectId === null) return null;
  if (boards.some((p) => p.id === projectId)) return projectId;
  return loaded ? null : undefined;
}

// ---------- columns, types and priorities ----------

export interface ColumnMeta {
  status: WorkItemStatus;
  /** `tasks` namespace */
  label: `status.${WorkItemStatus}`;
  /** Only done is told by colour as well as shape (ok), and always with its word */
  tone: 'ok' | null;
}

/** The five columns, left to right. Fixed: never filtered out of a board, never reordered. */
export const WORK_ITEM_COLUMNS: readonly ColumnMeta[] = WORK_ITEM_STATUSES.map((status) => ({
  status,
  label: `status.${status}` as const,
  tone: status === 'done' ? 'ok' : null,
}));

export const columnMeta = (status: WorkItemStatus): ColumnMeta =>
  WORK_ITEM_COLUMNS.find((column) => column.status === status) ?? { status, label: `status.${status}`, tone: null };

/** Open is every column but Done: what the sidebar counts and a milestone has left to do. */
export const isOpen = (status: WorkItemStatus): boolean => status !== 'done';

export interface TypeMeta {
  type: WorkItemType;
  /** `tasks` namespace */
  label: `type.${WorkItemType}`;
}

/** In the order a form offers them; every type is drawn neutral, told apart by shape. */
export const WORK_ITEM_TYPE_META: readonly TypeMeta[] = WORK_ITEM_TYPES.map((type) => ({ type, label: `type.${type}` as const }));

export interface PriorityMeta {
  priority: WorkItemPriority;
  /** `tasks` namespace: the word alone ("High"), for a field or a filter */
  label: `priority.${WorkItemPriority}`;
  /** `tasks` namespace: what the mark says to a screen reader and in its tooltip ("High priority") */
  aria: `priorityMark.${WorkItemPriority}`;
  /**
   * How many of the mark's three bars are filled. Urgent has none: it is the one mark drawn in a
   * colour (the accent, which no status uses), as an exclamation instead of bars.
   */
  bars: 0 | 1 | 2 | 3;
  urgent: boolean;
}

/** Lowest first. Priority is not a status: it never takes a status colour. */
export const WORK_ITEM_PRIORITY_META: readonly PriorityMeta[] = WORK_ITEM_PRIORITIES.map((priority, index) => ({
  priority,
  label: `priority.${priority}` as const,
  aria: `priorityMark.${priority}` as const,
  bars: priority === 'urgent' ? 0 : ((index + 1) as 1 | 2 | 3),
  urgent: priority === 'urgent',
}));

export const priorityMeta = (priority: WorkItemPriority): PriorityMeta =>
  WORK_ITEM_PRIORITY_META.find((meta) => meta.priority === priority) ?? {
    priority,
    label: `priority.${priority}`,
    aria: `priorityMark.${priority}`,
    bars: 0,
    urgent: false,
  };

// ---------- filters in the address ----------

/**
 * What the Tasks toolbar narrows to, as the address keeps it so a filtered board can be linked and
 * survives a reload. The API's filter plus `projects`, which the All projects view applies itself
 * (the API takes one project at a time) with {@link inProjects}.
 */
export interface TaskFilters extends Omit<WorkItemFilter, 'projectId'> {
  projects?: string[];
}

/** The address's names for each filter. `project` is left alone: it is the top bar's scope. */
export const FILTER_PARAMS = {
  q: 'q',
  status: 'status',
  type: 'type',
  priority: 'priority',
  labels: 'label',
  assignee: 'assignee',
  epicId: 'epic',
  milestoneId: 'milestone',
  projects: 'projects',
} as const satisfies Record<keyof TaskFilters, string>;

const list = (value: string | null): string[] =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

/** A value the API does not know would answer 400; a stale link simply loses that part */
const known = <T extends string>(values: string[], allowed: readonly T[]): T[] | undefined => {
  const kept = values.filter((value): value is T => (allowed as readonly string[]).includes(value));
  return kept.length ? [...new Set(kept)] : undefined;
};

const some = (values: string[]): string[] | undefined => (values.length ? [...new Set(values)] : undefined);

export function filtersFromSearch(params: URLSearchParams): TaskFilters {
  const q = params.get(FILTER_PARAMS.q)?.trim();
  const status = known(list(params.get(FILTER_PARAMS.status)), WORK_ITEM_STATUSES);
  const type = known(list(params.get(FILTER_PARAMS.type)), WORK_ITEM_TYPES);
  const priority = known(list(params.get(FILTER_PARAMS.priority)), WORK_ITEM_PRIORITIES);
  const labels = some(list(params.get(FILTER_PARAMS.labels)));
  const assignee = some(list(params.get(FILTER_PARAMS.assignee)));
  const projects = some(list(params.get(FILTER_PARAMS.projects)));
  const epicId = params.get(FILTER_PARAMS.epicId)?.trim();
  const milestoneId = params.get(FILTER_PARAMS.milestoneId)?.trim();
  return {
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(priority ? { priority } : {}),
    ...(labels ? { labels } : {}),
    ...(assignee ? { assignee } : {}),
    ...(epicId ? { epicId } : {}),
    ...(milestoneId ? { milestoneId } : {}),
    ...(projects ? { projects } : {}),
  };
}

/**
 * The address with these filters, every other parameter (the scope, the view, an open panel) kept
 * as it was. An empty filter removes its parameter rather than leaving `type=`.
 */
export function filtersToSearch(filters: TaskFilters, base: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const [field, param] of Object.entries(FILTER_PARAMS) as Array<[keyof TaskFilters, string]>) {
    const value = filters[field];
    const text = Array.isArray(value) ? value.join(',') : (value ?? '').trim();
    if (text) next.set(param, text);
    else next.delete(param);
  }
  return next;
}

/** What the API is asked for; `projects` stays behind for {@link inProjects}. */
export function apiFilter(filters: TaskFilters): Omit<WorkItemFilter, 'projectId'> {
  const { projects: _projects, ...rest } = filters;
  return rest;
}

/** True when anything narrows the view: an empty result is "no matches", not "no tasks". */
export function hasFilters(filters: TaskFilters): boolean {
  return Object.values(filters).some((value) => (Array.isArray(value) ? value.length > 0 : Boolean(value)));
}

/**
 * The same filter always as the same string, whatever order its lists were picked in, so it can sit
 * in a query key and two views narrowed alike share one cache entry.
 */
export function filterKey(filters: Omit<WorkItemFilter, 'projectId'>): string {
  const parts: string[] = [];
  for (const field of Object.keys(FILTER_PARAMS) as Array<keyof TaskFilters>) {
    if (field === 'projects') continue;
    const value = (filters as TaskFilters)[field];
    const text = Array.isArray(value) ? [...value].sort().join(',') : (value ?? '').trim();
    if (text) parts.push(`${field}=${text}`);
  }
  return parts.join('&');
}

/**
 * The filters in the address that cannot apply to the scope, by field: `projects` outside All
 * projects, where no chip shows it, and an epic or a milestone the scope does not have (one of the
 * project left, or deleted since). Kept, they narrow the view to "0 of N" with nothing to take off.
 * `epics` and `milestones` are the ids the scope has, or null while they are loading.
 */
export function staleFilters(
  filters: TaskFilters,
  scope: { allProjects: boolean; epics: ReadonlySet<string> | null; milestones: ReadonlySet<string> | null; noMilestone: string },
): Array<keyof TaskFilters> {
  const stale: Array<keyof TaskFilters> = [];
  if (!scope.allProjects && filters.projects?.length) stale.push('projects');
  if (filters.epicId && scope.epics && !scope.epics.has(filters.epicId)) stale.push('epicId');
  if (filters.milestoneId && filters.milestoneId !== scope.noMilestone && scope.milestones && !scope.milestones.has(filters.milestoneId)) stale.push('milestoneId');
  return stale;
}

/** The All projects view narrowed to some projects; no list keeps every one. */
export function inProjects<T extends Pick<WorkItem, 'projectId'>>(items: readonly T[], projects: readonly string[] | undefined): T[] {
  if (!projects?.length) return [...items];
  const wanted = new Set(projects);
  return items.filter((item) => wanted.has(item.projectId));
}

// ---------- views ----------

/** Tasks shows the board or the list at `/tasks` (`?view=list`); milestones have a path of their own. */
export type TaskView = 'board' | 'list';
export const VIEW_PARAM = 'view';

export function viewFromSearch(params: URLSearchParams): TaskView {
  return params.get(VIEW_PARAM) === 'list' ? 'list' : 'board';
}

/**
 * The row J (`delta` 1) or K (-1) moves to in a list of `count` rows, from the one at `at` (-1 for
 * none in focus: J starts at the first, K at the last). Null at either end, where it stays put.
 */
export function listRowStep(count: number, at: number, delta: 1 | -1): number | null {
  if (count === 0) return null;
  if (at < 0) return delta === 1 ? 0 : count - 1;
  const next = at + delta;
  return next >= 0 && next < count ? next : null;
}

// ---------- a board ----------

/**
 * The five columns in order, whatever the response held: a column the answer lacks is drawn empty
 * rather than missing, so the board never loses a place to drop a card.
 */
export function boardColumns(board: Pick<Board, 'columns'> | undefined): BoardColumn[] {
  return WORK_ITEM_STATUSES.map(
    (status) => board?.columns.find((column) => column.status === status) ?? { status, limit: null, count: 0, overLimit: false, items: [] },
  );
}

/** Items under the column they are in, in board order: the list view and the phone's board. */
export function groupByStatus<T extends Pick<WorkItem, 'status'>>(items: readonly T[]): Array<{ status: WorkItemStatus; items: T[] }> {
  return WORK_ITEM_STATUSES.map((status) => ({ status, items: items.filter((item) => item.status === status) }));
}

/**
 * Whether an item takes a place in its column's count and limit. An epic groups the work rather than
 * being some, so the server leaves it out of the counts, and a card moved before it answers must too.
 */
export const countsInColumn = (item: Pick<WorkItem, 'type'>): boolean => item.type !== 'epic';

/**
 * The items not in Done (epics aside, as in every count), from the columns' real counts, which a filter does not narrow: the figure
 * beside Tasks in the sidebar and the More sheet.
 */
export function openCount(board: Pick<Board, 'columns'> | undefined): number | undefined {
  if (!board) return undefined;
  return board.columns.reduce((sum, column) => (isOpen(column.status) ? sum + column.count : sum), 0);
}

// ---------- live ----------

/**
 * What the chat or orchestration node on an item is doing now: `working` is live (the rail, the
 * ring spinner, cyan), `waiting` waits for the person (idle, still). Null when nothing works on it,
 * including a chat that ended or a node that finished: only live things move.
 */
export function workItemLiveState(item: Pick<WorkItem, 'activeLink'>): 'working' | 'waiting' | null {
  const link = item.activeLink;
  if (!link) return null;
  if (link.taskStatus === 'running' || link.chatState === 'working') return 'working';
  if (link.chatState === 'waiting') return 'waiting';
  return null;
}

export const isLive = (item: Pick<WorkItem, 'activeLink'>): boolean => workItemLiveState(item) === 'working';
