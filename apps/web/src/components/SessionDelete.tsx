import type { SessionSummary } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../api';
import { useConfirm } from './Dialog';
import { useToast } from './Toast';

/** Confirms and deletes a session transcript; the API refuses while the session is live. */
export function useDeleteSession(onDeleted?: () => void) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useTranslation('components');

  const mutation = useMutation({
    mutationFn: (session: SessionSummary) => api.deleteSession(session.id),
    onSuccess: (_result, session) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      void queryClient.invalidateQueries({ queryKey: keys.overview });
      toast.success(t('sessionDelete.deleted'), session.title);
      onDeleted?.();
    },
    onError: (err) => toast.error(t('sessionDelete.failed'), err),
  });

  const requestDelete = (session: SessionSummary) =>
    void confirm({
      title: t('sessionDelete.title'),
      body: (
        <>
          <p className="strong break">{session.title}</p>
          <p>{t('sessionDelete.body', { count: session.messageCount })}</p>
        </>
      ),
      confirmLabel: t('sessionDelete.confirm'),
      danger: true,
    }).then((ok) => ok && mutation.mutate(session));

  return { requestDelete, isPending: mutation.isPending, pendingId: mutation.isPending ? mutation.variables?.id : undefined };
}
