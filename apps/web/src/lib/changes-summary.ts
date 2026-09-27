import type { ChangedFile, ChangeSummary, EditStep } from '@agentry/shared';
import type { StepPart } from './chat-steps';
import type { TickerActivity } from './live';

/*
 * What the compact summary of a change and the edit chips of a transcript work out, without React:
 * which files the whole work touched, which one the agent is editing now, and which steps a tool
 * group made. The review screen is where each of them leads.
 */

export type StatusLetter = 'M' | 'A' | 'D' | 'R' | 'B';

const LETTERS: Record<ChangedFile['status'], StatusLetter> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R' };

export function statusLetter(file: Pick<ChangedFile, 'status' | 'binary'>): StatusLetter {
  return file.binary ? 'B' : LETTERS[file.status];
}

/**
 * Every file the work touched, committed or not. `working` says it exactly; a server older than it
 * only has the commits' files and the uncommitted ones, so a file in both keeps its committed row.
 */
export function workFiles(summary: ChangeSummary): ChangedFile[] {
  if (summary.working) return summary.working;
  const seen = new Set(summary.files.map((f) => f.path));
  return [...summary.files, ...summary.uncommitted.filter((f) => !seen.has(f.path))];
}

const EDIT_TOOLS = new Set(['edit', 'multiedit', 'write', 'notebookedit']);

export const isEditTool = (name: string | null | undefined): boolean => EDIT_TOOLS.has((name ?? '').toLowerCase());

/**
 * The listed file the agent is writing right now. An activity's target is relative to the chat's
 * directory, which can sit below the git top level the paths are relative to, and it is cut at 80
 * characters: a target that does not end one listed path is no file of this list.
 */
export function liveFile(activity: TickerActivity | null | undefined, paths: readonly string[]): string | null {
  if (!activity || activity.kind !== 'tool' || !isEditTool(activity.tool)) return null;
  const target = activity.target?.trim().replace(/^\.\//, '') ?? '';
  if (!target || target.endsWith('…')) return null;
  const found = paths.filter((p) => p === target || p.endsWith(`/${target}`) || (target.startsWith('/') && target.endsWith(`/${p}`)));
  return found.length === 1 ? (found[0] ?? null) : (found.find((p) => p === target) ?? null);
}

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1) || path;

/** The files a chat's steps wrote, newest edit first, with what the steps added and removed. */
export function stepFiles(steps: readonly EditStep[]): { path: string; additions: number; deletions: number; created: boolean }[] {
  const byPath = new Map<string, { path: string; additions: number; deletions: number; created: boolean; last: number }>();
  for (const step of steps) {
    const file = byPath.get(step.path) ?? { path: step.path, additions: 0, deletions: 0, created: false, last: 0 };
    file.additions += step.additions;
    file.deletions += step.deletions;
    file.created ||= step.created;
    file.last = step.index;
    byPath.set(step.path, file);
  }
  return [...byPath.values()].sort((a, b) => b.last - a.last).map(({ last: _, ...file }) => file);
}

export interface EditChip {
  /** The file as the call named it */
  file: string;
  name: string;
  /** The last call on the file in this group: the step the chip opens */
  stepId: string;
  /** Null until the chat's steps are known, or when none of the calls is a step */
  additions: number | null;
  deletions: number | null;
}

function editedPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const { file_path: file, notebook_path: notebook } = input as Record<string, unknown>;
  const path = typeof file === 'string' ? file : typeof notebook === 'string' ? notebook : null;
  return path?.trim() || null;
}

/**
 * One chip per file a tool group edited. A call that failed made no step, so it gets no chip; one
 * still waiting does, since the step it becomes is the one the chip opens.
 */
export function editChips(parts: readonly StepPart[], steps: ReadonlyMap<string, EditStep> | null): EditChip[] {
  const chips = new Map<string, EditChip>();
  for (const part of parts) {
    if (part.kind !== 'call' || !isEditTool(part.name) || part.result?.isError) continue;
    const file = editedPath(part.input);
    if (!file) continue;
    const chip = chips.get(file) ?? { file, name: baseName(file), stepId: part.id, additions: null, deletions: null };
    chip.stepId = part.id;
    const step = steps?.get(part.id);
    if (step) {
      chip.additions = (chip.additions ?? 0) + step.additions;
      chip.deletions = (chip.deletions ?? 0) + step.deletions;
    }
    chips.set(file, chip);
  }
  return [...chips.values()];
}

/** Where the review screen of each source is, and its deep links. */
export const reviewPath = {
  chat: (id: string) => `/chats/${encodeURIComponent(id)}/changes`,
  task: (id: string, taskId: string) => `/orchestration/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/changes`,
  integration: (id: string) => `/orchestration/${encodeURIComponent(id)}/changes`,
};

export function reviewLink(base: string, params: { file?: string; lens?: 'steps'; step?: string } = {}): string {
  const qs = new URLSearchParams();
  if (params.lens) qs.set('lens', params.lens);
  if (params.step) qs.set('step', params.step);
  if (params.file) qs.set('file', params.file);
  const query = qs.toString();
  return query ? `${base}?${query}` : base;
}
