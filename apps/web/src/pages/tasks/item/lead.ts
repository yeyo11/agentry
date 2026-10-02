import type { WorkItemPullRequest } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { api, keys, useMergeState } from '../../../api';
import { fixStage } from '../../../lib/change-requests';
import { mergePrimary } from '../../../lib/merge';
import { partlyPost } from '../../../lib/reviews';
import { useFixOffered } from './Checks';
import { useFollowUp } from './follow';
import { leadingAction, type LeadingAction } from './model';
import { useReviewDrafts } from './Review';

/** The pull request zone's one gradient action, from the same reads its blocks make. */
export function useLeadingAction(pr: WorkItemPullRequest | null | undefined): LeadingAction | null {
  const open = pr?.phase === 'open' && pr.id ? pr.id : undefined;
  const fixOffered = useFixOffered(pr);
  const drafts = useReviewDrafts(pr).data?.length ?? 0;
  const merge = useMergeState(pr?.phase === 'open' && pr.number !== null ? pr.id : undefined).data;
  const posts = useQuery({ queryKey: keys.reviewPosts(open ?? ''), queryFn: ({ signal }) => api.reviewPosts(open ?? '', { signal }), enabled: !!open, retry: false });
  const follow = useFollowUp(pr);
  if (!pr || !open) return null;
  return leadingAction({
    pushWaiting: fixStage(pr) === 'push',
    publishWaiting: partlyPost(posts.data?.posts) !== null,
    replyWaiting: follow !== null,
    drafts,
    fixOffered,
    mergeOffered: mergePrimary(merge) !== null,
  });
}

/** The header's Work on it keeps its gradient only while nothing in the pull request zone leads. */
export const workOnItNeutral = (lead: LeadingAction | null): boolean => lead !== null;
