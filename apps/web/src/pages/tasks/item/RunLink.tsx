import type { ChatSummary, FlowRun, WorkItemDetail, WorkItemLink, WorkItemStatus } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { formatCost, formatDateTime, timeAgo } from '@agentry/ui/lib/format';
import { columnMeta } from '../../../lib/work-items';
import { RoleAvatar } from '../../team/RoleAvatar';
import { linkEffect, shortId } from './model';
import { RawError, RunStatusBadge, useFailureReason, useRunTitle } from './RunParts';
import { failureReason, runStatus } from './runs';

/**
 * A chat the flow ran for one of its members, told by its run rather than by its chat (decision 8):
 * the role's squircle leads, the run is named by what the role does ("QA verifies AGN-26"), and its
 * badge is the run's outcome, since a failed run leaves its chat reading "completed". A failure says
 * why in the person's words; the core's raw text shows only when there is no cause to word it by.
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
        {reason && failureReason(run)?.key === 'run.cause.unknown' && <RawError run={run} className="work-link-raw" />}
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
