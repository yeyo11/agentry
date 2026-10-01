import type {
  CodeHostId,
  DocumentKind,
  Milestone,
  MilestoneProgress,
  WorkItemActor,
  WorkItemAssignee,
  WorkItemChange,
  WorkItemComment,
  WorkItemHistoryValue,
  WorkItemLink,
  WorkItemLinkKind,
  WorkItemLinkRole,
  WorkItemHistoryPullRequest,
  WorkItemPullRequest,
  WorkItemPullRequestCi,
  WorkItemPullRequestPhase,
  WorkItemRelation,
  WorkItemSource,
  WorkItemStatus,
  WorkItemType,
} from '@agentry/shared';
import { DOCUMENT_KINDS, WORK_ITEM_LINK_KINDS, WORK_ITEM_LINK_ROLES, WORK_ITEM_STATUSES, workItemKey } from '@agentry/shared';

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
  /** The flow's round of verification; 0 on a row written before the flow existed */
  bounces: number;
  /** A `WorkItemWaitReason`, or null */
  waiting: string | null;
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
  /** Set on a `document` link only, relative to the project */
  document_path: string | null;
  document_kind: string | null;
  team_role: string | null;
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
  | WorkItemHistoryPullRequest
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

/** The roles of a link through which an agent works on the item: a chat or node on it, a Product Owner refining it, QA verifying it. */
const LIVE_ROLES: ReadonlySet<WorkItemLinkRole> = new Set<WorkItemLinkRole>(['work', 'refine', 'verify']);

/**
 * An agent is on the item now: a chat or node working on it, or a flow run refining or verifying it,
 * so the card is live whichever member holds it. A document never is, even one whose chat is still
 * running: the chat has its own link, and that one says so. An `origin` or `reference` chat is only
 * where the item came from or is mentioned, not work on it.
 */
export function isLive(link: WorkItemLink): boolean {
  return link.kind !== 'document' && LIVE_ROLES.has(link.role) && (link.chatState === 'working' || link.taskStatus === 'running');
}

const known = <T extends string>(value: string | null, allowed: readonly T[]): T | null => ((allowed as readonly string[]).includes(value ?? '') ? (value as T) : null);

/**
 * A kind or a role this version does not know reads as the most inert one there is: a chat a newer
 * release linked some other way is still a chat, and a role it made up plays no part here.
 */
export function linkOf(row: LinkRow): WorkItemLink {
  const kind: WorkItemLinkKind = known(row.kind, WORK_ITEM_LINK_KINDS) ?? 'chat';
  const role: WorkItemLinkRole = known(row.role, WORK_ITEM_LINK_ROLES) ?? 'reference';
  return {
    id: row.id,
    itemId: row.item_id,
    kind,
    role,
    chatId: row.chat_id,
    orchestrationId: row.orchestration_id,
    taskId: row.task_id,
    ...(kind === 'document' ? { documentPath: row.document_path, documentKind: known<DocumentKind>(row.document_kind, DOCUMENT_KINDS) ?? 'doc' } : {}),
    ...(row.team_role ? { teamRole: row.team_role } : {}),
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

// ---------- pull requests ----------

export interface PullRequestRow {
  id: string;
  item_id: string;
  project_id: string;
  /** A `CodeHostId`; rows opened before hosts existed read `github` */
  host: string;
  /** Null until read from origin */
  hostname: string | null;
  phase: string;
  number: number | null;
  url: string | null;
  branch: string;
  base: string;
  ci: string | null;
  conflicts: string;
  error_code: string | null;
  error_detail: string | null;
  approved_at: string;
  moved_at: string | null;
  opened_at: string | null;
  closed_at: string | null;
  checked_at: string | null;
  claimed_until: string | null;
  created_at: string;
  updated_at: string;
}

const PR_PHASES: readonly WorkItemPullRequestPhase[] = ['preparing', 'conflict', 'awaiting-verify', 'open', 'merged', 'closed', 'failed'];
const PR_CI: readonly WorkItemPullRequestCi[] = ['none', 'pending', 'passing', 'failing'];

/** How each host writes a change request's number: GitHub's `#12`, GitLab's `!12` */
const REF_PREFIX: Record<CodeHostId, string> = { github: '#', gitlab: '!' };

/** A host this version does not know reads as github, which every row before hosts was */
export function hostOf(value: string): CodeHostId {
  return value === 'gitlab' ? 'gitlab' : 'github';
}

/** `#12` or `!12`; null without a number */
export function refOf(host: CodeHostId, number: number | null): string | null {
  return number === null ? null : `${REF_PREFIX[host]}${String(number)}`;
}

/** A stored PR as the contract carries it; a phase this version does not know reads as failed. */
export function pullRequestOf(row: PullRequestRow): WorkItemPullRequest {
  let conflicts: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.conflicts);
    if (Array.isArray(parsed)) conflicts = parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    // an unreadable list reads as none
  }
  const host = hostOf(row.host);
  return {
    phase: PR_PHASES.find((p) => p === row.phase) ?? 'failed',
    host,
    number: row.number,
    ref: refOf(host, row.number),
    url: row.url,
    branch: row.branch,
    base: row.base,
    ci: PR_CI.find((c) => c === row.ci) ?? null,
    conflicts,
    error: row.error_code ? { code: row.error_code, detail: row.error_detail ?? '' } : null,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    checkedAt: row.checked_at,
  };
}
