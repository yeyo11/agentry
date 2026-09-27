import type { OrchestrationTaskStatus, WorkItem } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { ActivityTicker } from '../../../components/ActivityTicker';
import { ProgressBar } from '../../../components/ProgressBar';
import { Spinner } from '../../../components/Spinner';
import { useFallbackInterval } from '../../../lib/feed';
import { chatActivity, orchestrationProgress } from '../../../lib/shell-live';
import { workItemLiveState } from '../../../lib/work-items';

/** The same list the shell's Live section reads, so a board adds no request of its own. */
const LIVE_LIMIT = 10;

export interface LiveSources {
  chats: ReadonlyArray<{ id: string; activity?: unknown }>;
  orchestrations: ReadonlyArray<{ id: string; tasks: ReadonlyArray<{ id: string; status: OrchestrationTaskStatus }> }>;
}

/**
 * What the live cards need to say what they are doing: the working chats (for the tool and the time)
 * and the orchestrations (for the node and the graph's progress). Read only while a card is live,
 * with the shell's own query keys, so the sidebar and the board share one answer.
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

/**
 * The line a live card carries: a chat's verb, command and time, or an orchestration node's place
 * in its graph with the graph's segmented bar. A card whose chat waits for the person says so in
 * the idle tone and stands still. Nothing for an item at rest.
 */
export function LiveLine({ item, sources, className = '' }: { item: Pick<WorkItem, 'activeLink'>; sources: LiveSources; className?: string }) {
  const { t } = useTranslation('tasks');
  const state = workItemLiveState(item);
  const link = item.activeLink;
  if (!state || !link) return null;

  if (state === 'waiting')
    return (
      <div className={`workitem-card-live is-waiting ${className}`.trim()}>
        <span className="dot dot-idle" aria-hidden />
        <span className="workitem-live-idle">{t('card.waiting')}</span>
      </div>
    );

  if (link.orchestrationId) {
    const orchestration = sources.orchestrations.find((o) => o.id === link.orchestrationId);
    const index = orchestration ? orchestration.tasks.findIndex((task) => task.id === link.taskId) + 1 : 0;
    return (
      <div className={`workitem-card-live ${className}`.trim()}>
        <Spinner className="workitem-live-spin" />
        <span className="workitem-live-verb mono">
          {orchestration && index > 0 ? t('card.node', { index, total: orchestration.tasks.length }) : t('card.working')}
        </span>
        {orchestration && <ProgressBar variant="segments" size="sm" decorative counts={orchestrationProgress(orchestration.tasks)} className="workitem-live-bar" />}
      </div>
    );
  }

  const activity = chatActivity(sources.chats.find((chat) => chat.id === link.chatId) ?? {});
  if (activity)
    return (
      <div className={`workitem-card-live has-ticker ${className}`.trim()}>
        <ActivityTicker activity={activity} className="workitem-live-ticker" />
      </div>
    );
  return (
    <div className={`workitem-card-live ${className}`.trim()}>
      <Spinner className="workitem-live-spin" />
      <span className="workitem-live-verb">{t('card.working')}</span>
    </div>
  );
}
