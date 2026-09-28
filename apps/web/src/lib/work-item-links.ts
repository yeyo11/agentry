/**
 * How chats and orchestration nodes name the work items they are linked to. Pure, so what a chat's
 * header and a node's name say is unit tested.
 */
import type { WorkItemDetail, WorkItemLinkRole } from '@agentry/shared';

/** The part a chat played in an item, as its header says it: it acted on the item, or the item was made from it. */
export type ChatItemRole = 'work' | 'origin';

const ACTING: readonly WorkItemLinkRole[] = ['work', 'refine', 'verify'];

/**
 * What a chat was to an item, from the item's links: `work` when it worked on, refined or verified
 * it, `origin` when the item was created from one of its messages, null when it is not linked. An
 * item created in a chat that then worked on it is worked on: that is what the chat is about. The
 * worker chat of an orchestration node counts as well, through its node's link.
 */
export function chatItemRole(item: Pick<WorkItemDetail, 'links'>, chatId: string): ChatItemRole | null {
  const own = item.links.filter((link) => link.kind !== 'document' && link.chatId === chatId);
  if (own.some((link) => ACTING.includes(link.role))) return 'work';
  if (own.some((link) => link.role === 'origin')) return 'origin';
  return null;
}

/**
 * Whether the end of this chat's turn takes the item to In review, as the chat's inspector says: a
 * chat that works on it does, from any column before In review. A flow run that refines or verifies
 * it does not: its result moves the item (to To do, or back to In progress), never to In review.
 */
export function movesToReviewOnEnd(item: Pick<WorkItemDetail, 'links' | 'status'>, chatId: string): boolean {
  const works = item.links.some((link) => link.kind !== 'document' && link.chatId === chatId && link.role === 'work');
  return works && (item.status === 'backlog' || item.status === 'todo' || item.status === 'in_progress');
}

/** The items a chat works on first, then the ones made from it, each group in the order given. */
export function byChatRole<T extends { role: ChatItemRole }>(links: readonly T[]): T[] {
  return [...links.filter((l) => l.role === 'work'), ...links.filter((l) => l.role === 'origin')];
}

/** How far an item's acceptance checklist has got. */
export function criteriaProgress(item: Pick<WorkItemDetail, 'acceptanceCriteria'>): { done: number; total: number } {
  return { done: item.acceptanceCriteria.filter((c) => c.checked).length, total: item.acceptanceCriteria.length };
}

/**
 * A node built from a work item is named "AGN-28 Title": beside its key the name would say the key
 * twice, so the key is left to the link.
 */
export function withoutKey(name: string, key: string | undefined): string {
  if (!key || !name.startsWith(`${key} `)) return name;
  return name.slice(key.length + 1);
}
