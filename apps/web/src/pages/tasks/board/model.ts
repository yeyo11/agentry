/**
 * The board's own rules, pure so they are tested without a browser (test/tasks-board.test.ts):
 * where a dropped card lands and which neighbour the API is told it goes after, the board as it
 * looks the moment a card is moved (before the server answers), where a keyboard move takes a card,
 * and what may be picked for "Orchestrate". The shared vocabulary (columns, filters, live) is in
 * lib/work-items.ts.
 */
import type { Board, BoardColumn, WorkItem, WorkItemRef, WorkItemStatus } from '@agentry/shared';
import { BOARD_DONE_PAGE, WORK_ITEM_STATUSES } from '@agentry/shared';
import { countsInColumn } from '../../../lib/work-items';

/**
 * Done keeps growing, and what is finished matters least on a board: it shows its first few cards
 * and says how many more there are; "and N more" draws the next page of them in place.
 */
export const DONE_SHOWN = 3;

/**
 * The Done cards drawn after one more "and N more": up to the page the board already holds
 * (`BOARD_DONE_PAGE`), then a page more each time.
 */
export function nextDoneShown(shown: number): number {
  return (Math.floor(shown / BOARD_DONE_PAGE) + 1) * BOARD_DONE_PAGE;
}

/**
 * The `doneLimit` a board is asked with so its Done column holds `shown` cards. Undefined while the
 * default page holds them, so the board shares its answer with the sidebar's count.
 */
export function doneLimitFor(shown: number): number | undefined {
  return shown <= BOARD_DONE_PAGE ? undefined : Math.ceil(shown / BOARD_DONE_PAGE) * BOARD_DONE_PAGE;
}

/**
 * Done reads as a record of what was finished, newest first by when it was closed (its last update
 * for an item closed before that was recorded), as the server holds it. A card is never placed by
 * hand inside Done: one moved there is the newest and heads the column.
 */
export function newestDoneFirst<T extends Pick<WorkItem, 'closedAt' | 'updatedAt' | 'id'>>(items: readonly T[]): T[] {
  const when = (item: T) => item.closedAt ?? item.updatedAt;
  return [...items].sort((a, b) => (when(a) > when(b) ? -1 : when(a) < when(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * What a column draws of what it holds, and what its "and N more" counts: the cards it holds but
 * folds, plus those the server left out (`more`). Only Done folds.
 */
export function foldColumn<T>(column: { status: WorkItemStatus; items: readonly T[]; more?: number }, shown: number): { shown: T[]; hidden: number } {
  const drawn = column.status === 'done' ? column.items.slice(0, shown) : [...column.items];
  return { shown: drawn, hidden: column.items.length - drawn.length + (column.more ?? 0) };
}

/** Every item a board counts, the ones its Done column leaves out included. */
export function boardTotal(board: Pick<Board, 'columns'> | undefined): number {
  return board ? board.columns.reduce((sum, column) => sum + column.items.length + (column.more ?? 0), 0) : 0;
}

/** Whether the board leaves some of its Done items out: then its cards alone cannot say how far an epic is. */
export function holdsPart(board: Pick<Board, 'columns'> | undefined): boolean {
  return Boolean(board?.columns.some((column) => (column.more ?? 0) > 0));
}

/** Where a card goes: a column and its index among the cards drawn there, the card itself left out. */
export interface Drop {
  status: WorkItemStatus;
  index: number;
}

/**
 * The neighbour a card lands after, as `POST /work-items/:id/move` takes it: null for the top of the
 * column, otherwise the card drawn just above the drop. Named by the cards on screen, so on a
 * filtered board a card lands after the one the person saw above it.
 */
export function afterIdFor(column: readonly Pick<WorkItem, 'id'>[], itemId: string, index: number): string | null {
  const others = column.filter((item) => item.id !== itemId);
  const at = Math.max(0, Math.min(index, others.length));
  return at === 0 ? null : (others[at - 1]?.id ?? null);
}

/** True when the drop leaves the card where it already is: nothing to ask the server. */
export function isSamePlace(board: Pick<Board, 'columns'>, itemId: string, drop: Drop): boolean {
  const column = board.columns.find((c) => c.items.some((item) => item.id === itemId));
  if (!column || column.status !== drop.status) return false;
  // Done is in closing order, so a card moved inside it stays where it is
  if (column.status === 'done') return true;
  return column.items.findIndex((item) => item.id === itemId) === drop.index;
}

const overLimit = (count: number, limit: number | null) => limit !== null && count > limit;

/**
 * The board as it looks once the card has moved, drawn before the server answers so the card does
 * not jump back while the request is in flight. Counts and limits follow the card; a board that
 * does not hold it is returned as it was, since a filter may have left it out.
 */
export function moveOnBoard<T extends Pick<Board, 'columns'>>(board: T, itemId: string, drop: Drop): T {
  let moving: WorkItem | undefined;
  for (const column of board.columns) moving ??= column.items.find((item) => item.id === itemId);
  if (!moving) return board;
  const from = moving.status;
  if (from === 'done' && drop.status === 'done') return board;
  // Into Done it is the newest closed item, so it heads the column wherever it was dropped
  const moved: WorkItem = drop.status === 'done' && from !== 'done' ? { ...moving, status: 'done', closedAt: new Date().toISOString() } : { ...moving, status: drop.status };
  const index = drop.status === 'done' ? 0 : drop.index;
  const columns = board.columns.map((column): BoardColumn => {
    let items = column.items.filter((item) => item.id !== itemId);
    let count = column.count;
    const crosses = from !== drop.status && countsInColumn(moving);
    if (column.status === from && crosses) count -= 1;
    if (column.status === drop.status) {
      if (crosses) count += 1;
      const at = Math.max(0, Math.min(index, items.length));
      items = [...items.slice(0, at), moved, ...items.slice(at)];
    }
    return { ...column, items, count, overLimit: overLimit(count, column.limit) };
  });
  return { ...board, columns };
}

/**
 * Where an arrow key takes a card picked up with the keyboard: up and down within its column,
 * left and right into the neighbouring column at the same height (or its end). Null at an edge.
 * `counts` is how many other cards each column draws, the moving one left out.
 */
export function keyboardDrop(
  current: Drop,
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight',
  counts: Readonly<Record<WorkItemStatus, number>>,
): Drop | null {
  const col = WORK_ITEM_STATUSES.indexOf(current.status);
  // Done is in closing order: nothing to move up or down, and a card carried into it heads it
  if (current.status === 'done' && (key === 'ArrowUp' || key === 'ArrowDown')) return null;
  if (key === 'ArrowUp') return current.index > 0 ? { ...current, index: current.index - 1 } : null;
  if (key === 'ArrowDown') return current.index < counts[current.status] ? { ...current, index: current.index + 1 } : null;
  const next = WORK_ITEM_STATUSES[col + (key === 'ArrowRight' ? 1 : -1)];
  if (!next) return null;
  return { status: next, index: next === 'done' ? 0 : Math.min(current.index, counts[next]) };
}

/** A column one step up or down the board's order, for the phone's move menu. */
export function neighbourStatus(status: WorkItemStatus, step: -1 | 1): WorkItemStatus | null {
  return WORK_ITEM_STATUSES[WORK_ITEM_STATUSES.indexOf(status) + step] ?? null;
}

/**
 * Why an item cannot be picked for "Orchestrate", as the API refuses it: an epic groups work and is
 * not a node, a done item has nothing left to do, and a graph runs in one project. Null when it can.
 */
export type NotSelectable = 'epic' | 'done' | 'project';

export function notSelectable(item: Pick<WorkItem, 'type' | 'status' | 'projectId'>, projectOfSelection: string | null): NotSelectable | null {
  if (item.type === 'epic') return 'epic';
  if (item.status === 'done') return 'done';
  if (projectOfSelection !== null && item.projectId !== projectOfSelection) return 'project';
  return null;
}

/**
 * The `blocks` relations among the picked items, in the order they were picked: what the draft turns
 * into `dependsOn`, said on the selection bar ("AGN-36 blocks AGN-33").
 */
export function blocksWithin(selected: readonly Pick<WorkItem, 'id' | 'key' | 'relations'>[]): Array<{ blocker: string; blocked: string }> {
  const keyOf = new Map(selected.map((item) => [item.id, item.key]));
  const pairs: Array<{ blocker: string; blocked: string }> = [];
  for (const item of selected) {
    for (const relation of item.relations) {
      if (relation.type !== 'blocks') continue;
      const blocked = keyOf.get(relation.item.id);
      if (blocked) pairs.push({ blocker: item.key, blocked });
    }
  }
  return pairs;
}

/** The items this one waits for and that are not done: what the card's relation mark names. */
export function openBlockers(item: Pick<WorkItem, 'relations'>): WorkItemRef[] {
  return item.relations.filter((relation) => relation.type === 'blocked_by' && relation.item.status !== 'done').map((relation) => relation.item);
}

/**
 * How far an epic is, from the items it groups on the board: its card counts them instead of
 * carrying an epic label. Read from the unfiltered board, so a filter does not change the figure.
 */
export function epicProgress(items: readonly Pick<WorkItem, 'epicId' | 'status' | 'type'>[]): Map<string, { done: number; total: number }> {
  const progress = new Map<string, { done: number; total: number }>();
  for (const item of items) {
    if (!item.epicId || item.type === 'epic') continue;
    const entry = progress.get(item.epicId) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (item.status === 'done') entry.done += 1;
    progress.set(item.epicId, entry);
  }
  return progress;
}

/**
 * An epic's progress from the items it groups, as its page reads them (`children`), for a board
 * whose Done column leaves some of them out.
 */
export function childProgress(children: readonly Pick<WorkItemRef, 'status' | 'type'>[]): { done: number; total: number } {
  const grouped = children.filter((child) => child.type !== 'epic');
  return { done: grouped.filter((child) => child.status === 'done').length, total: grouped.length };
}

/** Every item of a board, column after column, in board order. */
export function boardItems(board: Pick<Board, 'columns'> | undefined): WorkItem[] {
  return board ? board.columns.flatMap((column) => column.items) : [];
}

/** Every label in use, folded the way the API folds them, first spelling kept, sorted for a menu. */
export function labelsInUse(items: readonly Pick<WorkItem, 'labels'>[]): string[] {
  const seen = new Map<string, string>();
  for (const item of items) for (const label of item.labels) if (!seen.has(label.toLocaleLowerCase())) seen.set(label.toLocaleLowerCase(), label);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Items in rank order inside each column: what the list shows, "ordered by their place on the board". */
export function byRank<T extends Pick<WorkItem, 'rank' | 'id'>>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * `?milestone=none` narrows to the items in no milestone. The API filters by one milestone id, so
 * "none" is applied here, after the answer.
 */
export const NO_MILESTONE = 'none';
