import { watch, type FSWatcher } from 'node:fs';
import type {
  IntegrationStatus,
  Orchestration,
  OrchestrationTaskStatus,
  PermissionRequest,
  RunEventRef,
  RunWaitingReason,
} from '@agentry/shared';
import type { ChatRuntime } from './chats.ts';
import type { BackgroundTask, SubagentInfo, WorkflowRun } from './cli-facts.ts';
import type { AgentryEventInput, EventBus } from './events.ts';

/*
 * Turns the state the core already keeps into events for the bus. Sources are diff-based on
 * purpose: the runner and the orchestrator have dozens of places that change a status, and one
 * comparison after each batch of changes cannot miss one the way a hand-placed emit could.
 */

/** Chatty updates of one run are folded into one event per this many milliseconds. */
export const RUN_UPDATE_COALESCE_MS = 250;
/** File changes under the projects directory are folded the same way, into one `sessions.changed`. */
export const SESSIONS_COALESCE_MS = 1000;

const TERMINAL = new Set(['completed', 'failed', 'stopped']);

export const runRef = (run: ChatRuntime): RunEventRef => ({
  runId: run.id,
  runName: run.name,
  sessionId: run.id,
  orchestrationId: run.orchestrationId,
  internal: run.origin === 'internal',
});

/** The run may be gone by the time its prompt is answered; the id still says which one it was. */
export const runRefOr = (runId: string, run: ChatRuntime | null): RunEventRef =>
  run ? runRef(run) : { runId, runName: runId, sessionId: null, orchestrationId: null, internal: false };

/** AskUserQuestion and ExitPlanMode reach the host as tool permission requests like any other. */
export function waitingReason(toolName: string): RunWaitingReason {
  if (toolName === 'AskUserQuestion') return 'question';
  if (toolName === 'ExitPlanMode') return 'plan';
  return 'permission';
}

export function waitingTitle(runName: string, reason: RunWaitingReason, toolName: string): string {
  if (reason === 'question') return `${runName} is asking you a question`;
  if (reason === 'plan') return `${runName} has a plan for you to approve`;
  return `${runName} needs your approval to use ${toolName}`;
}

export function permissionEvents(
  request: PermissionRequest,
  run: ChatRuntime | null,
): Array<Extract<AgentryEventInput, { type: 'run.waiting' | 'permission.requested' }>> {
  const reason = waitingReason(request.toolName);
  const ref = runRefOr(request.runId, run);
  const title = waitingTitle(ref.runName, reason, request.toolName);
  return [
    { type: 'permission.requested', title, ...ref, permissionId: request.id, toolName: request.toolName, reason, description: request.description ?? null },
    { type: 'run.waiting', title, ...ref, reason, permissionId: request.id, toolName: request.toolName },
  ];
}

// ---------- runs ----------

/** `fromSubagent` is recorded on the task by the runner when the CLI reports `owned_by_subagent`. */
const fromSubagent = (task: BackgroundTask): boolean => (task as BackgroundTask & { fromSubagent?: boolean }).fromSubagent === true;

const workflowKey = (w: WorkflowRun): string =>
  `${w.totalTokens ?? ''}|${w.phases.length}|${w.agents.map((a) => `${a.state}${a.tokens ?? ''}`).join(',')}`;

/** The agent to open when a workflow ends: the one that errored if it failed, else the last to report back. */
export function endingAgentId(workflow: WorkflowRun): string | null {
  const withTranscript = workflow.agents.filter((a) => a.agentId).sort((a, b) => a.index - b.index);
  const errored = withTranscript.filter((a) => a.state === 'error');
  const pool = workflow.status === 'failed' && errored.length > 0 ? errored : withTranscript;
  return pool[pool.length - 1]?.agentId ?? null;
}

const workflowCounts =(w: WorkflowRun) => ({
  agentsRunning: w.agents.filter((a) => a.state === 'start' || a.state === 'progress').length,
  agentsDone: w.agents.filter((a) => a.state === 'done' || a.state === 'error').length,
  agentsTotal: w.agents.length,
});

interface RunSnapshot {
  status: ChatRuntime['status'];
  turns: number;
  costUsd: number;
  pendingPrompts: number;
  lastText: string | null;
  name: string;
  tasks: Map<string, string>;
  subagents: Map<string, { status: SubagentInfo['status']; agentId: string | undefined; background: boolean }>;
  workflows: Map<string, { status: WorkflowRun['status']; key: string }>;
  timer: NodeJS.Timeout | null;
  /** Latest summary and the workflows whose progress is waiting for the timer */
  latest: ChatRuntime;
  dirty: boolean;
  progress: Set<string>;
}

/**
 * Watches runs and says what changed in them: status, delegated work, and the fields a list
 * shows. Status changes and endings go out at once; everything else waits for the coalescing
 * window, so a run producing a message every few milliseconds costs the clients one event per window.
 */
export class RunEventPublisher {
  private readonly snapshots = new Map<string, RunSnapshot>();

  constructor(
    private readonly emit: (event: AgentryEventInput) => void,
    private readonly windowMs = RUN_UPDATE_COALESCE_MS,
  ) {}

  /** Records where a run stands without announcing it: what happens from here on is the news. */
  baseline(run: ChatRuntime): void {
    this.snapshots.set(run.id, {
      status: run.status,
      turns: run.turns,
      costUsd: run.costUsd,
      pendingPrompts: run.pendingPrompts ?? 0,
      lastText: run.lastText,
      name: run.name,
      tasks: new Map(run.backgroundTasks.map((t) => [t.id, t.status])),
      subagents: new Map(run.subagents.map((s) => [s.toolUseId, { status: s.status, agentId: s.agentId, background: s.background === true }])),
      workflows: new Map((run.workflows ?? []).map((w) => [w.id, { status: w.status, key: workflowKey(w) }])),
      timer: null,
      latest: run,
      dirty: false,
      progress: new Set(),
    });
  }

  created(run: ChatRuntime): void {
    this.baseline(run);
    this.emit({ type: 'run.created', title: `${run.name} started`, ...runRef(run), status: run.status });
  }

  forget(runId: string): void {
    const snap = this.snapshots.get(runId);
    if (snap?.timer) clearTimeout(snap.timer);
    this.snapshots.delete(runId);
  }

  dispose(): void {
    for (const id of [...this.snapshots.keys()]) this.forget(id);
  }

  /** Compares the run with what was last announced and emits the difference. */
  observe(run: ChatRuntime): void {
    const snap = this.snapshots.get(run.id);
    if (!snap) return this.baseline(run);
    snap.latest = run;
    const ref = runRef(run);
    const at = { runId: run.id, runName: run.name, sessionId: run.id };

    this.diffTasks(run, snap, at);
    this.diffSubagents(run, snap, at);
    this.diffWorkflows(run, snap, at);

    if (run.status !== snap.status) {
      const previousStatus = snap.status;
      this.settle(snap, run);
      if (TERMINAL.has(run.status)) {
        const status = run.status as 'completed' | 'failed' | 'stopped';
        this.emit({
          type: 'run.ended',
          title: status === 'completed' ? `${run.name} finished` : status === 'failed' ? `${run.name} failed` : `${run.name} stopped`,
          ...ref,
          status,
          error: run.error,
          turns: run.turns,
          costUsd: run.costUsd,
        });
      } else {
        this.emit(this.updated(run, previousStatus));
      }
      return;
    }
    const changed =
      run.turns !== snap.turns ||
      run.costUsd !== snap.costUsd ||
      (run.pendingPrompts ?? 0) !== snap.pendingPrompts ||
      run.lastText !== snap.lastText ||
      run.name !== snap.name;
    if (changed) snap.dirty = true;
    if ((snap.dirty || snap.progress.size > 0) && !snap.timer) {
      snap.timer = setTimeout(() => this.flush(run.id), this.windowMs);
      snap.timer.unref();
    }
  }

  private updated(run: ChatRuntime, previousStatus: ChatRuntime['status'] | null): AgentryEventInput {
    return {
      type: 'run.updated',
      title: `${run.name} is ${run.status}`,
      ...runRef(run),
      status: run.status,
      previousStatus,
      turns: run.turns,
      costUsd: run.costUsd,
      pendingPrompts: run.pendingPrompts ?? 0,
    };
  }

  /** Marks everything a run-level event carries as announced. */
  private settle(snap: RunSnapshot, run: ChatRuntime): void {
    if (snap.timer) clearTimeout(snap.timer);
    snap.timer = null;
    snap.dirty = false;
    Object.assign(snap, {
      status: run.status,
      turns: run.turns,
      costUsd: run.costUsd,
      pendingPrompts: run.pendingPrompts ?? 0,
      lastText: run.lastText,
      name: run.name,
    });
  }

  private flush(runId: string): void {
    const snap = this.snapshots.get(runId);
    if (!snap) return;
    snap.timer = null;
    const run = snap.latest;
    for (const id of snap.progress) {
      const workflow = (run.workflows ?? []).find((w) => w.id === id);
      if (workflow && workflow.status === 'running') this.emit(this.progress(run, workflow));
    }
    snap.progress.clear();
    if (snap.dirty) {
      this.settle(snap, run);
      this.emit(this.updated(run, null));
    }
  }

  private diffTasks(run: ChatRuntime, snap: RunSnapshot, at: { runId: string; runName: string; sessionId: string | null }): void {
    for (const task of run.backgroundTasks) {
      const before = snap.tasks.get(task.id);
      if (before === undefined) {
        this.emit({
          type: 'task.started',
          title: `Background task started: ${task.description || task.type}`,
          ...at,
          taskId: task.id,
          taskType: task.type,
          description: task.description,
          toolUseId: task.toolUseId,
          fromSubagent: fromSubagent(task),
        });
      }
      if (task.status !== 'running' && (before === undefined || before === 'running')) {
        this.emit({
          type: 'task.ended',
          title: `Background task ${task.status === 'completed' ? 'finished' : task.status}: ${task.description || task.type}`,
          ...at,
          taskId: task.id,
          taskType: task.type,
          description: task.description,
          status: task.status,
          summary: task.summary,
          fromSubagent: fromSubagent(task),
        });
      }
      snap.tasks.set(task.id, task.status);
    }
  }

  private diffSubagents(run: ChatRuntime, snap: RunSnapshot, at: { runId: string; runName: string; sessionId: string | null }): void {
    for (const sub of run.subagents) {
      const before = snap.subagents.get(sub.toolUseId);
      const background = sub.background === true;
      const label = sub.description || sub.subagentType;
      if (!before) {
        this.emit({
          type: 'subagent.started',
          title: `Subagent started: ${label}`,
          ...at,
          toolUseId: sub.toolUseId,
          agentId: sub.agentId ?? null,
          subagentType: sub.subagentType,
          description: sub.description,
          background,
        });
      } else if (before.agentId !== sub.agentId || before.background !== background || (before.status !== 'running' && sub.status === 'running')) {
        this.emit({
          type: 'subagent.updated',
          title: `Subagent updated: ${label}`,
          ...at,
          toolUseId: sub.toolUseId,
          agentId: sub.agentId ?? null,
          subagentType: sub.subagentType,
          background,
        });
      }
      if (sub.status !== 'running' && (!before || before.status === 'running')) {
        this.emit({
          type: 'subagent.ended',
          title: `Subagent ${sub.status === 'completed' ? 'finished' : sub.status}: ${label}`,
          ...at,
          toolUseId: sub.toolUseId,
          agentId: sub.agentId ?? null,
          subagentType: sub.subagentType,
          description: sub.description,
          status: sub.status,
        });
      }
      snap.subagents.set(sub.toolUseId, { status: sub.status, agentId: sub.agentId, background });
    }
  }

  private diffWorkflows(run: ChatRuntime, snap: RunSnapshot, at: { runId: string; runName: string; sessionId: string | null }): void {
    for (const wf of run.workflows ?? []) {
      const before = snap.workflows.get(wf.id);
      const key = workflowKey(wf);
      const label = wf.name ?? wf.description;
      if (wf.status !== 'running') {
        snap.progress.delete(wf.id);
        if (!before || before.status === 'running') {
          this.emit({
            type: 'workflow.ended',
            title: `Workflow ${wf.status === 'completed' ? 'finished' : wf.status}: ${label}`,
            ...at,
            workflowId: wf.id,
            taskId: wf.taskId,
            agentId: endingAgentId(wf),
            name: wf.name,
            status: wf.status,
            summary: wf.summary,
            totalTokens: wf.totalTokens,
          });
        }
      } else if (!before) {
        this.emit(this.progress(run, wf));
      } else if (before.key !== key) {
        snap.progress.add(wf.id);
      }
      snap.workflows.set(wf.id, { status: wf.status, key });
    }
  }

  private progress(run: ChatRuntime, wf: WorkflowRun): AgentryEventInput {
    const counts = workflowCounts(wf);
    return {
      type: 'workflow.progress',
      title: `Workflow ${wf.name ?? wf.description}: ${counts.agentsDone}/${counts.agentsTotal} agents done`,
      runId: run.id,
      runName: run.name,
      sessionId: run.id,
      workflowId: wf.id,
      taskId: wf.taskId,
      name: wf.name,
      ...counts,
      totalTokens: wf.totalTokens,
    };
  }
}

// ---------- orchestrations ----------

interface OrchestrationSnapshot {
  status: Orchestration['status'];
  integration: IntegrationStatus | null;
  conflictKey: string;
  tasks: Map<string, OrchestrationTaskStatus>;
}

/** Compares the orchestrations with what was last announced; called wherever the orchestrator persists. */
export class OrchestrationEventTracker {
  private readonly snapshots = new Map<string, OrchestrationSnapshot>();

  private static snapshot(o: Orchestration): OrchestrationSnapshot {
    return {
      status: o.status,
      integration: o.integration?.status ?? null,
      conflictKey: `${o.integration?.status ?? ''}:${o.integration?.conflicts.length ?? 0}`,
      tasks: new Map(o.tasks.map((t) => [t.id, t.status])),
    };
  }

  baseline(all: Orchestration[]): void {
    this.snapshots.clear();
    for (const o of all) this.snapshots.set(o.id, OrchestrationEventTracker.snapshot(o));
  }

  observe(all: Orchestration[]): AgentryEventInput[] {
    const events: AgentryEventInput[] = [];
    const seen = new Set<string>();
    for (const o of all) {
      seen.add(o.id);
      const before = this.snapshots.get(o.id);
      const now = OrchestrationEventTracker.snapshot(o);
      this.snapshots.set(o.id, now);
      const integration = o.integration ?? null;
      if (!before || before.status !== now.status || before.integration !== now.integration) {
        events.push({
          type: 'orchestration.updated',
          title: !before ? `Orchestration ${o.name} started` : `Orchestration ${o.name} ${now.status === 'running' ? 'is running' : now.status}`,
          orchestrationId: o.id,
          orchestrationName: o.name,
          status: o.status,
          previousStatus: before?.status ?? null,
          integrationStatus: now.integration,
          costUsd: o.costUsd,
        });
      }
      for (const task of o.tasks) {
        const previous = before?.tasks.get(task.id) ?? null;
        // A task that appears already `pending` is part of the graph, not news
        if (previous === task.status || (previous === null && task.status === 'pending')) continue;
        events.push({
          type: 'orchestration.task',
          title: `Task ${task.name} ${task.status}`,
          orchestrationId: o.id,
          orchestrationName: o.name,
          taskId: task.id,
          taskName: task.name,
          status: task.status,
          previousStatus: previous,
          runId: task.runId,
          error: task.error,
        });
      }
      if (
        integration &&
        (integration.status === 'conflicted' || integration.status === 'resolving') &&
        integration.conflicts.length > 0 &&
        before?.conflictKey !== now.conflictKey
      ) {
        events.push({
          type: 'orchestration.conflict',
          title: `Merge conflict in ${o.name}${integration.status === 'resolving' ? ': an agent is resolving it' : ''}`,
          orchestrationId: o.id,
          orchestrationName: o.name,
          integrationStatus: integration.status,
          branch: integration.branch,
          paths: [...new Set(integration.conflicts.flatMap((c) => c.paths))],
          resolving: integration.status === 'resolving',
        });
      }
    }
    for (const id of [...this.snapshots.keys()]) {
      if (seen.has(id)) continue;
      this.snapshots.delete(id);
      events.push({ type: 'orchestration.removed', title: 'Orchestration removed', orchestrationId: id });
    }
    return events;
  }
}

// ---------- sessions on disk ----------

/**
 * Says when the CLI wrote under its projects directory. Nothing else in the server watches those
 * files (readers look at them when asked), so this is the one place that does — with an inotify
 * watch rather than polling, and only while someone is listening to the feed.
 */
export class SessionsWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private wanted = false;

  constructor(
    private readonly dir: string,
    private readonly bus: EventBus,
    private readonly windowMs = SESSIONS_COALESCE_MS,
  ) {
    bus.onDemand = (wanted) => (wanted ? this.start() : this.stop());
  }

  private start(): void {
    this.wanted = true;
    if (this.watcher) return;
    try {
      this.watcher = watch(this.dir, { recursive: true, persistent: false }, (_kind, file) => this.touched(file));
      this.watcher.on('error', () => this.restart());
    } catch {
      // The directory appears with the first session; look again later instead of holding a watch
      // on a parent for it
      this.restart();
    }
  }

  private restart(): void {
    this.watcher?.close();
    this.watcher = null;
    if (!this.wanted || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.wanted) this.start();
    }, 30_000);
    this.retry.unref();
  }

  private touched(file: string | Buffer | null): void {
    // Transcripts, subagent records and their sidecars; editors' swap files and the like are noise
    const name = file?.toString() ?? '';
    if (name && !/\.(jsonl|json|output)$/.test(name)) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.bus.emit({ type: 'sessions.changed', title: 'Sessions changed' });
    }, this.windowMs);
    this.timer.unref();
  }

  private stop(): void {
    this.wanted = false;
    this.watcher?.close();
    this.watcher = null;
    for (const t of [this.timer, this.retry]) if (t) clearTimeout(t);
    this.timer = this.retry = null;
  }

  close(): void {
    this.stop();
  }
}
