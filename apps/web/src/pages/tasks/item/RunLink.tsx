import type { ChatSummary, FlowRun, WorkItemDetail, WorkItemLink, WorkItemStatus } from '@agentry/shared';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON_SM } from '@agentry/ui/components/icons';
import { formatCost, formatDateTime, timeAgo } from '@agentry/ui/lib/format';
import { columnMeta } from '../../../lib/work-items';
import { RoleAvatar } from '../../team/RoleAvatar';
import { linkEffect, shortId } from './model';
import { RawError, RunStatusBadge, useFailureReason, useRetryRun, useRunTitle } from './RunParts';
import { retryOutcome, runStatus } from './runs';

/**
 * A chat the flow ran for one of its members, told by its run rather than by its chat (decision 8):
 * the role's squircle leads, the run is named by what the role does ("QA verifies AGN-26"), and its
 * badge is the run's outcome, since a failed run leaves its chat reading "completed". A failure says
 * why in the person's words, with the core's raw text under it in mono.
 * A run no chat link stands for (queued, or failed before its chat started) is drawn the same way,
 * without a link: it says it has no chat instead of naming one.
 */
export function RunLinkRow({
  link,
  run,
  item,
  chat,
  latest,
}: {
  link: WorkItemLink | null;
  run: FlowRun;
  item: WorkItemDetail;
  chat: ChatSummary | undefined;
  latest: boolean;
}) {
  const { t } = useTranslation('workItem');
  const { t: tt } = useTranslation('tasks');
  const title = useRunTitle();
  const reasonOf = useFailureReason();
  const status = runStatus(run);
  const reason = reasonOf(run);
  const retry = useRetryRun(item.id);
  const next = reason ? retryOutcome(run) : null;
  const effect = link ? linkEffect(link, item.history) : null;
  const at = run.endedAt ?? run.startedAt ?? run.queuedAt;
  const cost = chat ? chat.cost.usd : undefined;
  // What the run left the item in: nothing moved on a failure, and a verification that passed leaves
  // the move to Done to the person, which is what the item waits for while it is the latest one
  const said =
    status === 'failed'
      ? t('run.noMove')
      : status === 'passed' && latest && run.stage === 'verify' && item.waiting === 'approval'
        ? t('run.waitsApproval')
        : !effect
          ? null
          : effect.key === 'link.moved'
            ? t(effect.key, { to: tt(columnMeta(effect.values.to as WorkItemStatus).label) })
            : t(effect.key);
  const chatId = run.chatId ?? link?.chatId ?? null;
  const href = chatId ? `/chats/${chatId}` : null;
  return (
    <div className={`work-link-row is-run ${status === 'running' ? 'live-rail' : ''}`.trim()}>
      <RoleAvatar role={run.role} />
      <span className="work-link-body">
        {href ? (
          <Link to={href} className="work-link-name">
            {title(run, item.key)}
          </Link>
        ) : (
          <span className="work-link-name">{title(run, item.key)}</span>
        )}
        <span className="work-link-state">
          <RunStatusBadge run={run} />
          {cost !== undefined && <span className="mono small muted tnum">{cost === null ? t('link.noCost') : formatCost(cost)}</span>}
        </span>
        {reason && <span className="work-link-why">{reason}</span>}
        {/* Under the reason, as every failed run is told (design-system.md, "Copy"): the reason is
            the person's words, the raw text is what the core or the CLI said, and both are kept */}
        {reason && <RawError run={run} className="work-link-raw" />}
        {/* Then what comes of the failure (work-items.md, "Links"): what the retry did, or the retry
            while the run can still be queued again */}
        {next && (
          <span className="work-link-retried">
            {t('run.retriedLead')} <b className={next.status === 'passed' ? 'text-ok' : next.status === 'failed' ? 'text-bad' : ''}>{t(`run.status.${next.status}`)}</b>{' '}
            {next.chatId && next.chatId !== run.chatId
              ? t('run.retriedWhen', { when: next.at ? timeAgo(next.at) : '', chat: shortId(next.chatId) }).trimStart()
              : t('run.retriedNoChat', { when: next.at ? timeAgo(next.at) : '' }).trimStart()}
          </span>
        )}
        {reason && !next && run.retryable && (
          <span className="work-link-acts">
            <button type="button" className="btn btn-small work-link-retry" disabled={retry.isPending} onClick={() => retry.mutate(run.id)}>
              <RotateCcw {...ICON_SM} />
              {t('run.retry')}
            </button>
          </span>
        )}
        <span className="work-link-meta">
          {chatId ? t('link.chat', { id: shortId(chatId) }) : t('run.noChat')} · {t('run.flowRun')} ·{' '}
          <time dateTime={at} title={formatDateTime(at)}>
            {timeAgo(at)}
          </time>
          {said && ` · ${said}`}
        </span>
      </span>
    </div>
  );
}

/** Whether no later run of the same stage exists on the item: runs come newest first. */
export function latestOfStep(run: FlowRun, runs: readonly FlowRun[]): boolean {
  return runs.find((other) => other.stage === run.stage && other.column === run.column) === run;
}
