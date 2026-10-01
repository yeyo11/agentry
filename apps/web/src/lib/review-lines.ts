/**
 * Where a draft note lands (a thread's place is `groupThreads` in `reviews.ts`) on a line of the diff, and what a new note on a line starts
 * from. Pure, like `reviews.ts` (which it builds on): tested without a browser
 * (test/review-lines.test.ts).
 */
import type { ReviewDraft, ReviewSide } from '@agentry/shared';
import type { ParsedDiff } from './diff';
import { lineKey } from './reviews';

/** A line of a file's diff: the side it is read on and its number there. */
export interface LineAnchor {
  side: ReviewSide;
  line: number;
}

/** The line a draft note is drawn under, or null for a note on the whole change request or a whole file. */
export function draftAnchor(draft: Pick<ReviewDraft, 'path' | 'side' | 'line'>): LineAnchor | null {
  if (draft.path === null || draft.line === null) return null;
  return { side: draft.side ?? 'right', line: draft.line };
}

/**
 * One file's drafts by the line they end on. A range hangs under its last line, as the host draws it.
 * Notes with no line are not in the map: the item page's draft block lists them.
 */
export function draftsByLine(drafts: readonly ReviewDraft[], path: string): Map<string, ReviewDraft[]> {
  const map = new Map<string, ReviewDraft[]>();
  for (const draft of drafts) {
    if (draft.path !== path) continue;
    const at = draftAnchor(draft);
    if (!at) continue;
    const key = lineKey(at.side, at.line);
    const list = map.get(key);
    if (list) list.push(draft);
    else map.set(key, [draft]);
  }
  return map;
}

/** How many notes of the draft review are on this file, for the header's chip. */
export const draftsInFile = (drafts: readonly ReviewDraft[], path: string): number => drafts.filter((d) => d.path === path).length;

/**
 * The text of a line on the head side, which a suggestion starts from; empty where the diff does not
 * hold it (a gap that was never opened) or the line was removed.
 */
export function newLineText(diff: ParsedDiff | null, line: number): string {
  if (!diff) return '';
  for (const hunk of diff.hunks) {
    for (const l of hunk.lines) if (l.kind !== 'del' && l.new === line) return l.text;
  }
  for (const gap of diff.gaps) {
    const found = gap?.lines?.find((l) => l.new === line);
    if (found) return found.text;
  }
  return '';
}

/** The change request's id while it is open: what its threads and draft review are read by */
export const openChangeRequestId = (pr: { id?: string; phase: string } | null | undefined): string | null => (pr?.phase === 'open' && pr.id ? pr.id : null);
