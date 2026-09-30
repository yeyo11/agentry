import { existsSync } from 'node:fs';
import type {
  ChangeSummary,
  ChatChanges,
  ChatSummary,
  Checklist,
  DiffContext,
  EditStep,
  FileDiff,
  Orchestration,
  OrchestrationTaskState,
  TranscriptEntry,
} from '@agentry/shared';
import type { ChatService } from './chat-service.ts';
import type { DecisionEngine } from './decisions/engine.ts';
import type { ChatManager } from './chats.ts';
import { editStepsFromEntries, editStepsOf } from './edit-steps.ts';
import {
  aheadCount,
  branchExists,
  commitsBetween,
  currentBranch,
  diffFiles,
  fileDiff,
  headCommit,
  isAncestor,
  isGitRepo,
  isUntracked,
  lineCount,
  mainCheckout,
  mainTopLevel,
  mergeBase,
  parentOf,
  pathInside,
  resolveCommit,
  topLevel,
  uncommittedFiles,
  untrackedDiff,
  workingFiles,
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

/** Which part of a branch's work to show: all of it, one of its commits, or what is not committed. */
export interface ChangeScope {
  commit?: string;
  uncommitted?: boolean;
}

export interface DiffOptions extends ChangeScope {
  context?: DiffContext;
}

const DEFAULT_CONTEXT = 3;
const MAX_CONTEXT = 500;
/** Past this a whole file is more than anyone reads in a diff, and more than a page should draw */
const FULL_LIMIT = 20_000;

/** `?context=` as a request sends it: a count of lines or `full`; anything else is the default. */
export function parseDiffContext(raw: unknown): DiffContext {
  if (raw === 'full') return 'full';
  // A repeated parameter arrives as a list: not a count either
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return DEFAULT_CONTEXT;
  return Math.min(MAX_CONTEXT, Number(raw.trim()));
}

/** `?commit=` and `?uncommitted=` as a request sends them; asking for both at once is refused. */
export function parseChangeScope(query: { commit?: unknown; uncommitted?: unknown }): ChangeScope {
  if (Array.isArray(query.commit) || Array.isArray(query.uncommitted)) throw new Error('commit and uncommitted are given once each');
  const uncommitted = query.uncommitted === '1' || query.uncommitted === 'true';
  const commit = (typeof query.commit === 'string' ? query.commit.trim() : '') || undefined;
  if (commit && uncommitted) throw new Error('commit and uncommitted cannot be asked for together');
  return { ...(commit ? { commit } : {}), ...(uncommitted ? { uncommitted } : {}) };
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

/**
 * The commit a request names, as a full hash, once it is known to be on the branch since its base.
 * Checked by ancestry both ways rather than against the commit list, which stops at 200.
 */
function commitOnBranch(dir: string, ref: string, base: string | null, sha: string): string {
  const commit = resolveCommit(dir, sha);
  const since = base ? resolveCommit(dir, base) : null;
  if (!commit || !since || commit === since || !isAncestor(dir, since, commit) || !isAncestor(dir, commit, ref)) {
    throw new Error(`commit ${sha} is not on this branch since its base`);
  }
  return commit;
}

function summarize(site: Site, scope: ChangeScope = {}): ChangeSummary {
  const at = reader(site);
  if (!at || !site.base) {
    if (scope.commit) throw new Error(`commit ${scope.commit} is not on this branch since its base`);
    return emptySummary(site);
  }
  const live = liveWorktree(site);
  const uncommitted = live ? uncommittedFiles(live) : [];
  const branch: Omit<ChangeSummary, 'files'> = {
    branch: (live ? currentBranch(live) : null) ?? site.branch,
    base: site.base,
    ahead: aheadCount(at.dir, site.base, at.ref),
    commits: commitsBetween(at.dir, site.base, at.ref),
    uncommitted,
  };
  // A scope narrows the files and nothing else: the rest describes the branch, which the scope menu lists
  if (scope.commit) {
    const commit = commitOnBranch(at.dir, at.ref, site.base, scope.commit);
    return { ...branch, files: diffFiles(at.dir, parentOf(at.dir, commit), commit) };
  }
  if (scope.uncommitted) return { ...branch, files: uncommitted };
  const files = diffFiles(at.dir, site.base, at.ref);
  return { ...branch, files, working: live ? workingFiles(live, site.base) : files };
}

/**
 * The `--unified` count for `context`, and whether it carries the whole file: `full` becomes a
 * count above the longest side's lines, unless the file is too long to be worth it.
 */
function unifiedFor(context: DiffContext, sides: () => number[]): { unified: number; full: boolean } {
  if (context !== 'full') return { unified: Number.isFinite(context) ? Math.min(MAX_CONTEXT, Math.max(0, Math.trunc(context))) : DEFAULT_CONTEXT, full: false };
  const longest = Math.max(0, ...sides());
  return longest > FULL_LIMIT ? { unified: DEFAULT_CONTEXT, full: false } : { unified: longest + 1, full: true };
}

/**
 * One file as the panel opens it. By default everything the branch did to it against the base,
 * committed or not, since a worker's last edit is usually the interesting part and it is not
 * committed yet; or what one commit did to it, or what is not committed yet.
 */
function diffOf(site: Site, path: string, opts: DiffOptions = {}): FileDiff {
  const at = reader(site);
  if (!at || !site.base) throw new Error(`nothing to compare ${path} against: the branch has no worktree or base`);
  const live = liveWorktree(site);
  const rel = pathInside(at.dir, path);
  const context = opts.context ?? DEFAULT_CONTEXT;

  let dir = at.dir;
  let from = site.base;
  let to: string | undefined = live ? undefined : at.ref;
  if (opts.commit) {
    to = commitOnBranch(at.dir, at.ref, site.base, opts.commit);
    from = parentOf(at.dir, to);
  } else if (opts.uncommitted) {
    if (!live) throw new Error(`${rel} not found among the uncommitted changes: the worktree is gone`);
    dir = live;
    from = 'HEAD';
  }

  // A file that was created and never added is invisible to `git diff`
  if (live && to === undefined && isUntracked(live, rel)) {
    const { full } = unifiedFor(context, () => [lineCount(live, undefined, rel)]);
    return { path: rel, diff: untrackedDiff(live, rel), full };
  }
  const known = diffFiles(dir, from, to).find((f) => f.path === rel);
  const paths = known?.previousPath ? [known.previousPath, rel] : [rel];
  const { unified, full } = unifiedFor(context, () => [lineCount(dir, from, paths[0] as string), lineCount(dir, to, rel)]);
  const diff = fileDiff(dir, from, to, paths, unified);
  if (!diff) throw new Error(`${rel} not found among the changes against ${from.slice(0, 8)}`);
  return { path: rel, diff, full };
}

/** The commit a checkout is on, or null when it is gone or not a repository any more. */
function tipOf(dir: string | null): string | null {
  if (!dir || !existsSync(dir) || !isGitRepo(dir)) return null;
  try {
    return headCommit(dir);
  } catch {
    return null;
  }
}

const EMPTY_CHECKLIST: Checklist = { items: [], updatedAt: null };

export interface ChangesDeps {
  orchestrator: Orchestrator;
  chats: ChatService;
  sessions: SessionStore;
  runtime: ChatManager;
  /**
   * The directory a chat's worktree left from, when that is not the main checkout: the project of
   * the work item the chat works on, which may itself be a linked worktree on another branch
   */
  forkedFrom?: (chatId: string) => string | null;
  /** The decision engine: both points here are suggestions, prepared in the background and never waited for */
  decisions?: Pick<DecisionEngine, 'ask' | 'effective'>;
}

/** What a question was already asked about, so a page that polls does not pay for the same answer twice */
const MAX_ASKED = 2000;
/** Steps asked about per read, and what is sent of one: a hunk must leave room for the sentence before it */
const HUNKS_PER_READ = 5;
const HUNK_CHARS = 3000;
const COMMITS_ASKED = 20;
const PATHS_PER_COMMIT = 40;

/**
 * What a branch or a chat has actually done on disk, read from git and from the transcript rather
 * than from what the agent says it did.
 */
export class Changes {
  private readonly asked = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: ChangesDeps) {}

  /** Resolves once every question asked in the background is over: what a test waits on instead of a clock */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** True the first time a key is seen */
  private firstTime(key: string): boolean {
    if (this.asked.has(key)) return false;
    this.asked.add(key);
    if (this.asked.size > MAX_ASKED) for (const old of [...this.asked].slice(0, MAX_ASKED / 2)) this.asked.delete(old);
    return true;
  }

  /**
   * `flow.scope-drift`: which commits of a work item's branch do more than the card asks. Nothing
   * compares a commit with its card today, so this only adds a flag: the answer is a row a person
   * reads (and rates), never a change to the branch. Returns the hashes it flagged, and nothing
   * unless the point acted.
   */
  async scopeDrift(
    projectPath: string,
    place: { worktree: string | null; branch: string | null },
    item: { id: string; projectId: string; title: string; criteria: readonly string[] },
  ): Promise<string[]> {
    const engine = this.deps.decisions;
    if (!engine || engine.effective('flow.scope-drift', item.projectId).mode === 'off') return [];
    let commits: Array<{ id: string; message: string; paths: string[] }>;
    try {
      const summary = this.itemChanges(projectPath, place);
      const tip = summary?.commits[0];
      if (!summary || !tip || !this.firstTime(`drift:${item.id}:${tip.hash}`)) return [];
      // Paths only, never the diff: what a commit touched says enough about what it set out to do
      commits = summary.commits.slice(0, COMMITS_ASKED).map((c) => ({
        id: c.hash,
        message: c.subject,
        paths: (this.itemChanges(projectPath, place, { commit: c.hash })?.files ?? []).slice(0, PATHS_PER_COMMIT).map((f) => f.path),
      }));
    } catch {
      return [];
    }
    const outcome = await engine.ask(
      'flow.scope-drift',
      { kind: 'work_item', id: item.id, data: { title: item.title, criteria: item.criteria, commits } },
      { projectId: item.projectId },
    );
    if (!outcome.act) return [];
    return commits.filter((c) => {
      const answer = outcome.answers?.[c.id];
      return answer?.kind === 'noul' && answer.value;
    }).map((c) => c.id);
  }

  /**
   * `changes.unexplained-hunk`: asks, in the background, whether the sentence a chat wrote before
   * an edit explains it. The answer is a row the review reads; nothing here waits for it.
   */
  private flagHunks(chat: ChatSummary, steps: readonly EditStep[]): void {
    const engine = this.deps.decisions;
    const projectId = chat.project?.id ?? null;
    if (!engine || engine.effective('changes.unexplained-hunk', projectId).mode === 'off') return;
    const fresh = steps.filter((s) => s.diff && !s.pending && this.firstTime(`hunk:${chat.id}:${s.id}`)).slice(0, HUNKS_PER_READ);
    for (const step of fresh) {
      const work = engine.ask(
        'changes.unexplained-hunk',
        { kind: 'chat', id: chat.id, data: { hunk: step.diff.slice(0, HUNK_CHARS), step: step.intent ?? '', title: chat.firstPrompt ?? chat.title } },
        { projectId },
      );
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    }
  }

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

  taskChanges(id: string, taskId: string, scope: ChangeScope = {}): ChangeSummary {
    const { orch, task } = this.task(id, taskId);
    return summarize(this.taskSite(orch, task), scope);
  }

  taskDiff(id: string, taskId: string, path: string, opts: DiffOptions = {}): FileDiff {
    const { orch, task } = this.task(id, taskId);
    return diffOf(this.taskSite(orch, task), path, opts);
  }

  integrationChanges(id: string, scope: ChangeScope = {}): ChangeSummary {
    return summarize(this.integrationSite(this.orchestration(id)), scope);
  }

  integrationDiff(id: string, path: string, opts: DiffOptions = {}): FileDiff {
    return diffOf(this.integrationSite(this.orchestration(id)), path, opts);
  }

  private async chatOf(id: string): Promise<ChatSummary> {
    const chat = await this.deps.chats.summaryOf(id);
    if (!chat) throw new Error('chat not found');
    return chat;
  }

  /**
   * The site of a chat that works in a worktree of its own. A worker of an orchestration is
   * measured from where its own branch was cut, which is not where the main checkout is now.
   */
  private siteOf(chat: ChatSummary): Site | null {
    if (chat.orchestration?.taskId) {
      const { orch, task } = this.task(chat.orchestration.id, chat.orchestration.taskId);
      if (orch.worktree && task.branch) return this.taskSite(orch, task);
    }
    const tree = chat.worktree;
    if (!tree || !existsSync(tree.path) || !isGitRepo(tree.path)) return null;
    const repo = mainTopLevel(tree.path);
    // Where the worktree left the checkout it was cut from, whatever has landed there since
    const from = this.deps.forkedFrom?.(chat.id);
    const base = mergeBase(tree.path, 'HEAD', tipOf(from ?? null) ?? headCommit(repo));
    return { repo, worktree: tree.path, branch: tree.branch, base };
  }

  /**
   * The site of a work item's own worktree and branch, measured from where it left the project's
   * checkout (a linked worktree's HEAD is not the main checkout's), as a chat's is. Once the worktree is gone the branch is still read by name, from the
   * project's repository; null when neither is left.
   */
  private itemSite(projectPath: string, place: { worktree: string | null; branch: string | null }): Site | null {
    const live = place.worktree && existsSync(place.worktree) && isGitRepo(place.worktree) ? place.worktree : null;
    const from = live ?? (existsSync(projectPath) && isGitRepo(projectPath) ? projectPath : null);
    if (!from) return null;
    const repo = mainCheckout(from);
    if (!live && !(place.branch && branchExists(repo, place.branch))) return null;
    const tip = tipOf(projectPath) ?? headCommit(repo);
    const base = live ? mergeBase(live, 'HEAD', tip) : mergeBase(repo, place.branch ?? 'HEAD', tip);
    return { repo, worktree: live, branch: place.branch, base };
  }

  /** What a work item's branch changed; null while nothing has worked on it in a worktree. */
  itemChanges(projectPath: string, place: { worktree: string | null; branch: string | null }, scope: ChangeScope = {}): ChangeSummary | null {
    if (!place.worktree && !place.branch) return null;
    const site = this.itemSite(projectPath, place);
    return site ? summarize(site, scope) : null;
  }

  itemDiff(projectPath: string, place: { worktree: string | null; branch: string | null }, path: string, opts: DiffOptions = {}): FileDiff {
    const site = this.itemSite(projectPath, place);
    if (!site) throw new Error('this work item has no worktree or branch left to compare');
    return diffOf(site, path, opts);
  }

  /** A worktree gives a summary; a chat anywhere else has only what its own calls wrote. */
  async chatChanges(id: string, scope: ChangeScope = {}): Promise<ChatChanges> {
    const site = this.siteOf(await this.chatOf(id));
    return {
      summary: site ? summarize(site, scope) : null,
      touched: touchedFilesOf(await this.calls(id, WRITING_TOOLS)),
    };
  }

  async chatDiff(id: string, path: string, opts: DiffOptions = {}): Promise<FileDiff> {
    const site = this.siteOf(await this.chatOf(id));
    if (!site) throw new Error('this chat has no worktree of its own, so there is no diff to show: see the files it touched');
    return diffOf(site, path, opts);
  }

  /**
   * What a step's path is relative to: the git top level of where the chat works, so it matches a
   * `ChangedFile.path`, or the chat's own directory outside git.
   */
  private stepRoot(chat: ChatSummary): string {
    const site = this.siteOf(chat);
    const dir = (site && liveWorktree(site)) ?? (chat.worktree && existsSync(chat.worktree.path) ? chat.worktree.path : chat.cwd);
    if (existsSync(dir) && isGitRepo(dir)) {
      try {
        return topLevel(dir);
      } catch {
        /* a bare or broken checkout: the directory itself will do */
      }
    }
    return dir;
  }

  /** Every edit of a chat's main transcript, oldest first, each with its patch and its why. */
  async chatSteps(id: string): Promise<EditStep[]> {
    const chat = await this.chatOf(id);
    const opts = { root: this.stepRoot(chat), running: chat.execution !== null };
    const fromDisk = await this.deps.sessions.editSteps(id);
    let steps: EditStep[];
    if (fromDisk) steps = editStepsOf(fromDisk, opts);
    else {
      // No transcript yet, or never one: what the process streamed names the edits, without patches
      const streamed: TranscriptEntry[] | null = this.deps.runtime.messages(id);
      steps = streamed ? editStepsOf(editStepsFromEntries(streamed), opts) : [];
    }
    this.flagHunks(chat, steps);
    return steps;
  }

  /** A task's edits are its chat's; a task that has not started has made none. */
  async taskSteps(id: string, taskId: string): Promise<EditStep[]> {
    const { task } = this.task(id, taskId);
    const chat = task.sessionId ?? task.runId;
    return chat ? this.chatSteps(chat) : [];
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
