import type { BoardCheckout, CodeHostId, PullRequestNotReadyReason, PullRequestReadiness, WorkItem, WorkItemDetail, WorkItemPullRequestCi } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Clock, Minus, X } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, ApiRequestError, keys } from '../../../api';
import { useToast } from '../../../components/Toast';
import { changeRequestRef, changeRequestWords } from '../../../lib/code-hosts';
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

/**
 * The words one host's change request takes in a sentence of the `tasks` namespace: its noun
 * ("PR", "MR"), the host's own name, and a number written the way the host writes it (`#12`, `!7`).
 * Every string that used to say "PR" or "GitHub" takes these as `{{noun}}`, `{{host}}` and `{{ref}}`.
 */
export function useChangeRequestWords(host: CodeHostId | string | null | undefined) {
  const { t } = useTranslation('tasks');
  const words = changeRequestWords(host);
  return {
    noun: t(words.nounKey),
    /** The noun spelled out, for a sentence: "a merge request", never "a MR" */
    long: t(words.longKey),
    host: words.label,
    /** The number as its host writes it; the server's own `ref` wins; empty without a number */
    ref: (number: number | null, ref?: string | null): string => changeRequestRef(host, number, ref) ?? '',
  };
}

/** The command-line client a host is reached through; the name the readiness notes give. */
export const hostCli = (host: CodeHostId | string | null | undefined): 'gh' | 'glab' => (host === 'gitlab' ? 'glab' : 'gh');

export type TasksT = ReturnType<typeof useTranslation<'tasks'>>['t'];

/** What a readiness sentence names: the client, and the host as the remote spells it. */
export function reasonValues(t: TasksT, readiness: Pick<PullRequestReadiness, 'host' | 'hostname'> | null | undefined) {
  const host = readiness?.host ?? null;
  return { cli: hostCli(host), host: readiness?.hostname ?? (host ? changeRequestWords(host).label : t('pr.hostFallback')) };
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
    mutationFn: (item: Pick<WorkItem, 'id'> & { pullRequestReadiness?: PullRequestReadiness | null }) => api.openPullRequest(item.id),
    onSuccess: (result) => {
      qc.setQueryData<WorkItemDetail>(keys.workItem(result.item.id), (old) => (old ? { ...old, ...result.item } : old));
      void qc.invalidateQueries({ queryKey: keys.workItems });
    },
    onError: (error, item) => {
      const readiness = item.pullRequestReadiness;
      const noun = t(changeRequestWords(readiness?.host).nounKey);
      const code = error instanceof ApiRequestError ? error.code : undefined;
      const worded =
        code && (REFUSALS as readonly string[]).includes(code)
          ? t(`pr.refused.${code as (typeof REFUSALS)[number]}`, { noun })
          : code && pullRequestErrorKey(code).startsWith('pr.notReady.')
            ? t('pr.noPr', { noun, reason: t(pullRequestErrorKey(code) as `pr.notReady.${PullRequestNotReadyReason}`, reasonValues(t, readiness)) })
            : null;
      toast.error(t('pr.failed', { noun }), worded ? new ApiRequestError(worded, error instanceof ApiRequestError ? error.status : 0, error instanceof Error ? error.message : undefined) : error);
    },
  });
}

/**
 * Asks the host's CLI about an open pull request once when its item is shown, so the page does not wait for the
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

/**
 * Why the project offers no change request, in words and in warn, with the underlying line of the
 * checkout or the CLI as its title and the one thing to do about it as a link (an install or sign-in
 * page, the docs, or Settings → Integrations): never a command to copy.
 */
export function NotReadyNote({ readiness, className = '' }: { readiness: PullRequestReadiness | null | undefined; className?: string }) {
  const { t } = useTranslation('tasks');
  const reason = notReadyReason(readiness);
  if (!reason) return null;
  const noun = t(changeRequestWords(readiness?.host).nounKey);
  const remedy = readiness?.remedy ?? null;
  const label = remedy ? t(`pr.remedy.${remedy.kind}`, { cli: hostCli(readiness?.host) }) : null;
  return (
    <span className={`pr-not-ready ${className}`.trim()} title={readiness?.detail ?? undefined}>
      <CircleAlert size={12} strokeWidth={2} aria-hidden />
      <span>
        {t('pr.noPr', { noun, reason: t(`pr.notReady.${reason}`, reasonValues(t, readiness)) })}
        {remedy && label && (
          <>
            {' '}
            {remedy.url ? (
              <a className="pr-not-ready-remedy" href={remedy.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                {label}
              </a>
            ) : remedy.kind === 'settings' ? (
              <Link className="pr-not-ready-remedy" to="/settings?tab=integrations" onClick={(event) => event.stopPropagation()}>
                {label}
              </Link>
            ) : null}
          </>
        )}
      </span>
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
