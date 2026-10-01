import type { BoardCheckout, PullRequestNotReadyReason, PullRequestReadiness, WorkItem, WorkItemDetail, WorkItemPullRequestCi } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Clock, Minus, X } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiRequestError, keys } from '../../../api';
import { useToast } from '../../../components/Toast';
import { checkoutNote, ciTone, notReadyReason, pullRequestErrorKey } from '../../../lib/work-items';

// The pieces of an item's pull request that the board and the item's page share
// (docs/plans/work-item-pull-requests.md): the project's readiness, the approval that opens it, the
// CI badge and the checkout's line.

const ReadinessContext = createContext<PullRequestReadiness | null>(null);

/** The board's project readiness, for the strips under it; null on All projects, where no project says. */
export const useBoardReadiness = (): PullRequestReadiness | null => useContext(ReadinessContext);

export function BoardReadinessProvider({ value, children }: { value: PullRequestReadiness | null | undefined; children: ReactNode }) {
  return <ReadinessContext.Provider value={value ?? null}>{children}</ReadinessContext.Provider>;
}

/** The refusals `POST /work-items/:itemId/pull-request` names with a code, each worded in `tasks:pr.refused`. */
const REFUSALS = ['not-in-review', 'busy', 'nothing-to-propose'] as const;

/**
 * Approving an item in a ready project: `POST /work-items/:itemId/pull-request`. The answer's item
 * goes into the page's cache and every board and list reads again; the steps that follow arrive on
 * the event feed. A refusal is a toast in the person's words, the server's English kept as detail.
 */
export function useOpenPullRequest() {
  const { t } = useTranslation('tasks');
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (item: Pick<WorkItem, 'id'>) => api.openPullRequest(item.id),
    onSuccess: (result) => {
      qc.setQueryData<WorkItemDetail>(keys.workItem(result.item.id), (old) => (old ? { ...old, ...result.item } : old));
      void qc.invalidateQueries({ queryKey: keys.workItems });
    },
    onError: (error) => {
      const code = error instanceof ApiRequestError ? error.code : undefined;
      const worded =
        code && (REFUSALS as readonly string[]).includes(code)
          ? t(`pr.refused.${code as (typeof REFUSALS)[number]}`)
          : code && pullRequestErrorKey(code).startsWith('pr.notReady.')
            ? t('pr.noPr', { reason: t(pullRequestErrorKey(code) as `pr.notReady.${PullRequestNotReadyReason}`) })
            : null;
      toast.error(t('pr.failed'), worded ? new ApiRequestError(worded, error instanceof ApiRequestError ? error.status : 0, error instanceof Error ? error.message : undefined) : error);
    },
  });
}

/**
 * Asks gh about an open pull request once when its item is shown, so the page does not wait for the
 * watcher's next pass to say it was merged or its CI turned. Quiet on failure: the watcher asks again.
 */
export function useRefreshPullRequestOnOpen(item: Pick<WorkItem, 'id' | 'pullRequest'>) {
  const qc = useQueryClient();
  const asked = useRef<string | null>(null);
  const open = item.pullRequest?.phase === 'open';
  useEffect(() => {
    if (!open || asked.current === item.id) return;
    asked.current = item.id;
    api
      .refreshPullRequest(item.id)
      .then((fresh) => qc.setQueryData<WorkItemDetail>(keys.workItem(fresh.id), (old) => (old ? { ...old, ...fresh } : old)))
      .catch(() => undefined);
  }, [open, item.id, qc]);
}

const CI_ICON = { passing: Check, pending: Clock, failing: X, none: Minus } as const;

/** A PR's checks as a badge with its word: passing ok, failing bad, pending and none neutral and still. */
export function CiBadge({ ci }: { ci: WorkItemPullRequestCi | null | undefined }) {
  const { t } = useTranslation('tasks');
  if (!ci) return null;
  const tone = ciTone(ci);
  const Icon = CI_ICON[ci];
  return (
    <span className={`badge pr-ci ${tone ? `badge-${tone}` : ''}`.trim()} data-ci={ci}>
      <Icon size={11} strokeWidth={2} aria-hidden />
      {t(`pr.ci.${ci}`)}
    </span>
  );
}

/** Why the project offers no pull request, in words and in warn, with git's or gh's own line as its title. */
export function NotReadyNote({ readiness, className = '' }: { readiness: PullRequestReadiness | null | undefined; className?: string }) {
  const { t } = useTranslation('tasks');
  const reason = notReadyReason(readiness);
  if (!reason) return null;
  return (
    <span className={`pr-not-ready ${className}`.trim()} title={readiness?.detail ?? undefined}>
      <CircleAlert size={12} strokeWidth={2} aria-hidden />
      {t('pr.noPr', { reason: t(`pr.notReady.${reason}`) })}
    </span>
  );
}

/**
 * One quiet line under the board's toolbar while the project's checkout is behind its default branch,
 * with the reason Agentry did not bring it forward. Never a command to copy.
 */
export function CheckoutLine({ checkout }: { checkout: BoardCheckout | null | undefined }) {
  const { t } = useTranslation('tasks');
  const note = checkoutNote(checkout);
  if (!note) return null;
  const behind = t('checkout.behind', { count: note.count, base: note.base });
  const text = note.reason ? t('checkout.withReason', { behind, reason: t(`checkout.reason.${note.reason}`, { base: note.base, branch: note.branch ?? '' }) }) : behind;
  return (
    <p className="workitem-checkout-note" role="note">
      <CircleAlert size={13} strokeWidth={1.75} aria-hidden />
      <span>{text}</span>
    </p>
  );
}
