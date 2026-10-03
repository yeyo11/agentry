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
  FLOW_STEP_OF_COLUMN,
  parseWorkItemKey,
  type Board,
  type BoardCheckout,
  type BoardColumn,
  type ChatActivity,
  type ChangeRequestFixOrigin,
  type CodeHostId,
  type FlowRun,
  type FlowRunCause,
  type FlowStep,
  type LimitWait,
  type Project,
  type PullRequestNotReadyReason,
  type PullRequestReadiness,
  type WorkItem,
  type WorkItemFilter,
  type WorkItemPriority,
  type WorkItemPullRequestCi,
  type WorkItemStatus,
  type WorkItemType,
} from '@agentry/shared';
import { fixStage, type FixStage } from './change-requests';

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

// ---------- the strip ----------

/**
 * Who a card's strip starts with, told by its shape before any word: a role's squircle, the
 * person's round monogram, or an orchestration's glyph (design system, decision 2).
 */
export type StripActor = { kind: 'role'; role: string } | { kind: 'person' } | { kind: 'orchestration' };

/**
 * What happens to an item now, as the one strip at the foot of its card says it (decision 1). One
 * state per card, and none when nothing is going on.
 *
 * - `run`: a team member works on it (live): its stage verb, its clock, what its chat is doing;
 * - `chat`: the person's own chat ("Work on it") works on it (live);
 * - `node`: an orchestration node works on it (live);
 * - `chat-waiting`: the person's chat stopped to ask them something (idle);
 * - `approval` and `bounces`: it waits for the person's move (idle);
 * - `failed`: the last run of its column failed and nothing ran that step since (bad);
 * - `rejected`: QA sent it back, in QA's words (neutral: a bounce is not a failure);
 * - `queued`: a member waits for a place under the flow's limit (neutral);
 * - `pr-*`: its pull request (docs/plans/work-item-pull-requests.md): Agentry preparing it
 *   (neutral: Agentry works, no agent does, so nothing moves), a conflict updating the branch (warn),
 *   an approval kept until QA passes (neutral), open and waiting for the person's merge (idle),
 *   closed without merging (idle, with the approval again) and failed to open (bad). A Done card
 *   draws no strip, so a merged PR whose worktree was kept is told on the item's page.
 */
export type WorkItemStripState =
  | { kind: 'run'; role: string; step: FlowStep; startedAt: string | null; activity: ChatActivity | null }
  /** A run that stopped for its provider's limit to reset: warn and still, never live */
  | { kind: 'run-waiting'; role: string; step: FlowStep; wait: LimitWait }
  | { kind: 'chat'; chatId: string }
  | { kind: 'node'; orchestrationId: string; taskId: string | null }
  | { kind: 'chat-waiting' }
  | { kind: 'approval' }
  | { kind: 'bounces'; count: number }
  | { kind: 'failed'; role: string; step: FlowStep; cause: FlowRunCause | null; error: string | null }
  | { kind: 'rejected'; role: string; quote: string | null }
  | { kind: 'queued'; role: string; step: FlowStep }
  | { kind: 'pr-preparing'; host: CodeHostId | null }
  | { kind: 'pr-conflict'; base: string; count: number; host: CodeHostId | null }
  | { kind: 'pr-awaiting'; base: string; host: CodeHostId | null }
  | { kind: 'pr-fix'; fix: 'checks' | 'review'; stage: FixStage; origin: ChangeRequestFixOrigin | null; attempt: number; number: number | null; ref: string | null; host: CodeHostId | null }
  | { kind: 'pr-open'; id: string | null; number: number | null; ref: string | null; host: CodeHostId | null; url: string | null; ci: WorkItemPullRequestCi | null }
  | { kind: 'pr-closed'; number: number | null; ref: string | null; host: CodeHostId | null }
  | { kind: 'pr-failed'; code: string; detail: string | null; host: CodeHostId | null };

/** The flow runs a board knows, by item id: working now, waiting for a place, and the last one that did not pass. */
export interface StripRuns {
  running?: ReadonlyMap<string, FlowRun>;
  queued?: ReadonlyMap<string, FlowRun>;
  /** The newest failed or rejected run of each item ({@link lastEndedRuns}) */
  ended?: ReadonlyMap<string, FlowRun>;
}

type StripItem = Pick<WorkItem, 'id' | 'status' | 'activeLink' | 'waiting' | 'bounces' | 'pullRequest'>;

/** The step a flow link names, read by the column the item is in: the Product Owner only checks in Por hacer. */
function linkStep(role: string | undefined, status: WorkItemStatus): FlowStep {
  if (role === 'verify') return 'verify';
  if (role === 'refine') return FLOW_STEP_OF_COLUMN[status] === 'check' ? 'check' : 'refine';
  return 'work';
}

/**
 * What the item's pull request says on its strip, where it still applies: the newest PR stays on the
 * item after it closed or failed, so each phase speaks only in the column it leaves the item in.
 */
function pullRequestStrip(item: StripItem): WorkItemStripState | null {
  const pr = item.pullRequest ?? null;
  if (item.status === 'done') return null;
  const host = pr?.host ?? null;
  if (pr?.phase === 'open' && pr.fixState) {
    const stage = fixStage({ fixState: pr.fixState ?? null });
    if (stage) return { kind: 'pr-fix', fix: pr.fixKind === 'review' ? 'review' : 'checks', stage, origin: pr.fixOrigin ?? null, attempt: pr.fixAttempts ?? 0, number: pr.number, ref: pr.ref ?? null, host };
  }
  if (item.waiting === 'merge' || pr?.phase === 'open')
    return { kind: 'pr-open', id: pr?.id ?? null, number: pr?.number ?? null, ref: pr?.ref ?? null, host, url: pr?.url ?? null, ci: pr?.ci ?? null };
  if (!pr) return null;
  switch (pr.phase) {
    case 'preparing':
      return { kind: 'pr-preparing', host };
    case 'conflict':
      // Back in In progress for the merge to be resolved; once it is in review again, it is approved again
      return item.status === 'in_progress' ? { kind: 'pr-conflict', base: pr.base, count: pr.conflicts.length, host } : null;
    case 'awaiting-verify':
      return item.status === 'in_progress' || item.status === 'in_review' ? { kind: 'pr-awaiting', base: pr.base, host } : null;
    case 'closed':
      return item.status === 'in_review' && item.waiting !== 'bounces' ? { kind: 'pr-closed', number: pr.number, ref: pr.ref ?? null, host } : null;
    case 'failed':
      return item.status === 'in_review' && item.waiting !== 'bounces' ? { kind: 'pr-failed', code: pr.error?.code ?? 'unknown', detail: pr.error?.detail || null, host } : null;
    default:
      return null;
  }
}

/**
 * The one state a card's strip shows, most pressing first: something at work, then what waits for
 * the person (its pull request before a plain approval), then a failure, then QA's words on a card
 * it sent back (which win over waiting for a place, as DSTablero draws it), then a place in the
 * queue. A card in Done has none.
 */
export function workItemStrip(item: StripItem, runs: StripRuns = {}): WorkItemStripState | null {
  if (item.status === 'done') return null;
  const running = runs.running?.get(item.id);
  if (running?.waiting) return { kind: 'run-waiting', role: running.role, step: running.step, wait: running.waiting };
  if (running) return { kind: 'run', role: running.role, step: running.step, startedAt: running.startedAt, activity: running.activity ?? null };
  const link = item.activeLink;
  const live = workItemLiveState(item);
  if (link && live === 'working') {
    if (link.orchestrationId) return { kind: 'node', orchestrationId: link.orchestrationId, taskId: link.taskId };
    if (link.teamRole) return { kind: 'run', role: link.teamRole, step: linkStep(link.role, item.status), startedAt: null, activity: null };
    if (link.chatId) return { kind: 'chat', chatId: link.chatId };
  }
  if (live === 'waiting') return { kind: 'chat-waiting' };
  const pullRequest = pullRequestStrip(item);
  if (pullRequest) return pullRequest;
  if (item.waiting === 'approval') return { kind: 'approval' };
  if (item.waiting === 'bounces') return { kind: 'bounces', count: item.bounces ?? 0 };
  const ended = runs.ended?.get(item.id);
  // A later run of the same step answers the failure, and a card that left the run's column moved on
  if (ended && !ended.retriedBy) {
    if (ended.outcome === 'failed' && item.status === ended.column)
      return { kind: 'failed', role: ended.role, step: ended.step, cause: ended.cause, error: ended.error };
    if (ended.outcome === 'rejected' && item.status === 'in_progress' && (item.bounces ?? 0) > 0) return { kind: 'rejected', role: ended.role, quote: ended.summary };
  }
  const queued = runs.queued?.get(item.id);
  if (queued) return { kind: 'queued', role: queued.role, step: queued.step };
  return null;
}

/** Who the strip starts with; null when it starts with a word ("te espera"). */
export function stripActor(strip: WorkItemStripState | null): StripActor | null {
  if (!strip) return null;
  switch (strip.kind) {
    case 'run':
    case 'run-waiting':
    case 'failed':
    case 'rejected':
    case 'queued':
      return { kind: 'role', role: strip.role };
    case 'chat':
      return { kind: 'person' };
    case 'node':
      return { kind: 'orchestration' };
    default:
      return null;
  }
}

/**
 * Whether the card's foot leaves its assignee out because the strip already starts with the same
 * role, or with the person (ecosystem review, "For development").
 */
export function stripNamesAssignee(assignee: WorkItem['assignee'], strip: WorkItemStripState | null): boolean {
  const actor = stripActor(strip);
  if (!assignee || !actor) return false;
  if (assignee.kind === 'role') return actor.kind === 'role' && actor.role === assignee.role;
  return actor.kind === 'person';
}

/**
 * The strip's tone, which is its class: live moves, wait takes the idle colour, fail the bad one,
 * warn a conflict; the rest is neutral.
 */
export function stripTone(strip: WorkItemStripState): 'live' | 'wait' | 'fail' | 'warn' | null {
  switch (strip.kind) {
    case 'run':
    case 'chat':
    case 'node':
      return 'live';
    case 'chat-waiting':
    case 'approval':
    case 'bounces':
    case 'pr-open':
    case 'pr-closed':
      return 'wait';
    // Agents fixing or verifying show as run strips while they work; with none running it is neutral and still
    case 'pr-fix':
      return strip.stage === 'push' ? 'wait' : null;
    case 'failed':
    case 'pr-failed':
      return 'fail';
    case 'pr-conflict':
    case 'run-waiting':
      return 'warn';
    default:
      return null;
  }
}

/**
 * Whether the list's "Now" column shows the strip: who runs the item now, or a run that failed on it
 * (DesktopTareasLista). What waits for the person reads on the card and the item's page, where its
 * button has room.
 */
export function stripInList(strip: WorkItemStripState | null): strip is WorkItemStripState {
  return strip !== null && (stripTone(strip) === 'live' || strip.kind === 'failed');
}

/** The strips that carry the approval button: QA passed it, or its pull request closed or failed and it can be proposed again. */
export function stripOffersApproval(strip: WorkItemStripState | null): boolean {
  return strip?.kind === 'approval' || strip?.kind === 'pr-closed' || strip?.kind === 'pr-failed';
}

// ---------- pull requests ----------

/**
 * Whether approving an item opens its pull request: only in a project whose readiness is `ready`.
 * Anywhere else (not ready, or a board that does not say, as All projects) approving moves it to
 * Done, as it did before pull requests.
 */
export function approvalOpensPullRequest(readiness: Pick<PullRequestReadiness, 'status'> | null | undefined): boolean {
  return readiness?.status === 'ready';
}

/**
 * The reasons an older server still sends, for the three the host work renamed: GitHub was the only
 * host then, so each one maps to the neutral reason that says the same.
 */
export const LEGACY_NOT_READY_REASONS: Readonly<Record<string, PullRequestNotReadyReason>> = {
  'not-github': 'unsupported-host',
  'no-gh': 'cli-missing',
  'gh-unauthenticated': 'cli-signed-out',
};

/** Why the project offers no pull request, so the card and the item say it instead of failing silently; null when ready or unknown. */
export function notReadyReason(readiness: Pick<PullRequestReadiness, 'status'> | null | undefined): PullRequestNotReadyReason | null {
  if (!readiness || readiness.status === 'ready') return null;
  return LEGACY_NOT_READY_REASONS[readiness.status] ?? readiness.status;
}

const PULL_REQUEST_STEPS = ['fetch', 'merge', 'push', 'create', 'commit', 'worktree-kept'] as const;
const NOT_READY_REASONS: readonly PullRequestNotReadyReason[] = [
  'not-git',
  'no-remote',
  'unsupported-host',
  'no-default-branch',
  'cli-missing',
  'cli-incompatible',
  'cli-signed-out',
];

/**
 * The words for a pull request's error code (`tasks` namespace): the step that failed, or the
 * readiness reason the project lost since. A code this version does not know still reads as a
 * failure; one an older server sends for a renamed reason reads as its neutral name.
 */
export function pullRequestErrorKey(code: string): `pr.error.${(typeof PULL_REQUEST_STEPS)[number] | 'unknown'}` | `pr.notReady.${PullRequestNotReadyReason}` {
  const step = PULL_REQUEST_STEPS.find((known) => known === code);
  if (step) return `pr.error.${step}`;
  const neutral = LEGACY_NOT_READY_REASONS[code] ?? code;
  const reason = NOT_READY_REASONS.find((known) => known === neutral);
  return reason ? `pr.notReady.${reason}` : 'pr.error.unknown';
}

/** A CI state's badge colour: passing ok, failing bad; pending and none neutral, since no agent works on it and nothing is wrong yet. */
export function ciTone(ci: WorkItemPullRequestCi): 'ok' | 'bad' | null {
  return ci === 'passing' ? 'ok' : ci === 'failing' ? 'bad' : null;
}

/**
 * The quiet line under the board's toolbar when the project's checkout is behind its default
 * branch: how far, and why Agentry did not bring it forward. Null while it is up to date. The words
 * are the `tasks` namespace's `checkout.*`; it never offers a command to copy.
 */
export interface CheckoutNote {
  count: number;
  base: string;
  reason: 'not-on-default' | 'detached' | 'dirty' | 'diverged' | null;
  branch: string | null;
}

export function checkoutNote(checkout: BoardCheckout | null | undefined): CheckoutNote | null {
  if (!checkout || checkout.behind <= 0) return null;
  const reason = checkout.reason === 'not-on-default' && checkout.branch === null ? 'detached' : checkout.reason;
  return { count: checkout.behind, base: checkout.defaultBranch, reason, branch: checkout.branch };
}

/** The newest of each item's runs, from failed and rejected runs in any order: the one a card may still show. */
export function lastEndedRuns(runs: readonly FlowRun[]): Map<string, FlowRun> {
  const last = new Map<string, FlowRun>();
  for (const run of runs) {
    const seen = last.get(run.itemId);
    if (!seen || seen.queuedAt < run.queuedAt) last.set(run.itemId, run);
  }
  return last;
}
