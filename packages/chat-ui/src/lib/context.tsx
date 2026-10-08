import { createContext, useContext, type ComponentType, type ReactElement, type ReactNode } from 'react';
import type {
  AgentTranscript,
  Attachment,
  BackgroundTaskOutput,
  Chat,
  ChatBackgroundTask,
  ChatDetail,
  ChatMessageRequest,
  ChatMessageResponse,
  ChatSummary,
  ForkChatRequest,
  McpSelection,
  PermissionMode,
  PermissionDecision,
  PermissionRequest,
  ResumeChatRequest,
} from '@agentry/shared';
import { RUN_TAG } from './chat-pages';

/** What a resume or a fork may start with; a key left out keeps what the chat had. */
export interface StartChoices {
  /** `null` asks for no preset at all: not the default on a new chat, not the one it had on a resume */
  toolPreset?: string | null;
  /** `null` goes back to the servers the CLI loads on its own, an object picks exactly those */
  mcp?: McpSelection | null;
  permissionMode?: PermissionMode;
  model?: string;
}

/** What the chat package asks of the server. `api` in apps/web satisfies it, plus two URL builders. */
export interface ChatClient {
  chat(id: string, sidechains: boolean, page?: { limit?: number; before?: number }, o?: { signal?: AbortSignal }): Promise<ChatDetail>;
  chatPermissions(id: string): Promise<PermissionRequest[]>;
  chatTasks(id: string): Promise<ChatBackgroundTask[]>;
  answerPermission(id: string, requestId: string, decision: PermissionDecision): Promise<unknown>;
  sendMessage(id: string, req: ChatMessageRequest): Promise<ChatMessageResponse>;
  resumeChat(id: string, req: ResumeChatRequest): Promise<ChatSummary>;
  forkChat(id: string, req: ForkChatRequest): Promise<ChatSummary>;
  deleteChat(id: string): Promise<{ ok: true }>;
  uploadFile(file: File): Promise<Attachment>;
  subagent(chatId: string, agentId: string, after?: number): Promise<AgentTranscript>;
  workflowAgent(chatId: string, workflowId: string, agentId: string, after?: number): Promise<AgentTranscript>;
  taskOutput(chatId: string, taskId: string, offset?: number): Promise<BackgroundTaskOutput>;
  /** The SSE URL of one chat's stream, with the token when the wrapper is guarded. */
  streamUrl(chatId: string, since: number): string;
  /** Where an upload's bytes are served (`/api/uploads/:id/content` today). */
  contentUrl(uploadId: string): string;
}

export interface ChatUiConfig {
  client: ChatClient;
  /** The name of the agent a chat runs on, as the person reads it: the app derives it from the provider's label. */
  agentNameFor(chat: ChatSummary): string;
  /** The app's polling fallback while its event feed is down (useFallbackInterval), as a value. */
  fallbackInterval: number | false;
  paths: {
    /** '/chats/:id', after a fork */
    chat(id: string): string;
    /** The review screen at one step */
    chatChangeStep(chatId: string, stepId: string): string;
  };
  slots: {
    StartOptions: ComponentType<{ chat: Chat; value: StartChoices; onChange(next: StartChoices): void; forking: boolean }>;
    LiveOptions: ComponentType<{ chat: Chat }>;
  };
}

const ChatUiContext = createContext<ChatUiConfig | null>(null);

export function ChatUiProvider({ value, children }: { value: ChatUiConfig; children: ReactNode }): ReactElement {
  return <ChatUiContext.Provider value={value}>{children}</ChatUiContext.Provider>;
}

/** Throws outside the provider: a chat component without a client is a wiring bug, not a state. */
export function useChatUi(): ChatUiConfig {
  const config = useContext(ChatUiContext);
  if (!config) throw new Error('useChatUi needs a ChatUiProvider above it');
  return config;
}

/**
 * The keys the chat package reads and writes. `lib/events.ts` invalidates by prefix, so each
 * prefix travels with the keys under it (`agentDetail` with `agent`, `taskOutput` with `output`).
 * apps/web spreads them into `keys`, unchanged.
 */
export const chatKeys = {
  chats: ['chats'] as const,
  /** Prefix of a chat's page and of everything read for it */
  chatScope: (id: string) => ['chat', id] as const,
  chat: (id: string, sidechains: boolean) => ['chat', id, sidechains] as const,
  /** The pages of a chat read back from its newest one, kept across visits */
  chatEarlier: (id: string, sidechains: boolean) => ['chat', id, sidechains, RUN_TAG] as const,
  chatPermissions: (id: string) => ['chat', id, 'permissions'] as const,
  chatTasks: (chatId: string) => ['tasks', 'chat', chatId] as const,
  agentDetail: ['agent-detail'] as const,
  agent: (chatId: string, workflowId: string, agentId: string) => ['agent-detail', chatId, workflowId, agentId] as const,
  taskOutput: ['task-output'] as const,
  output: (chatId: string, taskId: string) => ['task-output', chatId, taskId] as const,
};
