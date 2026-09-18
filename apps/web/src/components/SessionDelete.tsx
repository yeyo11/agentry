import type { SessionSummary } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, keys } from '../api';
import { useConfirm } from './Dialog';
import { useToast } from './Toast';

/** Confirms and deletes a session transcript; the API refuses while the session is live. */
export function useDeleteSession(onDeleted?: () => void) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const mutation = useMutation({
    mutationFn: (session: SessionSummary) => api.deleteSession(session.id),
    onSuccess: (_result, session) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      void queryClient.invalidateQueries({ queryKey: keys.overview });
      toast.success('Session deleted', session.title);
      onDeleted?.();
    },
    onError: (err) => toast.error('Could not delete the session', err),
  });

  const requestDelete = (session: SessionSummary) =>
    void confirm({
      title: 'Delete this session?',
      body: (
        <>
          <p className="strong break">{session.title}</p>
          <p>
            The transcript ({session.messageCount} messages) is removed from disk and the session can no longer be resumed. This
            cannot be undone.
          </p>
        </>
      ),
      confirmLabel: 'Delete session',
      danger: true,
    }).then((ok) => ok && mutation.mutate(session));

  return { requestDelete, isPending: mutation.isPending, pendingId: mutation.isPending ? mutation.variables?.id : undefined };
}
