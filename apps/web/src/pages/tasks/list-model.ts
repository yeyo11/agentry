/**
 * The list view's rules, pure so they are tested without a browser (test/tasks-list-pages.test.ts):
 * how the rows read so far fall into the board's groups, and when the next page is worth asking for.
 */
import type { BoardColumn, WorkItem } from '@agentry/shared';
import { WORK_ITEM_STATUSES } from '@agentry/shared';
import { countsInColumn } from '../../lib/work-items';
import { newestDoneFirst } from './board/model';

export interface ListGroup {
  column: BoardColumn;
  /** The rows read so far, in the list's order; Done's newest first */
  items: WorkItem[];
  /** What the group's head counts: its board column's figure, epics left out, read or not */
  counted: number;
  /** Every row the group has, read or not */
  held: number;
}

/**
 * The groups that have rows read, in board order. The figures come from the board, which holds every
 * open item and counts what its Done column leaves out, so a head does not grow as pages arrive.
 */
export function listGroups(columns: readonly BoardColumn[], loaded: readonly WorkItem[]): ListGroup[] {
  const groups: ListGroup[] = [];
  const open = columns.filter((column) => column.status !== 'done').reduce((sum, column) => sum + column.items.length, 0);
  const openRead = loaded.filter((item) => item.status !== 'done').length >= open;
  for (const status of WORK_ITEM_STATUSES) {
    let items = loaded.filter((item) => item.status === status);
    if (status === 'done') {
      // Done reads newest first, as the board draws it. Its rows come last in the pages' order, so
      // once the open rows are read the board's newest Done items join those read, and the folded
      // group shows the newest even before a page reaches them
      const held = openRead ? (columns.find((c) => c.status === 'done')?.items ?? []) : [];
      const read = new Set(items.map((item) => item.id));
      items = newestDoneFirst([...items, ...held.filter((item) => !read.has(item.id))]);
    }
    if (items.length === 0) continue;
    const column = columns.find((c) => c.status === status) ?? { status, limit: null, count: 0, overLimit: false, items: [] };
    const more = column.more ?? 0;
    // A row that moved here after the board was read still counts, until the board catches up
    const held = Math.max(column.items.length + more, items.length);
    const counted = Math.max(column.items.filter(countsInColumn).length + more, items.filter(countsInColumn).length);
    groups.push({ column, items, counted, held });
  }
  return groups;
}

/**
 * How many rows the next pages still hold, or 0 when there is nothing worth asking for: no page
 * left, or only Done rows while Done is folded (its own button says how many there are).
 */
export function listMore({
  columns,
  loaded,
  total,
  hasNext,
  allDone,
}: {
  columns: readonly BoardColumn[];
  loaded: readonly WorkItem[];
  total: number;
  hasNext: boolean;
  allDone: boolean;
}): number {
  if (!hasNext) return 0;
  if (!allDone) {
    const open = columns.filter((column) => column.status !== 'done').reduce((sum, column) => sum + column.items.length, 0);
    const openRead = loaded.filter((item) => item.status !== 'done').length;
    if (openRead >= open) return 0;
  }
  return Math.max(1, total - loaded.length);
}
