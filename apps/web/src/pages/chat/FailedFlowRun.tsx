import type { FlowRun, WorkItemDetail } from '@agentry/shared';
import { Check, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON_SM } from '@agentry/ui/components/icons';
import { formatDateTime, timeAgo } from '@agentry/ui/lib/format';
import { taskPath } from '../../lib/work-items';
import { shortId } from '../tasks/item/model';
import { RawError, useFailureReason, useRetryRun } from '../tasks/item/RunParts';
import { rawError, retryOutcome, runStep } from '../tasks/item/runs';
import { useRoleName } from '../team/RoleAvatar';

/**
 * A chat a member ran for the flow reads "completed" even when its run failed (no result, no provider that could take it,
 * a limit that never reset, a restart it could not continue from). The banner at the head of the chat
 * (`.run-fail`, ChatFlujo) says so in the person's words, from the run's cause, with the core's raw
 * text under it; then what the retry did and its chat, or "Retry" while the run can still be queued
 * again. The item never moved, so the banner says that too.
 */
export function FailedFlowRunNote({ item, run, chatId = null }: { item: Pick<WorkItemDetail, 'id' | 'key'>; run: FlowRun | null; chatId?: string | null }) {
  const { t } = useTranslation(['chat', 'workItem']);
  const roleName = useRoleName();
  const reasonOf = useFailureReason();
  const retry = useRetryRun(item.id);
  const reason = run ? reasonOf(run) : null;
  if (!run || reason === null) return null;
  const next = retryOutcome(run);
  // The Developer continues its own chat, so a retry often ran in the chat being read: say when, and
  // offer no way back into the chat already open
  const elsewhere = next?.chatId && next.chatId !== chatId ? next.chatId : null;
  const role = roleName(run.role);
  return (
    <div className="chat-run-failed" role="status">
      <X size={16} strokeWidth={2} aria-hidden className="chat-run-failed-icon" />
      <div className="chat-run-failed-body">
        <span className="chat-run-failed-text">
          <b>{t(`workItem:run.failedHead.${runStep(run)}`)}</b> {reason} {t('workItem:run.commented', { role, key: item.key })}
        </span>
        <span className="chat-run-failed-why mono">
          <RawError run={run} />
          {run.endedAt && (
            <>
              {rawError(run) && ' · '}
              <time dateTime={run.endedAt} title={formatDateTime(run.endedAt)}>
                {timeAgo(run.endedAt)}
              </time>
            </>
          )}
        </span>
        {next && (
          <span className="chat-run-failed-next">
            {next.status === 'passed' && <Check size={13} strokeWidth={2.25} aria-hidden className="chat-run-failed-ok" />}
            <span>
              {t('workItem:run.retriedLead')} <b className={next.status === 'passed' ? 'text-ok' : next.status === 'failed' ? 'text-bad' : ''}>{t(`workItem:run.status.${next.status}`)}</b>{' '}
              {elsewhere
                ? t('workItem:run.retriedWhen', { when: next.at ? timeAgo(next.at) : '', chat: shortId(elsewhere) }).trimStart()
                : t('workItem:run.retriedNoChat', { when: next.at ? timeAgo(next.at) : '' }).trimStart()}
            </span>
          </span>
        )}
        <div className="chat-run-failed-acts">
          {elsewhere && (
            <Link to={`/chats/${elsewhere}`} className="btn btn-small">
              {t('view.workItem.openChat', { chat: shortId(elsewhere) })}
            </Link>
          )}
          {run.retryable && (
            <button type="button" className="btn btn-small chat-run-failed-retry" disabled={retry.isPending} onClick={() => retry.mutate(run.id)}>
              <RotateCcw {...ICON_SM} />
              {t('workItem:run.retry')}
            </button>
          )}
          {/* On a phone the row above is already the way to the item */}
          <Link to={taskPath(item.key)} className="btn btn-small chat-run-failed-quiet">
            {t('view.workItem.openItem', { key: item.key })}
          </Link>
        </div>
      </div>
    </div>
  );
}
