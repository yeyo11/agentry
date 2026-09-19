import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type {
  Orchestration,
  OrchestrationEngine,
  OrchestrationIntegration,
  OrchestrationSpec,
  OrchestrationTaskSpec,
  OrchestrationTaskState,
  PlanDraftSummary,
  PlanRequest,
  ResumeOrchestrationRequest,
  RunSummary,
  SaveOrchestrationWorkflowRequest,
  WorkflowDefinition,
  WorkflowRun,
} from '@agentry/shared';
import type { Db } from './db.ts';
import { OrchestrationEventTracker } from './event-sources.ts';
import type { EventBus } from './events.ts';
import {
  abortMerge,
  addWorktree,
  branchExists,
  commitAll,
  conflictedPaths,
  contains,
  git,
  headCommit,
  isGitRepo,
  isIgnored,
  lockWorktree,
  merge,
  mergeInProgress,
  removeWorktree,
  topLevel,
} from './git.ts';
import type { CoreConfig } from './paths.ts';
import type { RunManager } from './runner.ts';
import { compileWorkflow, readCompiledResult, workflowName } from './workflow-engine.ts';

const ID_RE = /^[\w-]{1,40}$/;
/** The planner's own name, which is how a past planner run is recognised later. */
export const PLANNER_RUN_NAME = 'orchestration-planner';
// The objective is read back out of the prompt when recovering a draft, so both halves are built
// from these constants: they cannot drift apart.
const PROMPT_HEAD = 'Plan a multi-agent orchestration for this objective:\n\n';
const PROMPT_TAIL = '\n\nSplit it into at most ';
const MAX_DEP_CONTEXT = 6000;
const now = () => new Date().toISOString();

/** Unique per orchestration: two graphs sharing a task id would otherwise collide on one worktree. */
function worktreeName(orch: Orchestration, task: OrchestrationTaskState): string {
  return `${orch.id.slice(0, 8)}-${task.id}`.slice(0, 60);
}

/**
 * Where the CLI keeps the worktree of that name, so a pre-created one is the one it picks up. It
 * resolves them from the repository's top level, not from the directory it is started in.
 */
const worktreePath = (root: string, name: string) => join(root, '.claude', 'worktrees', name);

/** A graph's repository: its top level, and the subdirectory of it the graph works in ('' for the top). */
interface Checkout {
  root: string;
  subdir: string;
}

function checkoutOf(cwd: string): Checkout {
  const root = topLevel(cwd);
  // git answers with the real path, so a symlinked cwd would otherwise look like it is outside
  const subdir = relative(root, realpathSync(cwd));
  // An ignored directory is missing from a fresh worktree, and whatever a worker writes there never
  // reaches its branch: in one of those, working at the top is the only way the work survives.
  return { root, subdir: subdir && !isIgnored(root, subdir) ? subdir : '' };
}

/** `agentry/<name>-<id>`: readable in a branch list, and never shared by two graphs. */
function integrationBranch(orch: Orchestration): string {
  const slug = orch.name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `agentry/${slug || 'orchestration'}-${orch.id.slice(0, 8)}`;
}

/** Worktrees branch from a commit, so an empty repository cannot have any. */
function baseOf(repo: string): string {
  try {
    return headCommit(repo);
  } catch {
    throw new Error(`per-task worktrees need a commit to start from, and ${repo} has none yet`);
  }
}

/** Tasks in an order where every dependency comes before what depends on it. */
function topological(tasks: OrchestrationTaskState[]): OrchestrationTaskState[] {
  const out: OrchestrationTaskState[] = [];
  const seen = new Set<string>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (t: OrchestrationTaskState) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    for (const dep of t.dependsOn ?? []) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    out.push(t);
  };
  tasks.forEach(visit);
  return out;
}

/** A merge a worker has to finish before starting its own task. */
interface PendingMerge {
  branch: string;
  paths: string[];
  remaining: string[];
}

/** A task's worktree, ready for the CLI. */
interface PreparedWorktree {
  /** Where the worker is started */
  cwd: string;
  /**
   * Whether the CLI is handed the worktree by name. It always works at a worktree's top, so a
   * graph in a subdirectory starts its worker inside the worktree instead.
   */
  adopt: boolean;
  pendingMerge: PendingMerge | null;
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['name', 'engine', 'engineReason', 'tasks'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Short name for the orchestration' },
    engine: {
      type: 'string',
      enum: ['graph', 'workflow'],
      description: 'graph (the default): one process per task, each able to get its own git worktree; workflow: every task a subagent of one session',
    },
    engineReason: { type: 'string', description: 'One sentence on why that engine fits' },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'name', 'prompt', 'dependsOn'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'kebab-case unique id' },
          name: { type: 'string' },
          prompt: { type: 'string', description: 'Self-contained instructions for the worker agent' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'ids of tasks that must finish first' },
        },
      },
    },
  },
} as const;

export function validateTasks(tasks: OrchestrationTaskSpec[]): void {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('at least one task is required');
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!ID_RE.test(t.id ?? '')) throw new Error(`invalid task id '${t.id}' (letters, digits, _ and - only)`);
    if (ids.has(t.id)) throw new Error(`duplicate task id '${t.id}'`);
    if (!t.prompt?.trim()) throw new Error(`task '${t.id}' has an empty prompt`);
    ids.add(t.id);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!ids.has(dep)) throw new Error(`task '${t.id}' depends on unknown task '${dep}'`);
      if (dep === t.id) throw new Error(`task '${t.id}' depends on itself`);
    }
  }
  // Kahn's algorithm: whatever is left over is part of a cycle
  const pending = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn ?? [])]));
  while (pending.size > 0) {
    const ready = [...pending].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) throw new Error(`dependency cycle between: ${[...pending.keys()].join(', ')}`);
    for (const id of ready) {
      pending.delete(id);
      for (const deps of pending.values()) deps.delete(id);
    }
  }
}

/**
 * Orchestration mode: a DAG of tasks, each executed by its own `claude -p` worker.
 * Independent tasks run in parallel (up to `concurrency`); a task receives the results of
 * its dependencies as context; an optional final worker synthesizes everything.
 */
export class Orchestrator {
  private readonly items = new Map<string, Orchestration>();
  private readonly file: string;
  /**
   * Reads the workflows a session ran from the files beside its transcript, where the CLI records
   * each one's result. Set by Core, which owns the session store.
   */
  workflowRecords: ((sessionId: string) => Promise<WorkflowRun[]>) | null = null;
  /** Workflows the run already had before the current launch, so an old one is not taken for it */
  private readonly workflowBaseline = new Map<string, number>();
  /** Where status changes, task changes and merge conflicts are announced; set by Core */
  bus: EventBus | null = null;
  private readonly tracker = new OrchestrationEventTracker();

  constructor(
    private readonly config: CoreConfig,
    private readonly runs: RunManager,
    private readonly db: Db,
  ) {
    this.file = join(config.dataDir, 'orchestrations.json');
    this.load();
    this.tracker.baseline(this.list());
  }

  private load(): void {
    this.importLegacy();
    for (const o of this.db.loadOrchestrations()) {
      // Records written before a field existed come back without it; normalise on the way in so
      // the rest of the code never has to ask whether an orchestration is old.
      o.worktree ??= false;
      o.allowedTools ??= [];
      o.permissionPrompts ??= 'none';
      o.integration ??= null;
      o.synthesisRunId ??= null;
      o.engine ??= 'graph';
      o.engineReason ??= null;
      o.workflow ??= null;
      if (o.integration && ['merging', 'resolving'].includes(o.integration.status)) {
        o.integration.status = 'failed';
        o.integration.error = 'interrupted by a restart; integrate again to finish it';
      }
      // Workers do not survive a wrapper restart
      if (o.status === 'running') {
        o.status = 'stopped';
        o.endedAt ??= now();
        for (const t of o.tasks) if (t.status === 'running' || t.status === 'pending') t.status = 'stopped';
      }
      this.items.set(o.id, o);
    }
  }

  /** Carries a pre-SQLite `orchestrations.json` into the store once, then renames it away. */
  private importLegacy(): void {
    if (!existsSync(this.file)) return;
    try {
      this.db.saveOrchestrations(JSON.parse(readFileSync(this.file, 'utf8')) as Orchestration[]);
    } catch {
      // corrupt state file: start clean
    }
    try {
      renameSync(this.file, `${this.file}.migrated`);
    } catch {
      // another process got there first
    }
  }

  /** Every state change ends in a save, so the save is where they are compared and announced. */
  private announce(): void {
    for (const event of this.tracker.observe([...this.items.values()])) this.bus?.emit(event);
  }

  private persist(): void {
    this.announce();
    try {
      this.db.saveOrchestrations([...this.items.values()]);
    } catch {
      // best-effort: a failed save must not abort the orchestration in flight
    }
  }

  list(): Orchestration[] {
    return [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Orchestration | null {
    return this.items.get(id) ?? null;
  }

  runningCount(): number {
    return this.list().filter((o) => o.status === 'running').length;
  }

  create(spec: OrchestrationSpec): Orchestration {
    validateTasks(spec.tasks);
    const root = resolve(spec.cwd ?? this.config.workspaceDir);
    // Fail here rather than per task: half a graph isolated and half of it not is worse than
    // refusing outright.
    const engine: OrchestrationEngine = spec.engine === 'workflow' ? 'workflow' : 'graph';
    if (engine === 'workflow' && spec.worktree === true) {
      throw new Error('a workflow runs every task in the project directory; use the graph engine for per-task worktrees');
    }
    if (spec.worktree === true && !isGitRepo(root)) {
      throw new Error(`per-task worktrees need a git repository, and ${root} is not one`);
    }
    const orch: Orchestration = {
      id: randomUUID(),
      name: spec.name?.trim() || 'orchestration',
      objective: spec.objective?.trim() || null,
      status: 'running',
      cwd: resolve(spec.cwd ?? this.config.workspaceDir),
      model: spec.model ?? null,
      permissionMode: spec.permissionMode ?? this.config.defaultPermissionMode,
      concurrency: Math.min(Math.max(spec.concurrency ?? 3, 1), this.config.maxConcurrentRuns),
      synthesize: spec.synthesize ?? false,
      worktree: spec.worktree === true,
      allowedTools: (spec.allowedTools ?? []).map(String).filter(Boolean),
      permissionPrompts: spec.permissionPrompts === 'host' ? 'host' : 'none',
      createdAt: now(),
      endedAt: null,
      finalResult: null,
      costUsd: 0,
      // Every worktree starts here, so work that lands on the checkout meanwhile does not leak in
      baseCommit: spec.worktree === true ? baseOf(root) : null,
      integration: null,
      synthesisRunId: null,
      engine,
      engineReason: spec.engineReason?.trim() || null,
      workflow: null,
      tasks: spec.tasks.map<OrchestrationTaskState>((t) => ({
        id: t.id,
        name: t.name?.trim() || t.id,
        prompt: t.prompt,
        dependsOn: t.dependsOn ?? [],
        cwd: t.cwd,
        model: t.model,
        status: 'pending',
        runId: null,
        sessionId: null,
        result: null,
        error: null,
        startedAt: null,
        endedAt: null,
        costUsd: 0,
      })),
    };
    this.items.set(orch.id, orch);
    if (engine === 'workflow') this.launchWorkflow(orch, null);
    else this.schedule(orch);
    return orch;
  }

  stop(id: string): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    if (orch.status !== 'running') return orch;
    orch.status = 'stopped';
    orch.endedAt = now();
    // One process runs every task of a workflow
    if (orch.workflow?.runId && this.runs.get(orch.workflow.runId)?.pid) this.runs.stop(orch.workflow.runId);
    for (const t of orch.tasks) {
      if (t.status === 'running' && t.runId && orch.engine !== 'workflow') this.runs.stop(t.runId);
      if (t.status === 'pending' || t.status === 'running') t.status = 'stopped';
    }
    // The last steps run agents too, and stopping the graph has to stop them
    for (const runId of [orch.integration?.integratorRunId, orch.synthesisRunId]) {
      if (runId && this.runs.get(runId)) this.runs.stop(runId);
    }
    if (orch.integration && ['merging', 'resolving'].includes(orch.integration.status)) {
      orch.integration.status = 'failed';
      orch.integration.error = 'stopped';
    }
    this.persist();
    return orch;
  }

  /**
   * Relaunches a graph that is no longer running. Workers do not survive a wrapper restart, and
   * until now that left the whole orchestration dead with no way back — a restart in the middle
   * threw away every task still in flight and every one waiting behind it.
   *
   * Completed tasks and their results are kept, so the work already paid for is not repeated and
   * dependants still receive their context. Everything else — stopped, failed, or skipped because
   * a dependency never completed — goes back to pending and is attempted again.
   */
  resume(id: string, changes: ResumeOrchestrationRequest = {}): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    if (orch.status === 'running') return orch;
    const unfinished = orch.tasks.filter((t) => t.status !== 'completed');
    if (unfinished.length === 0) throw new Error('every task already completed');
    // A graph that died for lack of permissions, or by editing the checkout the wrapper runs from,
    // would only die the same way again: correct those before relaunching what is left.
    if (changes.worktree === true && orch.engine === 'workflow') {
      throw new Error('a workflow runs every task in the project directory; per-task worktrees need the graph engine');
    }
    if (changes.worktree === true && !isGitRepo(orch.cwd)) {
      throw new Error(`per-task worktrees need a git repository, and ${orch.cwd} is not one`);
    }
    const base = changes.worktree === true && !orch.baseCommit ? baseOf(orch.cwd) : undefined;
    if (changes.worktree !== undefined) orch.worktree = changes.worktree;
    if (orch.worktree) orch.baseCommit ??= base ?? baseOf(orch.cwd);
    if (changes.permissionPrompts !== undefined) orch.permissionPrompts = changes.permissionPrompts === 'host' ? 'host' : 'none';
    if (changes.allowedTools !== undefined) orch.allowedTools = changes.allowedTools.map(String).filter(Boolean);
    if (changes.permissionMode !== undefined) orch.permissionMode = changes.permissionMode;
    for (const task of unfinished) {
      task.status = 'pending';
      task.runId = null;
      task.sessionId = null;
      task.result = null;
      task.error = null;
      task.startedAt = null;
      task.endedAt = null;
    }
    orch.status = 'running';
    orch.endedAt = null;
    orch.finalResult = null;
    orch.synthesisRunId = null;
    // Integrated again once the resumed tasks finish. The branch name is derived from the graph, so
    // that reuses the same branch, which already holds the earlier merges.
    orch.integration = null;
    // A workflow picks up in its own session, where the CLI replays the agents that already finished
    // from its cache instead of running them again
    if (orch.engine === 'workflow') this.launchWorkflow(orch, orch.workflow?.workflowRunId ?? null);
    else this.schedule(orch); // persists
    return orch;
  }

  /** What every worker is told first; shared by both engines, so a task reads the same either way. */
  private workerHead(orch: Orchestration): string {
    return orch.objective ? `You are one worker in a multi-agent orchestration.\nOverall objective: ${orch.objective}` : '';
  }

  private workerTask(task: OrchestrationTaskState): string {
    return `Your task (${task.name}):\n${task.prompt}\n\nFinish with a concise report of what you did and found; it is handed to the next workers.`;
  }

  private buildPrompt(orch: Orchestration, task: OrchestrationTaskState, pendingMerge: PendingMerge | null = null): string {
    const parts: string[] = [];
    const head = this.workerHead(orch);
    if (head) parts.push(head);
    const deps = orch.tasks.filter((t) => task.dependsOn?.includes(t.id));
    if (deps.length > 0) {
      parts.push(
        'Results from the tasks you depend on:\n' +
          deps.map((d) => `<task id="${d.id}" name="${d.name}">\n${(d.result ?? '').slice(0, MAX_DEP_CONTEXT)}\n</task>`).join('\n'),
      );
    }
    if (task.worktree && task.branch) {
      parts.push(
        `You are working in a git worktree of your own at ${task.worktree}, checked out on branch ${task.branch}. ` +
          'Every other worker has its own, so nothing you write there collides with theirs. Work only inside it, ' +
          'commit your work on that branch with clear messages, and do not push: once every task is done, all ' +
          'branches are merged into one automatically.' +
          (deps.length > 0 ? ' Your branch already contains the work of the tasks you depend on; build on it rather than redoing it.' : ''),
      );
    }
    if (pendingMerge) {
      parts.push(
        `Before your task: combining the work of your dependencies left a merge of ${pendingMerge.branch} unfinished, ` +
          `with conflicts in:\n${pendingMerge.paths.map((p) => `- ${p}`).join('\n')}\n` +
          'Resolve them keeping the intent of both sides, then commit the merge.' +
          (pendingMerge.remaining.length
            ? ` After that, merge these branches too, resolving any conflict the same way:\n${pendingMerge.remaining.map((b) => `- ${b}`).join('\n')}`
            : ''),
      );
    }
    parts.push(this.workerTask(task));
    return parts.join('\n\n');
  }

  private schedule(orch: Orchestration): void {
    if (orch.status !== 'running') return;
    const byId = new Map(orch.tasks.map((t) => [t.id, t]));

    // A task whose dependency did not complete can never run
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of orch.tasks) {
        if (t.status !== 'pending') continue;
        const blocked = (t.dependsOn ?? []).some((d) => ['failed', 'skipped', 'stopped'].includes(byId.get(d)?.status ?? ''));
        if (blocked) {
          t.status = 'skipped';
          t.error = 'a dependency did not complete';
          changed = true;
        }
      }
    }

    let running = orch.tasks.filter((t) => t.status === 'running').length;
    for (const t of orch.tasks) {
      if (running >= orch.concurrency) break;
      if (t.status !== 'pending') continue;
      if (!(t.dependsOn ?? []).every((d) => byId.get(d)?.status === 'completed')) continue;
      if (this.launch(orch, t)) running++;
      else break;
    }

    if (orch.tasks.every((t) => !['pending', 'running'].includes(t.status))) void this.finish(orch);
    this.persist();
  }

  /**
   * Creates the task's worktree before the CLI runs, on a branch that already holds its
   * dependencies' work. Left to itself `claude --worktree` branches from HEAD, so a dependent task
   * started from nothing its dependencies had done and rebuilt it. The CLI adopts an existing
   * worktree of the name it is given, so it still locks it and records it as its own.
   */
  private prepareWorktree(orch: Orchestration, task: OrchestrationTaskState, name: string): PreparedWorktree {
    const { root, subdir } = checkoutOf(orch.cwd);
    const path = worktreePath(root, name);
    const branch = `worktree-${name}`;
    // Before worktrees were resolved from the top level, a graph in a subdirectory put them where
    // the CLI never looked, and every worker failed there before doing anything. Its branch cannot
    // be checked out twice, so that worktree goes; git refuses if it holds anything.
    const old = task.worktree;
    if (old && existsSync(old) && (!existsSync(path) || realpathSync(old) !== realpathSync(path))) removeWorktree(root, old);
    task.worktree = path;
    task.branch = branch;
    // Handed a name, the CLI finds the worktree from the top level and works at the worktree's top
    const prepared: PreparedWorktree = subdir
      ? { cwd: join(path, subdir), adopt: false, pendingMerge: null }
      : { cwd: root, adopt: true, pendingMerge: null };
    // A resumed task continues where its first attempt stopped
    if (!existsSync(path)) {
      const deps = orch.tasks
        .filter((t) => task.dependsOn?.includes(t.id) && t.branch && branchExists(root, t.branch))
        .map((t) => t.branch as string);
      const base = deps[0] ?? orch.baseCommit ?? 'HEAD';
      addWorktree(root, path, branch, base);
      const rest = deps.slice(1);
      for (const [i, dep] of rest.entries()) {
        if (contains(path, dep)) continue;
        const paths = merge(path, dep, `Merge ${dep} into ${branch}`);
        // A conflict between two dependencies is the worker's to resolve, as the first thing it does:
        // it has the context to, and starting it on half the code would be worse.
        if (paths) {
          prepared.pendingMerge = { branch: dep, paths, remaining: rest.slice(i + 1) };
          break;
        }
      }
    }
    if (!prepared.adopt) {
      // A directory holding only untracked files in the checkout does not exist in the worktree
      mkdirSync(prepared.cwd, { recursive: true });
      lockWorktree(root, path, `agentry orchestration ${orch.id.slice(0, 8)}`);
    }
    return prepared;
  }

  private launch(orch: Orchestration, task: OrchestrationTaskState): boolean {
    try {
      const isolated = orch.worktree && !task.cwd;
      const name = worktreeName(orch, task);
      const prepared = isolated ? this.prepareWorktree(orch, task, name) : null;
      const run = this.runs.start(
        {
          prompt: this.buildPrompt(orch, task, prepared?.pendingMerge ?? null),
          cwd: prepared?.cwd ?? task.cwd ?? orch.cwd,
          // The CLI adopts the worktree prepared above, locks it and works in it
          ...(prepared?.adopt ? { worktree: name } : {}),
          model: task.model ?? orch.model ?? undefined,
          permissionMode: orch.permissionMode,
          ...(orch.allowedTools?.length ? { allowedTools: orch.allowedTools } : {}),
          ...(orch.permissionPrompts === 'host' ? { permissionPrompts: 'host' as const } : {}),
          name: `${orch.name}:${task.id}`.slice(0, 60),
          keepAlive: false,
        },
        { orchestrationId: orch.id, orchestrationTaskId: task.id },
      );
      task.status = 'running';
      task.runId = run.id;
      task.sessionId = run.sessionId;
      task.startedAt = now();
      void this.runs.waitForResult(run.id).then((result) => {
        if (task.status !== 'running') return; // stopped meanwhile
        task.status = result.isError ? 'failed' : 'completed';
        task.result = result.isError ? null : result.result;
        task.error = result.isError ? result.result : null;
        task.costUsd = result.costUsd;
        task.endedAt = now();
        if (task.status === 'completed') this.commitTask(orch, task);
        orch.costUsd = orch.tasks.reduce((sum, t) => sum + t.costUsd, 0);
        this.schedule(orch);
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The global run limit is the one transient failure: stay pending and try again shortly.
      if (message.includes('Concurrent run limit')) {
        setTimeout(() => this.schedule(orch), 3000).unref();
        return false;
      }
      // Everything else used to be swallowed and retried for ever, which left a graph reporting
      // itself as running with nothing running and no way to find out why. Fail it visibly.
      task.status = 'failed';
      task.error = `could not start the worker: ${message}`;
      task.endedAt = now();
      setTimeout(() => this.schedule(orch), 0).unref();
      return false;
    }
  }

  /**
   * Commits what a finished worker left uncommitted. Asked to commit, workers often do not, and
   * work stranded in a worktree is invisible to everything that comes after: its dependants, the
   * integration, a review.
   */
  private commitTask(orch: Orchestration, task: OrchestrationTaskState): void {
    if (!task.worktree || !existsSync(task.worktree)) return;
    try {
      // A worker told to resolve a merge that did not is not the wrapper's to paper over
      if (mergeInProgress(task.worktree) && conflictedPaths(task.worktree).length > 0) return;
      const commit = commitAll(task.worktree, `${task.name}\n\nOrchestration ${orch.name} (${orch.id.slice(0, 8)}), task ${task.id}.`);
      if (commit) task.commit = commit;
    } catch (err) {
      task.error = `the work was left uncommitted: ${(err as Error).message}`;
    }
  }

  /**
   * Builds the one branch a worktree graph delivers: every completed task's branch merged, in
   * dependency order, into `agentry/<name>` from the commit the graph started on. A conflict is
   * handed to an integrator agent in that branch's worktree, and the result is checked rather than
   * trusted. Never throws: whatever happens is recorded on `orch.integration`.
   */
  private async integrate(orch: Orchestration): Promise<void> {
    const tasks = topological(orch.tasks).filter((t) => t.status === 'completed' && t.branch);
    if (tasks.length === 0) return;
    const branch = orch.integration?.branch ?? integrationBranch(orch);
    let root: string;
    try {
      root = checkoutOf(orch.cwd).root;
    } catch {
      root = orch.cwd; // no longer a repository: adding the worktree below says so on the record
    }
    const path = worktreePath(root, `${orch.id.slice(0, 8)}-integration`);
    const state: OrchestrationIntegration = (orch.integration = {
      branch,
      worktree: path,
      status: 'merging',
      merged: [],
      conflicts: [],
      commit: null,
      error: null,
      integratorRunId: orch.integration?.integratorRunId ?? null,
      pullRequestUrl: orch.integration?.pullRequestUrl ?? null,
    });
    this.persist();
    try {
      // Graphs from before tasks were committed on completion still have their work loose
      for (const task of tasks) this.commitTask(orch, task);
      addWorktree(root, path, branch, orch.baseCommit ?? 'HEAD');
      if (mergeInProgress(path)) abortMerge(path); // a previous attempt stopped half way

      const unmerged: OrchestrationTaskState[] = [];
      for (const task of tasks) {
        const taskBranch = task.branch as string;
        if (!branchExists(root, taskBranch)) continue; // the CLI removes a worktree that changed nothing
        if (contains(path, taskBranch)) {
          state.merged.push(task.id);
          continue;
        }
        const paths = merge(path, taskBranch, `Merge task ${task.id}: ${task.name}`);
        if (!paths) {
          state.merged.push(task.id);
          continue;
        }
        abortMerge(path);
        state.conflicts.push({ taskId: task.id, paths });
        unmerged.push(task);
      }
      if (unmerged.length > 0) await this.resolveConflicts(orch, state, unmerged);

      const left = tasks.filter((t) => t.branch && branchExists(root, t.branch) && !contains(path, t.branch));
      if (left.length > 0 || mergeInProgress(path) || conflictedPaths(path).length > 0) {
        state.status = 'conflicted';
        state.error = left.length
          ? `not merged: ${left.map((t) => t.id).join(', ')}`
          : 'the integration branch has an unfinished merge';
      } else {
        state.merged = tasks.filter((t) => t.branch && branchExists(root, t.branch)).map((t) => t.id);
        state.status = 'merged';
      }
      state.commit = headCommit(path);
    } catch (err) {
      state.status = 'failed';
      state.error = (err as Error).message;
    }
    this.persist();
  }

  /** Runs an agent in the integration worktree to merge the branches git could not. */
  private async resolveConflicts(orch: Orchestration, state: OrchestrationIntegration, tasks: OrchestrationTaskState[]): Promise<void> {
    state.status = 'resolving';
    const run = this.runs.start(
      {
        prompt:
          `You are integrating the work of a multi-agent orchestration into one branch.\n` +
          `Objective: ${orch.objective ?? orch.name}\n\n` +
          `You are in a git worktree at ${state.worktree}, on branch ${state.branch}, which already contains the work of: ` +
          `${state.merged.join(', ') || 'no task yet'}. Merging these branches conflicted:\n` +
          state.conflicts.map((c) => `- ${orch.tasks.find((t) => t.id === c.taskId)?.branch}: ${c.paths.join(', ')}`).join('\n') +
          `\n\nMerge each of them into ${state.branch}, in this order, with \`git merge --no-ff\`:\n` +
          tasks.map((t) => `- ${t.branch}`).join('\n') +
          '\n\nResolve every conflict so that the intent of both sides survives; read the code on each branch to ' +
          'understand it. Commit each merge. Do not push, and do not change anything beyond what resolving needs. ' +
          'Finish with a short report of how each conflict was resolved.\n\n' +
          'What each task did:\n' +
          tasks.map((t) => `<task id="${t.id}" name="${t.name}">\n${(t.result ?? '').slice(0, MAX_DEP_CONTEXT)}\n</task>`).join('\n'),
        cwd: state.worktree ?? orch.cwd,
        model: orch.model ?? undefined,
        permissionMode: orch.permissionMode,
        // Merging is git work; without it the integrator could only describe the conflicts
        allowedTools: [...new Set([...(orch.allowedTools ?? []), 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git:*)'])],
        ...(orch.permissionPrompts === 'host' ? { permissionPrompts: 'host' as const } : {}),
        name: `${orch.name}:integration`.slice(0, 60),
        keepAlive: false,
      },
      { orchestrationId: orch.id, orchestrationTaskId: '__integration__' },
    );
    state.integratorRunId = run.id;
    this.persist();
    const result = await this.runs.waitForResult(run.id);
    orch.costUsd += result.costUsd;
    if (result.isError) state.error = `integrator: ${result.result}`;
  }

  private async finish(orch: Orchestration): Promise<void> {
    if (orch.status !== 'running' || orch.endedAt) return;
    const anyFailed = orch.tasks.some((t) => t.status === 'failed' || t.status === 'skipped');
    orch.endedAt = now(); // guards against re-entry while integration and synthesis run

    if (orch.worktree) await this.integrate(orch);
    if (orch.status !== 'running') return; // stopped meanwhile
    if (orch.synthesize && orch.tasks.some((t) => t.status === 'completed')) await this.synthesize(orch);
    if (orch.status === 'running') orch.status = anyFailed ? 'failed' : 'completed';
    orch.endedAt = now();
    this.persist();
  }

  private async synthesize(orch: Orchestration): Promise<void> {
    const integration = orch.integration;
    const onBranch = integration?.status === 'merged' && integration.worktree && existsSync(integration.worktree);
    try {
      const run = this.runs.start(
        {
          prompt:
            `Synthesize the results of a multi-agent orchestration into one final report.\n` +
            `Objective: ${orch.objective ?? orch.name}\n\n` +
            (onBranch
              ? `All of the tasks' work has been merged into branch ${integration.branch}, checked out in your working ` +
                'directory. Describe what is actually there and anything still missing; do not merge, push or open pull requests.\n\n'
              : integration
                ? `Merging the tasks' branches into ${integration.branch} did not finish (${integration.error ?? integration.status}). Say so in the report.\n\n`
                : '') +
            orch.tasks
              .map((t) => `<task id="${t.id}" name="${t.name}" status="${t.status}">\n${(t.result ?? t.error ?? '').slice(0, MAX_DEP_CONTEXT)}\n</task>`)
              .join('\n'),
          cwd: onBranch ? this.integratedDir(orch, integration.worktree as string) : orch.cwd,
          model: orch.model ?? undefined,
          permissionMode: orch.permissionMode,
          name: `${orch.name}:synthesis`.slice(0, 60),
          keepAlive: false,
        },
        { orchestrationId: orch.id, orchestrationTaskId: '__synthesis__' },
      );
      // Kept so the report can be answered: it is a conversation like any other
      orch.synthesisRunId = run.id;
      this.persist();
      const result = await this.runs.waitForResult(run.id);
      orch.finalResult = result.isError ? `Synthesis failed: ${result.result}` : result.result;
      orch.costUsd += result.costUsd;
    } catch (err) {
      orch.finalResult = `Synthesis failed: ${(err as Error).message}`;
    }
  }

  /** The graph's subdirectory inside the integration worktree, where the workers worked too. */
  private integratedDir(orch: Orchestration, worktree: string): string {
    const dir = join(worktree, checkoutOf(orch.cwd).subdir);
    return existsSync(dir) ? dir : worktree;
  }

  /** Integrates a finished graph again: after resolving by hand, or one from before this existed. */
  retryIntegration(id: string): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    if (orch.status === 'running') throw new Error('the orchestration is still running');
    if (orch.integration && ['merging', 'resolving'].includes(orch.integration.status)) return orch;
    if (!orch.tasks.some((t) => t.status === 'completed' && t.branch)) throw new Error('no task has a branch to integrate');
    if (!isGitRepo(orch.cwd)) throw new Error(`${orch.cwd} is not a git repository`);
    orch.baseCommit ??= this.forkPoint(orch);
    void this.integrate(orch);
    return orch;
  }

  /** Where the task branches of a graph started, for one recorded before the base commit was. */
  private forkPoint(orch: Orchestration): string {
    const branches = orch.tasks.map((t) => t.branch).filter((b): b is string => !!b && branchExists(orch.cwd, b));
    if (branches.length === 0) return headCommit(orch.cwd);
    try {
      return git(orch.cwd, ['merge-base', '--octopus', ...branches]);
    } catch {
      return headCommit(orch.cwd);
    }
  }

  /**
   * Publishes the integration branch and opens a pull request for it. Only ever on request: pushing
   * is the one step that leaves the machine.
   */
  pullRequest(id: string): { branch: string; url: string | null; detail: string } {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    const integration = orch.integration;
    if (integration?.status !== 'merged') throw new Error('the orchestration has no integrated branch yet');
    if (integration.pullRequestUrl) return { branch: integration.branch, url: integration.pullRequestUrl, detail: 'already open' };
    git(orch.cwd, ['push', '-u', 'origin', integration.branch], 180_000);
    let url: string | null = null;
    let detail = `pushed ${integration.branch}`;
    try {
      const body = [orch.objective, orch.finalResult].filter(Boolean).join('\n\n---\n\n') || orch.name;
      url = execFileSync('gh', ['pr', 'create', '--head', integration.branch, '--title', orch.name, '--body', body.slice(0, 60_000)], {
        cwd: orch.cwd,
        stdio: 'pipe',
        timeout: 120_000,
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .pop() ?? null;
      integration.pullRequestUrl = url;
      detail = 'pull request opened';
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      detail = `pushed ${integration.branch}, but no pull request was opened: ${(e.stderr || e.message).trim().split('\n')[0]}`;
    }
    this.persist();
    return { branch: integration.branch, url, detail };
  }

  /**
   * Starts the planner agent and returns its run without waiting. The caller streams it like any
   * other run, which is what keeps a two-minute plan from living inside one HTTP request: a lost
   * connection no longer loses the plan, because {@link draftFrom} can read it back afterwards.
   */
  startPlan(req: PlanRequest): RunSummary {
    if (!req.objective?.trim()) throw new Error('objective is required');
    const maxTasks = Math.min(Math.max(req.maxTasks ?? 6, 1), 12);
    const cwd = resolve(req.cwd ?? this.config.workspaceDir);
    return this.runs.start({
      prompt:
        `${PROMPT_HEAD}${req.objective}${PROMPT_TAIL}` +
        `${maxTasks} tasks. Each task is executed by an independent Claude Code agent working in ${cwd}, ` +
        `so every prompt must be self-contained. Maximize parallelism: only add a dependency when a task truly needs another task's output ` +
        `(results of dependencies are passed along automatically). You may inspect the directory with read-only tools first. Do not perform the work itself.\n\n` +
        `Also choose how it runs. "graph" is the default: every task is a separate Claude Code process that can get a git worktree ` +
        `and branch of its own, merged at the end; choose it whenever a task changes files. "workflow" runs every task as a subagent ` +
        `of one Claude Code session in ${cwd} itself: cheaper and resumable, but with no isolation, so choose it only when it is ` +
        `clearly better, meaning no task modifies the repository (analysis, review, research, audits). Say why in engineReason.`,
      cwd,
      model: req.model,
      permissionMode: 'manual',
      allowedTools: ['Read', 'Glob', 'Grep'],
      name: PLANNER_RUN_NAME,
      keepAlive: false,
      internal: true,
      jsonSchema: PLAN_SCHEMA,
    });
  }

  /**
   * Starts the planner and records its draft as soon as it finishes, whether or not anyone is
   * still listening. This is what makes a plan survive a dropped response or a page reload.
   */
  startPlanAndRecord(req: PlanRequest): RunSummary {
    const run = this.startPlan(req);
    void this.draftFrom(run.id).catch(() => {
      // A failed plan has nothing worth recording; the run itself carries the error.
    });
    return run;
  }

  /**
   * The editable draft a planner run produced. Works on any finished planner run, so a plan whose
   * HTTP response was lost — or that was generated before a reload — is recoverable instead of paid
   * for twice.
   */
  private async draftFrom(runId: string): Promise<OrchestrationSpec> {
    const run = this.runs.get(runId);
    if (!run) throw new Error('run not found');
    if (run.name !== PLANNER_RUN_NAME) throw new Error('that run is not a planner run');
    const result = await this.runs.waitForResult(runId);
    if (result.isError) throw new Error(`planner failed: ${result.result}`);

    let draft = result.structuredOutput as { name?: string; engine?: string; engineReason?: string; tasks?: OrchestrationTaskSpec[] } | undefined;
    if (!draft?.tasks) {
      // Older CLIs return the JSON as text
      const match = /\{[\s\S]*\}/.exec(result.result);
      draft = match ? (JSON.parse(match[0]) as typeof draft) : undefined;
    }
    if (!draft?.tasks) throw new Error('planner returned no tasks');
    validateTasks(draft.tasks);
    const head = run.prompt.indexOf(PROMPT_HEAD);
    const tail = run.prompt.indexOf(PROMPT_TAIL);
    // The planner only knows what a workflow is; whether this CLI can run one, its own init told us
    const engine: OrchestrationEngine = draft.engine === 'workflow' ? 'workflow' : 'graph';
    const canRunWorkflows = this.workflowsAvailable(run.cwd);
    const spec: OrchestrationSpec = {
      name: draft.name ?? 'orchestration',
      objective: head === 0 && tail > 0 ? run.prompt.slice(PROMPT_HEAD.length, tail) : undefined,
      engine: engine === 'workflow' && canRunWorkflows ? 'workflow' : 'graph',
      ...(draft.engineReason
        ? { engineReason: engine === 'workflow' && !canRunWorkflows ? `${draft.engineReason} (as a graph: this CLI has no Workflow tool)` : draft.engineReason }
        : {}),
      cwd: run.cwd,
      model: run.model ?? undefined,
      concurrency: 3,
      synthesize: true,
      tasks: draft.tasks,
    };
    this.db.savePlanDraft(runId, spec);
    return spec;
  }

  /** A draft this planner run produced, from the live run or from the store once it is gone. */
  async draft(runId: string): Promise<OrchestrationSpec> {
    const stored = this.db.planDraft(runId);
    if (stored) return stored;
    return this.draftFrom(runId);
  }

  /**
   * Removes the worktrees a graph created, once its branches have been reviewed. `claude rm` would
   * do this but only for background jobs, and these workers are --print runs.
   *
   * The branch is always kept, so anything committed survives. Without `force` a worktree holding
   * uncommitted changes is left alone and reported: losing a worker's unfinished work to a cleanup
   * is exactly what nobody asks for.
   */
  pruneWorktrees(id: string, opts: { force?: boolean } = {}): Array<{ task: string; removed: boolean; detail: string }> {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    if (orch.status === 'running') throw new Error('stop the orchestration before removing its worktrees');
    const out: Array<{ task: string; removed: boolean; detail: string }> = [];
    const places: Array<{ id: string; path: string | null | undefined; branch: string | null | undefined; clear: () => void }> = [
      ...orch.tasks.map((t) => ({ id: t.id, path: t.worktree, branch: t.branch, clear: () => (t.worktree = null) })),
    ];
    const integration = orch.integration;
    if (integration) {
      places.push({ id: 'integration', path: integration.worktree, branch: integration.branch, clear: () => (integration.worktree = null) });
    }
    for (const place of places) {
      if (!place.path || !existsSync(place.path)) continue;
      try {
        removeWorktree(orch.cwd, place.path, opts.force);
        place.clear();
        out.push({ task: place.id, removed: true, detail: `branch ${place.branch ?? '?'} kept` });
      } catch (err) {
        const detail = err instanceof Error ? err.message.split('\n')[0] ?? err.message : String(err);
        out.push({ task: place.id, removed: false, detail });
      }
    }
    this.persist();
    return out;
  }

  /**
   * Forgets a graph that is not running. Its worktrees go with it, but their branches are kept:
   * deleting a record must not delete work that was committed there.
   */
  remove(id: string): void {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    if (orch.status === 'running') throw new Error('stop the orchestration before deleting it');
    const kept = this.pruneWorktrees(id, { force: false }).filter((r) => !r.removed);
    if (kept.length > 0) {
      throw new Error(
        `${kept.length} worktree(s) still hold uncommitted work (${kept.map((k) => k.task).join(', ')}); commit it or remove them with force first`,
      );
    }
    this.items.delete(id);
    this.db.deleteOrchestration(id);
    this.announce();
  }

  /** Plans that can still be launched, newest first. */
  drafts(limit?: number): PlanDraftSummary[] {
    return this.db.planDrafts(limit);
  }

  // ---------- the workflow engine ----------

  /** Whether the CLI in this directory can run workflows, from what the latest run there loaded. */
  private workflowsAvailable(cwd: string): boolean {
    const tools = this.runs.environments.get(cwd)?.tools;
    // Unknown until a run has started there; the run that launches it will say so plainly if not
    return tools === undefined || tools.includes('Workflow');
  }

  private scriptPath(orch: Orchestration): string {
    return join(this.config.dataDir, 'workflows', `${orch.id}.js`);
  }

  /** The graph as a workflow script: the same prompts, dependencies, concurrency and synthesis. */
  private compile(orch: Orchestration): string {
    const head = this.workerHead(orch);
    return compileWorkflow({
      name: orch.name,
      description: orch.objective ?? orch.name,
      concurrency: orch.concurrency,
      maxContext: MAX_DEP_CONTEXT,
      tasks: orch.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        dependsOn: t.dependsOn ?? [],
        ...(t.model ? { model: t.model } : {}),
        before: head,
        after: this.workerTask(t),
      })),
      synthesis: orch.synthesize
        ? `Synthesize the results of a multi-agent orchestration into one final report.\nObjective: ${orch.objective ?? orch.name}`
        : null,
    });
  }

  /**
   * Runs the graph as one workflow, or resumes one that stopped. The CLI has no command to start a
   * workflow: the Workflow tool does it from inside a session, so a run is asked to call it with
   * the generated script. A resume goes back to that same session, which is where the CLI keeps
   * the cache that replays the agents that had already finished.
   */
  private launchWorkflow(orch: Orchestration, resumeFrom: string | null): void {
    const scriptPath = this.scriptPath(orch);
    try {
      // A resume replays the script that ran: regenerating it could miss the cache
      if (!resumeFrom || !existsSync(scriptPath)) {
        mkdirSync(join(this.config.dataDir, 'workflows'), { recursive: true });
        writeFileSync(scriptPath, this.compile(orch));
      }
      const prompt =
        `Run the workflow Agentry generated for the orchestration "${orch.name}": call the Workflow tool with ` +
        `scriptPath "${scriptPath}"${resumeFrom ? ` and resumeFromRunId "${resumeFrom}"` : ''}, exactly as given, without editing the script. ` +
        'I explicitly ask you to run this workflow. Wait for it to finish, then reply with one line saying whether it completed.';
      const previous = orch.workflow?.runId ? this.runs.get(orch.workflow.runId) : null;
      if (resumeFrom && previous) {
        orch.workflow = { scriptPath, runId: previous.id, workflowRunId: resumeFrom };
        // Back to the session that holds the cache. Its last process may still be on its way out
        // from the previous turn, and whatever is sent before it exits would be lost with it.
        void this.runs.exited(previous.id).then(() => {
          if (orch.status !== 'running') return;
          this.workflowBaseline.set(orch.id, this.runs.get(previous.id)?.workflows?.length ?? 0);
          this.runs.send(previous.id, prompt);
          this.followWorkflow(orch, previous.id);
        });
      } else {
        const run = this.runs.start(
          {
            prompt,
            cwd: orch.cwd,
            model: orch.model ?? undefined,
            permissionMode: orch.permissionMode,
            // Asked for by the person who launched the graph: nothing to confirm again
            allowedTools: [...new Set([...orch.allowedTools, 'Workflow'])],
            ...(orch.permissionPrompts === 'host' ? { permissionPrompts: 'host' as const } : {}),
            name: `${orch.name}:workflow`.slice(0, 60),
            keepAlive: false,
          },
          { orchestrationId: orch.id, orchestrationTaskId: '__workflow__' },
        );
        orch.workflow = { scriptPath, runId: run.id, workflowRunId: null };
        this.workflowBaseline.set(orch.id, 0);
        this.followWorkflow(orch, run.id);
      }
    } catch (err) {
      orch.status = 'failed';
      orch.endedAt = now();
      for (const t of orch.tasks) {
        if (t.status === 'pending' || t.status === 'running') {
          t.status = 'failed';
          t.error = `could not start the workflow: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
    this.persist();
  }

  /**
   * Tracks the workflow until it ends. Its end is its own: in a `-p` session the Workflow tool
   * runs in the background, so the turn that launched it ends at once ("Workflow is running…") and
   * the process stays up until the workflow reports back with a task notification. A process that
   * goes away before that took the workflow with it.
   */
  private followWorkflow(orch: Orchestration, runId: string): void {
    const run = this.runs.get(runId);
    for (const t of orch.tasks) {
      t.runId = runId;
      t.sessionId = run?.sessionId ?? null;
    }
    const watcher = setInterval(() => {
      if (orch.status !== 'running') return clearInterval(watcher);
      this.syncWorkflow(orch);
      const workflow = this.currentWorkflow(orch);
      const now = this.runs.get(runId);
      const ended = workflow !== null && workflow.status !== 'running';
      const gone = !now || (now.pid === null && ['completed', 'failed', 'stopped'].includes(now.status));
      if (!ended && !gone) return;
      clearInterval(watcher);
      void this.finishWorkflow(orch, runId);
    }, 1000);
    watcher.unref();
    this.persist();
  }

  /** The workflow this launch started, once the run has reported it. */
  private currentWorkflow(orch: Orchestration): WorkflowRun | null {
    const run = orch.workflow?.runId ? this.runs.get(orch.workflow.runId) : null;
    const all = run?.workflows ?? [];
    return all.length > (this.workflowBaseline.get(orch.id) ?? 0) ? (all.at(-1) ?? null) : null;
  }

  /** Mirrors the live progress of the workflow's agents onto the tasks they run: one agent per task, labelled with its id. */
  private syncWorkflow(orch: Orchestration): void {
    if (orch.status !== 'running') return;
    const workflow = this.currentWorkflow(orch);
    if (!workflow) return;
    if (orch.workflow && !orch.workflow.workflowRunId) void this.learnWorkflowRunId(orch, workflow);
    const byId = new Map(orch.tasks.map((t) => [t.id, t]));
    let changed = false;
    for (const agent of workflow.agents) {
      const task = byId.get(agent.label);
      if (!task || task.status === 'completed') continue;
      const status = agent.state === 'done' ? 'completed' : agent.state === 'error' ? 'failed' : 'running';
      if (task.status === status) continue;
      task.status = status;
      task.startedAt ??= agent.startedAt ?? now();
      if (status !== 'running') task.endedAt = now();
      // The preview is cut short; the full result arrives with the workflow's record
      if (status === 'completed') task.result = agent.resultPreview;
      changed = true;
    }
    if (changed) this.persist();
  }

  /**
   * The CLI's id for the run (`wf_…`), which a resume needs. The live stream only carries the task
   * id; the files do from the start, since the journal is written before the record, so a graph
   * stopped half way can still be resumed from cache.
   */
  private async learnWorkflowRunId(orch: Orchestration, workflow: WorkflowRun): Promise<void> {
    const run = orch.workflow?.runId ? this.runs.get(orch.workflow.runId) : null;
    if (!run?.sessionId || !this.workflowRecords) return;
    const records = await this.workflowRecords(run.sessionId).catch(() => []);
    const match = records.find((r) => r.taskId === workflow.taskId) ?? records.find((r) => r.status === 'running');
    if (match?.id.startsWith('wf_') && orch.workflow && !orch.workflow.workflowRunId) {
      orch.workflow.workflowRunId = match.id;
      this.persist();
    }
  }

  private async finishWorkflow(orch: Orchestration, runId: string): Promise<void> {
    if (orch.status !== 'running') return; // stopped meanwhile
    this.syncWorkflow(orch);
    const live = this.currentWorkflow(orch);
    const run = this.runs.get(runId);
    // The record is written as the workflow ends, around the notification: give it a moment
    let record: WorkflowRun | null = null;
    for (let attempt = 0; attempt < 10 && !record?.result; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
      const records = run?.sessionId && this.workflowRecords ? await this.workflowRecords(run.sessionId).catch(() => []) : [];
      record = (live?.taskId ? records.find((r) => r.taskId === live.taskId) : undefined) ?? records[0] ?? null;
      if (live?.status !== 'completed') break; // nothing more is coming
    }
    if (orch.status !== 'running') return;
    if (orch.workflow && record?.id.startsWith('wf_')) orch.workflow.workflowRunId = record.id;
    const compiled = readCompiledResult(record?.result);

    for (const task of orch.tasks) {
      if (task.status !== 'pending' && task.status !== 'running' && !(compiled && task.status === 'completed')) continue;
      const result = compiled?.results[task.id];
      if (typeof result === 'string') {
        task.status = 'completed';
        task.result = result;
        task.error = null;
      } else if (compiled?.skipped.includes(task.id)) {
        task.status = 'skipped';
        task.error = 'a dependency did not complete';
      } else if (task.status !== 'completed') {
        task.status = 'failed';
        task.error = compiled
          ? 'the agent returned nothing'
          : `the workflow did not finish: ${live?.summary ?? run?.error ?? run?.lastText ?? record?.status ?? 'no result'}`;
      }
      task.endedAt ??= now();
    }
    if (compiled?.synthesis) orch.finalResult = compiled.synthesis;
    orch.costUsd = run?.costUsd ?? orch.costUsd;
    orch.status = orch.tasks.every((t) => t.status === 'completed') ? 'completed' : 'failed';
    orch.endedAt = now();
    this.persist();
  }

  /** The script a workflow graph runs, as generated from it. */
  workflowScript(id: string): { path: string; script: string } {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    const path = this.scriptPath(orch);
    // A graph edited or never launched as a workflow still has one: the graph compiles either way
    return { path, script: existsSync(path) ? readFileSync(path, 'utf8') : this.compile(orch) };
  }

  /** Keeps the graph as a workflow of the project, which the CLI can run by name from then on. */
  saveWorkflow(id: string, req: SaveOrchestrationWorkflowRequest = {}): WorkflowDefinition {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    const name = req.name?.trim() || workflowName(orch.name);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('name must be lower case letters, digits and dashes');
    const dir = join(orch.cwd, '.claude', 'workflows');
    const path = join(dir, `${name}.js`);
    if (existsSync(path) && !req.overwrite) throw new Error(`a workflow named ${name} already exists in ${dir}`);
    const script = this.workflowScript(id).script.replace(/(\bname:\s*)("[^"]*")/, `$1${JSON.stringify(name)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, script);
    return { name, description: orch.objective ?? orch.name, scope: 'project', path };
  }

  /** Plans and waits, for callers that want the draft in one call. */
  async plan(req: PlanRequest): Promise<OrchestrationSpec> {
    const run = this.startPlan(req);
    return this.draftFrom(run.id);
  }
}
