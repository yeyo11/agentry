import type {
  Milestone,
  MilestoneProgress,
  WorkItemActor,
  WorkItemAssignee,
  WorkItemChange,
  WorkItemComment,
  WorkItemHistoryValue,
  WorkItemLink,
  WorkItemRelation,
  WorkItemSource,
  WorkItemStatus,
  WorkItemType,
} from '@agentry/shared';
import { WORK_ITEM_STATUSES, workItemKey } from '@agentry/shared';

/**
 * The work item tables as SQLite hands their rows back, and the conversions between those rows and
 * the contract's shapes. No query runs here: the store in `work-items.ts` reads and writes.
 */

export interface ItemRow {
  id: string;
  project_id: string;
  number: number;
  type: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee_kind: string | null;
  assignee_role: string | null;
  epic_id: string | null;
  milestone_id: string | null;
  rank: string;
  worktree: string | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface CriterionRow {
  id: string;
  item_id: string;
  position: number;
  text: string;
  checked: number;
  checked_by_kind: string | null;
  checked_by_role: string | null;
}

export interface LinkRow {
  id: string;
  item_id: string;
  kind: string;
  role: string;
  chat_id: string | null;
  orchestration_id: string | null;
  task_id: string | null;
  created_at: string;
}

export interface MilestoneRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  state: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface HistoryRow {
  id: string;
  item_id: string;
  change: string;
  from_value: string | null;
  to_value: string | null;
  actor_kind: string;
  actor_role: string | null;
  cause_kind: string | null;
  cause_event: string | null;
  cause_chat_id: string | null;
  cause_orchestration_id: string | null;
  cause_task_id: string | null;
  created_at: string;
}

export interface CommentRow {
  id: string;
  item_id: string;
  author_kind: string;
  author_role: string | null;
  source_kind: string | null;
  source_chat_id: string | null;
  source_orchestration_id: string | null;
  source_task_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

/**
 * A history value as it is stored. A work item is kept by its number, not its key, so the entry
 * reads with the project's current prefix like every other key.
 */
export type StoredItemRef = { id: string; number: number; title: string; type: WorkItemType; status: WorkItemStatus };
export type StoredHistoryValue =
  | string
  | string[]
  | WorkItemAssignee
  | { id: string; label: string; number?: number }
  | { id: string; text: string; checked: boolean }
  | { type: WorkItemRelation['type']; item: StoredItemRef }
  | null;

export interface PendingEntry {
  itemId: string;
  change: WorkItemChange;
  from: StoredHistoryValue;
  to: StoredHistoryValue;
}

/** A list bound as one parameter: `IN (SELECT value FROM json_each(?))` has no limit on its length. */
export const inList = (values: readonly string[]): string => JSON.stringify(values);

export const statusIndex = (status: string): number => WORK_ITEM_STATUSES.indexOf(status as WorkItemStatus);

/** A kind this version does not know reads as the system: never as the person, whose moves the links respect. */
export function actorOf(kind: string | null, role: string | null): WorkItemActor {
  const k = kind === 'person' || kind === 'agent' ? kind : 'system';
  return { kind: k, role: role ?? null };
}

export function sourceOf(kind: string | null, chatId: string | null, orchestrationId: string | null, taskId: string | null): WorkItemSource | null {
  if (kind !== 'chat' && kind !== 'orchestration') return null;
  return { kind, chatId, orchestrationId, taskId };
}

export function assigneeOf(row: ItemRow): WorkItemAssignee | null {
  if (row.assignee_kind === 'person') return { kind: 'person' };
  if (row.assignee_kind === 'role' && row.assignee_role) return { kind: 'role', role: row.assignee_role };
  return null;
}

export function emptySource(): WorkItemSource {
  return { kind: 'chat', chatId: null, orchestrationId: null, taskId: null };
}

export function emptyProgress(): MilestoneProgress {
  return { total: 0, done: 0, byStatus: { backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0 } };
}

/**
 * Text as search compares it. SQLite's `LIKE` and `lower()` fold ASCII only, so `sesión` would miss
 * `SESIÓN`; the round trip through upper case also folds `ß` into `ss` and a final sigma into `σ`.
 */
export function fold(value: string): string {
  return value.normalize('NFC').toUpperCase().toLowerCase();
}

export function textMatches(row: ItemRow, q: string): boolean {
  const needle = fold(q);
  return fold(row.title).includes(needle) || fold(row.description).includes(needle);
}

export function isLive(link: WorkItemLink): boolean {
  return link.role === 'work' && (link.chatState === 'working' || link.taskStatus === 'running');
}

export function linkOf(row: LinkRow): WorkItemLink {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind === 'orchestration' ? 'orchestration' : 'chat',
    role: row.role === 'origin' ? 'origin' : 'work',
    chatId: row.chat_id,
    orchestrationId: row.orchestration_id,
    taskId: row.task_id,
    createdAt: row.created_at,
  };
}

export function commentOf(row: CommentRow): WorkItemComment {
  return {
    id: row.id,
    itemId: row.item_id,
    author: actorOf(row.author_kind, row.author_role),
    source: sourceOf(row.source_kind, row.source_chat_id, row.source_orchestration_id, row.source_task_id),
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function milestoneOf(row: MilestoneRow, progress: MilestoneProgress): Milestone {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    state: row.state === 'closed' ? 'closed' : 'open',
    progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

/** A stored history value back as the contract has it: numbers become keys with today's prefix. */
export function readValue(raw: string | null, prefix: string): WorkItemHistoryValue {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.item === 'object' && v.item !== null && (v.type === 'blocks' || v.type === 'blocked_by')) {
    const item = v.item as StoredItemRef;
    return { type: v.type, item: { id: item.id, key: workItemKey(prefix, item.number), title: item.title, type: item.type, status: item.status } };
  }
  if (typeof v.id === 'string' && typeof v.label === 'string') {
    return typeof v.number === 'number' ? { id: v.id, label: v.label, key: workItemKey(prefix, v.number) } : { id: v.id, label: v.label };
  }
  return value as WorkItemHistoryValue;
}
