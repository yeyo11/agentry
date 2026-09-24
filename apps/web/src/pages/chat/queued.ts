/**
 * Messages sent into a turn that is still running.
 *
 * The CLI reads its stdin between turns, so a message written while Claude works is accepted at
 * once and then waits, out of sight: the composer empties and nothing is shown anywhere until the
 * turn ends and the message finally lands in the transcript. They are held here instead, so the
 * chat can show what it is still holding — and offer to end the turn and have it read now.
 *
 * A turn that ends without the message being read (the process was stopped under it, say) leaves it
 * nowhere: the CLI had it in a buffer that died with the process. The card stays in that case, says
 * so, and hands the words back to the box they were typed in.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Chat, TranscriptEntry } from '@agentry/shared';
import { isStreamed } from '../../lib/chat-stream';

export interface QueuedMessage {
  id: string;
  /** What was typed, trimmed: how the message is recognised once the transcript has it */
  text: string;
  /** Files attached to it, which the card names when there is no text */
  files: number;
  /** The turn ended and the chat never read it */
  undelivered: boolean;
}

/** After the turn ends, how long a message still has to show up before it is taken to be lost. */
const LOST_AFTER_MS = 8000;

const textOf = (entry: TranscriptEntry): string =>
  entry.blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

/** A user entry the transcript itself holds, as opposed to one the stream put there. */
const delivered = (entry: TranscriptEntry): boolean => entry.role === 'user' && !entry.isSidechain && !isStreamed(entry);

export function useQueuedMessages(chat: Chat | undefined, items: TranscriptEntry[]) {
  // `after` is the last entry the transcript held when the message was sent: only what arrives
  // after it can be that message, so sending the same text twice does not clear the card early
  const [queued, setQueued] = useState<Array<QueuedMessage & { after: string }>>([]);
  const working = chat?.state === 'working';

  const add = useCallback((text: string, files: number, after: string) => {
    setQueued((held) => [...held, { id: `${Date.now()}-${held.length}`, text: text.trim(), files, after, undelivered: false }]);
  }, []);

  const drop = useCallback((id: string) => setQueued((held) => held.filter((message) => message.id !== id)), []);

  useEffect(() => {
    setQueued((held) => {
      if (held.length === 0) return held;
      const left = held.filter((message) => {
        const from = message.after ? items.findIndex((entry) => entry.uuid === message.after) + 1 : 0;
        const since = items.slice(from);
        // Delivered means the transcript holds it — the CLI took the turn and wrote it down. The
        // copy the wrapper streams the moment it is sent is the card itself, not its delivery.
        return !since.some((entry) => delivered(entry) && (message.text ? textOf(entry) === message.text : true));
      });
      return left.length === held.length ? held : left;
    });
  }, [items]);

  // The turn is over. What the CLI read is on its way to the transcript, which takes a moment and a
  // read to arrive; what is still here after that was never read at all.
  useEffect(() => {
    if (working) return;
    const lost = setTimeout(() => setQueued((held) => (held.some((m) => !m.undelivered) ? held.map((m) => ({ ...m, undelivered: true })) : held)), LOST_AFTER_MS);
    return () => clearTimeout(lost);
  }, [working]);

  /**
   * The entry a card stands for: put on the page by the stream the moment it was sent, and not in
   * the conversation until the chat reads it. The page leaves it out, or the message would be in
   * two places at once.
   */
  const pending = useCallback(
    (entry: TranscriptEntry) => entry.role === 'user' && isStreamed(entry) && queued.some((message) => message.text && textOf(entry) === message.text),
    [queued],
  );

  return { queued, add, drop, pending };
}
