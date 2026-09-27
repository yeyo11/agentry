import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
  parseWorkItemKey,
  workItemKey,
  type AcceptanceCriterion,
  type AcceptanceCriterionInput,
  type Board,
  type BoardColumn,
  type BoardColumnSummary,
  type ChatState,
  type CheckAcceptanceCriterionRequest,
  type CreateMilestoneRequest,
  type CreateWorkItemCommentRequest,
  type CreateWorkItemLinkRequest,
  type CreateWorkItemRelationRequest,
  type CreateWorkItemRequest,
  type Milestone,
  type MilestoneChangeAction,
  type MilestoneProgress,
  type MilestoneState,
  type MoveWorkItemRequest,
  type MoveWorkItemResult,
  type OrchestrationTaskStatus,
  type UpdateMilestoneRequest,
  type UpdateWorkItemRequest,
  type WorkItem,
  type WorkItemActor,
  type WorkItemCause,
  type WorkItemChange,
  type WorkItemComment,
  type WorkItemDetail,
  type WorkItemFilter,
  type WorkItemHistoryEntry,
  type WorkItemLink,
  type WorkItemPriority,
  type WorkItemRef,
  type WorkItemRelation,
  type WorkItemSource,
  type WorkItemStatus,
  type WorkItemType,
} from '@agentry/shared';
import type { Db } from './db.ts';
import type { AgentryEventInput } from './events.ts';
import { RANK_REBALANCE_LENGTH, rankBetween, spreadRanks } from './work-item-rank.ts';
import {
  actorOf,
  assigneeOf,
  commentOf,
  emptyProgress,
  emptySource,
  fold,
  inList,
  isLive,
  linkOf,
  milestoneOf,
  readValue,
  sourceOf,
  statusIndex,
  textMatches,
  type CommentRow,
  type CriterionRow,
  type HistoryRow,
  type ItemRow,
  type LinkRow,
  type MilestoneRow,
  type PendingEntry,
  type StoredHistoryValue,
  type StoredItemRef,
} from './work-item-rows.ts';
import { CRITERIA_MAX, WorkItemError, actorFrom, assignee, commentBody, criterionText, labels, milestoneName, oneOf, text, title } from './work-item-validation.ts';

export { WorkItemError } from './work-item-validation.ts';

/**
 * The work items of every project: the store behind the board, with no HTTP in it.
 *
 * The rules of the model live here rather than in the routes, so every caller (the API, the links
 * that move an item when its chat starts, a later agent) gets them: an epic has no epic, a relation
 * never points at its own item nor closes a cycle of `blocks`, a number is never handed out twice
 * inside a project, and a move over a column's limit succeeds and says so.
 *
 * History is written here and only here, one entry per field that changed, with who changed it and
 * why; a caller says who it is acting as, never what the history should read.
 *
 * Several wrapper processes share the database, so every write runs in a `BEGIN IMMEDIATE`
 * transaction: it takes the write lock before reading the counter or the neighbours' ranks, so two
 * processes cannot read the same last number or the same gap and both write into it.
 */

/** What the store needs to know about a project, from its settings document. */
export interface WorkItemProject {
  keyPrefix: string;
  columnLimits: Partial<Record<WorkItemStatus, number>>;
}

/** What a link points at as it is now; the store keeps only the ids. */
export interface WorkItemLinkState {
  name: string | null;
  chatState?: ChatState | null;
  taskStatus?: OrchestrationTaskStatus | null;
}

export interface WorkItemServiceDeps {
  db: Db;
  /**
   * The project's key prefix and column limits; null for an id that names no project. Settings
   * outlive a project removed from Agentry, so its items keep reading with their own keys.
   */
  project: (projectId: string) => WorkItemProject | null;
  /** Told of every change once it is committed, never before */
  emit?: (event: AgentryEventInput) => void;
  /** Fills in a link's name and state when read; without it links carry only their ids and no item is live */
  linkState?: (link: WorkItemLink) => WorkItemLinkState | null;
}

/** Who is acting, and why when it is a chat or an orchestration rather than someone on the item. */
export interface WorkItemContext {
  /** Default: the person */
  actor?: WorkItemActor;
  cause?: WorkItemCause | null;
}

/** A comment also says where an agent wrote it from. */
export interface WorkItemCommentContext extends WorkItemContext {
  source?: WorkItemSource | null;
}

/** Agentry recording a fact about an item (its worktree, a link's chat), not anyone editing it */
const SYSTEM: WorkItemActor = { kind: 'system', role: null };

/** The prefix a key is composed with when the project's settings cannot be read at all. */
const FALLBACK_PREFIX = 'ITEM';

const COLUMN_NAMES: Record<WorkItemStatus, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
};

// ---------- the service ----------

export class WorkItemService {
  private readonly sql: DatabaseSync;

  constructor(private readonly deps: WorkItemServiceDeps) {
    this.sql = deps.db.connection;
  }

  // ---------- reading ----------

  /** One item with its page: children, links, comments and history. */
  get(itemId: string): WorkItemDetail {
    const row = this.row(itemId);
    if (!row) throw new WorkItemError('work item not found', 404);
    const [item] = this.hydrate([row]);
    if (!item) throw new WorkItemError('work item not found', 404);
    const prefix = this.prefixOf(row.project_id);
    const children = (
      this.sql.prepare('SELECT * FROM work_items WHERE epic_id = ? ORDER BY number').all(itemId) as unknown as ItemRow[]
    ).map((child) => this.refOf(child, prefix));
    return {
      ...item,
      children,
      links: this.linksOf([itemId]).get(itemId) ?? [],
      comments: this.comments(itemId),
      history: this.history(itemId),
    };
  }

  /** Null rather than a refusal: for callers that only want to know whether it is there. */
  find(itemId: string): WorkItem | null {
    const row = this.row(itemId);
    return row ? (this.hydrate([row])[0] ?? null) : null;
  }

  /** By its key in a project (`AGN-12`), whatever the case it is typed in. */
  findByKey(projectId: string, key: string): WorkItem | null {
    const parsed = parseWorkItemKey(key);
    if (!parsed || parsed.prefix !== this.prefixOf(projectId)) return null;
    const row = this.sql.prepare('SELECT * FROM work_items WHERE project_id = ? AND number = ?').get(projectId, parsed.number) as ItemRow | undefined;
    return row ? (this.hydrate([row])[0] ?? null) : null;
  }

  /**
   * The items that pass the filter, in board order: column by column, and by rank inside one. The
   * All projects list (no `projectId`) orders each column by project, then rank.
   */
  list(filter: WorkItemFilter = {}): WorkItem[] {
    return this.hydrate(this.filtered(filter));
  }

  /** The five columns with their limits and real counts, and the items that pass the filter. */
  board(projectId: string | null, filter: Omit<WorkItemFilter, 'projectId'> = {}): Board {
    const limits = projectId ? (this.deps.project(projectId)?.columnLimits ?? {}) : {};
    const counts = this.counts(projectId);
    const items = this.list({ ...filter, ...(projectId ? { projectId } : {}) });
    const columns: BoardColumn[] = WORK_ITEM_STATUSES.map((status) => ({
      ...summary(status, projectId ? (limits[status] ?? null) : null, counts.get(status) ?? 0),
      items: items.filter((item) => item.status === status),
    }));
    return { projectId, columns };
  }

  /** Oldest first. */
  history(itemId: string): WorkItemHistoryEntry[] {
    const row = this.row(itemId);
    if (!row) throw new WorkItemError('work item not found', 404);
    const prefix = this.prefixOf(row.project_id);
    const rows = this.sql.prepare('SELECT * FROM work_item_history WHERE item_id = ? ORDER BY seq').all(itemId) as unknown as HistoryRow[];
    return rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      change: r.change as WorkItemChange,
      from: readValue(r.from_value, prefix),
      to: readValue(r.to_value, prefix),
      actor: actorOf(r.actor_kind, r.actor_role),
      cause:
        r.cause_kind && r.cause_event
          ? { ...(sourceOf(r.cause_kind, r.cause_chat_id, r.cause_orchestration_id, r.cause_task_id) ?? emptySource()), event: r.cause_event }
          : null,
      createdAt: r.created_at,
    }));
  }

  /** Oldest first. */
  comments(itemId: string): WorkItemComment[] {
    if (!this.row(itemId)) throw new WorkItemError('work item not found', 404);
    const rows = this.sql.prepare('SELECT * FROM work_item_comments WHERE item_id = ? ORDER BY created_at, rowid').all(itemId) as unknown as CommentRow[];
    return rows.map(commentOf);
  }

  /** Every link of an item, oldest first, with its state filled in when a reader is wired. */
  links(itemId: string): WorkItemLink[] {
    if (!this.row(itemId)) throw new WorkItemError('work item not found', 404);
    return this.linksOf([itemId]).get(itemId) ?? [];
  }

  /** The links a chat holds, for whoever moves items when the chat starts or ends a turn. */
  linksOfChat(chatId: string): WorkItemLink[] {
    const rows = this.sql.prepare('SELECT * FROM work_item_links WHERE chat_id = ? ORDER BY created_at, rowid').all(chatId) as unknown as LinkRow[];
    return rows.map((r) => this.withState(linkOf(r)));
  }

  /** The links an orchestration task holds, for whoever makes items follow their node. */
  linksOfTask(orchestrationId: string, taskId: string): WorkItemLink[] {
    const rows = this.sql
      .prepare('SELECT * FROM work_item_links WHERE orchestration_id = ? AND task_id = ? ORDER BY created_at, rowid')
      .all(orchestrationId, taskId) as unknown as LinkRow[];
    return rows.map((r) => this.withState(linkOf(r)));
  }

  // ---------- writing an item ----------

  create(projectId: string, input: CreateWorkItemRequest, ctx?: WorkItemContext): WorkItem {
    if (!this.deps.project(projectId)) throw new WorkItemError('project not found', 404);
    const type = input.type === undefined ? 'task' : oneOf(input.type, WORK_ITEM_TYPES, 'type');
    const status = input.status === undefined ? 'backlog' : oneOf(input.status, WORK_ITEM_STATUSES, 'status');
    const priority = input.priority === undefined ? 'medium' : oneOf(input.priority, WORK_ITEM_PRIORITIES, 'priority');
    const itemTitle = title(input.title);
    const description = input.description === undefined ? '' : text(input.description, 'description');
    const itemLabels = input.labels === undefined ? [] : labels(input.labels);
    const itemAssignee = input.assignee === undefined ? null : assignee(input.assignee);
    const criteria = (input.acceptanceCriteria ?? []).map((c) => criterionText(c.text));
    if (criteria.length > CRITERIA_MAX) throw new WorkItemError(`an item holds at most ${String(CRITERIA_MAX)} acceptance criteria`, 400);
    const actor = actorFrom(ctx);
    const cause = ctx?.cause ?? null;

    const id = randomUUID();
    const row = this.write(() => {
      const epicId = input.epicId ? this.checkEpic(projectId, input.epicId, type, id) : null;
      const milestoneId = input.milestoneId ? this.checkMilestone(projectId, input.milestoneId) : null;
      const counter = this.sql
        .prepare(
          `INSERT INTO work_item_counters (project_id, last_number) VALUES (?, 1)
           ON CONFLICT (project_id) DO UPDATE SET last_number = last_number + 1
           RETURNING last_number`,
        )
        .get(projectId) as { last_number: number } | undefined;
      if (!counter) throw new Error('the work item counter returned nothing');
      const now = new Date().toISOString();
      this.sql
        .prepare(
          `INSERT INTO work_items (id, project_id, number, type, title, description, status, priority, assignee_kind, assignee_role,
             epic_id, milestone_id, rank, worktree, branch, created_at, updated_at, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          projectId,
          counter.last_number,
          type,
          itemTitle,
          description,
          status,
          priority,
          itemAssignee?.kind ?? null,
          itemAssignee?.kind === 'role' ? itemAssignee.role : null,
          epicId,
          milestoneId,
          this.rankAtEnd(projectId, status, id),
          now,
          now,
          status === 'done' ? now : null,
        );
      this.writeLabels(id, itemLabels);
      const insert = this.sql.prepare('INSERT INTO work_item_criteria (id, item_id, position, text, checked) VALUES (?, ?, ?, ?, 0)');
      criteria.forEach((c, i) => insert.run(randomUUID(), id, i, c));
      this.record([{ itemId: id, change: 'created', from: null, to: itemTitle }], actor, cause, now);
      return this.mustRow(id);
    });
    const item = this.mustHydrate(row);
    this.emit({
      type: 'workitem.created',
      title: `Created ${item.key}: ${item.title}`,
      ...eventRef(item),
      itemType: item.type,
      status: item.status,
      source: cause ? sourcePart(cause) : null,
    });
    return item;
  }

  /** Only the fields present change; one history entry per field that did. */
  update(itemId: string, input: UpdateWorkItemRequest, ctx?: WorkItemContext): WorkItem {
    const actor = actorFrom(ctx);
    const cause = ctx?.cause ?? null;
    const result = this.write(() => {
      const before = this.mustRow(itemId);
      const prefix = this.prefixOf(before.project_id);
      const entries: PendingEntry[] = [];
      const sets: string[] = [];
      const params: SQLInputValue[] = [];
      const set = (column: string, value: SQLInputValue): void => {
        sets.push(`${column} = ?`);
        params.push(value);
      };

      const type = input.type === undefined ? (before.type as WorkItemType) : oneOf(input.type, WORK_ITEM_TYPES, 'type');
      if (type !== before.type) {
        if (before.type === 'epic') {
          const children = this.sql.prepare('SELECT COUNT(*) AS n FROM work_items WHERE epic_id = ?').get(itemId) as { n: number };
          if (children.n > 0) throw new WorkItemError(`this epic groups ${String(children.n)} items; move them out before changing its type`, 409);
        }
        set('type', type);
        entries.push({ itemId, change: 'type', from: before.type, to: type });
      }
      if (input.title !== undefined) {
        const next = title(input.title);
        if (next !== before.title) {
          set('title', next);
          entries.push({ itemId, change: 'title', from: before.title, to: next });
        }
      }
      if (input.description !== undefined) {
        const next = text(input.description, 'description');
        if (next !== before.description) {
          set('description', next);
          entries.push({ itemId, change: 'description', from: before.description, to: next });
        }
      }
      if (input.priority !== undefined) {
        const next = oneOf(input.priority, WORK_ITEM_PRIORITIES, 'priority');
        if (next !== before.priority) {
          set('priority', next);
          entries.push({ itemId, change: 'priority', from: before.priority, to: next });
        }
      }
      if (input.labels !== undefined) {
        const previous = this.labelsOf([itemId]).get(itemId) ?? [];
        const next = labels(input.labels);
        if (JSON.stringify(previous) !== JSON.stringify(next)) {
          this.writeLabels(itemId, next);
          entries.push({ itemId, change: 'labels', from: previous, to: next });
        }
      }
      if (input.assignee !== undefined) {
        const previous = assigneeOf(before);
        const next = assignee(input.assignee);
        if (JSON.stringify(previous) !== JSON.stringify(next)) {
          set('assignee_kind', next?.kind ?? null);
          set('assignee_role', next?.kind === 'role' ? next.role : null);
          entries.push({ itemId, change: 'assignee', from: previous, to: next });
        }
      }
      const epicId = input.epicId === undefined ? before.epic_id : input.epicId === null ? null : this.checkEpic(before.project_id, input.epicId, type, itemId);
      if (type === 'epic' && epicId !== null) throw new WorkItemError('an epic cannot belong to another epic', 400);
      if (epicId !== before.epic_id) {
        set('epic_id', epicId);
        entries.push({ itemId, change: 'epic', from: this.itemSnapshot(before.epic_id), to: this.itemSnapshot(epicId) });
      }
      if (input.milestoneId !== undefined) {
        const next = input.milestoneId === null ? null : this.checkMilestone(before.project_id, input.milestoneId);
        if (next !== before.milestone_id) {
          set('milestone_id', next);
          entries.push({ itemId, change: 'milestone', from: this.milestoneSnapshot(before.milestone_id), to: this.milestoneSnapshot(next) });
        }
      }
      // A new order alone rewrites the checklist without an entry, and still counts as a change
      let reordered = false;
      if (input.acceptanceCriteria !== undefined) {
        const criteria = this.replaceCriteria(itemId, input.acceptanceCriteria);
        entries.push(...criteria.entries);
        reordered = criteria.rewritten;
      }

      if (!entries.length && !reordered) return { row: before, changes: [] as WorkItemChange[], prefix };
      const now = new Date().toISOString();
      set('updated_at', now);
      this.sql.prepare(`UPDATE work_items SET ${sets.join(', ')} WHERE id = ?`).run(...params, itemId);
      this.record(entries, actor, cause, now);
      const changes: WorkItemChange[] = entries.map((e) => e.change);
      if (reordered) changes.push('criterion');
      return { row: this.mustRow(itemId), changes: unique(changes), prefix };
    });
    const item = this.mustHydrate(result.row);
    if (result.changes.length) this.emitUpdated(item, result.changes, actor, cause);
    return item;
  }

  /**
   * Moves an item to a column and a place in it. Over the column's limit is not a refusal: the
   * result and the event say so, and the board shows it.
   */
  move(itemId: string, input: MoveWorkItemRequest, ctx?: WorkItemContext): MoveWorkItemResult {
    const status = oneOf(input.status, WORK_ITEM_STATUSES, 'status');
    const actor = actorFrom(ctx);
    const cause = ctx?.cause ?? null;
    const result = this.write(() => {
      const before = this.mustRow(itemId);
      // Already between the neighbours it was asked to go between: its rank stays, and nothing moved
      const fits = (low: string | null, high: string | null): boolean =>
        before.status === status && (low === null || before.rank > low) && (high === null || before.rank < high);
      let rank: string;
      if (input.afterId === undefined) {
        rank = before.status === status && this.isLast(before) ? before.rank : this.rankAtEnd(before.project_id, status, itemId);
      } else if (input.afterId === null) {
        const first = this.sql
          .prepare('SELECT rank FROM work_items WHERE project_id = ? AND status = ? AND id != ? ORDER BY rank LIMIT 1')
          .get(before.project_id, status, itemId) as { rank: string } | undefined;
        const high = first?.rank ?? null;
        rank = fits(null, high) ? before.rank : this.rankInColumn(before.project_id, status, itemId, null, high);
      } else {
        if (input.afterId === itemId) throw new WorkItemError('an item cannot go after itself', 400);
        const after = this.row(input.afterId);
        if (!after || after.project_id !== before.project_id || after.status !== status) {
          throw new WorkItemError('afterId must name an item in the target column', 400);
        }
        const next = this.sql
          .prepare('SELECT rank FROM work_items WHERE project_id = ? AND status = ? AND id != ? AND rank > ? ORDER BY rank LIMIT 1')
          .get(before.project_id, status, itemId, after.rank) as { rank: string } | undefined;
        const high = next?.rank ?? null;
        rank = fits(after.rank, high) ? before.rank : this.rankInColumn(before.project_id, status, itemId, after.rank, high);
      }
      const statusChanged = status !== before.status;
      if (!statusChanged && rank === before.rank) return { row: before, previous: before.status as WorkItemStatus, moved: false };
      const now = new Date().toISOString();
      const closedAt = status === 'done' ? (statusChanged ? now : before.closed_at) : null;
      this.sql
        .prepare('UPDATE work_items SET status = ?, rank = ?, closed_at = ?, updated_at = ? WHERE id = ?')
        .run(status, rank, closedAt, now, itemId);
      if (statusChanged) this.record([{ itemId, change: 'status', from: before.status, to: status }], actor, cause, now);
      return { row: this.mustRow(itemId), previous: before.status as WorkItemStatus, moved: true };
    });
    const item = this.mustHydrate(result.row);
    const column = this.columnSummary(item.projectId, status);
    if (result.moved) {
      this.emit({
        type: 'workitem.moved',
        title: result.previous === status ? `Reordered ${item.key} in ${COLUMN_NAMES[status]}` : `Moved ${item.key} to ${COLUMN_NAMES[status]}`,
        ...eventRef(item),
        status,
        previousStatus: result.previous,
        overLimit: column.overLimit,
        actor,
        cause,
      });
    }
    return { item, column };
  }

  /**
   * Deletes an item for good. Its number is not handed out again. The items it grouped as an epic,
   * and those it was related to, record in their own history that it went.
   */
  remove(itemId: string, ctx?: WorkItemContext): void {
    const actor = actorFrom(ctx);
    const cause = ctx?.cause ?? null;
    const { row, touched } = this.write(() => {
      const row = this.mustRow(itemId);
      const entries: PendingEntry[] = [];
      const children = this.sql.prepare('SELECT id FROM work_items WHERE epic_id = ?').all(itemId) as Array<{ id: string }>;
      const snapshot = this.itemSnapshot(itemId);
      for (const child of children) entries.push({ itemId: child.id, change: 'epic', from: snapshot, to: null });
      for (const edge of this.edgesOf(itemId)) {
        const otherId = edge.blocker_id === itemId ? edge.blocked_id : edge.blocker_id;
        const type = edge.blocker_id === itemId ? 'blocked_by' : 'blocks';
        entries.push({ itemId: otherId, change: 'relation', from: { type, item: this.storedRef(row) }, to: null });
      }
      const now = new Date().toISOString();
      if (children.length) this.sql.prepare('UPDATE work_items SET epic_id = NULL, updated_at = ? WHERE epic_id = ?').run(now, itemId);
      this.record(entries, actor, cause, now);
      this.sql.prepare('DELETE FROM work_items WHERE id = ?').run(itemId);
      const touched = new Map<string, WorkItemChange[]>();
      for (const e of entries) touched.set(e.itemId, unique([...(touched.get(e.itemId) ?? []), e.change]));
      return { row, touched };
    });
    const key = workItemKey(this.prefixOf(row.project_id), row.number);
    this.emit({ type: 'workitem.removed', title: `Removed ${key}: ${row.title}`, projectId: row.project_id, itemId, key });
    for (const [otherId, changes] of touched) {
      const other = this.find(otherId);
      if (other) this.emitUpdated(other, changes, actor, cause);
    }
  }

  /** Records where the item is worked on git. Not a field anyone edits, so it writes no history. */
  setWorktree(itemId: string, place: { worktree: string | null; branch: string | null }): WorkItem {
    const row = this.write(() => {
      this.mustRow(itemId);
      this.sql
        .prepare('UPDATE work_items SET worktree = ?, branch = ?, updated_at = ? WHERE id = ?')
        .run(place.worktree, place.branch, new Date().toISOString(), itemId);
      return this.mustRow(itemId);
    });
    const item = this.mustHydrate(row);
    this.emitUpdated(item, [], SYSTEM, null);
    return item;
  }

  // ---------- criteria, comments, relations, links ----------

  checkCriterion(itemId: string, criterionId: string, input: CheckAcceptanceCriterionRequest, ctx?: WorkItemContext): WorkItem {
    if (typeof input.checked !== 'boolean') throw new WorkItemError('checked must be true or false', 400);
    const actor = actorFrom(ctx);
    const cause = ctx?.cause ?? null;
    const result = this.write(() => {
      this.mustRow(itemId);
      const c = this.sql.prepare('SELECT * FROM work_item_criteria WHERE id = ? AND item_id = ?').get(criterionId, itemId) as CriterionRow | undefined;
      if (!c) throw new WorkItemError('acceptance criterion not found', 404);
      if (Boolean(c.checked) === input.checked) return { row: this.mustRow(itemId), changed: false };
      const now = new Date().toISOString();
      this.sql
        .prepare('UPDATE work_item_criteria SET checked = ?, checked_by_kind = ?, checked_by_role = ? WHERE id = ?')
        .run(input.checked ? 1 : 0, input.checked ? actor.kind : null, input.checked ? (actor.role ?? null) : null, criterionId);
      this.sql.prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(now, itemId);
      this.record(
        [
          {
            itemId,
            change: 'criterion',
            from: { id: c.id, text: c.text, checked: Boolean(c.checked) },
            to: { id: c.id, text: c.text, checked: input.checked },
          },
        ],
        actor,
        cause,
        now,
      );
      return { row: this.mustRow(itemId), changed: true };
    });
    const item = this.mustHydrate(result.row);
    if (result.changed) this.emitUpdated(item, ['criterion'], actor, cause);
    return item;
  }

  /** Comments are their own list, not history; the event still says one arrived. */
  comment(itemId: string, input: CreateWorkItemCommentRequest, ctx?: WorkItemCommentContext): WorkItemComment {
    const body = commentBody(input.body);
    const actor = actorFrom(ctx);
    const source = ctx?.source ?? null;
    const comment = this.write(() => {
      this.mustRow(itemId);
      const now = new Date().toISOString();
      const id = randomUUID();
      this.sql
        .prepare(
          `INSERT INTO work_item_comments (id, item_id, author_kind, author_role, source_kind, source_chat_id, source_orchestration_id,
             source_task_id, body, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          itemId,
          actor.kind,
          actor.role ?? null,
          source?.kind ?? null,
          source?.chatId ?? null,
          source?.orchestrationId ?? null,
          source?.taskId ?? null,
          body,
          now,
          now,
        );
      this.sql.prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(now, itemId);
      const row = this.sql.prepare('SELECT * FROM work_item_comments WHERE id = ?').get(id) as unknown as CommentRow;
      return commentOf(row);
    });
    const item = this.find(itemId);
    if (item) this.emitUpdated(item, ['comment'], actor, ctx?.cause ?? null);
    return comment;
  }

  /**
   * Relates two items of one project. Stored once, as `blocks`, whichever end it was asked from;
   * refused when it points at the item itself or would close a cycle, and a no-op when it exists.
   */
  relate(itemId: string, input: CreateWorkItemRelationRequest, ctx?: WorkItemContext): WorkItem {
    const type = oneOf(input.type, ['blocks', 'blocked_by'] as const, 'type');
    if (typeof input.itemId !== 'string' || !input.itemId) throw new WorkItemError('itemId is required', 400);
    if (input.itemId === itemId) throw new WorkItemError('an item cannot be related to itself', 400);
    const actor = actorFrom(ctx);
    const cause = ctx?.cause ?? null;
    const result = this.write(() => {
      const self = this.mustRow(itemId);
      const other = this.row(input.itemId);
      if (!other || other.project_id !== self.project_id) throw new WorkItemError('the related item must be a work item of the same project', 400);
      const [blocker, blocked] = type === 'blocks' ? [self, other] : [other, self];
      if (this.sql.prepare('SELECT 1 FROM work_item_relations WHERE blocker_id = ? AND blocked_id = ?').get(blocker.id, blocked.id)) {
        return { row: self, changed: false };
      }
      if (this.reaches(blocked.id, blocker.id)) {
        throw new WorkItemError(`${this.keyOf(blocked)} already blocks ${this.keyOf(blocker)}, directly or through other items: this would close a cycle`, 409);
      }
      const now = new Date().toISOString();
      this.sql.prepare('INSERT INTO work_item_relations (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(blocker.id, blocked.id, now);
      this.sql.prepare('UPDATE work_items SET updated_at = ? WHERE id IN (?, ?)').run(now, blocker.id, blocked.id);
      this.record(
        [
          { itemId: blocker.id, change: 'relation', from: null, to: { type: 'blocks', item: this.storedRef(blocked) } },
          { itemId: blocked.id, change: 'relation', from: null, to: { type: 'blocked_by', item: this.storedRef(blocker) } },
        ],
        actor,
        cause,
        now,
      );
      return { row: this.mustRow(itemId), changed: true };
    });
    const item = this.mustHydrate(result.row);
    if (result.changed) {
      this.emitUpdated(item, ['relation'], actor, cause);
      const other = this.find(input.itemId);
      if (other) this.emitUpdated(other, ['relation'], actor, cause);
    }
    return item;
  }

  /** Removes the relation between two items, whichever way it points. */
  unrelate(itemId: string, otherId: string, ctx?: WorkItemContext): WorkItem {
    const actor = actorFrom(ctx);
    const cause = ctx?.cause ?? null;
    const row = this.write(() => {
      const self = this.mustRow(itemId);
      const edge = this.edgesOf(itemId).find((e) => e.blocker_id === otherId || e.blocked_id === otherId);
      if (!edge) throw new WorkItemError('these items are not related', 404);
      const blocker = this.mustRow(edge.blocker_id);
      const blocked = this.mustRow(edge.blocked_id);
      const now = new Date().toISOString();
      this.sql.prepare('DELETE FROM work_item_relations WHERE blocker_id = ? AND blocked_id = ?').run(blocker.id, blocked.id);
      this.sql.prepare('UPDATE work_items SET updated_at = ? WHERE id IN (?, ?)').run(now, blocker.id, blocked.id);
      this.record(
        [
          { itemId: blocker.id, change: 'relation', from: { type: 'blocks', item: this.storedRef(blocked) }, to: null },
          { itemId: blocked.id, change: 'relation', from: { type: 'blocked_by', item: this.storedRef(blocker) }, to: null },
        ],
        actor,
        cause,
        now,
      );
      return this.mustRow(self.id);
    });
    const item = this.mustHydrate(row);
    this.emitUpdated(item, ['relation'], actor, cause);
    const other = this.find(otherId);
    if (other) this.emitUpdated(other, ['relation'], actor, cause);
    return item;
  }

  /**
   * Ties a chat or an orchestration task to the item. An item keeps every link; the same link twice
   * is the one already there.
   */
  link(itemId: string, input: CreateWorkItemLinkRequest, ctx?: WorkItemContext): WorkItemLink {
    const kind = oneOf(input.kind, ['chat', 'orchestration'] as const, 'kind');
    const role = oneOf(input.role, ['work', 'origin'] as const, 'role');
    const chatId = input.chatId ?? null;
    const orchestrationId = input.orchestrationId ?? null;
    const taskId = input.taskId ?? null;
    if (kind === 'chat' && !chatId) throw new WorkItemError('a chat link needs chatId', 400);
    if (kind === 'orchestration' && (!orchestrationId || !taskId)) throw new WorkItemError('an orchestration link needs orchestrationId and taskId', 400);
    const actor = actorFrom(ctx);
    const cause = ctx?.cause ?? null;
    const result = this.write(() => {
      this.mustRow(itemId);
      // A task's chat is only known once its worker starts, so the task, not the chat, is its identity
      const existing = (
        kind === 'chat'
          ? this.sql.prepare("SELECT * FROM work_item_links WHERE item_id = ? AND kind = 'chat' AND role = ? AND chat_id = ?").get(itemId, role, chatId)
          : this.sql
              .prepare("SELECT * FROM work_item_links WHERE item_id = ? AND kind = 'orchestration' AND role = ? AND orchestration_id = ? AND task_id = ?")
              .get(itemId, role, orchestrationId, taskId)
      ) as LinkRow | undefined;
      if (existing) return { link: linkOf(existing), changed: false };
      const id = randomUUID();
      const now = new Date().toISOString();
      this.sql
        .prepare('INSERT INTO work_item_links (id, item_id, kind, role, chat_id, orchestration_id, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, itemId, kind, role, chatId, orchestrationId, taskId, now);
      const link = linkOf(this.sql.prepare('SELECT * FROM work_item_links WHERE id = ?').get(id) as unknown as LinkRow);
      this.sql.prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(now, itemId);
      this.record([{ itemId, change: 'link', from: null, to: { id, label: this.linkLabel(link) } }], actor, cause, now);
      return { link, changed: true };
    });
    if (result.changed) {
      const item = this.find(itemId);
      if (item) this.emitUpdated(item, ['link'], actor, cause);
    }
    return this.withState(result.link);
  }

  /** Once an orchestration task's worker starts, its link learns the chat it runs in. */
  setLinkChat(linkId: string, chatId: string): WorkItemLink {
    const row = this.write(() => {
      const link = this.sql.prepare('SELECT * FROM work_item_links WHERE id = ?').get(linkId) as LinkRow | undefined;
      if (!link) throw new WorkItemError('link not found', 404);
      this.sql.prepare('UPDATE work_item_links SET chat_id = ? WHERE id = ?').run(chatId, linkId);
      return this.sql.prepare('SELECT * FROM work_item_links WHERE id = ?').get(linkId) as unknown as LinkRow;
    });
    const link = linkOf(row);
    const item = this.find(link.itemId);
    if (item) this.emitUpdated(item, [], SYSTEM, null);
    return this.withState(link);
  }

  unlink(linkId: string, ctx?: WorkItemContext): void {
    const actor = actorFrom(ctx);
    const cause = ctx?.cause ?? null;
    const link = this.write(() => {
      const row = this.sql.prepare('SELECT * FROM work_item_links WHERE id = ?').get(linkId) as LinkRow | undefined;
      if (!row) throw new WorkItemError('link not found', 404);
      const link = linkOf(row);
      const now = new Date().toISOString();
      this.sql.prepare('DELETE FROM work_item_links WHERE id = ?').run(linkId);
      this.sql.prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(now, link.itemId);
      this.record([{ itemId: link.itemId, change: 'link', from: { id: linkId, label: this.linkLabel(link) }, to: null }], actor, cause, now);
      return link;
    });
    const item = this.find(link.itemId);
    if (item) this.emitUpdated(item, ['link'], actor, cause);
  }

  // ---------- milestones ----------

  milestones(projectId: string): Milestone[] {
    const rows = this.sql.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as unknown as MilestoneRow[];
    const progress = this.progress(rows.map((r) => r.id));
    return rows.map((r) => milestoneOf(r, progress.get(r.id) ?? emptyProgress()));
  }

  milestone(milestoneId: string): Milestone {
    const row = this.sql.prepare('SELECT * FROM milestones WHERE id = ?').get(milestoneId) as MilestoneRow | undefined;
    if (!row) throw new WorkItemError('milestone not found', 404);
    return milestoneOf(row, this.progress([row.id]).get(row.id) ?? emptyProgress());
  }

  createMilestone(projectId: string, input: CreateMilestoneRequest): Milestone {
    if (!this.deps.project(projectId)) throw new WorkItemError('project not found', 404);
    const name = milestoneName(input.name);
    const description = input.description === undefined ? '' : text(input.description, 'description');
    const id = randomUUID();
    this.write(() => {
      const now = new Date().toISOString();
      this.sql
        .prepare("INSERT INTO milestones (id, project_id, name, description, state, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, 'open', ?, ?, NULL)")
        .run(id, projectId, name, description, now, now);
    });
    const milestone = this.milestone(id);
    this.emitMilestone(milestone, 'created');
    return milestone;
  }

  updateMilestone(milestoneId: string, input: UpdateMilestoneRequest): Milestone {
    const action = this.write((): MilestoneChangeAction | null => {
      const row = this.sql.prepare('SELECT * FROM milestones WHERE id = ?').get(milestoneId) as MilestoneRow | undefined;
      if (!row) throw new WorkItemError('milestone not found', 404);
      const name = input.name === undefined ? row.name : milestoneName(input.name);
      const description = input.description === undefined ? row.description : text(input.description, 'description');
      const state = input.state === undefined ? (row.state as MilestoneState) : oneOf(input.state, ['open', 'closed'] as const, 'state');
      if (name === row.name && description === row.description && state === row.state) return null;
      const now = new Date().toISOString();
      const closedAt = state === 'closed' ? (row.state === 'closed' ? row.closed_at : now) : null;
      this.sql
        .prepare('UPDATE milestones SET name = ?, description = ?, state = ?, updated_at = ?, closed_at = ? WHERE id = ?')
        .run(name, description, state, now, closedAt, milestoneId);
      if (state !== row.state) return state === 'closed' ? 'closed' : 'reopened';
      return 'updated';
    });
    const milestone = this.milestone(milestoneId);
    if (action) this.emitMilestone(milestone, action);
    return milestone;
  }

  /** Its items stay, without a milestone, and each says so in its history. */
  deleteMilestone(milestoneId: string, ctx?: WorkItemContext): void {
    const actor = actorFrom(ctx);
    const cause = ctx?.cause ?? null;
    const { row, items } = this.write(() => {
      const row = this.sql.prepare('SELECT * FROM milestones WHERE id = ?').get(milestoneId) as MilestoneRow | undefined;
      if (!row) throw new WorkItemError('milestone not found', 404);
      const items = (this.sql.prepare('SELECT id FROM work_items WHERE milestone_id = ?').all(milestoneId) as Array<{ id: string }>).map((r) => r.id);
      const snapshot = this.milestoneSnapshot(milestoneId);
      const now = new Date().toISOString();
      this.sql.prepare('UPDATE work_items SET milestone_id = NULL, updated_at = ? WHERE milestone_id = ?').run(now, milestoneId);
      this.record(
        items.map((itemId) => ({ itemId, change: 'milestone', from: snapshot, to: null })),
        actor,
        cause,
        now,
      );
      this.sql.prepare('DELETE FROM milestones WHERE id = ?').run(milestoneId);
      return { row, items };
    });
    this.emitMilestone(milestoneOf(row, emptyProgress()), 'deleted');
    for (const itemId of items) {
      const item = this.find(itemId);
      if (item) this.emitUpdated(item, ['milestone'], actor, cause);
    }
  }

  // ---------- internals ----------

  /**
   * `BEGIN IMMEDIATE` takes the write lock up front. A deferred transaction that reads and then
   * writes can find another process holding the lock at the upgrade, which SQLite answers with
   * SQLITE_BUSY at once instead of waiting out busy_timeout.
   */
  private write<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.sql.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.sql.exec('ROLLBACK');
      } catch {
        // SQLite already ended the transaction (a failed COMMIT, or one it rolled back itself); what
        // the caller needs is the error that got us here, not "no transaction is active"
      }
      throw err;
    }
  }

  private emit(event: AgentryEventInput): void {
    try {
      this.deps.emit?.(event);
    } catch {
      // the change is committed; a broken listener must not turn it into an error for the caller
    }
  }

  private emitUpdated(item: WorkItem, changes: WorkItemChange[], actor: WorkItemActor, cause: WorkItemCause | null): void {
    this.emit({ type: 'workitem.updated', title: `Updated ${item.key}: ${item.title}`, ...eventRef(item), changes, actor, cause });
  }

  private emitMilestone(milestone: Milestone, action: MilestoneChangeAction): void {
    this.emit({
      type: 'milestone.changed',
      title: `Milestone ${milestone.name} ${action}`,
      projectId: milestone.projectId,
      milestoneId: milestone.id,
      milestoneName: milestone.name,
      action,
    });
  }

  private row(itemId: string): ItemRow | undefined {
    return this.sql.prepare('SELECT * FROM work_items WHERE id = ?').get(itemId) as ItemRow | undefined;
  }

  private mustRow(itemId: string): ItemRow {
    const row = this.row(itemId);
    if (!row) throw new WorkItemError('work item not found', 404);
    return row;
  }

  private mustHydrate(row: ItemRow): WorkItem {
    const [item] = this.hydrate([row]);
    if (!item) throw new WorkItemError('work item not found', 404);
    return item;
  }

  private prefixOf(projectId: string): string {
    return this.deps.project(projectId)?.keyPrefix ?? FALLBACK_PREFIX;
  }

  private keyOf(row: ItemRow): string {
    return workItemKey(this.prefixOf(row.project_id), row.number);
  }

  private refOf(row: ItemRow, prefix: string): WorkItemRef {
    return { id: row.id, key: workItemKey(prefix, row.number), title: row.title, type: row.type as WorkItemType, status: row.status as WorkItemStatus };
  }

  private storedRef(row: ItemRow): StoredItemRef {
    return { id: row.id, number: row.number, title: row.title, type: row.type as WorkItemType, status: row.status as WorkItemStatus };
  }

  private itemSnapshot(itemId: string | null): StoredHistoryValue {
    if (!itemId) return null;
    const row = this.row(itemId);
    return row ? { id: row.id, label: row.title, number: row.number } : { id: itemId, label: '' };
  }

  private milestoneSnapshot(milestoneId: string | null): StoredHistoryValue {
    if (!milestoneId) return null;
    const row = this.sql.prepare('SELECT name FROM milestones WHERE id = ?').get(milestoneId) as { name: string } | undefined;
    return { id: milestoneId, label: row?.name ?? '' };
  }

  private linkLabel(link: WorkItemLink): string {
    const name = this.deps.linkState?.(link)?.name;
    if (name) return name;
    return link.kind === 'chat' ? `chat ${link.chatId ?? ''}` : `${link.orchestrationId ?? ''} / ${link.taskId ?? ''}`;
  }

  /** The epic must be an epic of the same project, and only a non-epic may have one. */
  private checkEpic(projectId: string, epicId: string, type: WorkItemType, itemId: string): string {
    if (type === 'epic') throw new WorkItemError('an epic cannot belong to another epic', 400);
    if (epicId === itemId) throw new WorkItemError('an item cannot be its own epic', 400);
    const epic = this.row(epicId);
    if (!epic || epic.project_id !== projectId) throw new WorkItemError('epicId must name an epic of the same project', 400);
    if (epic.type !== 'epic') throw new WorkItemError(`${this.keyOf(epic)} is not an epic`, 400);
    return epicId;
  }

  private checkMilestone(projectId: string, milestoneId: string): string {
    const row = this.sql.prepare('SELECT project_id FROM milestones WHERE id = ?').get(milestoneId) as { project_id: string } | undefined;
    if (!row || row.project_id !== projectId) throw new WorkItemError('milestoneId must name a milestone of the same project', 400);
    return milestoneId;
  }

  private writeLabels(itemId: string, list: readonly string[]): void {
    this.sql.prepare('DELETE FROM work_item_labels WHERE item_id = ?').run(itemId);
    const insert = this.sql.prepare('INSERT INTO work_item_labels (item_id, position, label) VALUES (?, ?, ?)');
    list.forEach((label, i) => insert.run(itemId, i, label));
  }

  /**
   * Replaces the checklist. An entry with an id keeps its check; one without is new. History says
   * which were added, removed or reworded; a new order alone is not a change worth an entry, but
   * `rewritten` says the rows changed, so the caller still bumps the item and announces it.
   */
  private replaceCriteria(itemId: string, input: readonly AcceptanceCriterionInput[]): { entries: PendingEntry[]; rewritten: boolean } {
    if (!Array.isArray(input)) throw new WorkItemError('acceptanceCriteria must be a list', 400);
    if (input.length > CRITERIA_MAX) throw new WorkItemError(`an item holds at most ${String(CRITERIA_MAX)} acceptance criteria`, 400);
    const current = this.sql.prepare('SELECT * FROM work_item_criteria WHERE item_id = ? ORDER BY position').all(itemId) as unknown as CriterionRow[];
    const byId = new Map(current.map((c) => [c.id, c]));
    const kept = new Set<string>();
    const entries: PendingEntry[] = [];
    const next = input.map((entry) => {
      const t = criterionText(entry.text);
      if (entry.id !== undefined) {
        const existing = byId.get(entry.id);
        if (!existing || kept.has(entry.id)) throw new WorkItemError('an acceptance criterion id does not belong to this item', 400);
        kept.add(entry.id);
        if (existing.text !== t) {
          const checked = Boolean(existing.checked);
          entries.push({ itemId, change: 'criterion', from: { id: existing.id, text: existing.text, checked }, to: { id: existing.id, text: t, checked } });
        }
        return { id: existing.id, text: t, existing };
      }
      const id = randomUUID();
      entries.push({ itemId, change: 'criterion', from: null, to: { id, text: t, checked: false } });
      return { id, text: t, existing: null };
    });
    for (const c of current) {
      if (!kept.has(c.id)) entries.push({ itemId, change: 'criterion', from: { id: c.id, text: c.text, checked: Boolean(c.checked) }, to: null });
    }
    const orderChanged = next.some((c, i) => c.existing?.position !== i) || current.length !== next.length;
    if (!entries.length && !orderChanged) return { entries, rewritten: false };
    this.sql.prepare('DELETE FROM work_item_criteria WHERE item_id = ?').run(itemId);
    const insert = this.sql.prepare(
      'INSERT INTO work_item_criteria (id, item_id, position, text, checked, checked_by_kind, checked_by_role) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    next.forEach((c, i) => insert.run(c.id, itemId, i, c.text, c.existing?.checked ?? 0, c.existing?.checked_by_kind ?? null, c.existing?.checked_by_role ?? null));
    return { entries, rewritten: true };
  }

  private record(entries: readonly PendingEntry[], actor: WorkItemActor, cause: WorkItemCause | null, at: string): void {
    const insert = this.sql.prepare(
      `INSERT INTO work_item_history (id, item_id, change, from_value, to_value, actor_kind, actor_role,
         cause_kind, cause_event, cause_chat_id, cause_orchestration_id, cause_task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of entries) {
      insert.run(
        randomUUID(),
        e.itemId,
        e.change,
        e.from === null ? null : JSON.stringify(e.from),
        e.to === null ? null : JSON.stringify(e.to),
        actor.kind,
        actor.role ?? null,
        cause?.kind ?? null,
        cause?.event ?? null,
        cause?.chatId ?? null,
        cause?.orchestrationId ?? null,
        cause?.taskId ?? null,
        at,
      );
    }
  }

  // ---------- ranks ----------

  private isLast(row: ItemRow): boolean {
    return !this.sql.prepare('SELECT 1 FROM work_items WHERE project_id = ? AND status = ? AND rank > ? LIMIT 1').get(row.project_id, row.status, row.rank);
  }

  private rankAtEnd(projectId: string, status: WorkItemStatus, itemId: string): string {
    const last = this.sql
      .prepare('SELECT rank FROM work_items WHERE project_id = ? AND status = ? AND id != ? ORDER BY rank DESC LIMIT 1')
      .get(projectId, status, itemId) as { rank: string } | undefined;
    return this.rankInColumn(projectId, status, itemId, last?.rank ?? null, null);
  }

  /**
   * A rank between two neighbours of a column. Should it come out long, or should the neighbours
   * leave no room (a tie or a malformed rank a hand-edited row could leave), the column is spread
   * out again first, inside the same transaction, and the rank is taken from the fresh spacing.
   */
  private rankInColumn(projectId: string, status: WorkItemStatus, itemId: string, before: string | null, after: string | null): string {
    try {
      const rank = rankBetween(before, after);
      if (rank.length <= RANK_REBALANCE_LENGTH) return rank;
    } catch {
      // no room between these two: the respread below makes some
    }
    const others = this.sql
      .prepare('SELECT id, rank FROM work_items WHERE project_id = ? AND status = ? AND id != ? ORDER BY rank, id')
      .all(projectId, status, itemId) as Array<{ id: string; rank: string }>;
    // The new rank goes after every other ranked at or before `before`
    const order: Array<string | null> = others.map((o) => o.id);
    order.splice(before === null ? 0 : others.filter((o) => o.rank <= before).length, 0, null);
    const fresh = spreadRanks(order.length);
    const update = this.sql.prepare('UPDATE work_items SET rank = ? WHERE id = ?');
    let mine = '';
    order.forEach((id, i) => {
      const rank = fresh[i] ?? '';
      if (id === null) mine = rank;
      else update.run(rank, id);
    });
    return mine;
  }

  // ---------- relations ----------

  private edgesOf(itemId: string): Array<{ blocker_id: string; blocked_id: string }> {
    return this.sql.prepare('SELECT blocker_id, blocked_id FROM work_item_relations WHERE blocker_id = ? OR blocked_id = ?').all(itemId, itemId) as Array<{
      blocker_id: string;
      blocked_id: string;
    }>;
  }

  /** Whether `from` blocks `to`, directly or through a chain of `blocks`. */
  private reaches(from: string, to: string): boolean {
    const row = this.sql
      .prepare(
        `WITH RECURSIVE chain (id) AS (
           SELECT blocked_id FROM work_item_relations WHERE blocker_id = ?
           UNION
           SELECT r.blocked_id FROM work_item_relations r JOIN chain c ON r.blocker_id = c.id
         )
         SELECT 1 FROM chain WHERE id = ? LIMIT 1`,
      )
      .get(from, to);
    return Boolean(row);
  }

  // ---------- reading many ----------

  private filtered(filter: WorkItemFilter): ItemRow[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.projectId !== undefined) {
      where.push('w.project_id = ?');
      params.push(filter.projectId);
    }
    const within = (column: string, values: readonly string[] | undefined): void => {
      if (!values?.length) return;
      where.push(`${column} IN (SELECT value FROM json_each(?))`);
      params.push(inList(values));
    };
    within('w.status', filter.status);
    within('w.type', filter.type);
    within('w.priority', filter.priority);
    if (filter.assignee?.length) {
      const alternatives: string[] = [];
      for (const a of filter.assignee) {
        if (a === 'person') alternatives.push("w.assignee_kind = 'person'");
        else if (a === 'none') alternatives.push('w.assignee_kind IS NULL');
        else if (a.startsWith('role:') && a.length > 5) {
          alternatives.push("(w.assignee_kind = 'role' AND w.assignee_role = ?)");
          params.push(a.slice(5));
        } else throw new WorkItemError('assignee must be person, none or role:<role>', 400);
      }
      where.push(`(${alternatives.join(' OR ')})`);
    }
    if (filter.epicId !== undefined) {
      where.push('w.epic_id = ?');
      params.push(filter.epicId);
    }
    if (filter.milestoneId !== undefined) {
      where.push('w.milestone_id = ?');
      params.push(filter.milestoneId);
    }
    let rows = this.sql
      .prepare(`SELECT w.* FROM work_items w ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY w.project_id, w.rank, w.id`)
      .all(...params) as unknown as ItemRow[];
    // Text is matched here rather than in SQL, whose case folding stops at ASCII
    if (filter.labels?.length) {
      const wanted = new Set(filter.labels.map(fold));
      const labelMap = this.labelsOf(rows.map((r) => r.id));
      rows = rows.filter((r) => (labelMap.get(r.id) ?? []).some((label) => wanted.has(fold(label))));
    }
    const q = filter.q?.trim();
    if (q) {
      const key = parseWorkItemKey(q);
      rows = rows.filter((r) => textMatches(r, q) || (key !== null && r.number === key.number && this.prefixOf(r.project_id) === key.prefix));
    }
    return rows.sort((a, b) => statusIndex(a.status) - statusIndex(b.status));
  }

  private counts(projectId: string | null): Map<string, number> {
    const rows = (
      projectId
        ? this.sql.prepare('SELECT status, COUNT(*) AS n FROM work_items WHERE project_id = ? GROUP BY status').all(projectId)
        : this.sql.prepare('SELECT status, COUNT(*) AS n FROM work_items GROUP BY status').all()
    ) as Array<{ status: string; n: number }>;
    return new Map(rows.map((r) => [r.status, r.n]));
  }

  private columnSummary(projectId: string, status: WorkItemStatus): BoardColumnSummary {
    const limit = this.deps.project(projectId)?.columnLimits[status] ?? null;
    const row = this.sql.prepare('SELECT COUNT(*) AS n FROM work_items WHERE project_id = ? AND status = ?').get(projectId, status) as { n: number };
    return summary(status, limit, row.n);
  }

  private labelsOf(ids: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const rows = this.sql
      .prepare('SELECT item_id, label FROM work_item_labels WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY item_id, position')
      .all(inList(ids)) as Array<{ item_id: string; label: string }>;
    for (const r of rows) out.set(r.item_id, [...(out.get(r.item_id) ?? []), r.label]);
    return out;
  }

  private linksOf(ids: readonly string[]): Map<string, WorkItemLink[]> {
    const out = new Map<string, WorkItemLink[]>();
    const rows = this.sql
      .prepare('SELECT * FROM work_item_links WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid')
      .all(inList(ids)) as unknown as LinkRow[];
    for (const r of rows) out.set(r.item_id, [...(out.get(r.item_id) ?? []), this.withState(linkOf(r))]);
    return out;
  }

  private withState(link: WorkItemLink): WorkItemLink {
    if (!this.deps.linkState) return link;
    const state = this.deps.linkState(link);
    return {
      ...link,
      name: state?.name ?? null,
      ...(link.kind === 'chat' ? { chatState: state?.chatState ?? null } : { taskStatus: state?.taskStatus ?? null }),
    };
  }

  /** Everything a card needs, read for many items at once so a board costs a handful of queries. */
  private hydrate(rows: readonly ItemRow[]): WorkItem[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const prefixes = new Map<string, string>();
    const prefix = (projectId: string): string => {
      let p = prefixes.get(projectId);
      if (p === undefined) {
        p = this.prefixOf(projectId);
        prefixes.set(projectId, p);
      }
      return p;
    };
    const labelMap = this.labelsOf(ids);
    const criteria = new Map<string, AcceptanceCriterion[]>();
    for (const c of this.sql
      .prepare('SELECT * FROM work_item_criteria WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY item_id, position')
      .all(inList(ids)) as unknown as CriterionRow[]) {
      criteria.set(c.item_id, [
        ...(criteria.get(c.item_id) ?? []),
        { id: c.id, text: c.text, checked: Boolean(c.checked), checkedBy: c.checked ? actorOf(c.checked_by_kind, c.checked_by_role) : null },
      ]);
    }
    const relations = new Map<string, WorkItemRelation[]>();
    const edges = this.sql
      .prepare(
        `SELECT r.blocker_id, r.blocked_id, r.created_at FROM work_item_relations r
         WHERE r.blocker_id IN (SELECT value FROM json_each(?)) OR r.blocked_id IN (SELECT value FROM json_each(?))
         ORDER BY r.created_at, r.rowid`,
      )
      .all(inList(ids), inList(ids)) as Array<{ blocker_id: string; blocked_id: string }>;
    const referenced = new Set<string>();
    for (const r of rows) if (r.epic_id) referenced.add(r.epic_id);
    for (const e of edges) {
      referenced.add(e.blocker_id);
      referenced.add(e.blocked_id);
    }
    const refs = new Map<string, WorkItemRef>();
    for (const r of this.sql.prepare('SELECT * FROM work_items WHERE id IN (SELECT value FROM json_each(?))').all(inList([...referenced])) as unknown as ItemRow[]) {
      refs.set(r.id, this.refOf(r, prefix(r.project_id)));
    }
    const wanted = new Set(ids);
    for (const e of edges) {
      const blocked = refs.get(e.blocked_id);
      const blocker = refs.get(e.blocker_id);
      if (wanted.has(e.blocker_id) && blocked) relations.set(e.blocker_id, [...(relations.get(e.blocker_id) ?? []), { type: 'blocks', item: blocked }]);
      if (wanted.has(e.blocked_id) && blocker) relations.set(e.blocked_id, [...(relations.get(e.blocked_id) ?? []), { type: 'blocked_by', item: blocker }]);
    }
    const links = this.deps.linkState ? this.linksOf(ids) : new Map<string, WorkItemLink[]>();

    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      number: row.number,
      key: workItemKey(prefix(row.project_id), row.number),
      type: row.type as WorkItemType,
      title: row.title,
      description: row.description,
      status: row.status as WorkItemStatus,
      priority: row.priority as WorkItemPriority,
      labels: labelMap.get(row.id) ?? [],
      assignee: assigneeOf(row),
      epicId: row.epic_id,
      epic: row.epic_id ? (refs.get(row.epic_id) ?? null) : null,
      milestoneId: row.milestone_id,
      acceptanceCriteria: criteria.get(row.id) ?? [],
      relations: relations.get(row.id) ?? [],
      rank: row.rank,
      worktree: row.worktree,
      branch: row.branch,
      activeLink: [...(links.get(row.id) ?? [])].reverse().find(isLive) ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
    }));
  }

  /** Epics are left out: they group work, they are not work. */
  private progress(milestoneIds: readonly string[]): Map<string, MilestoneProgress> {
    const out = new Map<string, MilestoneProgress>();
    if (!milestoneIds.length) return out;
    const rows = this.sql
      .prepare(
        `SELECT milestone_id, status, COUNT(*) AS n FROM work_items
         WHERE milestone_id IN (SELECT value FROM json_each(?)) AND type != 'epic'
         GROUP BY milestone_id, status`,
      )
      .all(inList(milestoneIds)) as Array<{ milestone_id: string; status: string; n: number }>;
    for (const r of rows) {
      const p = out.get(r.milestone_id) ?? emptyProgress();
      if (statusIndex(r.status) >= 0) {
        p.byStatus[r.status as WorkItemStatus] += r.n;
        p.total += r.n;
        if (r.status === 'done') p.done += r.n;
      }
      out.set(r.milestone_id, p);
    }
    return out;
  }
}

// ---------- helpers ----------

function summary(status: WorkItemStatus, limit: number | null, count: number): BoardColumnSummary {
  return { status, limit, count, overLimit: limit !== null && count > limit };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sourcePart(cause: WorkItemCause): WorkItemSource {
  return { kind: cause.kind, chatId: cause.chatId, orchestrationId: cause.orchestrationId, taskId: cause.taskId };
}

function eventRef(item: WorkItem): { projectId: string; itemId: string; key: string } {
  return { projectId: item.projectId, itemId: item.id, key: item.key };
}
