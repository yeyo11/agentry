/**
 * Messages sent into a turn that is still running, tracked by the id each was sent with
 * (docs/chat-delivery.md).
 *
 * The agent reads a message written while it works at its next tool boundary, or as its next turn,
 * so the composer empties and nothing in the conversation says the message is still waiting. Each
 * one is a card over the box instead, from the moment the server answers that it took it, until the
 * stream says the agent read it, or that it was lost; then the card says so and hands the words and
 * the files back. Nothing here guesses from the words or from a clock: the server says which.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Chat, ChatMessageReceipt, ChatPendingAttachment, ChatPendingMessage, MessageDelivery, TranscriptEntry } from '@agentry/shared';
import { isStreamed, type ChatStreamStore } from '../lib/chat-stream';

export interface QueuedMessage {
  /** The message's own id: the one the server, the agent and its transcript know it by */
  id: string;
  /** What was typed, as sent */
  text: string;
  /** The files sent with it, which a lost card hands back */
  attachments: ChatPendingAttachment[];
  /** `waiting`: in the agent's queue. `held`: for the process that replaces the one leaving. `lost`: never read */
  state: 'waiting' | 'held' | 'lost';
}

export interface QueuedCard extends QueuedMessage {
  /** When this page learnt of it: a read older than that cannot know it */
  seenAt: number;
}

/** What the server has said about the messages of one chat, as the page holds it. */
export interface DeliveryFacts {
  /** What the chat lists as pending on its last read (`chat.pending`) */
  pending: readonly ChatPendingMessage[];
  /** When that read was made */
  readAt: number;
  /** What the stream said became of a message since the page opened it */
  delivery: (id: string) => MessageDelivery | undefined;
  /** Ids of the user entries the agent's transcript holds: those were read, whatever else was missed */
  written: ReadonlySet<string>;
  /** Cards the person dealt with, which the server may list a while longer */
  dismissed: ReadonlySet<string>;
}

/**
 * How long a card outlives a read of the chat that no longer lists it as pending. A read that set
 * out before the message was sent does not list it either; one that lands this much later and still
 * does not, says the agent has it.
 */
const SETTLE_MS = 3000;

const stateOf = (pending: ChatPendingMessage): QueuedMessage['state'] => (pending.state === 'undelivered' ? 'lost' : pending.state === 'held' ? 'held' : 'waiting');

/**
 * The cards of a chat brought up to what the server says, by id: a message the agent took goes, a
 * lost one says so, and one the server still holds that the page did not send (after a reload, or
 * sent from elsewhere) gets a card. The same array back when nothing changed.
 */
export function reconcileCards(held: readonly QueuedCard[], facts: DeliveryFacts): readonly QueuedCard[] {
  const listed = new Map(facts.pending.map((m) => [m.id, m]));
  const next: QueuedCard[] = [];
  for (const card of held) {
    const told = facts.delivery(card.id);
    if (told?.state === 'delivered' || told?.state === 'carried' || facts.written.has(card.id)) continue;
    if (told?.state === 'undelivered') {
      next.push(card.state === 'lost' ? card : { ...card, state: 'lost' });
      continue;
    }
    const server = listed.get(card.id);
    if (server) {
      const state = stateOf(server);
      next.push(state === card.state ? card : { ...card, state });
      continue;
    }
    // Not listed by a read made well after it was sent: the agent has it, or nobody can follow it
    if (card.state !== 'lost' && facts.readAt - card.seenAt > SETTLE_MS) continue;
    next.push(card);
  }
  for (const message of facts.pending) {
    if (next.some((card) => card.id === message.id) || facts.dismissed.has(message.id) || facts.written.has(message.id)) continue;
    const told = facts.delivery(message.id);
    if (told && told.state !== 'undelivered') continue;
    next.push({ id: message.id, text: message.text, attachments: message.attachments, state: told ? 'lost' : stateOf(message), seenAt: facts.readAt });
  }
  const same = next.length === held.length && next.every((card, i) => card === held[i]);
  return same ? held : next;
}

/**
 * The cards of one chat. `items` is the conversation the page holds, `readAt` when the chat was last
 * read: what the server lists as pending (`chat.pending`) is only as fresh as that read.
 */
export function useQueuedMessages(chat: Chat | undefined, items: TranscriptEntry[], stream: ChatStreamStore, readAt: number) {
  const chatId = chat?.id ?? '';
  // Kept by chat, so a card can never show over another chat's composer
  const [byChat, setByChat] = useState<Record<string, readonly QueuedCard[]>>({});
  // Cards the person dealt with (put back in the box): the server may list them a while longer
  const dismissed = useRef(new Set<string>());
  const heard = useSyncExternalStore(stream.subscribeDeliveries, stream.deliveryVersion);
  const pending = chat?.pending;

  const add = useCallback(
    (receipt: ChatMessageReceipt, text: string, attachments: ChatPendingAttachment[]) => {
      // A turn of its own starts on it at once: there is nothing to wait for
      if (receipt.taken === 'started' || !chatId) return;
      const told = stream.delivery(receipt.id);
      if (told && told.state !== 'undelivered') return;
      setByChat((all) => {
        const held = all[chatId] ?? [];
        if (held.some((card) => card.id === receipt.id)) return all;
        const card: QueuedCard = { id: receipt.id, text: text.trim(), attachments, state: told ? 'lost' : receipt.taken === 'held' ? 'held' : 'waiting', seenAt: Date.now() };
        return { ...all, [chatId]: [...held, card] };
      });
    },
    [chatId, stream],
  );

  const drop = useCallback(
    (id: string) => {
      dismissed.current.add(id);
      setByChat((all) => ({ ...all, [chatId]: (all[chatId] ?? []).filter((card) => card.id !== id) }));
    },
    [chatId],
  );

  // What the server says, by id: the stream as it happens, and the chat's own list on every read
  useEffect(() => {
    if (!chatId) return;
    const written = new Set(items.filter((entry) => entry.role === 'user' && !isStreamed(entry)).map((entry) => entry.uuid));
    const facts: DeliveryFacts = { pending: pending ?? [], readAt, delivery: (id) => stream.delivery(id), written, dismissed: dismissed.current };
    setByChat((all) => {
      const held = all[chatId] ?? [];
      const next = reconcileCards(held, facts);
      return next === held ? all : { ...all, [chatId]: next };
    });
  }, [chatId, pending, items, readAt, heard, stream]);

  const queued: readonly QueuedMessage[] = byChat[chatId] ?? [];

  /**
   * The entry a card stands for: put on the page by the stream the moment it was sent, and not in
   * the conversation until the agent reads it. The page leaves it out, or the message would be in
   * two places at once.
   */
  const ids = queued.map((card) => card.id).join('\n');
  const isPending = useCallback((entry: TranscriptEntry) => entry.role === 'user' && isStreamed(entry) && ids.split('\n').includes(entry.uuid), [ids]);

  return { queued, add, drop, pending: isPending };
}
