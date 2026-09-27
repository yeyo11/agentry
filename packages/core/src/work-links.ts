import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  WORK_ITEM_STATUSES,
  workItemBranch,
  type AgentryEvent,
  type ChatStartOptions,
  type Orchestration,
  type OrchestrationTaskSpec,
  type OrchestrationTaskState,
  type WorkItem,
  type WorkItemActor,
  type WorkItemCause,
  type WorkItemLink,
  type WorkItemOrchestrationDraft,
  type WorkItemRef,
  type WorkItemStatus,
} from '@agentry/shared';
import { addWorktree, headCommit, isGitRepo, isIgnored, lockWorktree, mainTopLevel, topLevel } from './git.ts';
import type { WorkItemService } from './work-items.ts';

/**
 * What ties a work item to the chats and orchestrations that work on it: the prompt they are given,
 * the worktree they work in, the draft a selection becomes, and the automation that moves the item
 * as they go.
 *
 * The automation listens to events that already exist (a run's status, a result, a node's status);
 * nothing here polls. Its moves are held to three rules, so a board never fights the person using
 * it: an item only goes forward, it never leaves `done`, and it stays where a person put it once the
 * work that would move it has begun.
 */

/** The stable codes a history entry's cause carries; a client translates them. */
export const WORK_CAUSE = {
  chatStarted: 'chat.started',
  turnCompleted: 'chat.turn-completed',
  message: 'chat.message',
  taskStarted: 'orchestration.task.started',
  taskCompleted: 'orchestration.task.completed',
} as const;

const SYSTEM: WorkItemActor = { kind: 'system', role: null };

const TITLE_MAX = 120;

// ---------- what an agent is told ----------

/**
 * The prompt a chat or a node starts from. It opens with the key and the title, since a chat's title
 * is its first prompt and the list should name the item.
 */
export function workItemPrompt(item: WorkItem): string {
  const lines = [`${item.key}: ${item.title}`, ''];
  lines.push(`You are working on the ${item.type} ${item.key} of this project${item.epic ? `, part of the epic ${item.epic.key} "${item.epic.title}"` : ''}.`);
  if (item.description.trim()) lines.push('', item.description.trim());
  if (item.acceptanceCriteria.length) {
    lines.push('', 'Acceptance criteria:');
    for (const c of item.acceptanceCriteria) lines.push(`- [${c.checked ? 'x' : ' '}] ${c.text}`);
  }
  lines.push('', 'When you are done, say what you changed and how each acceptance criterion is met.');
  return lines.join('\n');
}

/** A message's first line, without Markdown's heading and list marks, as the title of the item made from it. */
export function titleFromMessage(text: string): string {
  const first = text
    .split('\n')
    .map((l) => l.replace(/^\s*(#{1,6}\s+|[-*>]\s+|\d+[.)]\s+)/, '').trim())
    .find(Boolean);
  if (!first) return 'Untitled task';
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1).trimEnd()}…` : first;
}

/**
 * The options a new chat takes, and nothing else: the prompt and the directory come from the item,
 * so a body that also names them does not get to send the chat somewhere else.
 */
export function startOptions(request: ChatStartOptions | undefined): ChatStartOptions {
  const r: ChatStartOptions = request && typeof request === 'object' ? request : {};
  return {
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.effort !== undefined ? { effort: r.effort } : {}),
    ...(r.permissionMode !== undefined ? { permissionMode: r.permissionMode } : {}),
    ...(r.appendSystemPrompt !== undefined ? { appendSystemPrompt: r.appendSystemPrompt } : {}),
    ...(r.allowedTools !== undefined ? { allowedTools: r.allowedTools } : {}),
    ...(r.disallowedTools !== undefined ? { disallowedTools: r.disallowedTools } : {}),
    ...(r.toolPreset !== undefined ? { toolPreset: r.toolPreset } : {}),
    ...(r.mcp !== undefined ? { mcp: r.mcp } : {}),
    ...(r.maxBudgetUsd !== undefined ? { maxBudgetUsd: r.maxBudgetUsd } : {}),
    ...(r.permissionPrompts !== undefined ? { permissionPrompts: r.permissionPrompts } : {}),
    ...(r.account !== undefined ? { account: r.account } : {}),
  };
}

// ---------- where it works ----------

/** A repository with a commit to branch from: what a worktree of its own needs. */
export function canBranch(path: string): boolean {
  if (!existsSync(path) || !isGitRepo(path)) return false;
  try {
    headCommit(path);
    return true;
  } catch {
    return false;
  }
}

export interface ItemPlace {
  /** Where the chat starts: the worktree, or its copy of the project's subdirectory */
  cwd: string;
  worktree: string;
  branch: string;
}

/**
 * The item's own worktree, on `task/<key>`, made the first time and found again after. It sits where
 * the CLI keeps the worktrees it makes, under the main checkout, so the chat that runs there is
 * attached to the project. Null when the project is not a git repository, or has no commit yet to
 * branch from: the work then happens in the project's directory.
 */
export function itemWorktree(projectPath: string, item: Pick<WorkItem, 'key' | 'worktree' | 'branch'>): ItemPlace | null {
  if (!canBranch(projectPath)) return null;
  const root = topLevel(projectPath);
  const home = mainTopLevel(projectPath);
  const sub = relative(root, realpathSync(projectPath));
  // An ignored directory is missing from a fresh worktree: work at its top instead, as a node does
  const subdir = sub && !isIgnored(root, sub) ? sub : '';
  const worktree = item.worktree ?? join(home, '.claude', 'worktrees', `task-${item.key.toLowerCase()}`);
  const branch = item.branch ?? workItemBranch(item.key);
  if (!existsSync(worktree)) addWorktree(home, worktree, branch, 'HEAD');
  // As the CLI does with the worktrees it runs in, so `git worktree prune` leaves it be
  lockWorktree(home, worktree, `agentry work item ${item.key}`);
  const cwd = subdir ? join(worktree, subdir) : worktree;
  mkdirSync(cwd, { recursive: true });
  return { cwd, worktree, branch };
}

// ---------- orchestrating a selection ----------

/** A node's id from the item's key: readable on the graph, and unique inside a project. */
export function nodeId(item: Pick<WorkItem, 'key'>): string {
  return item.key.toLowerCase().replace(/[^\w-]/g, '-').slice(0, 40);
}

/**
 * The graph a selection becomes, for the person to review before launching it: one node per item,
 * in the order they were picked, and an edge wherever one item of the selection blocks another. A
 * blocker left out of the selection cannot be waited for, so it is named rather than dropped quietly.
 */
export function orchestrationDraft(project: { name: string; path: string }, selected: readonly WorkItem[], git: boolean): WorkItemOrchestrationDraft {
  const inSelection = new Set(selected.map((i) => i.id));
  const nodeOf = new Map(selected.map((i) => [i.id, nodeId(i)]));
  const external = new Map<string, WorkItemRef>();
  const tasks: OrchestrationTaskSpec[] = selected.map((item) => {
    const dependsOn: string[] = [];
    for (const r of item.relations) {
      if (r.type !== 'blocked_by') continue;
      const dep = nodeOf.get(r.item.id);
      if (dep) dependsOn.push(dep);
      else if (!inSelection.has(r.item.id) && r.item.status !== 'done') external.set(r.item.id, r.item);
    }
    return {
      id: nodeOf.get(item.id) ?? nodeId(item),
      name: clip(`${item.key} ${item.title}`, 80),
      prompt: workItemPrompt(item),
      ...(dependsOn.length ? { dependsOn } : {}),
      workItemId: item.id,
    };
  });
  const keys = selected.map((i) => i.key);
  const only = selected.length === 1 ? selected[0] : undefined;
  return {
    spec: {
      name: clip(only ? `${only.key} ${only.title}` : `${project.name}: ${keys.join(', ')}`, 80),
      objective: [`Work on these tasks of ${project.name}:`, ...selected.map((i) => `- ${i.key} ${i.title}`)].join('\n'),
      engine: 'graph',
      cwd: project.path,
      // Each node in its own worktree, as "Work on it" does, whenever there is a repository for it
      worktree: git,
      tasks,
    },
    externalBlockers: [...external.values()],
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// ---------- the automation ----------

export interface WorkItemAutomationDeps {
  items: WorkItemService;
  /** Whether items of the project may be changed: imported, with its Board module on */
  writable: (projectId: string) => boolean;
  orchestration: (id: string) => Orchestration | null;
}

const column = (status: WorkItemStatus): number => WORK_ITEM_STATUSES.indexOf(status);

/**
 * Moves items as the chats and nodes linked to them work. Fed from the event bus and from the
 * runtime's results; every handler swallows its own failures, since it runs inside someone else's
 * event and a board that cannot be updated must not break a chat.
 */
export class WorkItemAutomation {
  /** When each chat's current turn began: what "a person moved it since" is measured from */
  private readonly turns = new Map<string, string>();
  /** When each node's current attempt began, by `<orchestration>/<task>` */
  private readonly attempts = new Map<string, string>();

  constructor(private readonly deps: WorkItemAutomationDeps) {}

  /** Everything on the feed goes through here; what is not about a chat or a node is ignored. */
  observe(event: AgentryEvent): void {
    try {
      switch (event.type) {
        case 'run.updated':
          if (event.status === 'busy' && event.previousStatus !== 'busy') {
            this.turns.set(event.runId, event.at);
            this.chatStarted(event.runId);
          }
          break;
        case 'run.ended':
        case 'run.removed':
          this.turns.delete(event.runId);
          break;
        case 'orchestration.updated':
          if (event.previousStatus === null) this.linkNodes(event.orchestrationId);
          break;
        case 'orchestration.task':
          this.taskChanged(event.orchestrationId, event.taskId, event.status, event.runId, event.at);
          break;
        default:
          break;
      }
    } catch {
      // see the class comment
    }
  }

  /**
   * A chat's turn started: its items enter `in_progress`. Also called by "Work on it" right after it
   * links the chat, since the chat's first status can reach the feed before the link exists.
   */
  chatStarted(chatId: string): void {
    for (const link of this.chatLinks(chatId)) {
      this.advance(link, 'in_progress', chatCause(chatId, WORK_CAUSE.chatStarted), this.turns.get(chatId) ?? link.createdAt);
    }
  }

  /**
   * A chat's turn ended. Only a turn that ended well moves its items, to `in_review`; a failed or
   * stopped one leaves them where they are.
   */
  chatResult(chatId: string, result: { isError: boolean }): void {
    try {
      const since = this.turns.get(chatId);
      this.turns.delete(chatId);
      if (result.isError) return;
      for (const link of this.chatLinks(chatId)) {
        this.advance(link, 'in_review', chatCause(chatId, WORK_CAUSE.turnCompleted), since ?? link.createdAt);
      }
    } catch {
      // see the class comment
    }
  }

  /** "Work on it" links: an orchestration's nodes follow their own events, not their worker chat's. */
  private chatLinks(chatId: string): WorkItemLink[] {
    return this.deps.items.linksOfChat(chatId).filter((l) => l.kind === 'chat' && l.role === 'work');
  }

  /**
   * Links the nodes of a new orchestration to the items they name. A graph launched from a saved
   * template is left alone: whatever it was saved from, it is new work, not the items' own.
   */
  private linkNodes(orchestrationId: string): void {
    const orch = this.deps.orchestration(orchestrationId);
    if (!orch || orch.templateId) return;
    for (const task of orch.tasks) {
      if (!task.workItemId) continue;
      const item = this.deps.items.find(task.workItemId);
      if (!item || !this.deps.writable(item.projectId)) continue;
      this.deps.items.link(item.id, { kind: 'orchestration', role: 'work', orchestrationId: orch.id, taskId: task.id });
    }
  }

  private taskChanged(orchestrationId: string, taskId: string, status: OrchestrationTaskState['status'], runId: string | null, at: string): void {
    const links = this.deps.items.linksOfTask(orchestrationId, taskId).filter((l) => l.role === 'work');
    if (!links.length) return;
    const attempt = `${orchestrationId}/${taskId}`;
    if (status === 'running') this.attempts.set(attempt, at);
    for (const link of links) {
      if (runId && link.chatId !== runId) this.deps.items.setLinkChat(link.id, runId);
      const cause = (event: string): WorkItemCause => ({ kind: 'orchestration', chatId: runId ?? link.chatId, orchestrationId, taskId, event });
      const since = this.attempts.get(attempt) ?? link.createdAt;
      if (status === 'running') this.advance(link, 'in_progress', cause(WORK_CAUSE.taskStarted), since);
      else if (status === 'completed') this.advance(link, 'in_review', cause(WORK_CAUSE.taskCompleted), since);
    }
    if (status !== 'running' && status !== 'pending') this.attempts.delete(attempt);
  }

  /**
   * The one place an automatic move is made, and where its three rules are kept: forward only, never
   * out of `done`, and never over a person who moved the item after the work that causes it began.
   */
  private advance(link: WorkItemLink, target: WorkItemStatus, cause: WorkItemCause, since: string): void {
    const item = this.deps.items.find(link.itemId);
    if (!item || !this.deps.writable(item.projectId)) return;
    if (item.status === 'done' || column(item.status) >= column(target)) return;
    if (this.personMovedSince(item.id, since)) return;
    this.deps.items.move(item.id, { status: target }, { actor: SYSTEM, cause });
  }

  private personMovedSince(itemId: string, since: string): boolean {
    return this.deps.items.history(itemId).some((e) => e.change === 'status' && e.actor.kind === 'person' && e.createdAt >= since);
  }
}

function chatCause(chatId: string, event: string): WorkItemCause {
  return { kind: 'chat', chatId, orchestrationId: null, taskId: null, event };
}
