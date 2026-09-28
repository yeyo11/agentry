import type { EditStep } from '@agentry/shared';
import type { ParsedDiff } from '../../../lib/diff';

// What the Step by step lens works out from the chat's edits, kept pure so the rules that decide
// which step is shown, where the scrubber stands and what a key does are pinned by tests.

/** The step a link asks for; without one (or one that is gone) the latest, where a reader picks up */
export function currentStep(steps: readonly EditStep[], selected: string | null): EditStep | null {
  return steps.find((s) => s.id === selected) ?? steps.at(-1) ?? null;
}

/** The step before or after `current` in `steps`, or null at either end */
export function stepBeside(steps: readonly EditStep[], current: EditStep | null, delta: 1 | -1): EditStep | null {
  if (!current) return null;
  const at = steps.findIndex((s) => s.id === current.id);
  return at < 0 ? null : (steps[at + delta] ?? null);
}

export type ScrubDot = 'done' | 'current' | 'live' | 'ahead';

/**
 * One dot per step: those before the current one are done, the current one is drawn wide, and a
 * step still waiting for its result is live wherever it is (the current one stays current, so the
 * reader never loses their place)
 */
export function scrubDots(steps: readonly EditStep[], currentId: string | null): ScrubDot[] {
  const at = steps.findIndex((s) => s.id === currentId);
  return steps.map((s, i) => (i === at ? 'current' : s.pending ? 'live' : at >= 0 && i < at ? 'done' : 'ahead'));
}

/** The distinct files the steps touched, in the order they were first touched */
export function stepPaths(steps: readonly EditStep[]): string[] {
  return [...new Set(steps.map((s) => s.path))];
}

/**
 * The other steps on the current step's file, as `size` cards around it: the current one in the
 * middle when it can be, pushed to an edge at either end of the file's history
 */
export function sameFileWindow(steps: readonly EditStep[], current: EditStep, size = 3): { steps: EditStep[]; total: number } {
  const same = steps.filter((s) => s.path === current.path);
  const at = same.findIndex((s) => s.id === current.id);
  if (same.length <= size || at < 0) return { steps: same, total: same.length };
  const start = Math.min(Math.max(0, at - Math.floor(size / 2)), same.length - size);
  return { steps: same.slice(start, start + size), total: same.length };
}

/** The lines of the new file a patch covers, for its card's title; null when it has no hunk */
export function patchSpan(diff: ParsedDiff): { from: number; to: number } | null {
  const first = diff.hunks[0];
  const last = diff.hunks.at(-1);
  if (!first || !last) return null;
  const from = Math.max(1, first.newStart);
  return { from, to: Math.max(from, last.newStart + Math.max(last.newLines, 1) - 1) };
}

/** An intent as text and code: what Claude put between backticks reads as code, as it did in the chat */
export function intentParts(text: string): { code: boolean; text: string }[] {
  const parts: { code: boolean; text: string }[] = [];
  const re = /`([^`\n]+)`/g;
  let from = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > from) parts.push({ code: false, text: text.slice(from, m.index) });
    parts.push({ code: true, text: m[1] ?? '' });
    from = m.index + m[0].length;
  }
  if (from < text.length) parts.push({ code: false, text: text.slice(from) });
  return parts;
}

/** An intent as plain text, for the list and the cards: the backticks are a chat's markup, not words */
export const plainIntent = (text: string): string =>
  intentParts(text)
    .map((p) => p.text)
    .join('');

/** Where "See it in the conversation" goes: the chat, at the entry that holds the call */
export function conversationHref(chatId: string, step: Pick<EditStep, 'entryIndex'>): string | null {
  return step.entryIndex === null ? null : `/chats/${encodeURIComponent(chatId)}?at=${step.entryIndex}`;
}

/**
 * `←`/`→` move between steps. Like the Result lens's keys, none fires while typing in a field, with
 * a modifier held, or while a menu or dialog is open
 */
export function stepKey(e: Pick<KeyboardEvent, 'key' | 'target' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'defaultPrevented'>): -1 | 1 | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return null;
  const target = e.target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null } | null;
  const tag = target?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return null;
  // A tab list, a slider or a segmented control answers the arrows itself
  const role = target?.getAttribute?.('role');
  if (role === 'tab' || role === 'slider' || role === 'radio') return null;
  if (typeof document !== 'undefined' && document.querySelector('[data-escape-layer]')) return null;
  return e.key === 'ArrowLeft' ? -1 : 1;
}

/** Past this many pixels sideways a touch is a swipe, as long as it went more sideways than down */
const SWIPE_MIN = 56;

/** A finished touch as a move between steps: a swipe left is the next step, right the previous */
export function swipeOf(dx: number, dy: number): -1 | 1 | null {
  if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx < 0 ? 1 : -1;
}

/** `?at=` on a chat's link: the entry to open it at, or null when it is not an entry's index */
export function entryParam(value: string | null): number | null {
  if (value === null || !/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}
