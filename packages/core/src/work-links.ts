import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  PERMISSION_MODES,
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
import { addWorktree, branchExists, git, headCommit, isGitRepo, isIgnored, lockWorktree, mainTopLevel, topLevel, worktrees } from './git.ts';
import { WorkItemError } from './work-item-validation.ts';
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
  /** The chat ended failed before its turn gave any result: the move its start made is undone */
  chatFailed: 'chat.failed-to-start',
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
  // Read as unknown: a body is whatever was sent, and a number where a string goes used to reach the
  // CLI's argument list and come back as a 500
  const r: Record<string, unknown> = request && typeof request === 'object' && !Array.isArray(request) ? { ...request } : {};
  const options: ChatStartOptions = {};
  for (const key of ['model', 'effort', 'appendSystemPrompt', 'account'] as const) {
    const value = r[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new WorkItemError(`${key} must be a string`, 400);
    options[key] = value;
  }
  for (const key of ['allowedTools', 'disallowedTools'] as const) {
    const value = r[key];
    if (value === undefined) continue;
    if (!isStrings(value)) throw new WorkItemError(`${key} must be a list of tool names`, 400);
    options[key] = value;
  }
  const { permissionMode, toolPreset, mcp, maxBudgetUsd, permissionPrompts } = r;
  if (permissionMode !== undefined) {
    const mode = PERMISSION_MODES.find((m) => m === permissionMode);
    if (!mode) throw new WorkItemError(`permissionMode must be one of ${PERMISSION_MODES.join(', ')}`, 400);
    options.permissionMode = mode;
  }
  if (toolPreset !== undefined) {
    if (toolPreset !== null && typeof toolPreset !== 'string') throw new WorkItemError('toolPreset must be the id of a tool preset, or null', 400);
    options.toolPreset = toolPreset;
  }
  if (mcp !== undefined) {
    const servers: unknown = mcp && typeof mcp === 'object' ? (mcp as { servers?: unknown }).servers : undefined;
    if (mcp !== null && !isStrings(servers)) throw new WorkItemError('mcp must name its servers in a list, or be null', 400);
    // Only the names: the config file is the one Agentry writes for them
    options.mcp = mcp === null ? null : { servers: servers as string[] };
  }
  if (maxBudgetUsd !== undefined) {
    if (typeof maxBudgetUsd !== 'number' || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) throw new WorkItemError('maxBudgetUsd must be a positive number', 400);
    options.maxBudgetUsd = maxBudgetUsd;
  }
  if (permissionPrompts !== undefined) {
    if (permissionPrompts !== 'host' && permissionPrompts !== 'none') throw new WorkItemError("permissionPrompts must be 'host' or 'none'", 400);
    options.permissionPrompts = permissionPrompts;
  }
  return options;
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

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

/** Whether a recorded place is the item's own, rather than the worktree of a node that worked on it. */
export function ownsPlace(item: Pick<WorkItem, 'branch'>): boolean {
  return !!item.branch?.startsWith('task/');
}

const LOCK_REASON = 'agentry work item ';

/**
 * The item's own worktree, on `task/<key>`, made the first time and found again after. It sits where
 * the CLI keeps the worktrees it makes, under the main checkout, so the chat that runs there is
 * attached to the project. Null when the project is not a git repository, or has no commit yet to
 * branch from: the work then happens in the project's directory.
 *
 * It is never a node's worktree, even when a node worked on the item last: retrying that node
 * clean removes its worktree and branch, and whatever a person did there would go with them. The
 * item's own branch starts from the node's instead, so the node's work carries over, or else from
 * the project's HEAD, which in a linked worktree is not the main checkout's.
 */
export function itemWorktree(projectPath: string, item: Pick<WorkItem, 'key' | 'worktree' | 'branch'> & { projectId?: string }): ItemPlace | null {
  if (!canBranch(projectPath)) return null;
  const root = topLevel(projectPath);
  const home = mainTopLevel(projectPath);
  const sub = relative(root, realpathSync(projectPath));
  // An ignored directory is missing from a fresh worktree: work at its top instead, as a node does
  const subdir = sub && !isIgnored(root, sub) ? sub : '';
  const own = ownsPlace(item);
  // A recorded place keeps the key it was made with, so a new prefix does not strand earlier work
  const worktree = (own && item.worktree) || join(home, '.claude', 'worktrees', `task-${item.key.toLowerCase()}`);
  const branch = own && item.branch ? item.branch : workItemBranch(item.key);
  const known = worktrees(home);
  const wanted = new Set([worktree, existsSync(worktree) ? realpathSync(worktree) : worktree]);
  const entry = known.find((w) => wanted.has(w.path));
  const reason = `${LOCK_REASON}${item.key}${item.projectId ? ` of project ${item.projectId}` : ''}`;
  if (existsSync(worktree)) {
    // Git commands in a plain directory under the checkout reach the checkout itself: the chat
    // would work on the project's own branch, not the item's
    if (!entry) throw new WorkItemError(`${worktree} is there but is not a worktree of this project: move it away and try again`, 409);
    // Two projects in one repository (its main checkout and a linked worktree) can share a key
    const holder = entry.locked?.startsWith(LOCK_REASON) ? / of project (\S+)$/.exec(entry.locked)?.[1] : undefined;
    if (holder && item.projectId && holder !== item.projectId) {
      throw new WorkItemError(`${worktree} is the worktree of ${item.key} in another project of this repository: give this project another key prefix`, 409);
    }
  } else {
    // Deleted by hand: git still holds it, locked, and refuses to check its branch out anywhere else
    if (entry) forgetWorktree(home, worktree);
    const elsewhere = known.find((w) => w.branch === branch && !wanted.has(w.path));
    if (elsewhere) throw new WorkItemError(`${branch} is checked out at ${elsewhere.path}: switch that checkout to another branch, or remove it, and try again`, 409);
    const node = !own && item.branch && branchExists(home, item.branch) ? item.branch : null;
    addWorktree(home, worktree, branch, node ?? headCommit(projectPath));
  }
  // As the CLI does with the worktrees it runs in, so `git worktree prune` leaves it be
  lockWorktree(home, worktree, reason);
  const cwd = subdir ? join(worktree, subdir) : worktree;
  mkdirSync(cwd, { recursive: true });
  return { cwd, worktree, branch };
}

/**
 * Drops git's record of a worktree whose directory is gone, so its path and branch are free again.
 * Only this one: `git worktree prune` would also forget every other worktree whose directory is
 * missing, which is not ours to decide. Called only when the directory does not exist, so there is
 * no work in it to lose; the double force is what git asks for a locked worktree.
 */
function forgetWorktree(repo: string, path: string): void {
  git(repo, ['worktree', 'remove', '--force', '--force', path], 30_000);
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
  /**
   * A chat a run of the flow by column is running: the flow reads its result and makes the move it
   * earned, so this automation does not move the item on that chat's turn as well
   */
  flowOwns?: (chatId: string) => boolean;
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
  /**
   * The moves a chat's start made that no result has answered yet, with where each item was: a chat
   * whose process fails before its turn gives a result (the CLI missing, a flag it refuses) never
   * worked on the item, and leaving it in `in_progress` would say someone is on it
   */
  private readonly unanswered = new Map<string, Array<{ itemId: string; from: WorkItemStatus; at: string }>>();

  constructor(private readonly deps: WorkItemAutomationDeps) {}

  /** Everything on the feed goes through here; what is not about a chat or a node is ignored. */
  observe(event: AgentryEvent): void {
    try {
      switch (event.type) {
        case 'run.updated':
          // Only a real transition starts a turn: the coalesced update a busy run keeps sending carries
          // no previous status, and taking it for a new turn would undo a person's move every 250 ms
          if (event.status === 'busy' && event.previousStatus !== null && event.previousStatus !== 'busy') {
            this.turns.set(event.runId, event.at);
            this.chatStarted(event.runId);
          }
          break;
        case 'run.created':
          // A chat spawned or adopted already busy is announced once, with no transition after it
          if (event.status === 'busy') {
            this.turns.set(event.runId, event.at);
            this.chatStarted(event.runId);
          }
          break;
        case 'run.ended':
          this.turns.delete(event.runId);
          if (event.status === 'failed') this.chatFailed(event.runId);
          this.unanswered.delete(event.runId);
          break;
        case 'run.removed':
          this.turns.delete(event.runId);
          this.unanswered.delete(event.runId);
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
    try {
      for (const link of this.chatLinks(chatId)) {
        const from = this.advance(link, 'in_progress', chatCause(chatId, WORK_CAUSE.chatStarted), this.turns.get(chatId) ?? link.createdAt);
        if (from) this.unanswered.set(chatId, [...(this.unanswered.get(chatId) ?? []), { itemId: link.itemId, from, at: new Date().toISOString() }]);
      }
    } catch {
      // see the class comment: the chat is linked and running, and the next turn moves the item
    }
  }

  /**
   * A chat ended failed with no result for the turn that moved its items: each goes back where it
   * was, unless a person moved it since or something else took it further. A turn that gave a
   * result, even an error, did run, and leaves the item in progress as decision 21 says.
   */
  private chatFailed(chatId: string): void {
    for (const { itemId, from, at } of this.unanswered.get(chatId) ?? []) {
      try {
        const item = this.deps.items.find(itemId);
        if (!item || !this.deps.writable(item.projectId) || item.status !== 'in_progress') continue;
        if (this.personMovedSince(item.id, at)) continue;
        this.deps.items.move(item.id, { status: from }, { actor: SYSTEM, cause: chatCause(chatId, WORK_CAUSE.chatFailed) });
      } catch {
        // see the class comment
      }
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
      this.unanswered.delete(chatId);
      if (result.isError || this.deps.flowOwns?.(chatId)) return;
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
    const node = this.deps.orchestration(orchestrationId)?.tasks.find((t) => t.id === taskId);
    for (const link of links) {
      if (runId && link.chatId !== runId) this.deps.items.setLinkChat(link.id, runId);
      if (node?.worktree && node.branch) this.recordPlace(link.itemId, node.worktree, node.branch);
      const cause = (event: string): WorkItemCause => ({ kind: 'orchestration', chatId: runId ?? link.chatId, orchestrationId, taskId, event });
      const since = this.attempts.get(attempt) ?? link.createdAt;
      if (status === 'running') this.advance(link, 'in_progress', cause(WORK_CAUSE.taskStarted), since);
      else if (status === 'completed') this.advance(link, 'in_review', cause(WORK_CAUSE.taskCompleted), since);
    }
    if (status !== 'running' && status !== 'pending') this.attempts.delete(attempt);
  }

  /**
   * Where a node works is where the item's changes are, until the item has a worktree of its own:
   * then that one is where its changes are, and it is not traded for a node's. "Work on it" never
   * works in the node's worktree; it branches from the node's branch into its own.
   */
  private recordPlace(itemId: string, worktree: string, branch: string): void {
    const item = this.deps.items.find(itemId);
    if (!item || !this.deps.writable(item.projectId) || ownsPlace(item)) return;
    if (item.worktree !== worktree || item.branch !== branch) this.deps.items.setWorktree(item.id, { worktree, branch });
  }

  /**
   * The one place an automatic move forward is made, and where its three rules are kept: forward
   * only, never out of `done`, and never over a person who moved the item after the work that causes
   * it began. Returns where the item was when it moved it.
   */
  private advance(link: WorkItemLink, target: WorkItemStatus, cause: WorkItemCause, since: string): WorkItemStatus | null {
    const item = this.deps.items.find(link.itemId);
    if (!item || !this.deps.writable(item.projectId)) return null;
    if (item.status === 'done' || column(item.status) >= column(target)) return null;
    if (this.personMovedSince(item.id, since)) return null;
    this.deps.items.move(item.id, { status: target }, { actor: SYSTEM, cause });
    return item.status;
  }

  private personMovedSince(itemId: string, since: string): boolean {
    return this.deps.items.history(itemId).some((e) => e.change === 'status' && e.actor.kind === 'person' && e.createdAt >= since);
  }
}

function chatCause(chatId: string, event: string): WorkItemCause {
  return { kind: 'chat', chatId, orchestrationId: null, taskId: null, event };
}
