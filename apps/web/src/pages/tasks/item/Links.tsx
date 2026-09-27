import type { ChatSummary, WorkItemDetail, WorkItemLink, WorkItemStatus } from '@agentry/shared';
import { FileText, MessageSquare, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useChats } from '../../../api';
import { OutcomeBadge, StateBadge } from '../../../components/ChatBadges';
import { ICON_SM } from '../../../components/icons';
import { StatusBadge } from '../../../components/ui';
import { displayTitle, lastEnded } from '../../../lib/chat-model';
import { formatCost } from '../../../lib/format';
import { columnMeta } from '../../../lib/work-items';
import { linkEffect, shortId, sortLinks } from './model';

const LINK_ICON = { chat: MessageSquare, orchestration: Workflow, document: FileText } as const;

/** Where a link leads: the chat, the orchestration, or nowhere for a document (orchestration 3 opens those). */
function hrefOf(link: WorkItemLink): string | null {
  if (link.kind === 'chat' && link.chatId) return `/chats/${link.chatId}`;
  if (link.kind === 'orchestration' && link.orchestrationId) return `/orchestration/${link.orchestrationId}`;
  return null;
}

/**
 * How the chat or the node stands, as a badge with its word: the chat list's own badges for a chat
 * (working, waiting, or how its last turn ended), the task's status for a node.
 */
function LinkState({ link, chat }: { link: WorkItemLink; chat: ChatSummary | undefined }) {
  if (link.kind === 'orchestration') return link.taskStatus ? <StatusBadge status={link.taskStatus} /> : null;
  const state = chat?.state ?? link.chatState;
  if (state === 'working' || state === 'waiting') return <StateBadge state={state} />;
  const ended = chat ? lastEnded(chat) : null;
  // A process still up between turns has not ended an execution yet: its state says where it stands
  if (ended?.outcome) return <OutcomeBadge outcome={ended.outcome} />;
  return state ? <StateBadge state={state} /> : null;
}

function LinkRow({ link, item, chat }: { link: WorkItemLink; item: WorkItemDetail; chat: ChatSummary | undefined }) {
  const { t } = useTranslation('workItem');
  const { t: tt } = useTranslation('tasks');
  const Icon = LINK_ICON[link.kind];
  const live = link.taskStatus === 'running' || (chat?.state ?? link.chatState) === 'working';
  const href = hrefOf(link);
  const effect = linkEffect(link, item.history);
  // A chat is named by its first prompt, as the chat list names it, not by its generated title
  const name = (chat ? displayTitle(chat) : link.name) ?? (link.kind === 'document' ? (link.documentPath ?? '') : t('link.unnamed', { id: shortId(link.chatId ?? link.taskId) }));
  const where = link.kind === 'orchestration' ? t('link.node') : link.kind === 'document' ? t('link.document') : t('link.chat', { id: shortId(link.chatId) });
  const said = effect.key === 'link.moved' ? t(effect.key, { to: tt(columnMeta(effect.values.to as WorkItemStatus).label) }) : t(effect.key);
  const cost = link.kind === 'chat' && chat ? chat.cost.usd : undefined;
  return (
    <div className={`work-link-row ${live ? 'live-rail' : ''}`.trim()}>
      <span className="work-link-icon" aria-hidden>
        <Icon {...ICON_SM} />
      </span>
      <span className="work-link-body">
        {href ? (
          <Link to={href} className="work-link-name">
            {name}
          </Link>
        ) : (
          <span className="work-link-name">{name}</span>
        )}
        <span className="work-link-state">
          <LinkState link={link} chat={chat} />
          {cost !== undefined && <span className="mono small muted tnum">{cost === null ? t('link.noCost') : formatCost(cost)}</span>}
        </span>
        <span className="work-link-meta">
          {where} · {said}
        </span>
      </span>
    </div>
  );
}

/**
 * Every chat and orchestration task that worked on the item, not only the last (decision 25), with
 * how each stands now. The one running carries the live rail.
 */
export function Links({ item }: { item: WorkItemDetail }) {
  const { t } = useTranslation('workItem');
  // A chat's badge and cost come from the project's chat list, which the Chats page reads too
  const chats = useChats({ project: item.projectId, enabled: item.links.some((link) => link.kind === 'chat') });
  const byId = new Map((chats.data ?? []).map((chat) => [chat.id, chat]));
  // Documents have their own section (Documents.tsx): this one is what acted on the item
  const links = sortLinks(item.links.filter((link) => link.kind !== 'document'));
  return (
    <section className="workitem-section" aria-labelledby={`links-${item.id}`}>
      <div className="workitem-section-head">
        <h2 id={`links-${item.id}`} className="section-label grow">
          {t('links.title')}
        </h2>
        <span className="count">{links.length}</span>
      </div>
      {links.length === 0 ? (
        <p className="muted small workitem-none">{t('links.none')}</p>
      ) : (
        <div className="work-links">
          {links.map((link) => (
            <LinkRow key={link.id} link={link} item={item} chat={link.chatId ? byId.get(link.chatId) : undefined} />
          ))}
        </div>
      )}
    </section>
  );
}
