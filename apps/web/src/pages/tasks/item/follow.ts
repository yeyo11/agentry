import type { ReviewThread, WorkItemPullRequest } from '@agentry/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { answeredWith, followUp, followUpThreads } from '../../../lib/reviews';

const shortSha = (sha: string | null | undefined): string => (sha ?? '').slice(0, 7);

/** The threads of an open change request: the one read the strip, the dialog, the follow-up and the lead share. */
export function useChangeRequestThreads(pr: Pick<WorkItemPullRequest, 'id' | 'phase'> | null | undefined) {
  const id = pr?.phase === 'open' ? pr.id : undefined;
  return useQuery({
    queryKey: keys.changeRequestThreads(id ?? ''),
    queryFn: ({ signal }) => api.changeRequestThreads(id ?? '', false, { signal }),
    enabled: !!id,
    // A host that does not serve threads leaves the strip out, rather than an error on every item
    retry: false,
  });
}

/** Threads whose follow-up the person closed: kept in the query cache so the block and the lead agree on them. */
export function useDismissedThreads(id: string | undefined): { dismissed: ReadonlySet<string>; dismiss: (ids: string[]) => void } {
  const qc = useQueryClient();
  const key = ['follow-up-dismissed', id ?? ''] as const;
  const list = useQuery<string[]>({ queryKey: key, queryFn: () => [], initialData: [], staleTime: Infinity, enabled: false });
  return {
    dismissed: new Set(list.data),
    dismiss: (ids) => qc.setQueryData<string[]>(key, (current) => [...new Set([...(current ?? []), ...ids])]),
  };
}

/**
 * The threads a pushed fix answered that still wait for a reply or a resolve. A thread already
 * answered with the reply, that this person cannot resolve, has nothing left to offer; and one they
 * can resolve is offered Resolve alone, since the reply is on the host and is not posted again.
 */
export function useFollowUp(pr: WorkItemPullRequest | null | undefined): { sha: string; threads: ReviewThread[]; dismiss: (ids: string[]) => void } | null {
  const { t } = useTranslation('workItem');
  const list = useChangeRequestThreads(pr);
  const { dismissed, dismiss } = useDismissedThreads(pr?.phase === 'open' ? pr.id : undefined);
  const done = pr?.phase === 'open' ? followUp(pr) : null;
  if (!done || !list.data) return null;
  const sha = shortSha(done.sha);
  const replyText = t('address.followUp.replyText', { sha });
  const threads = followUpThreads(list.data.threads, done.threadIds).filter((thread) => !dismissed.has(thread.id) && !(answeredWith(thread, replyText) && !thread.viewerCanResolve));
  return threads.length > 0 ? { sha, threads, dismiss } : null;
}
