import type { ChangedFile, ChangeSummary, EditStep } from '@agentry/shared';
import { isEditTool } from '@agentry/chat-ui/lib/edit-chips';
import type { TickerActivity } from '@agentry/ui/lib/live';

/*
 * What the compact summary of a change and the edit chips of a transcript work out, without React:
 * which files the whole work touched, which one the agent is editing now, and which steps a tool
 * group made. The review screen is where each of them leads.
 */

export { baseName, editChips, isEditTool, type EditChip } from '@agentry/chat-ui/lib/edit-chips';

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

/** Where the review screen of each source is, and its deep links. */
export const reviewPath = {
  chat: (id: string) => `/chats/${encodeURIComponent(id)}/changes`,
  task: (id: string, taskId: string) => `/orchestration/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/changes`,
  integration: (id: string) => `/orchestration/${encodeURIComponent(id)}/changes`,
  workItem: (key: string) => `/tasks/${encodeURIComponent(key)}/changes`,
};

export function reviewLink(base: string, params: { file?: string; lens?: 'steps'; step?: string } = {}): string {
  const qs = new URLSearchParams();
  if (params.lens) qs.set('lens', params.lens);
  if (params.step) qs.set('step', params.step);
  if (params.file) qs.set('file', params.file);
  const query = qs.toString();
  return query ? `${base}?${query}` : base;
}
