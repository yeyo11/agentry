import type { OrchestrationTaskStatus, WorkItem } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { api, keys } from '../../../api';
import { useFallbackInterval } from '../../../lib/feed';
import { workItemLiveState } from '../../../lib/work-items';

/** The same list the shell's Live section reads, so a board adds no request of its own. */
const LIVE_LIMIT = 10;

export interface LiveSources {
  chats: ReadonlyArray<{ id: string; activity?: unknown }>;
  orchestrations: ReadonlyArray<{ id: string; tasks: ReadonlyArray<{ id: string; status: OrchestrationTaskStatus }> }>;
}

/**
 * What the live strips need to say what they are doing: the working chats (for the tool and the
 * time) and the orchestrations (for the node and the graph's progress). Read only while a card is
 * live, with the shell's own query keys, so the sidebar and the board share one answer. A team
 * member's run carries its own activity (`FlowRun.activity`) and needs neither.
 */
export function useLiveSources(items: readonly Pick<WorkItem, 'activeLink'>[]): LiveSources {
  const fallback = useFallbackInterval();
  const chats = items.some((item) => item.activeLink?.chatId && workItemLiveState(item) === 'working');
  const nodes = items.some((item) => item.activeLink?.orchestrationId && item.activeLink.taskStatus === 'running');
  const working = useQuery({
    queryKey: keys.chatList({ state: 'working', limit: LIVE_LIMIT }),
    queryFn: ({ signal }) => api.chats({ state: 'working', limit: LIVE_LIMIT }, { signal }),
    enabled: chats,
    refetchInterval: fallback,
  });
  const orchestrations = useQuery({ queryKey: keys.orchestrations, queryFn: api.orchestrations, enabled: nodes, refetchInterval: fallback });
  return { chats: chats ? (working.data ?? []) : [], orchestrations: nodes ? (orchestrations.data ?? []) : [] };
}
