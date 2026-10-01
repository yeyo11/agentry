import type { WorkItemDetail, WorkItemPullRequest } from '@agentry/shared';
import { Check, CircleAlert, ExternalLink, GitPullRequest, Hourglass, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@agentry/ui/components/icons';
import { notReadyReason, pullRequestErrorKey } from '../../../lib/work-items';
import { CiBadge, NotReadyNote, reasonValues, useChangeRequestWords, useOpenPullRequest } from '../board/PullRequest';
import { AddressReview } from './AddressReview';
import { Checks } from './Checks';
import { Review } from './Review';
import { pullRequestAction, pullRequestPanel } from './model';

const BADGE = { size: 11, strokeWidth: 2, 'aria-hidden': true } as const;

/** `PR #123` or `MR !7` in mono with tabular figures, the way its host writes it; `PR` before the host numbered it. */
function PrNumber({ pr }: { pr: Pick<WorkItemPullRequest, 'number' | 'host' | 'ref'> }) {
  const { t } = useTranslation('tasks');
  const words = useChangeRequestWords(pr.host);
  return <span className="item-pr-num">{pr.number === null ? t('pr.unnumbered', { noun: words.noun }) : t('pr.number', { noun: words.noun, ref: words.ref(pr.number, pr.ref) })}</span>;
}

/**
 * The item's pull request under its Changes (the PR row): its number, its branch into the default
 * one and its state, the whole row a plain link to it on its host. Only once the host gave it a number
 * and an address; before that, the panel above says what is happening.
 */
export function PullRequestRow({ pr }: { pr: WorkItemPullRequest | null | undefined }) {
  const { t } = useTranslation(['workItem', 'tasks']);
  if (!pr || pr.number === null || !pr.url) return null;
  let state: ReactNode = null;
  if (pr.phase === 'open') state = <CiBadge ci={pr.ci} />;
  else if (pr.phase === 'merged')
    state = (
      <span className="badge badge-ok">
        <Check {...BADGE} />
        {t('pr.state.merged')}
      </span>
    );
  else if (pr.phase === 'closed') state = <span className="badge">{t('pr.state.closed')}</span>;
  return (
    <a className="item-pr" href={pr.url} target="_blank" rel="noreferrer">
      <GitPullRequest {...ICON_SM} />
      <PrNumber pr={pr} />
      <span className="item-pr-branch">{t('pr.branches', { branch: pr.branch, base: pr.base })}</span>
      {state}
      <ExternalLink {...ICON_SM} className="item-pr-out" />
    </a>
  );
}

/**
 * What the item's pull request is doing and what the person can do about it, beside the waiting
 * panel (`.item-wait`): being prepared, conflicted (with the paths in mono), approved until QA
 * passes, waiting for the person's merge with its CI, closed or failed (with the approval again), or
 * the offer to open one; in a project that cannot, why, in warn and in words, with git's or the CLI's
 * line as its title. Nothing here moves: Agentry prepares a PR, no agent works on it.
 *
 * Before any PR exists (`offer`, `not-ready`) it is one quiet line, not a panel: the head already
 * says the item waits for the person and carries "Move to Done", so a boxed panel with a status
 * badge of its own would be a second headline for the same wait. The line adds only what the head
 * does not say, the PR it can open or why it cannot (DesktopTarea draws no approval panel).
 */
function PullRequestPanel({ item }: { item: WorkItemDetail }) {
  const { t } = useTranslation(['workItem', 'tasks']);
  const { t: tt } = useTranslation('tasks');
  const open = useOpenPullRequest();
  const readiness = item.pullRequestReadiness ?? null;
  const pr = item.pullRequest ?? null;
  const words = useChangeRequestWords(pr?.host ?? readiness?.host);
  const panel = pullRequestPanel(item, readiness);
  if (!panel) return null;
  const ref = words.ref(pr?.number ?? null, pr?.ref);
  const named = { noun: words.noun, host: words.host };
  const action = pullRequestAction(item, panel, readiness);
  const base = pr?.base ?? readiness?.defaultBranch ?? 'main';

  let badge: ReactNode = null;
  let why: ReactNode = null;
  let hint: string | null = null;
  let detail: string | null = null;
  let files: string[] = [];
  let extra: ReactNode = null;
  switch (panel) {
    case 'merge':
      badge = (
        <span className="badge badge-idle">
          <Hourglass {...BADGE} />
          {t('pr.mergeBadge')}
        </span>
      );
      why = pr && pr.number !== null ? t('pr.mergeWhy', { ...named, ref }) : t('pr.mergeWhyUnnumbered', named);
      hint = t('pr.mergeHint');
      extra = <CiBadge ci={pr?.ci} />;
      break;
    case 'preparing':
      badge = (
        <span className="badge">
          <GitPullRequest {...BADGE} />
          {t('pr.preparingBadge')}
        </span>
      );
      why = t('pr.preparingWhy', { base, ...named });
      break;
    case 'conflict':
      badge = (
        <span className="badge badge-warn">
          <CircleAlert {...BADGE} />
          {t('pr.conflictBadge')}
        </span>
      );
      files = pr?.conflicts ?? [];
      why = t('pr.conflictWhy', { base, count: files.length });
      hint = t('pr.conflictHint');
      break;
    case 'awaiting':
      badge = (
        <span className="badge">
          <Check {...BADGE} />
          {t('pr.awaitingBadge')}
        </span>
      );
      why = t('pr.awaitingWhy', named);
      files = pr?.conflicts ?? [];
      break;
    case 'closed':
      badge = (
        <span className="badge badge-idle">
          <Hourglass {...BADGE} />
          {t('pr.closedBadge')}
        </span>
      );
      why = pr && pr.number !== null ? t('pr.closedWhy', { ...named, ref }) : t('tasks:pr.closed');
      hint = t('pr.closedHint', named);
      break;
    case 'failed':
      badge = (
        <span className="badge badge-bad">
          <X {...BADGE} />
          {t('pr.failedBadge')}
        </span>
      );
      why = t('pr.failedWhy', { ...named, reason: tt(pullRequestErrorKey(pr?.error?.code ?? 'unknown'), { ...reasonValues(tt, readiness ?? { host: pr?.host ?? null, hostname: null }), host: words.host }) });
      detail = pr?.error?.detail || null;
      break;
    case 'kept':
      badge = (
        <span className="badge badge-warn">
          <CircleAlert {...BADGE} />
          {t('pr.keptBadge')}
        </span>
      );
      why = t('pr.keptWhy');
      detail = pr?.error?.detail || null;
      break;
    case 'offer':
    case 'not-ready':
      return (
        <div className={`item-wait is-quiet item-pr-wait is-${panel}`}>
          {panel === 'not-ready' ? (
            <NotReadyNote readiness={readiness} />
          ) : (
            <>
              <span className="item-wait-why">{item.waiting === 'approval' ? t('pr.approveWhy', { base, ...named }) : t('pr.offerWhy', { base, ...named })}</span>
              {action && (
                <button type="button" className="btn btn-small workitem-open-pr" disabled={open.isPending} onClick={() => open.mutate(item)}>
                  <GitPullRequest {...ICON_SM} />
                  {action === 'approve' ? t('tasks:pr.approve', named) : t('tasks:pr.open', named)}
                </button>
              )}
            </>
          )}
        </div>
      );
  }
  // A PR that closed or failed in a project that since lost what it needs says that too
  const lost = (panel === 'closed' || panel === 'failed') && notReadyReason(readiness);

  return (
    <section className={`item-wait item-pr-wait is-${panel}`} aria-label={t('pr.label', named)}>
      <div className="item-wait-head">
        {badge}
        <span className="item-wait-why">{why}</span>
        {extra}
      </div>
      {files.length > 0 && (
        <ul className="item-wait-files">
          {files.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      )}
      {detail && <p className="item-wait-detail">{detail}</p>}
      {lost && <NotReadyNote readiness={readiness} />}
      {hint && <p className="small muted item-wait-hint">{hint}</p>}
      {(action || (panel === 'merge' && pr?.url)) && (
        <div className="item-wait-actions">
          {panel === 'merge' && pr?.url && (
            <a className="btn btn-small item-pr-link" href={pr.url} target="_blank" rel="noreferrer">
              <ExternalLink {...ICON_SM} />
              {pr.number === null ? t('tasks:pr.linkUnnumbered', named) : t('tasks:pr.link', { ...named, ref })}
            </a>
          )}
          {action && (
            <button type="button" className="btn btn-small workitem-open-pr" disabled={open.isPending} onClick={() => open.mutate(item)}>
              <GitPullRequest {...ICON_SM} />
              {action === 'approve' ? t('tasks:pr.approve', named) : t('tasks:pr.open', named)}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** The panel of what the item's PR is doing, under it its review and the review comments waiting for an agent, and the checks of the PR while it is open. */
export function PullRequestState({ item }: { item: WorkItemDetail }) {
  return (
    <>
      <PullRequestPanel item={item} />
      <Review pr={item.pullRequest} itemId={item.id} changesPath={`/tasks/${item.key}/changes`} />
      <AddressReview pr={item.pullRequest} />
      <Checks pr={item.pullRequest} itemId={item.id} />
    </>
  );
}
