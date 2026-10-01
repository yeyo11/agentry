import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import type { ProviderId } from '@agentry/shared';
import { upperFirst } from '@agentry/chat-ui/lib/agent';
import { useTranslation } from 'react-i18next';
import { useProviders } from './providers';

const AgentContext = createContext<string | null>(null);

/**
 * Says whose work the screens below show (a chat's review), so their copy names its agent with the
 * provider's label. Only the scope reads `/providers`: a screen with no scope, a task's or an
 * integration branch's, says "the agent" and asks for nothing.
 */
export function AgentProviderScope({ provider, children }: { provider: ProviderId | null | undefined; children: ReactNode }): ReactElement {
  const providers = useProviders();
  const label = provider ? (providers.data?.find((p) => p.id === provider)?.label ?? null) : null;
  return <AgentContext.Provider value={label}>{children}</AgentContext.Provider>;
}

/** The `{{agent}}` of a string about a chat's work; `Agent` is for a string that opens a sentence. */
export function useAgentCopy(): { agent: string; Agent: string } {
  const { t } = useTranslation('chat');
  const agent = useContext(AgentContext) ?? t('agent.generic');
  return { agent, Agent: upperFirst(agent) };
}
