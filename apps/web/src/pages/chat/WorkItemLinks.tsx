import type { FlowStep, WorkItemDetail } from '@agentry/shared';
import { useQueries } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useChatWorkItems, useWorkItemRuns } from '../../api';
import { WorkItemKey, WorkItemStatusIcon } from '../../components/work-item-icons';
import { ProgressBar } from '@agentry/ui/components/ProgressBar';
import { byChatRole, chatItemRole, criteriaProgress, movesToReviewOnEnd, type ChatItemRole } from '../../lib/work-item-links';
import { columnMeta, taskPath } from '../../lib/work-items';
import { linkRun } from '../tasks/item/model';
import { runStep } from '../tasks/item/runs';
import { RoleAvatar } from '../team/RoleAvatar';
import { FailedFlowRunNote } from './FailedFlowRun';
import { Section } from './Side';

/** A work item this chat is linked to, and the part the chat played in it. */
export interface ChatItemLink {
  item: WorkItemDetail;
  role: ChatItemRole;
  /** Whether the end of the chat's turn takes the item to In review; a flow run that refines or verifies it does not */
  movesOnEnd: boolean;
}

/**
 * The work items a chat is linked to, the ones it works on first. A chat's list of items does not
 * say what part it played, so each item is read whole, under the key its page uses: the chat and
 * the item's page share one request, and the event feed keeps both current. A chat linked to nothing
 * costs the one list request and no more.
 */
export function useChatItemLinks(chatId: string): ChatItemLink[] {
  const { data: items } = useChatWorkItems(chatId);
  const details = useQueries({
    queries: (items ?? []).map((item) => ({
      queryKey: keys.workItem(item.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.workItem(item.id, { signal }),
    })),
  });
  const links: ChatItemLink[] = [];
  for (const { data: item } of details) {
    const role = item ? chatItemRole(item, chatId) : null;
    if (item && role) links.push({ item, role, movesOnEnd: movesToReviewOnEnd(item, chatId) });
  }
  return byChatRole(links);
}

/**
 * The flow's part in this chat, when a member ran it: the member's role and the step, from the run
 * (`refine` in To do is a check), or from the link while the runs load. Null for a person's chat.
 */
function useFlowPart(item: WorkItemDetail, chatId: string) {
  const link = item.links.find((l) => l.kind === 'chat' && l.chatId === chatId && Boolean(l.teamRole));
  const runs = useWorkItemRuns(item.id, Boolean(link)).data ?? [];
  if (!link?.teamRole) return null;
  const run = linkRun({ kind: 'chat', chatId }, runs);
  const step: FlowStep = run ? runStep(run) : link.role === 'refine' ? 'refine' : link.role === 'verify' ? 'verify' : 'work';
  return { role: run?.role ?? link.teamRole, step, run };
}

/**
 * The row under a chat's header that names the work item it works on, as `PartOf` names an
 * orchestration: "Works on AGN-28 *title* · In progress · criteria 2/5". The title is the link and
 * its box covers the row, so the whole line opens the item. A chat an item was created from says so
 * instead, in the same row. A flow run's chat leads with its role's squircle and names the step
 * ("Verification of AGN-26"), and when its run failed the banner under it says why.
 */
export function WorkItemPartOf({ link, chatId }: { link: ChatItemLink; chatId: string }) {
  const { t } = useTranslation(['chat', 'tasks']);
  const { item, role } = link;
  const criteria = criteriaProgress(item);
  const flow = useFlowPart(item, chatId);
  const lead = flow && flow.step !== 'work' ? t(`view.workItem.step.${flow.step}`) : t(role === 'work' ? 'view.workItem.works' : 'view.workItem.origin');
  return (
    <>
      <div className={`chat-part-of chat-part-of-item ${flow ? 'is-flow' : ''}`.trim()}>
        {flow && <RoleAvatar role={flow.role} size="sm" />}
        <span className="chat-part-of-text">
          <span className="chat-part-of-lead">
            <span className="muted">{lead}</span> <WorkItemKey value={item.key} boxed />
          </span>{' '}
          <Link to={taskPath(item.key)} className="chat-part-of-name">
            {item.title}
          </Link>
        </span>
        <span className="chat-part-of-state">
          <WorkItemStatusIcon status={item.status} decorative />
          {t(`tasks:${columnMeta(item.status).label}`)}
        </span>
        {criteria.total > 0 && <span className="chat-part-of-where mono chat-part-of-criteria">{t('view.workItem.criteria', criteria)}</span>}
      </div>
      {flow && <FailedFlowRunNote item={item} run={flow.run} />}
    </>
  );
}

/** The inspector's card for the item the chat works on: its key, where it stands, and what the end of the turn does to it. */
export function WorkItemCard({ link }: { link: ChatItemLink }) {
  const { t } = useTranslation(['chat', 'tasks']);
  const { item, movesOnEnd } = link;
  const criteria = criteriaProgress(item);
  return (
    <Section
      title={t('side.workItem.title')}
      actions={
        <Link to={taskPath(item.key)} className="small insp-item-open" aria-label={t('side.workItem.openLabel', { key: item.key })}>
          {t('side.workItem.open')}
        </Link>
      }
    >
      <dl className="insp-facts insp-item">
        <dt>{t('side.workItem.key')}</dt>
        <dd>
          <WorkItemKey value={item.key} boxed />
        </dd>
        <dt>{t('side.workItem.status')}</dt>
        <dd className="insp-item-status">
          <WorkItemStatusIcon status={item.status} decorative />
          {t(`tasks:${columnMeta(item.status).label}`)}
        </dd>
        <dt>{t('side.workItem.criteria')}</dt>
        <dd className="insp-item-criteria">
          {criteria.total === 0 ? (
            <span className="muted">{t('side.workItem.none')}</span>
          ) : (
            <>
              <span className="mono">
                {criteria.done}/{criteria.total}
              </span>
              <ProgressBar size="sm" decorative counts={{ done: criteria.done, pending: criteria.total - criteria.done }} className="insp-item-bar" />
            </>
          )}
        </dd>
        {item.branch && (
          <>
            <dt>{t('side.workItem.worktree')}</dt>
            <dd className="mono break">{item.branch}</dd>
          </>
        )}
        {movesOnEnd && (
          <>
            <dt>{t('side.workItem.onEnd')}</dt>
            <dd className="small muted">{t('side.workItem.onEndHint')}</dd>
          </>
        )}
      </dl>
    </Section>
  );
}
