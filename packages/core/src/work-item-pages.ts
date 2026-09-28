import { BOARD_DONE_PAGE, WORK_ITEMS_PAGE, WORK_ITEMS_PAGE_MAX } from '@agentry/shared';
import { statusIndex, type ItemRow } from './work-item-rows.ts';
import { WorkItemError } from './work-item-validation.ts';

/**
 * Paging a list and the board's Done column. A list is in board order (column, project, rank, id),
 * and a cursor is the place of the last item handed out in that order rather than an offset: items
 * move and are created while a person scrolls, and an offset would then repeat or skip some.
 */

/** Where a row sits in a list's order; two rows never share one, the id breaks every tie. */
type Place = [status: number, projectId: string, rank: string, id: string];

const placeOf = (row: ItemRow): Place => [statusIndex(row.status), row.project_id, row.rank, row.id];

// Ranks and ids are ASCII, so code unit order is SQLite's BINARY order, which the list is sorted by
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function comparePlaces(a: Place, b: Place): number {
  return a[0] - b[0] || compareText(a[1], b[1]) || compareText(a[2], b[2]) || compareText(a[3], b[3]);
}

export function encodeCursor(row: ItemRow): string {
  return Buffer.from(JSON.stringify(placeOf(row))).toString('base64url');
}

function decodeCursor(cursor: string): Place {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    value = null;
  }
  if (
    Array.isArray(value) &&
    value.length === 4 &&
    Number.isInteger(value[0]) &&
    typeof value[1] === 'string' &&
    typeof value[2] === 'string' &&
    typeof value[3] === 'string'
  ) {
    return [value[0] as number, value[1], value[2], value[3]];
  }
  throw new WorkItemError('cursor is not one this list handed out', 400);
}

/**
 * A count of items to hold, from a request: a whole number, at least `min`. Above the maximum it is
 * brought down rather than refused, since what is left out is still counted (`total`, `more`) and
 * the next page or the list reaches it.
 */
export function pageSize(value: unknown, field: string, fallback: number, min: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new WorkItemError(`${field} must be a whole number of at least ${String(min)}`, 400);
  }
  return Math.min(value, WORK_ITEMS_PAGE_MAX);
}

/** The rows of one page, from sorted rows, and the cursor of the next when there is one. */
export function pageOf(rows: readonly ItemRow[], query: { limit?: unknown; cursor?: unknown }): { rows: ItemRow[]; nextCursor: string | null } {
  const limit = pageSize(query.limit, 'limit', WORK_ITEMS_PAGE, 1);
  if (query.cursor !== undefined && query.cursor !== null && typeof query.cursor !== 'string') throw new WorkItemError('cursor must be text', 400);
  const after = query.cursor ? decodeCursor(query.cursor) : null;
  const start = after ? rows.findIndex((row) => comparePlaces(placeOf(row), after) > 0) : 0;
  const rest = start < 0 ? [] : rows.slice(start);
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rest.length > limit && last ? encodeCursor(last) : null };
}

/** The Done column's size when a board is asked for without one, and what it may be asked for. */
export const doneLimitOf = (value: unknown): number => pageSize(value, 'doneLimit', BOARD_DONE_PAGE, 0);

/**
 * The Done rows a board holds: the `limit` most recently closed, newest first. Done is read as a
 * record of what was finished, so its order is when, not a rank a person keeps; "and N more" then
 * reaches further back in time. A row closed before `closedAt` was recorded falls back to its last
 * update.
 */
export function newestDone(rows: readonly ItemRow[], limit: number): ItemRow[] {
  const newest = [...rows].sort((a, b) => compareText(b.closed_at ?? b.updated_at, a.closed_at ?? a.updated_at) || compareText(a.id, b.id));
  return newest.slice(0, limit);
}
