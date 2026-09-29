import type { WorkItemDetail, WorkItemPullRequest } from '@agentry/shared';
import { Check, CircleAlert, ExternalLink, GitPullRequest, Hourglass, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '../../../components/icons';
import { notReadyReason, pullRequestErrorKey } from '../../../lib/work-items';
import { CiBadge, NotReadyNote, useOpenPullRequest } from '../board/PullRequest';
import { pullRequestAction, pullRequestPanel } from './model';

const BADGE = { size: 11, strokeWidth: 2, 'aria-hidden': true } as const;

/** `PR #123` in mono with tabular figures; `PR` before GitHub numbered it. */
function PrNumber({ pr }: { pr: Pick<WorkItemPullRequest, 'number'> }) {
  const { t } = useTranslation('tasks');
  return <span className="item-pr-num">{pr.number === null ? t('pr.unnumbered') : t('pr.number', { number: String(pr.number) })}</span>;
}

/**
 * The item's pull request under its Changes (the PR row): its number, its branch into the default
 * one and its state, the whole row a plain link to it on GitHub. Only once GitHub gave it a number
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
 * the offer to open one; in a project that cannot, why, in warn and in words, with git's or gh's
 * line in mono. Nothing here moves: Agentry prepares a PR, no agent works on it.
 */
export function PullRequestState({ item }: { item: WorkItemDetail }) {
  const { t } = useTranslation(['workItem', 'tasks']);
  const open = useOpenPullRequest();
  const readiness = item.pullRequestReadiness ?? null;
  const panel = pullRequestPanel(item, readiness);
  if (!panel) return null;
  const pr = item.pullRequest ?? null;
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
      why = pr && pr.number !== null ? t('pr.mergeWhy', { number: String(pr.number) }) : t('pr.mergeWhyUnnumbered');
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
      why = t('pr.preparingWhy', { base });
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
      why = t('pr.awaitingWhy');
      files = pr?.conflicts ?? [];
      break;
    case 'closed':
      badge = (
        <span className="badge badge-idle">
          <Hourglass {...BADGE} />
          {t('pr.closedBadge')}
        </span>
      );
      why = pr && pr.number !== null ? t('pr.closedWhy', { number: String(pr.number) }) : t('tasks:pr.closed');
      hint = t('pr.closedHint');
      break;
    case 'failed':
      badge = (
        <span className="badge badge-bad">
          <X {...BADGE} />
          {t('pr.failedBadge')}
        </span>
      );
      why = t('pr.failedWhy', { reason: t(`tasks:${pullRequestErrorKey(pr?.error?.code ?? 'unknown')}`) });
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
      why = item.waiting === 'approval' ? t('pr.approveWhy', { base }) : t('pr.offerWhy', { base });
      break;
    case 'not-ready':
      badge = (
        <span className="badge badge-warn">
          <CircleAlert {...BADGE} />
          {t('pr.noPrBadge')}
        </span>
      );
      why = t(`tasks:pr.notReady.${notReadyReason(readiness) ?? 'no-remote'}`);
      detail = readiness?.detail || null;
      break;
  }
  // A PR that closed or failed in a project that since lost what it needs says that too
  const lost = (panel === 'closed' || panel === 'failed') && notReadyReason(readiness);

  return (
    <section className={`item-wait item-pr-wait is-${panel}`} aria-label={t('pr.label')}>
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
              {pr.number === null ? t('tasks:pr.linkUnnumbered') : t('tasks:pr.link', { number: String(pr.number) })}
            </a>
          )}
          {action && (
            <button type="button" className="btn btn-small workitem-open-pr" disabled={open.isPending} onClick={() => open.mutate(item)}>
              <GitPullRequest {...ICON_SM} />
              {action === 'approve' ? t('tasks:pr.approve') : t('tasks:pr.open')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
