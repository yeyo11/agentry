import type { Board, MoveWorkItemResult, WorkItem } from '@agentry/shared';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { useToast } from '@agentry/ui/components/Toast';
import { columnMeta } from '../../../lib/work-items';
import { afterIdFor, moveOnBoard, type Drop } from './model';

export interface MoveRequest {
  item: Pick<WorkItem, 'id' | 'key'>;
  drop: Drop;
  /** The cards drawn in the target column, in order: the neighbour is named from them */
  column: readonly Pick<WorkItem, 'id'>[];
}

type Snapshot = Array<[QueryKey, unknown]>;

const isBoard = (value: unknown): value is Board => Boolean(value && typeof value === 'object' && 'columns' in value);
const isList = (value: unknown): value is WorkItem[] => Array.isArray(value);

/**
 * Moves a card: every cached board and list that holds it shows it in its new place at once, the
 * API is told which card it goes after (so the order survives a reload and a second person's
 * move), and a refused move puts every one of them back and says why in a toast. The event feed
 * then refreshes what the move touched, here and in any other tab.
 */
export function useMoveWorkItem() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation('tasks');

  return useMutation<MoveWorkItemResult, unknown, MoveRequest, Snapshot>({
    mutationFn: ({ item, drop, column }) => api.moveWorkItem(item.id, { status: drop.status, afterId: afterIdFor(column, item.id, drop.index) }),
    onMutate: async ({ item, drop }) => {
      await queryClient.cancelQueries({ queryKey: keys.workItems });
      const snapshot: Snapshot = queryClient.getQueriesData({ queryKey: keys.workItems });
      for (const [key, value] of snapshot) {
        if (isBoard(value)) queryClient.setQueryData(key, moveOnBoard(value, item.id, drop));
        else if (isList(value) && value.some((entry) => entry.id === item.id))
          queryClient.setQueryData(
            key,
            value.map((entry) => (entry.id === item.id ? { ...entry, status: drop.status } : entry)),
          );
      }
      return snapshot;
    },
    onError: (error, { item, drop }, snapshot) => {
      for (const [key, value] of snapshot ?? []) queryClient.setQueryData(key, value);
      toast.error(t('move.failed', { key: item.key, column: t(columnMeta(drop.status).label) }), error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.workItems }),
  });
}
