import type { Checklist, ChecklistItem, TouchedFile, TranscriptEntry } from '@agentry/shared';

/** A tool call read back from a transcript, paired with what came of it. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** When the assistant made the call; null when the entry carries no timestamp */
  at: string | null;
  /** Null until a result arrives: a call still running */
  isError: boolean | null;
  /** What the tool answered, as text */
  result: string;
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The calls of the tools in `names`, oldest first, each with its result. A result comes in a later
 * entry than its call, so both are looked at and matched by the call's id.
 */
export function toolCallsOf(entries: Iterable<TranscriptEntry>, names: ReadonlySet<string>): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const entry of entries) {
    for (const block of entry.blocks) {
      if (block.type === 'tool_use' && names.has(block.name)) {
        calls.set(block.id, { id: block.id, name: block.name, input: asRecord(block.input), at: entry.timestamp, isError: null, result: '' });
      } else if (block.type === 'tool_result') {
        const call = calls.get(block.toolUseId);
        if (call) Object.assign(call, { isError: block.isError, result: block.content });
      }
    }
  }
  return [...calls.values()];
}

/** The tools a worker plans with. `TodoWrite` is the older one; a CLI has one or the other. */
export const CHECKLIST_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']);

/** The tools that write to a file, which is how a chat outside git is known to have changed it. */
export const WRITING_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const STATUSES: readonly ChecklistItem['status'][] = ['pending', 'in_progress', 'completed'];
const statusOf = (value: unknown): ChecklistItem['status'] | null => STATUSES.find((s) => s === value) ?? null;

/**
 * A worker's own plan as of its last update. `TodoWrite` sends the whole list every time; the task
 * tools change one item at a time, and name it by an id the CLI gave in the result of `TaskCreate`
 * ("Task #3 created successfully"), so an update is matched to the item that result named.
 */
export function checklistOf(calls: ToolCall[]): Checklist {
  const items = new Map<string, ChecklistItem>();
  let updatedAt: string | null = null;
  let created = 0;
  for (const call of calls) {
    // A call that failed changed nothing; one with no result yet is taken as it will most likely go
    if (call.isError === true) continue;
    if (call.name === 'TodoWrite') {
      items.clear();
      const todos = Array.isArray(call.input.todos) ? call.input.todos : [];
      todos.forEach((todo, i) => {
        const t = asRecord(todo);
        const text = asText(t.content) || asText(t.subject);
        if (text) items.set(String(i), { text, status: statusOf(t.status) ?? 'pending' });
      });
    } else if (call.name === 'TaskCreate') {
      const text = asText(call.input.subject);
      if (!text) continue;
      created++;
      items.set(/#(\d+)/.exec(call.result)?.[1] ?? String(created), { text, status: 'pending' });
    } else if (call.name === 'TaskUpdate') {
      const id = String(call.input.taskId ?? '');
      if (call.input.status === 'deleted') {
        items.delete(id);
      } else {
        const item = items.get(id);
        if (!item) continue;
        const subject = asText(call.input.subject);
        items.set(id, { text: subject || item.text, status: statusOf(call.input.status) ?? item.status });
      }
    } else {
      continue;
    }
    updatedAt = call.at ?? updatedAt;
  }
  return { items: [...items.values()], updatedAt };
}

/** Where a writing call puts its bytes; each tool names it differently. */
const targetOf = (call: ToolCall): string => asText(call.input.file_path) || asText(call.input.notebook_path) || asText(call.input.path);

/** The files a chat's writing calls succeeded on, newest first, once each. */
export function touchedFilesOf(calls: ToolCall[]): TouchedFile[] {
  const latest = new Map<string, TouchedFile>();
  for (const call of calls) {
    const path = targetOf(call);
    // A refused or failed edit left the file as it was
    if (!path || call.isError === true) continue;
    latest.delete(path); // so the map's order is the order of last touch
    latest.set(path, { path, at: call.at ?? '', tool: call.name });
  }
  return [...latest.values()].reverse();
}
