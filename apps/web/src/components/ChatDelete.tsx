import type { ChatSummary } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../api';
import { useConfirm } from './Dialog';
import { useToast } from './Toast';

/** Confirms and deletes a chat with its transcript; the server refuses while a process is working on it. */
export function useDeleteChat(onDeleted?: () => void) {
  const { t } = useTranslation('chat');
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const mutation = useMutation({
    mutationFn: (chat: Pick<ChatSummary, 'id' | 'title'>) => api.deleteChat(chat.id),
    onSuccess: (_result, chat) => {
      void queryClient.invalidateQueries({ queryKey: keys.chats });
      void queryClient.removeQueries({ queryKey: keys.chatScope(chat.id) });
      toast.success(t('delete.deleted'), chat.title);
      onDeleted?.();
    },
    onError: (err) => toast.error(t('delete.failed'), err),
  });

  const requestDelete = (chat: Pick<ChatSummary, 'id' | 'title' | 'messageCount'>) =>
    void confirm({
      title: t('delete.title'),
      body: (
        <>
          <p className="strong break">{chat.title}</p>
          <p>{t('delete.body', { count: chat.messageCount })}</p>
        </>
      ),
      confirmLabel: t('delete.confirm'),
      danger: true,
    }).then((ok) => ok && mutation.mutate(chat));

  return { requestDelete, isPending: mutation.isPending };
}
