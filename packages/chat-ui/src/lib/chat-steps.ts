import type { ContentBlock, TranscriptEntry } from '@agentry/shared';

/*
 * How a transcript reads on the chat page: a turn with twenty tool calls is one step that says
 * "20 tools · 42 s", not twenty rows that each repeat "Claude · model · time". Pure, so the rules
 * that decide what is folded together are unit tested rather than eyeballed.
 */

/** One tool call and, once it has come back, its result. */
export interface StepCall {
  kind: 'call';
  /** The tool_use id; a result whose call is on a page not read yet keeps its own id */
  id: string;
  /** Null for a result whose call is not held */
  name: string | null;
  input: unknown;
  result: { content: string; isError: boolean } | null;
}

export interface StepThinking {
  kind: 'thinking';
  text: string;
}

export type StepPart = StepCall | StepThinking;

export type TranscriptRow =
  | {
      kind: 'entry';
      key: string;
      entry: TranscriptEntry;
      /** Same author as the row above: the author line is left out */
      continued: boolean;
    }
  | {
      kind: 'step';
      key: string;
      entries: TranscriptEntry[];
      parts: StepPart[];
      /** Timestamps of the first and last entry, when the transcript has them */
      startedAt: string | null;
      endedAt: string | null;
      /** A call in it has not come back yet */
      pending: boolean;
      isSidechain: boolean;
    };

const blank = (block: ContentBlock) => block.type === 'text' && !block.text.trim();

/**
 * An entry that is only the machinery of a turn: calls, their results, and the thinking between
 * them. Claude Code writes each content block as an entry of its own, so a turn is a run of these.
 */
export function isStepEntry(entry: TranscriptEntry): boolean {
  const blocks = entry.blocks.filter((b) => !blank(b));
  return blocks.length > 0 && blocks.every((b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'thinking');
}

const author = (entry: TranscriptEntry) => `${entry.role}:${entry.isSidechain}`;
const onlyResults = (entry: TranscriptEntry) => entry.role === 'user' && entry.blocks.length > 0 && entry.blocks.every((b) => b.type === 'tool_result');

function partsOf(entries: TranscriptEntry[]): StepPart[] {
  const parts: StepPart[] = [];
  const calls = new Map<string, StepCall>();
  for (const entry of entries) {
    for (const block of entry.blocks) {
      if (block.type === 'thinking') {
        if (block.text.trim()) parts.push({ kind: 'thinking', text: block.text });
      } else if (block.type === 'tool_use') {
        const call: StepCall = { kind: 'call', id: block.id, name: block.name, input: block.input, result: null };
        calls.set(block.id, call);
        parts.push(call);
      } else if (block.type === 'tool_result') {
        const call = calls.get(block.toolUseId);
        const result = { content: block.content, isError: block.isError };
        if (call) call.result = result;
        else parts.push({ kind: 'call', id: block.toolUseId, name: null, input: null, result });
      }
    }
  }
  return parts;
}

/**
 * The rows the transcript renders. A run of step entries with at least one call becomes a step;
 * a run with only thinking in it stays as it is (there is nothing to fold). A subagent's entries
 * never share a step with the chat's own, and a row says who wrote it only when that changes.
 */
export function transcriptRows(entries: readonly TranscriptEntry[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let lastAuthor: string | null = null;
  let i = 0;
  while (i < entries.length) {
    const first = entries[i];
    if (!first) break;
    if (isStepEntry(first)) {
      let end = i;
      while (end + 1 < entries.length) {
        const next = entries[end + 1];
        if (!next || !isStepEntry(next) || next.isSidechain !== first.isSidechain) break;
        end++;
      }
      const run = entries.slice(i, end + 1);
      const parts = partsOf(run);
      if (parts.some((p) => p.kind === 'call')) {
        rows.push({
          kind: 'step',
          key: first.uuid || `step-${i}`,
          entries: run,
          parts,
          startedAt: run[0]?.timestamp ?? null,
          endedAt: run.at(-1)?.timestamp ?? null,
          pending: parts.some((p) => p.kind === 'call' && p.result === null && p.name !== null),
          isSidechain: first.isSidechain,
        });
        // A step is Claude's (or its subagent's) doing, whatever role the results were filed under
        lastAuthor = `assistant:${first.isSidechain}`;
        i = end + 1;
        continue;
      }
    }
    // Results on their own (their calls are on a page not read yet) do not change who is speaking
    const who: string | null = onlyResults(first) ? lastAuthor : author(first);
    rows.push({ kind: 'entry', key: first.uuid || `entry-${i}`, entry: first, continued: who === lastAuthor && lastAuthor !== null });
    lastAuthor = who;
    i++;
  }
  return rows;
}

/** The row that shows `entry`, for a search hit that points at an entry folded into a step. */
export function rowOf(rows: readonly TranscriptRow[], entry: TranscriptEntry): TranscriptRow | undefined {
  return rows.find((row) => (row.kind === 'entry' ? row.entry === entry : row.entries.includes(entry)));
}

/** "Read ×3 · Edit ×2 · Bash", in the order the tools were first called. */
export function stepTools(parts: readonly StepPart[]): Array<{ name: string; count: number }> {
  const tools = new Map<string, number>();
  for (const part of parts) if (part.kind === 'call' && part.name) tools.set(part.name, (tools.get(part.name) ?? 0) + 1);
  return [...tools].map(([name, count]) => ({ name, count }));
}

export const callCount = (parts: readonly StepPart[]) => parts.filter((p) => p.kind === 'call').length;

/** Milliseconds from the step's first entry to its last; null when the transcript has no times. */
export function stepDuration(row: { startedAt: string | null; endedAt: string | null }): number | null {
  if (!row.startedAt || !row.endedAt) return null;
  const ms = Date.parse(row.endedAt) - Date.parse(row.startedAt);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/**
 * The short label a tool row shows next to the tool's name: what it was pointed at. The keys are
 * the ones the CLI's own tools use; anything else shows nothing rather than a guess.
 */
export function callHint(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of ['description', 'command', 'file_path', 'notebook_path', 'path', 'pattern', 'query', 'url', 'prompt', 'skill', 'subagent_type']) {
    const value = o[key];
    if (typeof value === 'string' && value.trim()) {
      const line = value.replace(/\s+/g, ' ').trim();
      return line.length > 110 ? `${line.slice(0, 109)}…` : line;
    }
  }
  return '';
}

/** A `Task`/`Agent` call: the one whose work happens in a subagent's own transcript. */
export const isDelegation = (name: string | null) => name === 'Task' || name === 'Agent';

/**
 * The subagent a delegation started. The CLI's record of a subagent does not carry the id of the
 * call that started it, so it is matched on what the call asked for: its description and, when the
 * call named one, its kind. Two subagents asked for the same thing are ambiguous and match neither.
 */
export function subagentFor<T extends { id: string; description: string; kind: string }>(input: unknown, subagents: readonly T[]): T | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const description = typeof o.description === 'string' ? o.description.trim() : '';
  if (!description) return null;
  const kind = typeof o.subagent_type === 'string' ? o.subagent_type : null;
  const matches = subagents.filter((s) => s.description.trim() === description && (kind === null || s.kind === kind));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
