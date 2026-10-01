import { lazy, useMemo, type ReactNode } from 'react';
import { api, BASE, enc } from '../api';
import { withToken } from './auth';
import { ChatUiProvider, type ChatClient, type ChatUiConfig } from '@agentry/chat-ui/lib/context';
import { reviewLink, reviewPath } from './changes-summary';
import { useFallbackInterval } from './feed';
import { useProviderLabel } from './provider-status';

/** `api`'s chat methods, plus the two URLs the chat package cannot build without knowing the base. */
export const chatClient: ChatClient = {
  chat: api.chat,
  chatPermissions: api.chatPermissions,
  chatTasks: api.chatTasks,
  answerPermission: api.answerPermission,
  sendMessage: api.sendMessage,
  resumeChat: api.resumeChat,
  forkChat: api.forkChat,
  deleteChat: api.deleteChat,
  uploadFile: api.uploadFile,
  subagent: api.subagent,
  workflowAgent: api.workflowAgent,
  taskOutput: api.taskOutput,
  streamUrl: (chatId, since) => withToken(`${BASE}/chats/${enc(chatId)}/stream?since=${since}`),
  contentUrl: (uploadId) => withToken(`${BASE}/uploads/${enc(uploadId)}/content`),
};

// Lazy here, so `Controls` stays its own chunk
const slots: ChatUiConfig['slots'] = {
  StartOptions: lazy(() => import('../pages/chat/Controls').then((m) => ({ default: m.StartOptions }))),
  LiveOptions: lazy(() => import('../pages/chat/Controls').then((m) => ({ default: m.LiveOptions }))),
};

const paths: ChatUiConfig['paths'] = {
  chat: (id) => `/chats/${enc(id)}`,
  chatChangeStep: (chatId, stepId) => reviewLink(reviewPath.chat(chatId), { lens: 'steps', step: stepId }),
};

/** Mounted around `<App />`: the detail panel, orchestrations, work items and Home use chat hooks too. */
export function AppChatUi({ children }: { children: ReactNode }) {
  const fallbackInterval = useFallbackInterval();
  const labelOf = useProviderLabel();
  const value = useMemo<ChatUiConfig>(
    () => ({ client: chatClient, agentNameFor: (chat) => labelOf(chat.provider), fallbackInterval, paths, slots }),
    [fallbackInterval, labelOf],
  );
  return <ChatUiProvider value={value}>{children}</ChatUiProvider>;
}
