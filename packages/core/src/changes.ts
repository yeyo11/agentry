import { existsSync } from 'node:fs';
import type { ChangeSummary, ChatChanges, Checklist, FileDiff, Orchestration, OrchestrationTaskState, TranscriptEntry } from '@agentry/shared';
import type { ChatService } from './chat-service.ts';
import type { ChatManager } from './chats.ts';
import {
  aheadCount,
  branchExists,
  commitsBetween,
  currentBranch,
  diffFiles,
  fileDiff,
  headCommit,
  isGitRepo,
  isUntracked,
  mainTopLevel,
  mergeBase,
  pathInside,
  uncommittedFiles,
  untrackedDiff,
} from './git.ts';
import type { Orchestrator } from './orchestrator.ts';
import type { SessionStore } from './sessions.ts';
import { checklistOf, CHECKLIST_TOOLS, toolCallsOf, touchedFilesOf, WRITING_TOOLS, type ToolCall } from './tool-calls.ts';

/** Where the work of one branch lives and what it is measured against. */
interface Site {
  /** The main checkout: where the branch can still be read once its worktree is gone */
  repo: string;
  worktree: string | null;
  branch: string | null;
  base: string | null;
}

const emptySummary = (site: Site): ChangeSummary => ({ branch: site.branch, base: site.base, ahead: 0, commits: [], files: [], uncommitted: [] });

/** The worktree when it is still on disk: the CLI removes one that changed nothing. */
const liveWorktree = (site: Site): string | null => (site.worktree && existsSync(site.worktree) ? site.worktree : null);

/** What to read the branch through: its worktree's HEAD, or the branch by name once the worktree is gone. */
function reader(site: Site): { dir: string; ref: string } | null {
  const live = liveWorktree(site);
  if (live) return { dir: live, ref: 'HEAD' };
  if (site.branch && branchExists(site.repo, site.branch)) return { dir: site.repo, ref: site.branch };
  return null;
}

function summarize(site: Site): ChangeSummary {
  const at = reader(site);
  if (!at || !site.base) return emptySummary(site);
  const live = liveWorktree(site);
  return {
    branch: (live ? currentBranch(live) : null) ?? site.branch,
    base: site.base,
    ahead: aheadCount(at.dir, site.base, at.ref),
    commits: commitsBetween(at.dir, site.base, at.ref),
    files: diffFiles(at.dir, site.base, at.ref),
    uncommitted: live ? uncommittedFiles(live) : [],
  };
}

/**
 * One file against the base, as the panel opens it: everything the branch did to it, committed or
 * not, since a worker's last edit is usually the interesting part and it is not committed yet.
 */
function diffOf(site: Site, path: string): FileDiff {
  const at = reader(site);
  if (!at || !site.base) throw new Error(`nothing to compare ${path} against: the branch has no worktree or base`);
  const live = liveWorktree(site);
  const rel = pathInside(at.dir, path);
  // A file that was created and never added is invisible to `git diff`
  if (live && isUntracked(live, rel)) return { path: rel, diff: untrackedDiff(live, rel) };
  const known = diffFiles(at.dir, site.base, live ? undefined : at.ref).find((f) => f.path === rel);
  const paths = known?.previousPath ? [known.previousPath, rel] : [rel];
  const diff = fileDiff(at.dir, site.base, live ? undefined : at.ref, paths);
  if (!diff) throw new Error(`${rel} not found among the changes against ${site.base.slice(0, 8)}`);
  return { path: rel, diff };
}

const EMPTY_CHECKLIST: Checklist = { items: [], updatedAt: null };

export interface ChangesDeps {
  orchestrator: Orchestrator;
  chats: ChatService;
  sessions: SessionStore;
  runtime: ChatManager;
}

/**
 * What a branch or a chat has actually done on disk, read from git and from the transcript rather
 * than from what the agent says it did.
 */
export class Changes {
  constructor(private readonly deps: ChangesDeps) {}

  private orchestration(id: string): Orchestration {
    const orch = this.deps.orchestrator.get(id);
    if (!orch) throw new Error('orchestration not found');
    return orch;
  }

  private task(id: string, taskId: string): { orch: Orchestration; task: OrchestrationTaskState } {
    const orch = this.orchestration(id);
    const task = orch.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('task not found');
    return { orch, task };
  }

  /** The repository a graph's worktrees hang off; refused plainly when the graph never had one. */
  private repoOf(orch: Orchestration): string {
    if (!orch.worktree) throw new Error(`orchestration ${orch.name} has no worktrees: its tasks share one checkout, so there is no branch to compare`);
    if (!existsSync(orch.cwd) || !isGitRepo(orch.cwd)) throw new Error(`${orch.cwd} is no longer a git repository`);
    return mainTopLevel(orch.cwd);
  }

  private taskSite(orch: Orchestration, task: OrchestrationTaskState): Site {
    return { repo: this.repoOf(orch), worktree: task.worktree ?? null, branch: task.branch ?? null, base: task.baseCommit ?? orch.baseCommit ?? null };
  }

  private integrationSite(orch: Orchestration): Site {
    const repo = this.repoOf(orch);
    const { integration } = orch;
    return { repo, worktree: integration?.worktree ?? null, branch: integration?.branch ?? null, base: orch.baseCommit ?? null };
  }

  taskChanges(id: string, taskId: string): ChangeSummary {
    const { orch, task } = this.task(id, taskId);
    return summarize(this.taskSite(orch, task));
  }

  taskDiff(id: string, taskId: string, path: string): FileDiff {
    const { orch, task } = this.task(id, taskId);
    return diffOf(this.taskSite(orch, task), path);
  }

  integrationChanges(id: string): ChangeSummary {
    return summarize(this.integrationSite(this.orchestration(id)));
  }

  integrationDiff(id: string, path: string): FileDiff {
    return diffOf(this.integrationSite(this.orchestration(id)), path);
  }

  /**
   * The site of a chat that works in a worktree of its own. A worker of an orchestration is
   * measured from where its own branch was cut, which is not where the main checkout is now.
   */
  private async chatSite(id: string): Promise<Site | null> {
    const chat = await this.deps.chats.summaryOf(id);
    if (!chat) throw new Error('chat not found');
    if (chat.orchestration?.taskId) {
      const { orch, task } = this.task(chat.orchestration.id, chat.orchestration.taskId);
      if (orch.worktree && task.branch) return this.taskSite(orch, task);
    }
    const tree = chat.worktree;
    if (!tree || !existsSync(tree.path) || !isGitRepo(tree.path)) return null;
    const repo = mainTopLevel(tree.path);
    // Where the worktree left the main checkout, whatever has landed there since
    const base = mergeBase(tree.path, 'HEAD', headCommit(repo));
    return { repo, worktree: tree.path, branch: tree.branch, base };
  }

  /** A worktree gives a summary; a chat anywhere else has only what its own calls wrote. */
  async chatChanges(id: string): Promise<ChatChanges> {
    const site = await this.chatSite(id);
    return {
      summary: site ? summarize(site) : null,
      touched: touchedFilesOf(await this.calls(id, WRITING_TOOLS)),
    };
  }

  async chatDiff(id: string, path: string): Promise<FileDiff> {
    const site = await this.chatSite(id);
    if (!site) throw new Error('this chat has no worktree of its own, so there is no diff to show: see the files it touched');
    return diffOf(site, path);
  }

  private async calls(chatId: string, names: ReadonlySet<string>): Promise<ToolCall[]> {
    const fromDisk = await this.deps.sessions.toolCalls(chatId, names);
    if (fromDisk) return fromDisk;
    // A chat that has not written its transcript yet, or never will (housekeeping): what it streamed
    const streamed: TranscriptEntry[] | null = this.deps.runtime.messages(chatId);
    if (!streamed) throw new Error('chat not found');
    return toolCallsOf(streamed, names);
  }

  async chatChecklist(id: string): Promise<Checklist> {
    return checklistOf(await this.calls(id, CHECKLIST_TOOLS));
  }

  /** A task's own plan is the one its chat kept; a task that has not started has none. */
  async taskChecklist(id: string, taskId: string): Promise<Checklist> {
    const { task } = this.task(id, taskId);
    const chat = task.sessionId ?? task.runId;
    return chat ? this.chatChecklist(chat) : EMPTY_CHECKLIST;
  }
}
