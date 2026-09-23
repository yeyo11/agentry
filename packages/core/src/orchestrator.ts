import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type {
  ChatActivity,
  Health,
  LaunchOrchestrationTemplateRequest,
  Orchestration,
  OrchestrationEngine,
  OrchestrationIntegration,
  OrchestrationSpec,
  OrchestrationTaskSpec,
  OrchestrationTaskState,
  OrchestrationTemplate,
  PermissionMode,
  PlanDraftSummary,
  PlanRequest,
  RelaunchOrchestrationRequest,
  ResumeOrchestrationRequest,
  SaveOrchestrationTemplateRequest,
  SaveOrchestrationWorkflowRequest,
  VerificationCommand,
  VerificationSpec,
  VerificationState,
  VerifyOrchestrationRequest,
  WorkflowDefinition,
} from '@agentry/shared';
import { MODEL_RE, PERMISSION_MODES } from '@agentry/shared';
import type { WorkflowRun } from './cli-facts.ts';
import type { Db } from './db.ts';
import { OrchestrationEventTracker } from './event-sources.ts';
import type { EventBus } from './events.ts';
import { OrchestrationTemplates } from './orchestration-templates.ts';
import {
  abortMerge,
  addWorktree,
  branchExists,
  commitAll,
  conflictedPaths,
  contains,
  deleteBranch,
  git,
  headCommit,
  isGitRepo,
  isIgnored,
  lockWorktree,
  merge,
  mergeInProgress,
  removeWorktree,
  mainTopLevel,
  topLevel,
} from './git.ts';
import type { CoreConfig } from './paths.ts';
import type { ChatManager, ChatRuntime, RunResult } from './chats.ts';
import { effectiveLimits, elapsedMs, normalizeLimits, pastHardLimit, pastSoftLimit, remainingUsd, spentUsd, startClock, timeWarning } from './task-limits.ts';
import type { TaskContext } from './health-service.ts';
import {
  commitsSince,
  fixerPrompt,
  installStep,
  normalizeVerification,
  runCommand,
  tail,
  workerChecks,
  DEFAULT_VERIFY_MINUTES,
  type CommandHandle,
  type InstallStep,
} from './verification.ts';
import { compileWorkflow, readCompiledResult, workflowName } from './workflow-engine.ts';

const ID_RE = /^[\w-]{1,40}$/;
/** The planner's own name, which is how a past planner run is recognised later. */
export const PLANNER_RUN_NAME = 'orchestration-planner';
// The objective is read back out of the prompt when recovering a draft, so both halves are built
// from these constants: they cannot drift apart.
const PROMPT_HEAD = 'Plan a multi-agent orchestration for this objective:\n\n';
const PROMPT_TAIL = '\n\nSplit it into at most ';
const MAX_DEP_CONTEXT = 6000;
const DEFAULT_ATTEMPTS = 2;
const MAX_ATTEMPTS = 10;
const MAX_ERROR_QUOTE = 2000;
/** How often running tasks are checked against their time limit; the limits are in minutes */
const LIMITS_CHECK_MS = Number(process.env.AGENTRY_LIMITS_INTERVAL_MS ?? 10_000);
const now = () => new Date().toISOString();

const pendingCommand = (command: string): VerificationCommand => ({ command, status: 'pending', output: '', durationMs: 0 });
const usd = (n: number) => `$${n.toFixed(2)}`;

/** What a stop reaches while a graph's checks are running. */
interface VerificationControl {
  cancelled: boolean;
  command: CommandHandle | null;
  fixerRunId: string | null;
}

/** Whether a finished graph has a task that did not get done: failed, stopped, or none completed at all. */
const tasksUndone = (orch: Orchestration): boolean =>
  orch.tasks.some((t) => t.status === 'failed' || t.status === 'stopped') || !orch.tasks.some((t) => t.status === 'completed');

/** Why the graph fails by its checks, when it was launched with `failGraph` and they failed; null otherwise. */
function checksFailGraph(orch: Orchestration): string | null {
  if (!orch.verificationSpec?.failGraph || orch.verification?.status !== 'failed') return null;
  return `The checks on the merged branch failed: ${orch.verification.report}`;
}

const attemptsOf = (requested: number | undefined) =>
  Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested as number), 1), MAX_ATTEMPTS) : DEFAULT_ATTEMPTS;

/** Unique per orchestration: two graphs sharing a task id would otherwise collide on one worktree. */
function worktreeName(orch: Orchestration, task: OrchestrationTaskState): string {
  return `${orch.id.slice(0, 8)}-${task.id}`.slice(0, 60);
}

/**
 * Where the CLI keeps the worktree of that name, so a pre-created one is the one it picks up. It
 * resolves them from the repository's top level, not from the directory it is started in.
 */
const worktreePath = (root: string, name: string) => join(root, '.claude', 'worktrees', name);

/**
 * A graph's repository: the top level of the checkout it runs in, the subdirectory of it the graph
 * works in ('' for the top), and where task worktrees live. The last is the main checkout's top
 * level even when the graph runs from a linked worktree, because that is where the CLI looks.
 */
interface Checkout {
  root: string;
  subdir: string;
  home: string;
}

function checkoutOf(cwd: string): Checkout {
  const root = topLevel(cwd);
  // git answers with the real path, so a symlinked cwd would otherwise look like it is outside
  const subdir = relative(root, realpathSync(cwd));
  // An ignored directory is missing from a fresh worktree, and whatever a worker writes there never
  // reaches its branch: in one of those, working at the top is the only way the work survives.
  return { root, subdir: subdir && !isIgnored(root, subdir) ? subdir : '', home: mainTopLevel(cwd) };
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
 * `model` and `permissionMode` are never read here: they are handed to `claude` as flags. A value
 * the CLI does not know would first show itself as a worker dying in the middle of a graph, so the
 * spec is held to the same list the chat routes hold a chat to.
 */
export function validateModel(model: string | null | undefined, what = 'model'): void {
  if (model === undefined || model === null) return;
  if (typeof model !== 'string' || !MODEL_RE.test(model)) throw new Error(`${what} must be a model alias or id, such as haiku`);
}

export function validatePermissionMode(mode: PermissionMode | undefined): void {
  if (mode === undefined) return;
  if (!PERMISSION_MODES.includes(mode)) throw new Error(`permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
}

/** The settings of a whole spec, the per-task models included: every one of them becomes a flag. */
export function validateSpecSettings(spec: Pick<OrchestrationSpec, 'model' | 'permissionMode' | 'tasks'>): void {
  validateModel(spec.model);
  validatePermissionMode(spec.permissionMode);
  for (const task of spec.tasks ?? []) validateModel(task.model, `task '${task.id}' model`);
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
  /** Graphs a task result reached after their integration had started, which integrate again */
  private readonly lateArrivals = new Set<string>();
  /** Tasks between the decision to run their chat again and the process that does: they take no hint yet */
  private readonly relaunching = new Set<string>();
  /** Reads a running task's health; set by Core, which owns what health is read from */
  health: ((task: OrchestrationTaskState) => Health | null) | null = null;
  /** Tasks whose worker was told it is nearly out of time, by the clock it was told on, so a retry is warned again */
  private readonly warned = new Set<string>();
  private limitsTimer: NodeJS.Timeout | null = null;
  /** Graphs whose checks are running: what a stop has to reach, and what other decisions wait for */
  private readonly verifying = new Map<string, VerificationControl>();
  /** Graphs saved to be launched again on another objective */
  readonly templates: OrchestrationTemplates;

  constructor(
    private readonly config: CoreConfig,
    private readonly runs: ChatManager,
    private readonly db: Db,
  ) {
    this.file = join(config.dataDir, 'orchestrations.json');
    this.templates = new OrchestrationTemplates(join(config.dataDir, 'orchestration-templates.json'), (spec) => validateTasks(spec.tasks ?? []));
    this.load();
    this.tracker.baseline(this.list());
    this.runs.on('chat-result', (runId: string, result: RunResult) => this.follow(runId, result));
    this.limitsTimer = setInterval(() => this.enforceLimits(), LIMITS_CHECK_MS);
    this.limitsTimer.unref();
  }

  /** Stops the clock that enforces time limits; a process about to exit has no use for it. */
  close(): void {
    if (this.limitsTimer) clearInterval(this.limitsTimer);
    this.limitsTimer = null;
  }

  private load(): void {
    this.importLegacy();
    for (const o of this.db.loadOrchestrations()) {
      // Records written before a field existed come back without it; normalise on the way in so
      // the rest of the code never has to ask whether an orchestration is old.
      o.worktree ??= false;
      o.maxAttempts ??= DEFAULT_ATTEMPTS;
      for (const t of o.tasks) t.attempts ??= t.runId ? 1 : 0;
      o.allowedTools ??= [];
      o.permissionPrompts ??= 'none';
      o.integration ??= null;
      o.synthesisRunId ??= null;
      o.engine ??= 'graph';
      o.engineReason ??= null;
      o.workflow ??= null;
      if (o.verification) o.verification.costUsd ??= 0;
      if (o.verification && (o.verification.status === 'running' || o.verification.status === 'pending')) {
        o.verification.status = 'failed';
        o.verification.report = 'Interrupted by a wrapper restart before the checks finished; verify again to run them.';
        for (const c of o.verification.commands) if (c.status === 'running' || c.status === 'pending') c.status = 'pending';
      }
      if (o.integration && ['merging', 'resolving'].includes(o.integration.status)) {
        o.integration.status = 'failed';
        o.integration.error = 'interrupted by a restart; integrate again to finish it';
      }
      if (o.status === 'running') this.interrupt(o);
      this.items.set(o.id, o);
    }
  }

  /**
   * Workers do not survive a wrapper restart, but a restart is not a decision to stop: what was
   * running is `interrupted`, at the moment its chat was last heard from and not when the wrapper
   * came back, and `stopped` stays for what a person stopped. A graph with work left stays running,
   * and `recover()` continues it once the chats are back; one that had already finished its tasks
   * (it was integrating or synthesising) and a workflow, which is one session the CLI replays from
   * its cache, wait for `resume()`.
   */
  private interrupt(orch: Orchestration): void {
    let lastHeard = '';
    for (const task of orch.tasks) {
      if (task.status !== 'running') continue;
      task.status = 'interrupted';
      task.endedAt = (task.runId ? this.db.chatUpdatedAt(task.runId) : null) ?? task.startedAt ?? now();
      if (task.endedAt > lastHeard) lastHeard = task.endedAt;
    }
    const goesOn = orch.engine === 'graph' && !orch.endedAt && orch.tasks.some((t) => t.status === 'pending' || t.status === 'interrupted');
    if (goesOn) return;
    orch.status = 'stopped';
    orch.endedAt ??= lastHeard || (orch.workflow?.runId ? this.db.chatUpdatedAt(orch.workflow.runId) : null) || now();
  }

  /**
   * Puts back to work the graphs a restart cut off. The chats their tasks were working in are
   * restored asynchronously, so this waits for them: a task whose chat is not there yet would start
   * a new conversation instead of continuing its own.
   */
  recover(): void {
    for (const orch of this.items.values()) if (orch.status === 'running' && orch.engine === 'graph') this.schedule(orch);
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

  /**
   * The orchestration as a client reads it: each running task carries its health and what its
   * worker is doing right now, both facts of this moment and so worked out when it is read, never
   * stored. A copy, so nothing that is persisted grows a field that only means something for a moment.
   */
  view(orch: Orchestration): Orchestration {
    const read = this.health;
    const now = new Map<string, { health: Health | null; activity: ChatActivity | null }>();
    for (const task of orch.tasks) {
      if (task.status !== 'running' || !task.runId) continue;
      now.set(task.id, { health: read ? read(task) : null, activity: this.runs.get(task.runId)?.activity ?? null });
    }
    // Nothing of this moment to say: the stored graph is already the answer, copies and all
    if ([...now.values()].every((of) => !of.health && !of.activity)) return orch;
    return { ...orch, tasks: orch.tasks.map((t) => (now.has(t.id) ? { ...t, ...now.get(t.id) } : t)) };
  }

  /** The graph and task a chat works for, with the limits that apply to it; null for a chat that is not a running task. */
  taskContext(chatId: string, nowMs = Date.now()): TaskContext | null {
    for (const orch of this.items.values()) {
      const task = orch.tasks.find((t) => t.runId === chatId);
      if (!task || task.status !== 'running') continue;
      return { orchestrationId: orch.id, taskId: task.id, taskName: task.name, limits: effectiveLimits(orch.limits, task.limits), elapsedMs: elapsedMs(task, nowMs), spentUsd: spentUsd(task) };
    }
    return null;
  }

  /**
   * Holds running tasks to their time limit. Past most of it the worker is told to wrap up, once;
   * past all of it the task is stopped and fails with the reason, so a person decides what happens
   * to what it did. The clock is a parameter because a limit is a fact of it.
   */
  enforceLimits(nowMs = Date.now()): void {
    let changed = false;
    for (const orch of this.items.values()) {
      if (orch.status !== 'running' || orch.engine !== 'graph') continue;
      for (const task of orch.tasks) {
        if (task.status !== 'running' || !task.runId) continue;
        const limits = effectiveLimits(orch.limits, task.limits);
        if (limits?.maxMinutes === undefined) continue;
        const elapsed = elapsedMs(task, nowMs);
        if (pastHardLimit(elapsed, limits)) {
          const runId = task.runId;
          task.status = 'failed';
          task.error = `stopped at its time limit of ${String(limits.maxMinutes)} min`;
          task.endedAt = now();
          this.runs.notice(runId, `Agentry stopped this task at its time limit of ${String(limits.maxMinutes)} min.`);
          if (this.runs.get(runId)?.pid) this.runs.stop(runId);
          this.schedule(orch);
          changed = true;
        } else if (pastSoftLimit(elapsed, limits)) {
          const key = `${orch.id}:${task.id}:${task.clockStartedAt ?? task.startedAt ?? ''}`;
          if (this.warned.has(key) || !this.runs.get(task.runId)?.pid || this.relaunching.has(`${orch.id}:${task.id}`)) continue;
          this.warned.add(key);
          try {
            this.runs.send(task.runId, `A note from Agentry:\n\n${timeWarning(elapsed, limits)}`);
          } catch {
            // the worker is between two processes: the health signal still tells the person
          }
        }
      }
    }
    if (changed) this.persist();
  }

  runningCount(): number {
    return this.list().filter((o) => o.status === 'running').length;
  }

  create(spec: OrchestrationSpec, origin: { relaunchedFrom?: string; templateId?: string } = {}): Orchestration {
    validateTasks(spec.tasks);
    validateSpecSettings(spec);
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
    const limits = normalizeLimits(spec.limits, 'limits');
    const taskLimits = spec.tasks.map((t) => normalizeLimits(t.limits, `task '${t.id}' limits`));
    // A workflow runs every task as a subagent of one session: there is no worker of its own to stop
    // at a time or to hold to a budget, and a limit that is silently not kept is worse than none
    if (engine === 'workflow' && (limits || taskLimits.some(Boolean))) {
      throw new Error('limits apply to the graph engine, where each task is a worker of its own; a workflow runs its tasks inside one session');
    }
    const verification = normalizeVerification(spec.verification);
    // The checks run on the integration branch, which only a graph with a worktree per task has
    if (verification && (engine === 'workflow' || spec.worktree !== true)) {
      throw new Error('verification runs on the integration branch, which needs the graph engine with a worktree per task');
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
      maxAttempts: attemptsOf(spec.maxAttempts),
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
      limits: limits ?? null,
      verificationSpec: verification,
      verification: null,
      relaunchedFrom: origin.relaunchedFrom ?? null,
      templateId: origin.templateId ?? null,
      tasks: spec.tasks.map<OrchestrationTaskState>((t, i) => ({
        ...(taskLimits[i] ? { limits: taskLimits[i] } : {}),
        id: t.id,
        name: t.name?.trim() || t.id,
        prompt: t.prompt,
        dependsOn: t.dependsOn ?? [],
        cwd: t.cwd,
        model: t.model,
        status: 'pending',
        attempts: 0,
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
    // Checks started by hand run on a graph that is already over, and stopping it has to reach them
    this.cancelChecks(orch.id);
    if (orch.status !== 'running' && orch.status !== 'waiting') return orch;
    orch.status = 'stopped';
    orch.endedAt = now();
    // One process runs every task of a workflow
    if (orch.workflow?.runId && this.runs.get(orch.workflow.runId)?.pid) this.runs.stop(orch.workflow.runId);
    for (const t of orch.tasks) {
      if (t.status === 'running' && t.runId && orch.engine !== 'workflow') this.runs.stop(t.runId);
      if (t.status === 'pending' || t.status === 'running' || t.status === 'blocked' || t.status === 'interrupted') t.status = 'stopped';
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
   * dependants still receive their context. Everything else — stopped, failed, blocked or given up —
   * goes back to pending and is attempted again: a task that already has a chat continues it, in a
   * new execution, in the worktree it left, and keeps what it cost.
   */
  resume(id: string, changes: ResumeOrchestrationRequest = {}): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    if (orch.status === 'running') return orch;
    // Before anything of the graph is touched, so a mode the CLI would refuse leaves it as it was
    validatePermissionMode(changes.permissionMode);
    if (orch.status === 'waiting') throw new Error('the orchestration is waiting for a decision on its tasks: retry or skip them instead');
    if (this.verifying.has(orch.id)) throw new Error('the checks are running on the integration branch: stop the orchestration first');
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
    // Chats that worked in the shared checkout cannot move into a worktree: those tasks start over
    const isolating = changes.worktree === true && !orch.worktree;
    if (changes.worktree !== undefined) orch.worktree = changes.worktree;
    if (orch.worktree) orch.baseCommit ??= base ?? baseOf(orch.cwd);
    if (changes.permissionPrompts !== undefined) orch.permissionPrompts = changes.permissionPrompts === 'host' ? 'host' : 'none';
    if (changes.allowedTools !== undefined) orch.allowedTools = changes.allowedTools.map(String).filter(Boolean);
    if (changes.permissionMode !== undefined) orch.permissionMode = changes.permissionMode;
    for (const task of unfinished) {
      task.status = 'pending';
      task.result = null;
      task.startedAt = null;
      task.endedAt = null;
      if (isolating && orch.engine === 'graph') Object.assign(task, { runId: null, sessionId: null, attempts: 0, costUsd: 0 });
      // What failed is what the chat is told when it goes on; a task that never ran has nothing to say
      if (!task.runId || orch.engine === 'workflow') task.error = null;
    }
    orch.status = 'running';
    orch.endedAt = null;
    orch.finalResult = null;
    orch.synthesisRunId = null;
    // Integrated again once the resumed tasks finish. The branch name is derived from the graph, so
    // that reuses the same branch, which already holds the earlier merges.
    orch.integration = null;
    orch.verification = null;
    if (orch.error) orch.error = null;
    // A workflow picks up in its own session, where the CLI replays the agents that already finished
    // from its cache instead of running them again
    if (orch.engine === 'workflow') this.launchWorkflow(orch, orch.workflow?.workflowRunId ?? null);
    else this.schedule(orch); // persists
    return orch;
  }

  // ---------- relaunching and templates ----------

  /**
   * The spec that would launch this graph as it is: what a relaunch starts from and what a template
   * saves. Read back from the orchestration, so it carries the settings the graph actually ran with,
   * including corrections made when it was resumed.
   */
  specOf(id: string): OrchestrationSpec {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    return {
      name: orch.name,
      ...(orch.objective ? { objective: orch.objective } : {}),
      engine: orch.engine ?? 'graph',
      ...(orch.engineReason ? { engineReason: orch.engineReason } : {}),
      cwd: orch.cwd,
      ...(orch.model ? { model: orch.model } : {}),
      permissionMode: orch.permissionMode,
      concurrency: orch.concurrency,
      synthesize: orch.synthesize,
      worktree: orch.worktree,
      maxAttempts: orch.maxAttempts,
      allowedTools: [...(orch.allowedTools ?? [])],
      permissionPrompts: orch.permissionPrompts,
      ...(orch.limits ? { limits: orch.limits } : {}),
      ...(orch.verificationSpec ? { verification: orch.verificationSpec } : {}),
      tasks: orch.tasks.map<OrchestrationTaskSpec>((t) => ({
        id: t.id,
        name: t.name,
        prompt: t.prompt,
        ...(t.dependsOn?.length ? { dependsOn: [...t.dependsOn] } : {}),
        ...(t.cwd ? { cwd: t.cwd } : {}),
        ...(t.model ? { model: t.model } : {}),
        ...(t.limits ? { limits: t.limits } : {}),
      })),
    };
  }

  /**
   * Runs a graph that is no longer running again, with corrections, as a new orchestration that
   * records where it came from. It starts from nothing: new chats, new worktrees, its own branch. What
   * the first one produced stays exactly as it was, which is what makes "try it with a better prompt"
   * safe to do on a graph whose result someone may still want.
   */
  relaunch(id: string, changes: RelaunchOrchestrationRequest = {}): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    if (orch.status === 'running') throw new Error('the orchestration is still running: stop it first, or wait for it to finish');
    const original = this.specOf(id);
    const { tasks: replaced, ...overrides } = changes.spec ?? {};
    const spec: OrchestrationSpec = {
      ...original,
      ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
      tasks: changes.tasks ?? replaced ?? original.tasks,
    };
    return this.create(spec, { relaunchedFrom: orch.id });
  }

  /** Saves a graph as a template, from a spec (a draft plan) or from an orchestration's own. */
  saveTemplate(req: SaveOrchestrationTemplateRequest): OrchestrationTemplate {
    if (req.spec && req.fromOrchestration) throw new Error('give the graph as a spec or as an orchestration to take it from, not both');
    const spec = req.fromOrchestration ? this.specOf(req.fromOrchestration) : req.spec;
    if (!spec) throw new Error('spec or fromOrchestration is required');
    return this.templates.save(req.name, spec, req.description);
  }

  /** Launches a template on a new objective and directory; what is given here is for this run only. */
  launchTemplate(id: string, req: LaunchOrchestrationTemplateRequest = {}): Orchestration {
    const template = this.templates.get(id);
    if (!template) throw new Error('template not found');
    const spec: OrchestrationSpec = { ...template.spec };
    if (req.name?.trim()) spec.name = req.name.trim();
    if (req.objective !== undefined) spec.objective = req.objective;
    if (req.cwd) spec.cwd = req.cwd;
    if (req.model) spec.model = req.model;
    return this.create(spec, { templateId: template.id });
  }

  /** What every worker is told first; shared by both engines, so a task reads the same either way. */
  private workerHead(orch: Orchestration): string {
    return orch.objective ? `You are one worker in a multi-agent orchestration.\nOverall objective: ${orch.objective}` : '';
  }

  private workerTask(orch: Orchestration, task: OrchestrationTaskState): string {
    // Said here, and not left to the objective: what each stage checks is Agentry's rule
    return `Your task (${task.name}):\n${task.prompt}\n\n${workerChecks(!!orch.verificationSpec)}\n\nFinish with a concise report of what you did and found; it is handed to the next workers.`;
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
    parts.push(this.workerTask(orch, task));
    return parts.join('\n\n');
  }

  private schedule(orch: Orchestration): void {
    if (orch.status !== 'running') return;
    const byId = new Map(orch.tasks.map((t) => [t.id, t]));

    // A restart cut a task off: it goes on while it has attempts left, as a failure would. A stopped
    // one never comes here, because someone chose that.
    for (const t of orch.tasks) {
      if (t.status !== 'interrupted' || t.attempts < orch.maxAttempts) continue;
      t.status = 'failed';
      t.error = `interrupted by a restart, with no attempts left (${t.attempts} of ${orch.maxAttempts})`;
    }

    // What waits behind a task decides its own state, until nothing changes: a branch given up takes
    // its dependants with it, and one that failed for good holds them for a person to decide. A
    // task that stops being held (its blocker was retried, or completed late) goes back to pending.
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of orch.tasks) {
        if (t.status !== 'pending' && t.status !== 'blocked') continue;
        const deps = (t.dependsOn ?? []).map((d) => byId.get(d)?.status);
        const held = deps.some((s) => s === 'failed' || s === 'blocked' || s === 'stopped');
        if (deps.includes('skipped')) {
          t.status = 'skipped';
          t.error = 'a task it depends on was given up';
        } else if (t.status === 'pending' && held) {
          t.status = 'blocked';
          t.error = 'waiting for a decision on a task it depends on';
        } else if (t.status === 'blocked' && !held) {
          t.status = 'pending';
          t.error = null;
        } else continue;
        changed = true;
      }
    }

    let running = orch.tasks.filter((t) => t.status === 'running').length;
    for (const t of orch.tasks) {
      if (running >= orch.concurrency) break;
      if (t.status !== 'pending' && t.status !== 'interrupted') continue;
      if (!(t.dependsOn ?? []).every((d) => byId.get(d)?.status === 'completed')) continue;
      if (this.launch(orch, t)) running++;
      else break;
    }

    if (orch.tasks.every((t) => !['pending', 'running', 'interrupted'].includes(t.status))) {
      // A synthesis written over a graph that is missing a branch reads like the final report, so
      // nothing that summarises it runs until a person has decided about what failed
      if (orch.tasks.some((t) => t.status === 'failed' || t.status === 'blocked')) orch.status = 'waiting';
      else void this.finish(orch);
    }
    this.persist();
  }

  /**
   * Creates the task's worktree before the CLI runs, on a branch that already holds its
   * dependencies' work. Left to itself `claude --worktree` branches from HEAD, so a dependent task
   * started from nothing its dependencies had done and rebuilt it. The CLI adopts an existing
   * worktree of the name it is given, so it still locks it and records it as its own.
   */
  private prepareWorktree(orch: Orchestration, task: OrchestrationTaskState, name: string): PreparedWorktree {
    const { root, subdir, home } = checkoutOf(orch.cwd);
    const path = worktreePath(home, name);
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
      // A branch that is already there was cut by an earlier attempt, and its base is that one's
      const cutNow = !branchExists(root, branch);
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
      // What "changed by this task" is measured from: its dependencies' work is not its own
      if (cutNow) task.baseCommit = headCommit(path);
    }
    if (!prepared.adopt) {
      // A directory holding only untracked files in the checkout does not exist in the worktree
      mkdirSync(prepared.cwd, { recursive: true });
      lockWorktree(root, path, `agentry orchestration ${orch.id.slice(0, 8)}`);
    }
    return prepared;
  }

  private launch(orch: Orchestration, task: OrchestrationTaskState): boolean {
    // A task that has a chat goes on in it: a new execution, never a new conversation
    if (task.runId && this.runs.get(task.runId)) return this.continueChat(orch, task, task.runId);
    try {
      const isolated = orch.worktree && !task.cwd;
      const limits = effectiveLimits(orch.limits, task.limits);
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
          // The CLI ends the turn itself when this is spent
          ...(limits?.maxCostUsd !== undefined ? { maxBudgetUsd: limits.maxCostUsd } : {}),
        },
        { orchestrationId: orch.id, orchestrationTaskId: task.id },
      );
      task.status = 'running';
      task.runId = run.id;
      task.sessionId = run.id;
      task.attempts = 1;
      // The cost of a chat that is gone (its record deleted) stays in the graph's total, not here
      task.costUsd = 0;
      task.startedAt = now();
      startClock(task, task.startedAt);
      void this.runs.waitForResult(run.id).then((result) => this.settle(orch, task, result));
      return true;
    } catch (err) {
      return this.refuse(orch, task, err, 'start the worker');
    }
  }

  /**
   * Runs a task's chat again: a new execution of the same session, which keeps its worktree and
   * everything the previous execution did. What it is told comes from what happened to it (the
   * error, or the interruption), never from the objective.
   */
  private continueChat(orch: Orchestration, task: OrchestrationTaskState, chatId: string): boolean {
    const key = `${orch.id}:${task.id}`;
    try {
      if (orch.worktree && !task.cwd) this.prepareWorktree(orch, task, worktreeName(orch, task));
      const prompt = this.continuation(task);
      const limits = effectiveLimits(orch.limits, task.limits);
      // The CLI's ceiling is per process, so an attempt gets what the allowance has left, not all of it again
      const remaining = remainingUsd(limits, task);
      if (remaining !== null && remaining <= 0) {
        throw new Error(`its cost limit of $${(limits?.maxCostUsd ?? 0).toFixed(2)} is spent`);
      }
      task.status = 'running';
      task.attempts += 1;
      task.startedAt ??= now();
      if (!task.clockStartedAt) startClock(task, now());
      task.endedAt = null;
      this.relaunching.add(key);
      // The previous process may still be on its way out, and a chat has one process at most
      void this.runs.exited(chatId).then(() => {
        this.relaunching.delete(key);
        if (task.status !== 'running') return; // stopped meanwhile
        try {
          this.runs.resume(chatId, { prompt, ...(remaining !== null ? { maxBudgetUsd: remaining } : {}) });
          // The chat has answered before: only a result after this call is this attempt's
          void this.runs.nextResult(chatId).then((result) => this.settle(orch, task, result));
          task.error = null;
        } catch (err) {
          task.status = 'pending';
          task.attempts -= 1;
          this.refuse(orch, task, err, 'run the task again');
        }
        this.persist();
      });
      return true;
    } catch (err) {
      return this.refuse(orch, task, err, 'run the task again');
    }
  }

  /**
   * What a failed launch does. The global run limit is the one transient failure: the task stays
   * pending and is tried again shortly. Everything else used to be swallowed and retried for ever,
   * which left a graph reporting itself as running with nothing running and no way to find out why;
   * it fails visibly, and a person decides.
   */
  private refuse(orch: Orchestration, task: OrchestrationTaskState, err: unknown, doing: string): false {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Concurrent run limit')) {
      setTimeout(() => this.schedule(orch), 3000).unref();
      return false;
    }
    task.status = 'failed';
    task.error = `could not ${doing}: ${message}`;
    task.endedAt = now();
    setTimeout(() => this.schedule(orch), 0).unref();
    return false;
  }

  /** What a chat is told when its task goes on after an execution that did not finish it. */
  private continuation(task: OrchestrationTaskState): string {
    const closing = 'Finish with a concise report of what you did and found; it is handed to the next workers.';
    if (!task.error) {
      return (
        'This orchestration was interrupted before you finished your task. Everything you did is still in place, in the same ' +
        `working directory. Check where you stopped and carry on from there instead of starting over. ${closing}`
      );
    }
    const quoted = task.error.length > MAX_ERROR_QUOTE ? `${task.error.slice(0, MAX_ERROR_QUOTE)}…` : task.error;
    return (
      `Your previous attempt at this task ended with an error:

${quoted}

` +
      'Everything you did is still in place, in the same working directory. Work out what went wrong, fix it, and carry on from ' +
      `where you stopped instead of starting over. ${closing}`
    );
  }

  /**
   * Takes what an execution of a task produced. A failure is tried again, in the same chat, until
   * the task has used its attempts; what a retry cannot mend (a budget that ran out, a task stopped
   * on purpose, a rate limit that account rotation handles) is not tried again at all.
   */
  private settle(orch: Orchestration, task: OrchestrationTaskState, result: RunResult): void {
    if (task.status !== 'running') return; // stopped meanwhile
    if (result.isError && !result.cause && task.attempts < orch.maxAttempts && task.runId) {
      this.charge(orch, task, result);
      task.error = result.result;
      this.continueChat(orch, task, task.runId);
      return this.persist();
    }
    this.record(orch, task, result);
    this.schedule(orch);
  }

  /** The chat's total, so the graph adds only what this execution cost on top of what it already counted. */
  private charge(orch: Orchestration, task: OrchestrationTaskState, result: RunResult): void {
    orch.costUsd += result.costUsd - task.costUsd;
    task.costUsd = result.costUsd;
  }

  /**
   * Puts a result of the task's chat on the task. The first one decides how the task ended; a later
   * one comes from someone continuing the chat by hand, and is the task's work all the same.
   */
  private record(orch: Orchestration, task: OrchestrationTaskState, result: RunResult): void {
    // A turn that fails after the work was delivered does not take the delivery back
    if (!result.isError || task.status !== 'completed') {
      task.status = result.isError ? 'failed' : 'completed';
      task.result = result.isError ? null : result.result;
      task.error = result.isError ? result.result : null;
    }
    this.charge(orch, task, result);
    task.endedAt = now();
    if (!result.isError) this.commitTask(orch, task);
  }

  /**
   * Keeps a task on its chat for as long as the chat lives. A stopped worker ends its task failed,
   * but it can be continued by hand, finish the work and commit it on the task's branch; a graph
   * that only heard the first result left that work out of its status, its cost and its branch.
   */
  private follow(chatId: string, result: RunResult): void {
    const orch = [...this.items.values()].find((o) => o.engine === 'graph' && o.tasks.some((t) => t.runId === chatId));
    const task = orch?.tasks.find((t) => t.runId === chatId);
    // The result of a running task is settle's to record
    if (!orch || !task || task.status === 'running') return;
    // A branch given up stays given up, whatever the chat does; only its cost is still owed
    if (task.status === 'skipped') {
      this.charge(orch, task, result);
      return this.persist();
    }
    // Waiting for a turn, or behind a task that failed: the chat is not producing this task's work
    if (task.status === 'pending' || task.status === 'blocked') return;
    this.record(orch, task, result);
    if (orch.status === 'running' && !orch.endedAt) return this.schedule(orch);
    if (orch.status === 'waiting') {
      // Work delivered by hand while a person had yet to decide: what waited behind it goes on
      if (task.status === 'completed') {
        orch.status = 'running';
        return this.schedule(orch);
      }
    } else if (orch.status === 'running') {
      // Finishing: the integration may already have passed this task by, so it runs again after
      this.lateArrivals.add(orch.id);
    } else {
      // Someone who stopped the graph is told so until nothing is left undone
      orch.status = orch.tasks.every((t) => t.status === 'completed') ? 'completed' : orch.status === 'stopped' ? 'stopped' : 'failed';
      orch.endedAt = now();
      if (orch.worktree && (orch.integration || orch.status === 'completed')) this.integrateLate(orch);
    }
    this.persist();
  }

  /** Integrates a finished graph again for work that arrived late, after any integration in flight. */
  private integrateLate(orch: Orchestration): void {
    if (orch.integration && ['merging', 'resolving'].includes(orch.integration.status)) this.lateArrivals.add(orch.id);
    else {
      // A graph still running checks its branch itself when it finishes
      void this.integrate(orch).then(() => (orch.status === 'running' ? undefined : this.runChecks(orch)));
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
    let home: string;
    try {
      ({ root, home } = checkoutOf(orch.cwd));
    } catch {
      root = home = orch.cwd; // no longer a repository: adding the worktree below says so on the record
    }
    const path = worktreePath(home, `${orch.id.slice(0, 8)}-integration`);
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
    // While the graph is finishing, finish() integrates again itself once it is done
    if (orch.status !== 'running' && this.lateArrivals.delete(orch.id)) await this.integrate(orch);
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
    orch.endedAt = now(); // guards against re-entry while integration and synthesis run

    if (orch.worktree) await this.integrate(orch);
    if (orch.status !== 'running') return; // stopped meanwhile
    await this.runChecks(orch);
    if (orch.status !== 'running') return;
    if (orch.synthesize && orch.tasks.some((t) => t.status === 'completed')) await this.synthesize(orch);
    // Read at the end: a task continued by hand can fail or complete while the graph is finishing. A
    // branch given up is a decision, not a failure, so the graph finishes without it.
    if (orch.status === 'running') {
      const byChecks = checksFailGraph(orch);
      orch.status = tasksUndone(orch) || byChecks ? 'failed' : 'completed';
      if (byChecks) orch.error = byChecks;
    }
    orch.endedAt = now();
    this.persist();
    if (this.lateArrivals.delete(orch.id) && orch.worktree) this.integrateLate(orch);
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
            (orch.verification && orch.verification.status !== 'pending'
              ? `Verification of the merged branch: ${orch.verification.status}. ${orch.verification.report}\n\n`
              : '') +
            (orch.tasks.some((t) => t.status === 'skipped')
              ? 'Tasks marked skipped were given up on purpose by a person: say what is missing because of them.\n\n'
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

  // ---------- verification ----------

  /**
   * Runs the checks of a graph that is over on its integration branch, or runs them again: after a
   * fix made by hand, or on a graph launched without any. Returns at once, with the checks running;
   * their outcome lands on the orchestration.
   */
  verify(id: string, req: VerifyOrchestrationRequest = {}): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    if (orch.status === 'running' || orch.status === 'waiting') throw new Error('the checks run when the graph finishes: wait for it, or stop it first');
    if (orch.engine !== 'graph' || !orch.worktree) throw new Error('verification runs on the integration branch, which needs the graph engine with a worktree per task');
    if (this.verifying.has(orch.id)) throw new Error('the checks are already running');
    if (orch.integration?.status !== 'merged') throw new Error('the orchestration has no integrated branch yet');
    const spec = req.verification !== undefined ? normalizeVerification(req.verification) : (orch.verificationSpec ?? null);
    if (!spec) throw new Error('there are no checks to run: give them as verification');
    orch.verificationSpec = spec;
    // Asked for by hand, so they run even where they passed before
    orch.verification = null;
    void this.runChecks(orch);
    return orch;
  }

  /** Stops the checks that are running, and the fixer if one is at work. */
  private cancelChecks(id: string): void {
    const control = this.verifying.get(id);
    if (!control) return;
    control.cancelled = true;
    control.command?.cancel();
    if (control.fixerRunId && this.runs.get(control.fixerRunId)) this.runs.stop(control.fixerRunId);
  }

  /**
   * The verification phase: the graph's checks, in order, on the integration branch, once every
   * task is merged. A failing check goes to a fixer agent if the graph asked for one, and every
   * check runs again from the first after a fix, because a fix for one can break another. What comes
   * out is recorded on `orch.verification` whatever happens; this never throws.
   */
  private async runChecks(orch: Orchestration): Promise<void> {
    await this.checkBranch(orch);
    this.settleByChecks(orch);
  }

  /**
   * What checks run again outside `finish()` (by hand, after a late integration) do to a graph
   * launched with `failGraph`: failing them fails a completed graph, and passing them gives back
   * the completion that only they had taken away. A running graph is `finish()`'s to decide.
   */
  private settleByChecks(orch: Orchestration): void {
    if (orch.status === 'running' || orch.status === 'waiting') return;
    const v = orch.verification;
    if (!v || v.status === 'running' || v.status === 'pending') return;
    const byChecks = checksFailGraph(orch);
    if (byChecks && (orch.status === 'completed' || orch.error)) {
      orch.status = 'failed';
      orch.error = byChecks;
    } else if (!byChecks && orch.error) {
      orch.error = null;
      if (orch.status === 'failed' && !tasksUndone(orch)) orch.status = 'completed';
    }
    this.persist();
  }

  private async checkBranch(orch: Orchestration): Promise<void> {
    const spec = orch.verificationSpec;
    if (!spec || orch.engine !== 'graph' || this.verifying.has(orch.id)) return;
    const integration = orch.integration;
    const before = orch.verification;
    if (!integration || integration.status !== 'merged' || !integration.worktree || !existsSync(integration.worktree)) {
      const why = integration ? `the work was not merged into ${integration.branch} (${integration.error ?? integration.status})` : 'no task left work to merge';
      orch.verification = {
        status: 'failed',
        attempts: 0,
        // Only a given install is known here: detecting one needs the worktree that is not there
        commands: [...(typeof spec.install === 'string' ? [{ ...pendingCommand(spec.install), install: true }] : []), ...spec.commands.map(pendingCommand)],
        commits: [],
        commit: null,
        report: `Not run: ${why}.`,
        costUsd: 0,
      };
      this.persist();
      return;
    }
    // What passed on this very head does not need to run again
    if (before && (before.status === 'passed' || before.status === 'fixed') && before.commit === integration.commit) return;

    const root = integration.worktree;
    const control: VerificationControl = { cancelled: false, command: null, fixerRunId: null };
    this.verifying.set(orch.id, control);
    const startHead = headCommit(root);
    const install = installStep(spec, root, this.integratedDir(orch, root));
    const state: VerificationState = (orch.verification = {
      status: 'running',
      attempts: 0,
      commands: [...(install ? [{ ...pendingCommand(install.command), install: true }] : []), ...spec.commands.map(pendingCommand)],
      commits: [],
      commit: startHead,
      report: '',
      costUsd: 0,
    });
    this.persist();
    try {
      await this.checkAll(orch, spec, state, root, startHead, install, control);
    } catch (err) {
      state.status = 'failed';
      state.report = `The checks could not run: ${(err as Error).message}`;
    } finally {
      this.verifying.delete(orch.id);
    }
    try {
      state.commit = headCommit(root);
      // What the fixer committed is part of the branch now
      integration.commit = state.commit;
    } catch {
      // the worktree is gone; the outcome stands without a commit
    }
    this.persist();
  }

  private async checkAll(
    orch: Orchestration,
    spec: VerificationSpec,
    state: VerificationState,
    root: string,
    startHead: string,
    install: InstallStep | null,
    control: VerificationControl,
  ): Promise<void> {
    const minutes = spec.timeoutMinutes ?? DEFAULT_VERIFY_MINUTES;
    const dir = this.integratedDir(orch, root);
    const spent = state.commands.map(() => 0);
    const said = state.commands.map<string[]>(() => []);
    const mended = new Set<number>();
    const conclude = (status: 'passed' | 'fixed' | 'failed', headline: string) => {
      state.status = status;
      const left = state.commands.filter((c) => c.status === 'pending').map((c) => c.command);
      state.report = [headline, left.length ? `Not run: ${left.map((c) => `\`${c}\``).join(', ')}.` : ''].filter(Boolean).join(' ');
    };

    let i = 0;
    while (i < state.commands.length) {
      const entry = state.commands[i] as VerificationCommand;
      entry.status = 'running';
      this.persist();
      const outcome = await runCommand(entry.command, entry.install && install ? install.cwd : dir, minutes * 60_000, (handle) => {
        control.command = handle;
      });
      control.command = null;
      entry.output = outcome.output;
      entry.durationMs = outcome.durationMs;
      if (control.cancelled) {
        entry.status = 'failed';
        return conclude('failed', 'Stopped before the checks finished.');
      }
      if (outcome.ok) {
        entry.status = mended.has(i) ? 'fixed' : 'passed';
        i += 1;
        this.persist();
        continue;
      }

      entry.status = 'failed';
      const why = outcome.timedOut ? `timed out after ${String(minutes)} min and was killed` : `exited with code ${String(outcome.exitCode ?? 'unknown')}`;
      if (!spec.fixer) return conclude('failed', `\`${entry.command}\` ${why}. The fixer is off, so nothing was changed.`);
      if ((spent[i] ?? 0) >= spec.maxAttempts) {
        const last = said[i]?.at(-1);
        return conclude(
          'failed',
          `\`${entry.command}\` ${why} again after ${String(spent[i])} fixer attempt${spent[i] === 1 ? '' : 's'}, so Agentry stopped there.` +
            (last ? ` The last thing the fixer said: ${last}` : ''),
        );
      }
      // The CLI's ceiling is per process, so each attempt gets what the fixer has left, not all of it again
      const left = spec.maxCostUsd === undefined ? null : spec.maxCostUsd - state.costUsd;
      if (left !== null && left <= 0) {
        return conclude(
          'failed',
          `\`${entry.command}\` ${why}, and the fixer's cost limit of ${usd(spec.maxCostUsd ?? 0)} is spent (${usd(state.costUsd)} over ${String(state.attempts)} attempt${state.attempts === 1 ? '' : 's'}), so Agentry stopped there.`,
        );
      }
      spent[i] = (spent[i] ?? 0) + 1;
      state.attempts += 1;
      this.persist();
      const attempt = await this.fix(orch, spec, state, root, dir, i, why, said[i] ?? [], left, control);
      said[i]?.push(attempt.note);
      state.commits = commitsSince(root, startHead);
      if (control.cancelled) return conclude('failed', 'Stopped before the checks finished.');
      if (attempt.budget) {
        const made = state.commits.length;
        return conclude(
          'failed',
          `\`${entry.command}\` ${why}, and the fixer's cost limit of ${usd(spec.maxCostUsd ?? 0)} ran out during attempt ${String(state.attempts)} (${usd(state.costUsd)} spent), so Agentry stopped there without checking again.` +
            (made ? ` What the fixer committed is on the branch, unchecked: ${state.commits.map((c) => c.subject).join('; ')}.` : ''),
        );
      }
      mended.add(i);
      // A fix for one check can break another: they all run again, from the first
      for (const c of state.commands) c.status = 'pending';
      i = 0;
    }

    if (mended.size === 0) return conclude('passed', `All ${String(state.commands.length)} checks passed on the merged branch.`);
    const made = state.commits.length;
    conclude(
      'fixed',
      `${String(mended.size)} check${mended.size === 1 ? '' : 's'} failed and ${mended.size === 1 ? 'was' : 'were'} fixed in ${String(state.attempts)} attempt${state.attempts === 1 ? '' : 's'}, ` +
        (made ? `with ${String(made)} commit${made === 1 ? '' : 's'} on the branch: ${state.commits.map((c) => c.subject).join('; ')}. ` : 'without a commit: the re-run passed on its own. ') +
        `All ${String(state.commands.length)} checks pass now.`,
    );
  }

  /** One attempt of the fixer at one failing check: what it reported, trimmed, and whether its cost limit ended it. */
  private async fix(
    orch: Orchestration,
    spec: VerificationSpec,
    state: VerificationState,
    root: string,
    dir: string,
    index: number,
    failure: string,
    earlier: string[],
    budgetUsd: number | null,
    control: VerificationControl,
  ): Promise<{ note: string; budget: boolean }> {
    const entry = state.commands[index] as VerificationCommand;
    let note: string;
    let budget = false;
    try {
      const run = this.runs.start(
        {
          prompt: fixerPrompt({
            objective: orch.objective ?? orch.name,
            branch: orch.integration?.branch ?? '',
            worktree: root,
            command: entry.command,
            commands: state.commands.map((c) => c.command),
            failure: `It ${failure}.`,
            output: entry.output,
            attempt: earlier.length + 1,
            maxAttempts: spec.maxAttempts,
            earlier,
            tasks: orch.tasks
              .filter((t) => t.status === 'completed')
              .map((t) => ({ id: t.id, name: t.name, result: (t.result ?? '').slice(0, MAX_DEP_CONTEXT) })),
            timeoutMinutes: spec.timeoutMinutes ?? DEFAULT_VERIFY_MINUTES,
          }),
          cwd: dir,
          model: spec.model ?? orch.model ?? undefined,
          permissionMode: orch.permissionMode,
          // Building and running tests is the job, so it may run commands; the graph asked for a fixer
          allowedTools: [...new Set([...(orch.allowedTools ?? []), 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'])],
          ...(orch.permissionPrompts === 'host' ? { permissionPrompts: 'host' as const } : {}),
          name: `${orch.name}:verification`.slice(0, 60),
          keepAlive: false,
          // The CLI ends the turn itself when this is spent
          ...(budgetUsd !== null ? { maxBudgetUsd: budgetUsd } : {}),
        },
        { orchestrationId: orch.id, orchestrationTaskId: '__verification__' },
      );
      control.fixerRunId = run.id;
      const result = await this.runs.waitForResult(run.id);
      orch.costUsd += result.costUsd;
      state.costUsd += result.costUsd;
      budget = result.cause === 'budget';
      note = budget ? 'its cost limit ran out before it finished' : result.isError ? `the fixer ended with an error: ${result.result}` : result.result;
    } catch (err) {
      note = `the fixer could not run: ${(err as Error).message}`;
    }
    control.fixerRunId = null;
    try {
      // Asked to commit, agents often do not: what is left would be lost to the pull request
      commitAll(root, `chore: keep what the verification fixer left uncommitted\n\nOrchestration ${orch.name} (${orch.id.slice(0, 8)}), check \`${entry.command}\`.`);
    } catch {
      // the fixer left the tree in a state git will not commit; the re-run says whether it matters
    }
    return { note: tail(note, 1500), budget };
  }

  /** Integrates a finished graph again: after resolving by hand, or one from before this existed. */
  retryIntegration(id: string): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    if (orch.status === 'running') throw new Error('the orchestration is still running');
    if (orch.status === 'waiting') throw new Error('the orchestration is waiting for a decision on its tasks, and integrates once they are settled');
    if (orch.integration && ['merging', 'resolving'].includes(orch.integration.status)) return orch;
    if (!orch.tasks.some((t) => t.status === 'completed' && t.branch)) throw new Error('no task has a branch to integrate');
    if (!isGitRepo(orch.cwd)) throw new Error(`${orch.cwd} is not a git repository`);
    if (this.verifying.has(orch.id)) throw new Error('the checks are running on the integration branch: stop the orchestration first');
    orch.baseCommit ??= this.forkPoint(orch);
    // The checks skip themselves when the branch is where they last passed
    void this.integrate(orch).then(() => this.runChecks(orch));
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
    // A branch being fixed is a moving one, and what is pushed must be what was checked
    if (this.verifying.has(orch.id)) throw new Error('the checks are still running on the integration branch: wait for their outcome before opening a pull request');
    if (checksFailGraph(orch)) throw new Error('the checks failed on the integration branch, and the graph was launched to fail with them: fix the branch and verify again before opening a pull request');
    git(orch.cwd, ['push', '-u', 'origin', integration.branch], 180_000);
    let url: string | null = null;
    let detail = `pushed ${integration.branch}`;
    try {
      const checked = orch.verification && orch.verification.status !== 'pending' ? `Verification: ${orch.verification.status}. ${orch.verification.report}` : null;
      const body = [orch.objective, checked, orch.finalResult].filter(Boolean).join('\n\n---\n\n') || orch.name;
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
  startPlan(req: PlanRequest): ChatRuntime {
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
  startPlanAndRecord(req: PlanRequest): ChatRuntime {
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
    if (orch.status === 'running' || orch.status === 'waiting') throw new Error('stop the orchestration before removing its worktrees');
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
    if (orch.status === 'running' || orch.status === 'waiting') throw new Error('stop the orchestration before deleting it');
    if (this.verifying.has(orch.id)) throw new Error('the checks are running on the integration branch: stop the orchestration first');
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

  // ---------- decisions about a failed task ----------

  /** The task a decision is about, in a graph that can take one: only the graph engine has tasks to decide on. */
  private decidable(
    id: string,
    taskId: string,
    allowed: OrchestrationTaskState['status'][],
    refusal = (task: OrchestrationTaskState) => `task ${task.id} is ${task.status}, so there is nothing to decide about it`,
  ): { orch: Orchestration; task: OrchestrationTaskState } {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    if (orch.engine !== 'graph') throw new Error('a workflow runs its tasks as one session: resume it instead');
    if (orch.status !== 'running' && orch.status !== 'waiting') throw new Error(`the orchestration is ${orch.status}: resume it instead`);
    const task = orch.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('task not found');
    if (!allowed.includes(task.status)) throw new Error(refusal(task));
    return { orch, task };
  }

  /** Puts the graph back to work after a decision: what waited behind the task goes on. */
  private reopen(orch: Orchestration): Orchestration {
    orch.status = 'running';
    orch.endedAt = null;
    // The graph finishes again, and what it checked was the branch before this
    if (!this.verifying.has(orch.id)) orch.verification = null;
    if (orch.error) orch.error = null;
    this.schedule(orch);
    return orch;
  }

  /**
   * Runs a failed task again in its own chat, with its worktree, once more than its attempts allowed:
   * this is the person deciding it is worth it. What waited behind it stops waiting.
   */
  retryTask(id: string, taskId: string): Orchestration {
    const { orch, task } = this.decidable(id, taskId, ['failed']);
    task.status = 'pending';
    task.result = null;
    task.endedAt = null;
    // The person decided it is worth another go, and that is a new allowance of time and money
    task.clockStartedAt = null;
    return this.reopen(orch);
  }

  /**
   * Starts a failed task over: a new chat, in a worktree rebuilt from the base. What the old chat did
   * is thrown away, its branch with it, and it stays listed as the record of what was tried.
   */
  retryTaskClean(id: string, taskId: string): Orchestration {
    const { orch, task } = this.decidable(id, taskId, ['failed']);
    if (task.runId && this.runs.get(task.runId)?.pid) throw new Error('the task still has a process running: stop it first');
    this.startOver(orch, task);
    return this.reopen(orch);
  }

  /**
   * Throws away what a task did (its worktree and branch, uncommitted work included) and puts it back
   * to pending with no chat, so the next execution is a new conversation from the base. The chat it
   * had stays listed as the record of what was tried.
   */
  private startOver(orch: Orchestration, task: OrchestrationTaskState): void {
    if (task.worktree || task.branch) {
      const { root } = checkoutOf(orch.cwd);
      if (task.worktree && existsSync(task.worktree)) removeWorktree(root, task.worktree, true);
      if (task.branch) deleteBranch(root, task.branch);
    }
    Object.assign(task, {
      status: 'pending',
      runId: null,
      sessionId: null,
      worktree: null,
      branch: null,
      baseCommit: null,
      commit: null,
      result: null,
      error: null,
      attempts: 0,
      // The chat that is left behind keeps its cost in the graph's total; the task counts its new one
      costUsd: 0,
      startedAt: null,
      endedAt: null,
      clockStartedAt: null,
      clockCostUsd: 0,
    });
  }

  /**
   * Runs a task of a finished graph again, and with it everything that depends on it: their results
   * were built on the old one, and their branches contain its merge. Each starts over in a new chat
   * and a worktree rebuilt from what it now depends on, and the graph integrates and synthesises
   * again once they are done. Tasks outside that set keep their work.
   *
   * The integration branch is rebuilt from the base too: it holds merges of branches that no longer
   * exist, and merging the new ones on top would conflict with their own earlier versions.
   */
  rerunTask(id: string, taskId: string): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    if (orch.engine !== 'graph') throw new Error('a workflow runs its tasks as one session: resume it instead');
    if (orch.status === 'running') throw new Error('the orchestration is still running: stop it first, or wait for it to finish');
    if (orch.status === 'waiting') throw new Error('the orchestration is waiting for a decision on its tasks: retry or skip them instead');
    if (this.verifying.has(orch.id)) throw new Error('the checks are running on the integration branch: stop the orchestration first');
    const task = orch.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('task not found');
    const redo = this.withDependants(orch, task);
    const busy = redo.find((t) => t.runId && this.runs.get(t.runId)?.pid);
    if (busy) throw new Error(`task ${busy.id} still has a process running: stop it first`);
    if (orch.integration && ['merging', 'resolving'].includes(orch.integration.status)) {
      throw new Error('the graph is being integrated: wait for it to finish, or stop it');
    }
    if (orch.worktree && orch.integration?.pullRequestUrl) {
      throw new Error('the integration branch was already pushed for a pull request, and rebuilding it would leave that one behind: relaunch the graph instead');
    }

    if (orch.worktree) this.discardIntegration(orch);
    for (const t of redo) this.startOver(orch, t);
    orch.finalResult = null;
    orch.synthesisRunId = null;
    // What was checked belongs to the branch that was just thrown away
    if (orch.verification) orch.verification = null;
    this.lateArrivals.delete(orch.id);
    orch.integration = null;
    return this.reopen(orch);
  }

  /** The task and every task that depends on it, directly or not, in dependency order. */
  private withDependants(orch: Orchestration, task: OrchestrationTaskState): OrchestrationTaskState[] {
    const affected = new Set([task.id]);
    for (const t of topological(orch.tasks)) {
      if ((t.dependsOn ?? []).some((d) => affected.has(d))) affected.add(t.id);
    }
    return topological(orch.tasks).filter((t) => affected.has(t.id));
  }

  /** Removes the integration branch and its worktree, so the next integration builds it from the base. */
  private discardIntegration(orch: Orchestration): void {
    const { root } = checkoutOf(orch.cwd);
    const integration = orch.integration;
    if (integration?.worktree && existsSync(integration.worktree)) removeWorktree(root, integration.worktree, true);
    deleteBranch(root, integration?.branch ?? integrationBranch(orch));
  }

  /**
   * Gives a branch up so the graph can finish without it: the task and everything that depends on it
   * are skipped. The chat keeps whatever it did; nothing is deleted.
   */
  skipTask(id: string, taskId: string): Orchestration {
    const { orch, task } = this.decidable(id, taskId, ['failed', 'blocked']);
    task.status = 'skipped';
    task.endedAt ??= now();
    return this.reopen(orch);
  }

  /**
   * A nudge for a worker whose task is still running, sent from the orchestration board. A finished
   * task takes none: its result already fed the tasks that depend on it, so its way forward is a fork.
   */
  hintTask(id: string, taskId: string, text: string): Orchestration {
    const { orch, task } = this.decidable(id, taskId, ['running'], (t) =>
      `task ${t.id} is ${t.status}: a hint reaches a worker that is still running, and the way forward for a finished task is a fork of its chat`,
    );
    if (!text?.trim()) throw new Error('text is required');
    if (!task.runId || this.relaunching.has(`${orch.id}:${task.id}`)) throw new Error('the worker is between two executions: try again in a moment');
    this.runs.send(task.runId, `A hint from the person following this orchestration:\n\n${text.trim()}`);
    return orch;
  }

  /**
   * What the supervisor spent watching one of this graph's workers. It goes on the graph and not on
   * the task: a task's cost is its chat's own total, which each result replaces, and would drop it.
   */
  chargeSupervisor(id: string, costUsd: number): void {
    const orch = this.items.get(id);
    if (!orch || !(costUsd > 0)) return;
    orch.costUsd += costUsd;
    this.persist();
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
        after: this.workerTask(orch, t),
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
      t.sessionId = run?.id ?? null;
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
    if (!run || !this.workflowRecords) return;
    const records = await this.workflowRecords(run.id).catch(() => []);
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
      const records = run && this.workflowRecords ? await this.workflowRecords(run.id).catch(() => []) : [];
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
