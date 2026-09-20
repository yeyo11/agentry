import type { ChatSummary } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { chatApi, chatKeys } from '../lib/chats';
import { useConfirm } from './Dialog';
import { useToast } from './Toast';

/** Confirms and deletes a chat with its transcript; the server refuses while a process is working on it. */
export function useDeleteChat(onDeleted?: () => void) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const mutation = useMutation({
    mutationFn: (chat: Pick<ChatSummary, 'id' | 'title'>) => chatApi.remove(chat.id),
    onSuccess: (_result, chat) => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.lists });
      void queryClient.removeQueries({ queryKey: chatKeys.chat(chat.id) });
      toast.success('Chat deleted', chat.title);
      onDeleted?.();
    },
    onError: (err) => toast.error('Could not delete the chat', err),
  });

  const requestDelete = (chat: Pick<ChatSummary, 'id' | 'title' | 'messageCount'>) =>
    void confirm({
      title: 'Delete this chat?',
      body: (
        <>
          <p className="strong break">{chat.title}</p>
          <p>
            The transcript ({chat.messageCount} messages) is removed from disk and the chat can no longer be resumed or forked. This
            cannot be undone.
          </p>
        </>
      ),
      confirmLabel: 'Delete chat',
      danger: true,
    }).then((ok) => ok && mutation.mutate(chat));

  return { requestDelete, isPending: mutation.isPending };
}
