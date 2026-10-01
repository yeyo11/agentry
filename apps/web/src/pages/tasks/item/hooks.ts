import type { CreateWorkItemRelationRequest, UpdateWorkItemRequest, WorkItem, WorkItemDetail, WorkItemStatus } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys, useOverview } from '../../../api';
import { useConfirm } from '@agentry/ui/components/Dialog';
import { useToast } from '@agentry/ui/components/Toast';
import { personName, uncheckedCriteria } from './model';

/**
 * Every edit a work item's page makes, as mutations. What an answer returns goes straight into the
 * page's cache, so a field shows its new value at once; the event feed (lib/events.ts) refetches
 * the rest (the history the change wrote, the board it sits on). A failure is a toast and the page
 * reads the item again, so nothing stays drawn as saved when it was not.
 */
export function useItemActions(itemId: string) {
  const { t } = useTranslation('workItem');
  const qc = useQueryClient();
  const toast = useToast();
  const key = keys.workItem(itemId);

  const merge = (item: WorkItem) => qc.setQueryData<WorkItemDetail>(key, (old) => (old ? { ...old, ...item } : old));
  const settle = () => void qc.invalidateQueries({ queryKey: key });
  const failed = (title: string) => (error: unknown) => {
    toast.error(title, error);
    settle();
  };

  const update = useMutation({
    mutationFn: (req: UpdateWorkItemRequest) => api.updateWorkItem(itemId, req),
    onSuccess: merge,
    onError: failed(t('errors.save')),
  });
  const move = useMutation({
    mutationFn: (status: WorkItemStatus) => api.moveWorkItem(itemId, { status }),
    // The column shows at once; a move never fails over a limit, so rolling back is for real errors
    onMutate: (status) => qc.setQueryData<WorkItemDetail>(key, (old) => (old ? { ...old, status } : old)),
    onSuccess: (result) => merge(result.item),
    onError: failed(t('errors.move')),
  });
  const check = useMutation({
    mutationFn: ({ criterionId, checked }: { criterionId: string; checked: boolean }) => api.checkCriterion(itemId, criterionId, checked),
    onMutate: ({ criterionId, checked }) =>
      qc.setQueryData<WorkItemDetail>(key, (old) =>
        old
          ? {
              ...old,
              acceptanceCriteria: old.acceptanceCriteria.map((c) => (c.id === criterionId ? { ...c, checked, checkedBy: checked ? { kind: 'person' } : null } : c)),
            }
          : old,
      ),
    onSuccess: merge,
    onError: failed(t('errors.save')),
  });
  const relate = useMutation({
    mutationFn: (req: CreateWorkItemRelationRequest) => api.addWorkItemRelation(itemId, req),
    onSuccess: merge,
    onError: failed(t('errors.relate')),
  });
  const unrelate = useMutation({
    mutationFn: (otherId: string) => api.removeWorkItemRelation(itemId, otherId),
    onSuccess: merge,
    onError: failed(t('errors.save')),
  });
  const comment = useMutation({
    mutationFn: (body: string) => api.addWorkItemComment(itemId, { body }),
    onSuccess: (added) => qc.setQueryData<WorkItemDetail>(key, (old) => (old ? { ...old, comments: [...old.comments, added] } : old)),
    onError: failed(t('errors.comment')),
  });

  return { update, move, check, relate, unrelate, comment };
}

export type ItemActions = ReturnType<typeof useItemActions>;

/**
 * A move of the item as the person makes it: to Done with criteria still unchecked, it asks first
 * (the person's approval means every criterion is met, decision 29); any other move goes at once.
 */
export function useMoveItem(item: Pick<WorkItem, 'key' | 'acceptanceCriteria'>, actions: Pick<ItemActions, 'move'>): (status: WorkItemStatus) => void {
  const { t } = useTranslation('workItem');
  const confirm = useConfirm();
  return (status) => {
    const { unchecked, total } = uncheckedCriteria(item);
    if (status !== 'done' || unchecked === 0) return actions.move.mutate(status);
    void confirm({
      title: t('done.title', { key: item.key }),
      body: t('done.body', { count: unchecked, total }),
      confirmLabel: t('actions.moveToDone'),
    }).then((ok) => ok && actions.move.mutate(status));
  };
}

/** The person as comments and history name them: their account's name, or "you". */
export function usePersonName(): string {
  const { t } = useTranslation('workItem');
  const overview = useOverview();
  return personName(overview.data?.system.auth?.email) ?? t('person.you');
}
