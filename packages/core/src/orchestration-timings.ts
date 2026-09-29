import type {
  CriticalPathLink,
  Execution,
  Orchestration,
  OrchestrationPhaseName,
  OrchestrationPhaseTiming,
  OrchestrationTaskState,
  OrchestrationTimings,
  TaskWait,
  VerificationFix,
  VerificationTimings,
} from '@agentry/shared';
import { isRateLimitError } from './chats.ts';

/** What the timings read of a chat: its record's link to the graph, and its executions. */
export interface TimingsChat {
  id: string;
  orchestrationId: string | null;
  orchestrationTaskId: string | null;
  executions: readonly Execution[];
}

/** A gap shorter than this between being ready and starting is scheduling noise, not a wait. */
const SLOT_WAIT_MIN_MS = 1_000;

const ROLE_OF: Record<Exclude<OrchestrationPhaseName, 'tasks'>, string> = {
  integration: '__integration__',
  verification: '__verification__',
  synthesis: '__synthesis__',
};

/** A span of time; `end` null while it goes on. */
interface Span {
  start: string;
  end: string | null;
  error: string | null;
  outcome: Execution['outcome'];
}

const ms = (iso: string): number => Date.parse(iso);
const gap = (from: string, to: string): number => Math.max(0, ms(to) - ms(from));
const latest = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);

/**
 * Where a graph's time went, computed from the stored orchestration and the executions of the chats
 * Agentry started for it. Nothing is stored for it: every figure is read from what the graph and
 * its chats already recorded, so a graph stored before a field existed answers without that figure
 * and names it in `missing`. What is still running counts up to `at`.
 */
export function orchestrationTimings(orch: Orchestration, chats: readonly TimingsChat[], at: Date = new Date()): OrchestrationTimings {
  const atIso = at.toISOString();
  const running = orch.status === 'running';
  // `endedAt` is also set while a graph finishes, to guard against re-entry: only a graph that is over has an end
  const graphEnd = running ? atIso : (orch.endedAt ?? atIso);
  const until = (end: string | null | undefined): string => end ?? atIso;
  const missing: string[] = [];

  const own = chats.filter((c) => c.orchestrationId === orch.id);
  const executionsOf = (taskId: string): Execution[] =>
    own
      .filter((c) => c.orchestrationTaskId === taskId)
      .flatMap((c) => c.executions)
      .slice()
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  // A task's executions; a graph whose chats are gone (or a workflow, whose tasks are subagents of one session) has the task's own span
  const spans = new Map<string, Span[]>();
  for (const task of orch.tasks) {
    const execs = executionsOf(task.id);
    const list: Span[] = execs.length
      ? execs.map((e) => ({ start: e.startedAt, end: e.endedAt, error: e.error, outcome: e.outcome }))
      : task.startedAt
        ? [{ start: task.startedAt, end: task.endedAt ?? (task.status === 'running' ? null : task.startedAt), error: task.error, outcome: null }]
        : [];
    spans.set(task.id, list);
  }
  const spansOf = (task: OrchestrationTaskState): Span[] => spans.get(task.id) ?? [];
  const workOf = (task: OrchestrationTaskState): number => spansOf(task).reduce((sum, s) => sum + gap(s.start, until(s.end)), 0);
  const firstStart = (task: OrchestrationTaskState): string | null => spansOf(task)[0]?.start ?? null;
  const byId = new Map(orch.tasks.map((t) => [t.id, t]));

  // ---------- waits ----------
  const waitsOf = new Map<string, TaskWait[]>();
  for (const task of orch.tasks) {
    const waits: TaskWait[] = [];
    const deps = (task.dependsOn ?? []).map((d) => byId.get(d)).filter((d): d is OrchestrationTaskState => d !== undefined);
    const ready = deps.length ? deps.reduce<string | null>((acc, d) => latest(acc, d.endedAt), null) : orch.createdAt;
    const first = firstStart(task);
    if (ready && first && gap(ready, first) > SLOT_WAIT_MIN_MS) {
      waits.push({ taskId: task.id, kind: 'slot', startedAt: ready, endedAt: first, durationMs: gap(ready, first), reason: null });
    } else if (ready && !first && running && task.status === 'pending' && deps.every((d) => d.status === 'completed') && gap(ready, atIso) > SLOT_WAIT_MIN_MS) {
      // Ready and still not started: the wait goes on
      waits.push({ taskId: task.id, kind: 'slot', startedAt: ready, endedAt: null, durationMs: gap(ready, atIso), reason: null });
    }
    const list = spansOf(task);
    list.forEach((span, i) => {
      if (span.end === null || (span.outcome !== 'failed' && span.outcome !== 'interrupted')) return;
      const next = list[i + 1];
      // A task that delivered after all waits on nothing; one left failed waits until someone decides, or the graph ends
      if (!next && task.status === 'completed') return;
      const end = next ? next.start : running ? null : graphEnd;
      const kind = isRateLimitError(span.error) ? 'limit' : 'retry';
      waits.push({ taskId: task.id, kind, startedAt: span.end, endedAt: end, durationMs: gap(span.end, until(end)), reason: span.error });
    });
    waitsOf.set(task.id, waits);
  }
  const items = [...waitsOf.values()].flat().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const total = (kind: TaskWait['kind']) => items.filter((w) => w.kind === kind).reduce((sum, w) => sum + w.durationMs, 0);

  // ---------- phases ----------
  const phases: OrchestrationPhaseTiming[] = [];
  const phase = (name: OrchestrationPhaseName, start: string, end: string | null): void => {
    phases.push({ phase: name, startedAt: start, endedAt: end, durationMs: gap(start, until(end)) });
  };

  const starts = orch.tasks.map(firstStart).filter((s): s is string => s !== null).sort();
  const tasksStart = starts[0] ?? null;
  const unsettled = orch.status === 'waiting' || orch.tasks.some((t) => ['pending', 'running', 'interrupted', 'blocked'].includes(t.status));
  const tasksEnd = unsettled
    ? null
    : orch.tasks.reduce<string | null>((acc, t) => latest(acc, t.endedAt ?? spansOf(t).at(-1)?.end ?? null), null);
  if (tasksStart) phase('tasks', tasksStart, tasksEnd);

  /** A phase from its recorded fields, or else from its role chats' executions, or else named missing. */
  const recorded = (name: Exclude<OrchestrationPhaseName, 'tasks'>, happened: boolean, start: string | null | undefined, end: string | null | undefined, field: string): void => {
    if (!happened) return;
    if (start) return phase(name, start, end ?? null);
    const execs = executionsOf(ROLE_OF[name]);
    const first = execs[0];
    if (first) {
      const allEnded = execs.every((e) => e.endedAt !== null);
      phase(name, first.startedAt, allEnded ? execs.reduce<string | null>((acc, e) => latest(acc, e.endedAt), null) : null);
      return;
    }
    missing.push(field);
  };
  recorded('integration', !!orch.integration, orch.integration?.startedAt, orch.integration?.endedAt, 'integration.startedAt');
  const v = orch.verification;
  recorded('verification', !!v && v.status !== 'pending', v?.startedAt, v?.endedAt, 'verification.startedAt');
  recorded('synthesis', !!orch.synthesisRunId || !!orch.synthesisStartedAt, orch.synthesisStartedAt, orch.synthesisEndedAt, 'synthesisStartedAt');

  // ---------- critical path ----------
  const reach = (t: OrchestrationTaskState): string | null => t.endedAt ?? (firstStart(t) ? atIso : null);
  const pickLatest = (list: OrchestrationTaskState[]): OrchestrationTaskState | undefined =>
    list.reduce<OrchestrationTaskState | undefined>((best, t) => {
      const r = reach(t);
      if (r === null) return best;
      const b = best ? reach(best) : null;
      return b === null || r > b ? t : best;
    }, undefined);
  const chain: OrchestrationTaskState[] = [];
  const seen = new Set<string>();
  for (let link = pickLatest(orch.tasks); link && !seen.has(link.id); ) {
    seen.add(link.id);
    chain.unshift(link);
    const deps = (link.dependsOn ?? []).map((d) => byId.get(d)).filter((d): d is OrchestrationTaskState => d !== undefined);
    link = pickLatest(deps);
  }
  const links: CriticalPathLink[] = [];
  let previousEnd = orch.createdAt;
  for (const task of chain) {
    const start = firstStart(task) ?? previousEnd;
    links.push({
      taskId: task.id,
      taskName: task.name,
      startedAt: start,
      endedAt: task.endedAt,
      workMs: workOf(task),
      waitBeforeMs: gap(previousEnd, start),
      waits: waitsOf.get(task.id) ?? [],
    });
    previousEnd = task.endedAt ?? atIso;
  }
  const head = links[0];
  const tail = links.at(-1);
  const criticalMs = head && tail ? gap(head.startedAt, until(tail.endedAt)) : 0;

  // ---------- verification ----------
  let verification: VerificationTimings | null = null;
  if (v && v.status !== 'pending') {
    if (v.commands.some((c) => c.runs === undefined)) missing.push('verification.runs');
    // An older graph did not keep its fixer attempts, but the fixer's chats say when they ran and what they cost
    const fixerChats = own.filter((c) => c.orchestrationTaskId === ROLE_OF.verification);
    const fallback: VerificationFix[] = fixerChats
      .flatMap((c) => c.executions.map((e) => ({ runId: c.id, command: '', attempt: 0, startedAt: e.startedAt, endedAt: e.endedAt, costUsd: e.costUsd ?? 0 })))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((f, i) => ({ ...f, attempt: i + 1 }));
    if (v.fixes === undefined && fallback.length === 0) missing.push('verification.fixes');
    const commands = v.commands.map((c) => {
      const runs = c.runs ?? [];
      return { command: c.command, install: c.install === true, totalMs: runs.length ? runs.reduce((sum, r) => sum + r.durationMs, 0) : c.durationMs, runs };
    });
    const fixes = v.fixes ?? fallback;
    verification = {
      checksMs: commands.reduce((sum, c) => sum + c.totalMs, 0),
      fixerMs: fixes.reduce((sum, f) => sum + gap(f.startedAt, until(f.endedAt)), 0),
      passes: commands.reduce((max, c) => c.runs.reduce((m, r) => Math.max(m, r.pass), max), 0),
      commands,
      fixes,
    };
  }

  const tasksPhase = phases.find((p) => p.phase === 'tasks');
  const work = orch.tasks.reduce((sum, t) => sum + workOf(t), 0);
  return {
    orchestrationId: orch.id,
    at: atIso,
    createdAt: orch.createdAt,
    endedAt: running ? null : orch.endedAt,
    wallMs: gap(orch.createdAt, graphEnd),
    phases,
    afterTasksMs: tasksEnd ? gap(tasksEnd, graphEnd) : 0,
    parallelism: tasksPhase && tasksPhase.durationMs > 0 ? Math.round((work / tasksPhase.durationMs) * 100) / 100 : null,
    criticalPath: { durationMs: criticalMs, links },
    waits: { slotMs: total('slot'), limitMs: total('limit'), retryMs: total('retry'), items },
    verification,
    missing,
  };
}
