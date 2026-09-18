import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  Orchestration,
  OrchestrationSpec,
  OrchestrationTaskSpec,
  OrchestrationTaskState,
  PlanDraftSummary,
  PlanRequest,
  RunSummary,
} from '@agentry/shared';
import type { Db } from './db.ts';
import type { CoreConfig } from './paths.ts';
import type { RunManager } from './runner.ts';

const ID_RE = /^[\w-]{1,40}$/;
/** The planner's own name, which is how a past planner run is recognised later. */
export const PLANNER_RUN_NAME = 'orchestration-planner';
// The objective is read back out of the prompt when recovering a draft, so both halves are built
// from these constants: they cannot drift apart.
const PROMPT_HEAD = 'Plan a multi-agent orchestration for this objective:\n\n';
const PROMPT_TAIL = '\n\nSplit it into at most ';
const MAX_DEP_CONTEXT = 6000;
const now = () => new Date().toISOString();

const PLAN_SCHEMA = {
  type: 'object',
  required: ['name', 'tasks'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Short name for the orchestration' },
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

  constructor(
    private readonly config: CoreConfig,
    private readonly runs: RunManager,
    private readonly db: Db,
  ) {
    this.file = join(config.dataDir, 'orchestrations.json');
    this.load();
  }

  private load(): void {
    this.importLegacy();
    for (const o of this.db.loadOrchestrations()) {
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

  private persist(): void {
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
      createdAt: now(),
      endedAt: null,
      finalResult: null,
      costUsd: 0,
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
    this.schedule(orch);
    return orch;
  }

  stop(id: string): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    if (orch.status !== 'running') return orch;
    orch.status = 'stopped';
    orch.endedAt = now();
    for (const t of orch.tasks) {
      if (t.status === 'running' && t.runId) this.runs.stop(t.runId);
      if (t.status === 'pending' || t.status === 'running') t.status = 'stopped';
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
  resume(id: string): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new Error('orchestration not found');
    if (orch.status === 'running') return orch;
    const unfinished = orch.tasks.filter((t) => t.status !== 'completed');
    if (unfinished.length === 0) throw new Error('every task already completed');
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
    this.schedule(orch); // persists
    return orch;
  }

  private buildPrompt(orch: Orchestration, task: OrchestrationTaskState): string {
    const parts: string[] = [];
    if (orch.objective) parts.push(`You are one worker in a multi-agent orchestration.\nOverall objective: ${orch.objective}`);
    const deps = orch.tasks.filter((t) => task.dependsOn?.includes(t.id));
    if (deps.length > 0) {
      parts.push(
        'Results from the tasks you depend on:\n' +
          deps.map((d) => `<task id="${d.id}" name="${d.name}">\n${(d.result ?? '').slice(0, MAX_DEP_CONTEXT)}\n</task>`).join('\n'),
      );
    }
    parts.push(`Your task (${task.name}):\n${task.prompt}`);
    parts.push('Finish with a concise report of what you did and found; it is handed to the next workers.');
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

  private launch(orch: Orchestration, task: OrchestrationTaskState): boolean {
    try {
      const run = this.runs.start(
        {
          prompt: this.buildPrompt(orch, task),
          cwd: task.cwd ?? orch.cwd,
          model: task.model ?? orch.model ?? undefined,
          permissionMode: orch.permissionMode,
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
        orch.costUsd = orch.tasks.reduce((sum, t) => sum + t.costUsd, 0);
        this.schedule(orch);
      });
      return true;
    } catch {
      // Global run limit reached: leave it pending and retry shortly
      setTimeout(() => this.schedule(orch), 3000).unref();
      return false;
    }
  }

  private async finish(orch: Orchestration): Promise<void> {
    if (orch.status !== 'running' || orch.endedAt) return;
    const completed = orch.tasks.filter((t) => t.status === 'completed');
    const anyFailed = orch.tasks.some((t) => t.status === 'failed' || t.status === 'skipped');
    orch.endedAt = now(); // guards against re-entry while the synthesis runs

    if (orch.synthesize && completed.length > 0) {
      try {
        const run = this.runs.start(
          {
            prompt:
              `Synthesize the results of a multi-agent orchestration into one final report.\n` +
              `Objective: ${orch.objective ?? orch.name}\n\n` +
              orch.tasks
                .map((t) => `<task id="${t.id}" name="${t.name}" status="${t.status}">\n${(t.result ?? t.error ?? '').slice(0, MAX_DEP_CONTEXT)}\n</task>`)
                .join('\n'),
            cwd: orch.cwd,
            model: orch.model ?? undefined,
            permissionMode: orch.permissionMode,
            name: `${orch.name}:synthesis`.slice(0, 60),
            keepAlive: false,
          },
          { orchestrationId: orch.id, orchestrationTaskId: '__synthesis__' },
        );
        const result = await this.runs.waitForResult(run.id);
        orch.finalResult = result.isError ? `Synthesis failed: ${result.result}` : result.result;
        orch.costUsd += result.costUsd;
      } catch (err) {
        orch.finalResult = `Synthesis failed: ${(err as Error).message}`;
      }
    }
    if (orch.status === 'running') orch.status = anyFailed ? 'failed' : 'completed';
    orch.endedAt = now();
    this.persist();
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
        `(results of dependencies are passed along automatically). You may inspect the directory with read-only tools first. Do not perform the work itself.`,
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

    let draft = result.structuredOutput as { name?: string; tasks?: OrchestrationTaskSpec[] } | undefined;
    if (!draft?.tasks) {
      // Older CLIs return the JSON as text
      const match = /\{[\s\S]*\}/.exec(result.result);
      draft = match ? (JSON.parse(match[0]) as typeof draft) : undefined;
    }
    if (!draft?.tasks) throw new Error('planner returned no tasks');
    validateTasks(draft.tasks);
    const head = run.prompt.indexOf(PROMPT_HEAD);
    const tail = run.prompt.indexOf(PROMPT_TAIL);
    const spec: OrchestrationSpec = {
      name: draft.name ?? 'orchestration',
      objective: head === 0 && tail > 0 ? run.prompt.slice(PROMPT_HEAD.length, tail) : undefined,
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

  /** Plans that can still be launched, newest first. */
  drafts(limit?: number): PlanDraftSummary[] {
    return this.db.planDrafts(limit);
  }

  /** Plans and waits, for callers that want the draft in one call. */
  async plan(req: PlanRequest): Promise<OrchestrationSpec> {
    const run = this.startPlan(req);
    return this.draftFrom(run.id);
  }
}
