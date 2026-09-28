import type { ChangedFile, ChecklistItem, Health, HealthSignal, TranscriptEntry } from '@agentry/shared';

/*
 * What the panels that show an agent's real work read from the data: how big a change is,
 * what a chat is running this second, and how a health verdict is named. Pure, so the
 * rules are tested without a browser.
 */

// ---------- the diff ----------

/** Added and removed lines over a list of files, for the line that says how big the work is. */
export function totalsOf(files: ChangedFile[]): { additions: number; deletions: number } {
  return files.reduce((sum, f) => ({ additions: sum.additions + f.additions, deletions: sum.deletions + f.deletions }), { additions: 0, deletions: 0 });
}

// ---------- what it is doing now ----------

const SUMMARY_LIMIT = 120;

const clip = (text: string): string => {
  const one = text.replaceAll(/\s+/g, ' ').trim();
  return one.length > SUMMARY_LIMIT ? `${one.slice(0, SUMMARY_LIMIT - 1)}…` : one;
};

/** One line for a tool call: the command it runs, the file it touches, the pattern it searches. */
export function describeCall(name: string, input: unknown): string {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) if (typeof args[key] === 'string' && args[key]) return args[key];
    return null;
  };
  const detail = pick('command', 'file_path', 'notebook_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'subject');
  return detail ? clip(detail) : name;
}

export interface Activity {
  /** A tool call whose result has not come back: what the agent is waiting on right now */
  running: { id: string; name: string; summary: string; at: string | null } | null;
  /** The newest entry's time: the last thing the agent did, whatever it was */
  lastEventAt: string | null;
}

/**
 * What the newest part of a transcript says the agent is doing. A call with no result yet is the
 * command it is running; the time of the last entry is how long it has been quiet. Subagent
 * messages are ignored: they are a branch of the chat, and their tool calls would be the wrong
 * answer to "what is this chat running".
 */
export function currentActivity(entries: TranscriptEntry[]): Activity {
  const main = entries.filter((e) => !e.isSidechain);
  const answered = new Set<string>();
  for (const entry of main) {
    for (const block of entry.blocks) if (block.type === 'tool_result') answered.add(block.toolUseId);
  }
  let running: Activity['running'] = null;
  for (let i = main.length - 1; i >= 0 && !running; i--) {
    const entry = main[i];
    if (!entry) continue;
    for (let j = entry.blocks.length - 1; j >= 0; j--) {
      const block = entry.blocks[j];
      if (block?.type === 'tool_use' && !answered.has(block.id)) {
        running = { id: block.id, name: block.name, summary: describeCall(block.name, block.input), at: entry.timestamp };
        break;
      }
    }
  }
  const lastEventAt = [...main].reverse().find((e) => e.timestamp)?.timestamp ?? null;
  return { running, lastEventAt };
}

// ---------- health ----------

export type HealthWord = 'ok' | 'slow' | 'stuck' | 'looping';

/**
 * The word for a verdict. Core reports a level (`ok`, `warn`, `bad`); the person is told what it
 * means: a warning is a chat that is slow, a problem is one that is stuck, and a stuck one that
 * repeats itself is looping, which asks for a different intervention (a hint, not more waiting).
 */
export function healthWord(health: Pick<Health, 'level' | 'signals'>): HealthWord {
  if (health.level === 'ok') return 'ok';
  if (health.level === 'warn') return 'slow';
  return health.signals.some((s) => s.kind === 'loop' || s.kind === 'repeat-stall') ? 'looping' : 'stuck';
}

/** Signals that name one command still running: the only ones a person can cancel. */
export function cancellable(signal: HealthSignal): signal is HealthSignal & { toolUseId: string } {
  return (signal.kind === 'hung-command' || signal.kind === 'repeat-stall') && Boolean(signal.toolUseId);
}

// ---------- the worker's checklist ----------

/** Done and open counts of a checklist, with the item being worked on named apart. */
export function checklistProgress(items: ChecklistItem[]): { done: number; total: number; current: ChecklistItem | null } {
  return {
    done: items.filter((i) => i.status === 'completed').length,
    total: items.length,
    current: items.find((i) => i.status === 'in_progress') ?? null,
  };
}
