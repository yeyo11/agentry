import { isAbsolute, relative, sep } from 'node:path';
import { normalizeMessage, type EditStep, type EditStepTool, type TranscriptEntry } from '@agentry/shared';
import type { JsonlFold } from './jsonl-cache.ts';
import type { JsonLine } from './transcript-index.ts';

const STEP_TOOLS: ReadonlySet<string> = new Set<EditStepTool>(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const isStepTool = (name: string): name is EditStepTool => STEP_TOOLS.has(name);

/** The intent is a sentence to read beside a patch, not the whole message it came from. */
const INTENT_LIMIT = 280;

/** A writing call as the transcript made it. Never changed once kept, so a clone can share it. */
interface StepCall {
  id: string;
  tool: EditStepTool;
  path: string;
  at: string | null;
  intent: string | null;
  entryIndex: number | null;
}

/** What came of a call: refused or failed, or done with the patch the CLI stored for it. */
type StepResult = { ok: false } | { ok: true; diff: string; additions: number; deletions: number; created: boolean };

/**
 * What a pass over a transcript learned about its edits. Only the patch of each result is kept,
 * already as text: the `toolUseResult` it came from holds the whole file before the edit.
 */
export interface EditStepsState {
  /** Entries of the main view so far, counted as `getSession` counts them */
  entries: number;
  /** The last thing the assistant wrote, for the next call to carry as its why */
  intent: string | null;
  /** In the order the calls were made */
  calls: Map<string, StepCall>;
  results: Map<string, StepResult>;
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
const asCount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

function clip(text: string): string | null {
  const flat = text.trim();
  if (!flat) return null;
  return flat.length > INTENT_LIMIT ? `${flat.slice(0, INTENT_LIMIT - 1).trimEnd()}…` : flat;
}

/** The CLI's `structuredPatch` hunks as the unified text git would print for them. */
export function unifiedOf(hunks: unknown[]): string {
  let out = '';
  for (const raw of hunks) {
    const h = asRecord(raw);
    const lines = Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === 'string') : [];
    out += `@@ -${asCount(h.oldStart)},${asCount(h.oldLines)} +${asCount(h.newStart)},${asCount(h.newLines)} @@\n`;
    for (const line of lines) out += `${line}\n`;
  }
  return out;
}

/** A file created from nothing: every line of it is new. */
export function addedDiff(content: string): string {
  if (!content) return '';
  const lines = content.split('\n');
  const newline = content.endsWith('\n');
  if (newline) lines.pop();
  let out = `@@ -0,0 +1,${lines.length} @@\n`;
  for (const line of lines) out += `+${line}\n`;
  return newline ? out : `${out}\\ No newline at end of file\n`;
}

function counted(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

function patchOf(tool: EditStepTool, raw: unknown): StepResult {
  const r = asRecord(raw);
  const created = tool === 'Write' && r.type === 'create';
  const hunks = Array.isArray(r.structuredPatch) ? r.structuredPatch : [];
  const diff = hunks.length > 0 ? unifiedOf(hunks) : created ? addedDiff(asText(r.content)) : '';
  return { ok: true, diff, ...counted(diff), created };
}

export function emptyEditSteps(): EditStepsState {
  return { entries: 0, intent: null, calls: new Map(), results: new Map() };
}

/**
 * Folds one entry in. `toolUseResult` is what the CLI stored beside a result: an object with the
 * patch when the call went through, a string when it failed or was refused, nothing in a stream.
 */
export function addEditEntry(state: EditStepsState, entry: TranscriptEntry | null, toolUseResult?: unknown): void {
  // Sidechains are a subagent's edits, and are out of the main view's count too
  if (!entry || entry.isSidechain) return;
  const index = state.entries++;
  const results = entry.blocks.filter((b) => b.type === 'tool_result');
  // A new prompt: whatever the assistant said before it does not explain what comes after
  if (entry.role === 'user' && results.length === 0) state.intent = null;
  for (const block of entry.blocks) {
    if (block.type === 'text' && entry.role === 'assistant') {
      state.intent = clip(block.text) ?? state.intent;
    } else if (block.type === 'tool_use' && isStepTool(block.name)) {
      const input = asRecord(block.input);
      const path = asText(input.file_path) || asText(input.notebook_path) || asText(input.path);
      state.calls.set(block.id, { id: block.id, tool: block.name, path, at: entry.timestamp, intent: state.intent, entryIndex: index });
    } else if (block.type === 'tool_result') {
      const call = state.calls.get(block.toolUseId);
      if (!call) continue;
      const failed = block.isError || typeof toolUseResult === 'string';
      // The line's `toolUseResult` belongs to its one result; a line with several says nothing of which
      const raw = results.length === 1 ? toolUseResult : undefined;
      state.results.set(call.id, failed ? { ok: false } : patchOf(call.tool, raw));
    }
  }
}

/**
 * The edits of a transcript read line by line, the intent included: unlike the tool-call fold it
 * cannot skip lines that mention no tool, since the sentence before a call is on a text-only line.
 */
export const EDIT_STEPS_FOLD: JsonlFold<EditStepsState> = {
  init: emptyEditSteps,
  clone: (s) => ({ entries: s.entries, intent: s.intent, calls: new Map(s.calls), results: new Map(s.results) }),
  add: (state, line: JsonLine) => addEditEntry(state, normalizeMessage(line), line.toolUseResult),
};

/** The fold of what a process streamed, for a chat with no transcript on disk: no patches there. */
export function editStepsFromEntries(entries: Iterable<TranscriptEntry>): EditStepsState {
  const state = emptyEditSteps();
  for (const entry of entries) addEditEntry(state, entry);
  return state;
}

/** Relative to `root` when inside it, so it matches a `ChangedFile.path`; as the call named it otherwise. */
export function stepPath(path: string, root: string | null): string {
  if (!root || !isAbsolute(path)) return path;
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
  return rel.split(sep).join('/');
}

/**
 * The steps, oldest first. A failed call is left out. A call with no result yet is only shown while
 * the chat works (`running`), and only after the last one that was answered: in a chat nobody runs,
 * or before a later answer, an unanswered call is stale.
 */
export function editStepsOf(state: EditStepsState, opts: { root: string | null; running: boolean }): EditStep[] {
  const calls = [...state.calls.values()];
  let answered = -1;
  calls.forEach((call, i) => {
    if (state.results.has(call.id)) answered = i;
  });
  const steps: EditStep[] = [];
  calls.forEach((call, i) => {
    const result = state.results.get(call.id);
    if (result ? !result.ok : !opts.running || i < answered) return;
    const patch = result?.ok ? result : { diff: '', additions: 0, deletions: 0, created: false };
    steps.push({
      id: call.id,
      index: steps.length + 1,
      at: call.at,
      tool: call.tool,
      path: stepPath(call.path, opts.root),
      additions: patch.additions,
      deletions: patch.deletions,
      diff: patch.diff,
      created: patch.created,
      intent: call.intent,
      entryIndex: call.entryIndex,
      pending: !result,
    });
  });
  return steps;
}
