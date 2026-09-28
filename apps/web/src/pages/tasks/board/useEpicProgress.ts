import type { Board, WorkItem } from '@agentry/shared';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, keys } from '../../../api';
import { childProgress, epicProgress, holdsPart } from './model';

/**
 * How far each epic on the board is. The board's cards say it while the board holds every item;
 * once its Done column leaves some out ("and N more"), an epic's done children may be among them,
 * so each epic shown is read whole, under its page's key, and counted from the items it groups.
 */
export function useEpicProgress(board: Board | undefined, items: readonly WorkItem[]): ReadonlyMap<string, { done: number; total: number }> {
  const partial = holdsPart(board);
  const epics = useMemo(() => (partial ? items.filter((item) => item.type === 'epic') : []), [partial, items]);
  const details = useQueries({
    queries: epics.map((epic) => ({
      queryKey: keys.workItem(epic.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.workItem(epic.id, { signal }),
    })),
  });
  const fromCards = useMemo(() => epicProgress(items), [items]);
  if (!partial) return fromCards;
  const progress = new Map(fromCards);
  for (const { data } of details) if (data) progress.set(data.id, childProgress(data.children));
  return progress;
}
