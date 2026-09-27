import type { ProjectModule, ProjectTemplateId, WorkItemPriority, WorkItemStatus, WorkItemType } from './types.ts';

// The fixed orders of the project ecosystem, in one place so the core, the API's validation and the
// web never disagree on which columns exist or in which order they are drawn. `satisfies` keeps
// each list in step with its union: a member added to one and not the other fails the type check.

export const PROJECT_MODULES = ['board', 'team', 'documents', 'memory'] as const satisfies readonly ProjectModule[];

export const PROJECT_TEMPLATE_IDS = ['simple', 'software', 'library', 'research', 'custom'] as const satisfies readonly ProjectTemplateId[];

/** The board's columns, left to right */
export const WORK_ITEM_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const satisfies readonly WorkItemStatus[];

export const WORK_ITEM_TYPES = ['epic', 'story', 'task', 'bug'] as const satisfies readonly WorkItemType[];

/** Lowest first */
export const WORK_ITEM_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const satisfies readonly WorkItemPriority[];

/**
 * A key prefix: upper case letters and digits, starting with a letter, two to ten characters. The
 * derived ones are two to five letters, plus a digit on a clash; the rest of the room is for a
 * person who edits it.
 */
export const WORK_ITEM_KEY_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

/** `AGN-12`. Composed on every read, since only the number is stored. */
export function workItemKey(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}

/** Splits a key back into its prefix and number; null for anything that is not one. */
export function parseWorkItemKey(key: string): { prefix: string; number: number } | null {
  const match = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]*)$/.exec(key.toUpperCase());
  if (!match?.[1] || !match[2]) return null;
  return { prefix: match[1], number: Number(match[2]) };
}

/** The branch an item is worked on: `task/agn-12`. Lower case, as git refs usually are. */
export function workItemBranch(key: string): string {
  return `task/${key.toLowerCase()}`;
}
