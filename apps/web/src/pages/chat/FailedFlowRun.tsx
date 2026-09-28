import type { FlowRun, WorkItemDetail } from '@agentry/shared';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWorkItemRuns } from '../../api';
import { failedRunReason, linkRun } from '../tasks/item/model';
import { useRoleName } from '../team/RoleAvatar';

/**
 * A chat a member ran for the flow reads "completed" even when its run failed (no result, a limit
 * with no account left, a restart it could not continue from): the item it was for and why it
 * failed, as the core wrote it, so the chat is not taken for work that was done.
 */
export function FailedFlowRun({ item, chatId }: { item: WorkItemDetail; chatId: string }) {
  const flowMade = item.links.some((link) => link.kind === 'chat' && link.chatId === chatId && Boolean(link.teamRole));
  const runs = useWorkItemRuns(item.id, flowMade).data ?? [];
  return <FailedFlowRunNote item={item} chatId={chatId} runs={runs} />;
}

/** The note itself, from the item's runs, newest first. */
export function FailedFlowRunNote({ item, chatId, runs }: { item: Pick<WorkItemDetail, 'key'>; chatId: string; runs: readonly FlowRun[] }) {
  const { t } = useTranslation('chat');
  const roleName = useRoleName();
  const run = linkRun({ kind: 'chat', chatId }, runs);
  const why = failedRunReason(run);
  if (!run || why === null) return null;
  return (
    <div className="chat-run-failed" role="note">
      <TriangleAlert size={14} strokeWidth={2} aria-hidden className="chat-run-failed-icon" />
      <span className="chat-run-failed-text">
        <span className="badge badge-bad">{t('view.workItem.runFailed')}</span>{' '}
        {t('view.workItem.runFailedFor', { role: roleName(run.role), key: item.key })}
        {/* The core's reason, as it wrote it: messages from the API are not translated */}
        {why && <span className="chat-run-failed-why mono">{why}</span>}
      </span>
    </div>
  );
}
