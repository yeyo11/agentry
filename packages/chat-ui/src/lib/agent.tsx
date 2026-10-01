import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import type { ChatSummary } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { useChatUi } from './context';

const AgentContext = createContext<string | null>(null);

/**
 * Says whose chat the components below belong to, so a transcript, a prompt or a composer names the
 * agent that is really running without each being handed a chat.
 */
export function AgentScope({ chat, children }: { chat: ChatSummary; children: ReactNode }): ReactElement {
  const { agentNameFor } = useChatUi();
  return <AgentContext.Provider value={agentNameFor(chat)}>{children}</AgentContext.Provider>;
}

/** The scope's agent; "the agent" where no chat is in context (a shared view, a bare transcript). */
export function useAgentName(): string {
  const { t } = useTranslation('chat');
  return useContext(AgentContext) ?? t('agent.generic');
}

/** A name that opens a sentence: "the agent" becomes "The agent"; a proper name is untouched. */
export function upperFirst(text: string): string {
  const [first = '', ...rest] = Array.from(text);
  return first.toLocaleUpperCase() + rest.join('');
}
