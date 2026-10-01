import type { LucideIcon } from 'lucide-react';
import type { MotionLevel } from '@agentry/ui/lib/motion';

/*
 * The command palette's model: what a command is, how a query ranks it, and the recent commands
 * kept between visits. The palette itself (CommandPalette.tsx) builds the list and draws it.
 */

export const RECENT_KEY = 'agentry-palette-recent';
export const MAX_RECENT = 5;
export const MAX_RESULTS = 40;

export type Group = 'live' | 'actions' | 'theme' | 'language' | 'motion' | 'goTo' | 'settings' | 'projects' | 'recentChats' | 'recent';

export const MOTION_LEVELS: MotionLevel[] = ['full', 'subtle', 'off'];

export interface Command {
  id: string;
  group: Group;
  title: string;
  hint?: string;
  keywords?: string;
  icon: LucideIcon;
  run: () => void;
}

/** Subsequence match with a bonus for word starts and contiguous runs; -1 when it does not match. */
export function score(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct - (t.length - q.length) * 0.1;
  let total = 0;
  let from = 0;
  let streak = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at < 0) return -1;
    streak = at === from ? streak + 1 : 0;
    total += 10 + streak * 5 + (at === 0 || /[\s/\-_.]/.test(t[at - 1] ?? '') ? 8 : 0) - (at - from);
    from = at + 1;
  }
  return total;
}

export function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Tells the `palette.intent` row what the person did with the proposal: the command they ran, or
 * null when the palette closed without one. The server keeps the first report, and so does this,
 * so running a command and the close that follows it send one report. Errors are the caller's to ignore.
 */
export function createPaletteReporter(send: (decisionId: string, commandId: string | null) => Promise<unknown>) {
  const told = new Set<string>();
  return (decisionId: string | null, commandId: string | null): void => {
    if (!decisionId || told.has(decisionId)) return;
    told.add(decisionId);
    void send(decisionId, commandId).catch(() => undefined);
  };
}
