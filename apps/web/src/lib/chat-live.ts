import type { Chat, ChecklistItem } from '@agentry/shared';
import type { TickerActivity } from './live';
import type { ProgressCounts, StepState } from './progress';

/*
 * What the chat page says about a chat that is alive, without React: the one pill that merges its
 * state, who drives it and whether its stream is connected; the line under the transcript that
 * says what it is doing; and its checklist as steps and counts.
 */

/** How long a stream may be down before the page says so: a reconnect that takes a second is not news. */
export const RECONNECTING_AFTER_MS = 3000;

export type PillTone = 'working' | 'waiting' | 'idle';

/** The second word of the pill: the stream while a process is ours, who holds the chat otherwise. */
export type PillLink = 'live' | 'reconnecting' | 'interactive' | 'resumable' | 'readOnly';

export interface ChatPill {
  tone: PillTone;
  link: PillLink;
}

export function chatPill(chat: Pick<Chat, 'state' | 'control' | 'execution'>, stream: { connected: boolean; downLong: boolean }): ChatPill {
  const link: PillLink = chat.execution
    ? stream.connected || !stream.downLong
      ? 'live'
      : 'reconnecting'
    : chat.control.mode === 'readOnly'
      ? 'readOnly'
      : chat.control.mode;
  return { tone: chat.state, link };
}

/**
 * What the ticker under the transcript shows. The chat's own stream knows first when a block starts
 * streaming, so a partial wins; otherwise what core derived from the same events (patched in by the
 * event feed); otherwise, for a chat that is working and has not said at what, a plain "Working".
 */
export function tickerActivity(
  chat: Pick<Chat, 'state' | 'activity' | 'updatedAt' | 'startedAt'>,
  partial: { block: 'text' | 'thinking'; since: string } | null,
): TickerActivity | null {
  if (partial) return { kind: partial.block === 'thinking' ? 'thinking' : 'writing', since: partial.since };
  // An activity that outlived its turn by a refetch is not what an idle chat is doing
  if (chat.state === 'idle') return null;
  if (chat.activity) return chat.activity;
  // Empty when the chat has no time at all: the ticker then leaves its clock out
  const since = chat.updatedAt ?? chat.startedAt ?? '';
  return chat.state === 'waiting' ? { kind: 'waiting', since } : { kind: 'tool', since };
}

const CHECK_STEP: Record<ChecklistItem['status'], StepState> = { completed: 'done', in_progress: 'current', pending: 'pending' };

export const checklistStepState = (item: ChecklistItem): StepState => CHECK_STEP[item.status];

export function checklistCounts(items: readonly ChecklistItem[]): ProgressCounts {
  const counts = { done: 0, running: 0, pending: 0 };
  for (const item of items) {
    if (item.status === 'completed') counts.done++;
    else if (item.status === 'in_progress') counts.running++;
    else counts.pending++;
  }
  return counts;
}
