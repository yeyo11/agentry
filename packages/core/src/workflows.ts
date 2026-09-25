import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { WorkflowDefinition } from '@agentry/shared';
import type { WorkflowAgentState, WorkflowRun } from './cli-facts.ts';

// Claude Code workflows: scripts started with the Workflow tool that orchestrate subagents inside
// one session. The CLI reports them live as `local_workflow` tasks whose `task_progress` events carry
// a `workflow_progress` list, and keeps beside the session's transcript:
//
//   <session>/workflows/<runId>.json              the run's record, written when it finishes
//   <session>/workflows/scripts/<name>-<runId>.js the script it ran
//   <session>/subagents/workflows/<runId>/        one transcript and meta per agent, and a
//                                                 journal.jsonl of launches and results
//
// Saved workflows, which the tool runs by name, live in `.claude/workflows/` of a project or of the
// user's config directory.

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (ms: unknown): string | null => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** The CLI's task statuses, in the four the panel shows. */
export function workflowStatus(status: unknown): WorkflowRun['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'killed' || status === 'stopped') return 'stopped';
  return 'running';
}

/** Phases and agents from a `workflow_progress` list, the same shape live and in the record. */
export function readProgress(progress: unknown): { phases: string[]; agents: WorkflowAgentState[] } {
  const phases: string[] = [];
  const agents: WorkflowAgentState[] = [];
  for (const entry of Array.isArray(progress) ? (progress as Array<Record<string, unknown>>) : []) {
    if (entry.type === 'workflow_phase') {
      const title = text(entry.title);
      if (title) phases.push(title);
    } else if (entry.type === 'workflow_agent') {
      agents.push({
        index: count(entry.index) ?? agents.length + 1,
        label: text(entry.label) ?? `agent ${agents.length + 1}`,
        state: text(entry.state) ?? 'start',
        agentId: text(entry.agentId),
        phaseTitle: text(entry.phaseTitle),
        model: text(entry.model),
        startedAt: iso(entry.startedAt),
        durationMs: count(entry.durationMs),
        tokens: count(entry.tokens),
        toolCalls: count(entry.toolCalls),
        promptPreview: text(entry.promptPreview),
        resultPreview: text(entry.resultPreview),
      });
    }
  }
  return { phases, agents };
}

/** `name` and `description` from a script's `export const meta = {…}`, which must be a literal. */
export function scriptMeta(script: string): { name: string | null; description: string | null } {
  const meta = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n?\}/.exec(script)?.[1] ?? '';
  const field = (key: string) => new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(meta)?.[2] ?? null;
  return { name: field('name'), description: field('description') };
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readLines(file: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(file, 'utf8').catch(() => '');
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // a line still being written
    }
  }
  return out;
}

/** A finished run, from the record the CLI writes when the workflow ends. */
function fromRecord(record: Record<string, unknown>, sessionId: string): WorkflowRun | null {
  const id = text(record.runId);
  if (!id) return null;
  const { phases, agents } = readProgress(record.workflowProgress);
  const listed = Array.isArray(record.phases) ? (record.phases as Array<{ title?: unknown }>).map((p) => text(p.title)).filter((t): t is string => Boolean(t)) : [];
  const endedAt = text(record.timestamp);
  return {
    id,
    taskId: text(record.taskId),
    name: text(record.workflowName),
    description: text(record.summary) ?? text(record.workflowName) ?? id,
    status: workflowStatus(record.status),
    startedAt: iso(record.startTime) ?? endedAt ?? new Date(0).toISOString(),
    endedAt,
    sessionId,
    phases: phases.length ? phases : listed,
    agents,
    result: record.result,
    summary: text(record.summary),
    totalTokens: count(record.totalTokens),
    script: text(record.script),
  };
}

/**
 * A run without a record yet: still going, or cut off with its session. What it has done so far
 * is in its journal and in the meta of each agent it started.
 */
async function fromJournal(dir: string, id: string, scriptsDir: string, sessionId: string, live: boolean): Promise<WorkflowRun> {
  const journal = await readLines(join(dir, 'journal.jsonl'));
  const byAgent = new Map<string, WorkflowAgentState>();
  for (const entry of journal) {
    const agentId = text(entry.agentId);
    if (!agentId) continue;
    const known = byAgent.get(agentId);
    if (entry.type === 'started' && !known) {
      byAgent.set(agentId, {
        index: byAgent.size + 1,
        label: text(entry.label) ?? agentId,
        state: 'progress',
        agentId,
        phaseTitle: text(entry.phase),
        model: null,
        startedAt: null,
        durationMs: null,
        tokens: null,
        toolCalls: null,
        promptPreview: null,
        resultPreview: null,
      });
    } else if (entry.type === 'result' && known) {
      known.state = 'done';
      known.resultPreview = typeof entry.result === 'string' ? entry.result.slice(0, 200) : known.resultPreview;
    }
  }
  const script = (await readdir(scriptsDir).catch(() => [] as string[])).find((f) => f.endsWith(`-${id}.js`));
  const source = script ? await readFile(join(scriptsDir, script), 'utf8').catch(() => null) : null;
  const meta = source ? scriptMeta(source) : { name: null, description: null };
  const info = await stat(join(dir, 'journal.jsonl')).catch(() => stat(dir));
  const agents = [...byAgent.values()];
  const phases = [...new Set(agents.map((a) => a.phaseTitle).filter((t): t is string => Boolean(t)))];
  return {
    id,
    taskId: null,
    name: meta.name,
    description: meta.description ?? meta.name ?? id,
    // Nothing reports a workflow of a session that ended: it went down with it
    status: live ? 'running' : 'stopped',
    startedAt: (info.birthtimeMs ? info.birthtime : info.mtime).toISOString(),
    endedAt: live ? null : info.mtime.toISOString(),
    sessionId,
    phases,
    agents,
    summary: null,
    totalTokens: null,
    script: source,
  };
}

/**
 * The runs read from their files, kept while those files stay as they were: the lists that show
 * them are polled every couple of seconds, and a record carries the whole script and its result.
 */
export class WorkflowMemo {
  /** Runs kept at most, least recently read going first: each holds its script, and a long uptime sees many */
  private static readonly MAX_RUNS = 256;
  private readonly runs = new Map<string, { mtimeMs: number; size: number; live: boolean; run: WorkflowRun | null }>();

  /**
   * The run `read` makes of `file`, read again only when the file changed or so did `live`. A run
   * `settled` refuses is read again next time too: it depends on more than the file.
   */
  async get(file: string, live: boolean, read: () => Promise<WorkflowRun | null>, settled: (run: WorkflowRun | null) => boolean = () => true): Promise<WorkflowRun | null> {
    const info = await stat(file).catch(() => null);
    const known = this.runs.get(file);
    if (info && known && known.mtimeMs === info.mtimeMs && known.size === info.size && known.live === live) {
      this.runs.delete(file);
      this.runs.set(file, known);
      return known.run;
    }
    const run = await read();
    this.runs.delete(file);
    if (info && settled(run)) this.runs.set(file, { mtimeMs: info.mtimeMs, size: info.size, live, run });
    for (const oldest of this.runs.keys()) {
      if (this.runs.size <= WorkflowMemo.MAX_RUNS) break;
      this.runs.delete(oldest);
    }
    return run;
  }

  forget(drop: (file: string) => boolean): void {
    for (const file of [...this.runs.keys()]) if (drop(file)) this.runs.delete(file);
  }
}

/** Every workflow a session ran, from the files beside its transcript (`<session>.jsonl`). */
export async function readSessionWorkflows(transcript: string, sessionId: string, live: boolean, memo?: WorkflowMemo): Promise<WorkflowRun[]> {
  const base = transcript.slice(0, -'.jsonl'.length);
  const recordsDir = join(base, 'workflows');
  const runsDir = join(base, 'subagents', 'workflows');
  const cached = (file: string, read: () => Promise<WorkflowRun | null>, settled?: (run: WorkflowRun | null) => boolean) =>
    memo ? memo.get(file, live, read, settled) : read();
  const out = new Map<string, WorkflowRun>();
  for (const name of await readdir(recordsDir).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue;
    const file = join(recordsDir, name);
    // One not parsed yet may be half-written: only a record that read is kept
    const run = await cached(
      file,
      async () => {
        const record = await readJson(file);
        return record ? fromRecord(record, sessionId) : null;
      },
      (r) => r !== null,
    );
    if (run) out.set(run.id, run);
  }
  for (const id of await readdir(runsDir).catch(() => [] as string[])) {
    if (!id.startsWith('wf_') || out.has(id)) continue;
    // A run without a record changes as its journal grows; its script is written once, at its
    // start, so a run read before the script was there is read again
    const run = await cached(
      join(runsDir, id, 'journal.jsonl'),
      () => fromJournal(join(runsDir, id), id, join(recordsDir, 'scripts'), sessionId, live),
      (r) => r?.script != null,
    );
    if (run) out.set(id, run);
  }
  return [...out.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * A live chat's workflows: what its stream reported, merged with the files beside its transcript.
 *
 * The stream only knows the runs its own process started, under the task id; a chat resumed after
 * a restart, or taken over from a terminal, ran others before, and only the files know those. The
 * files know a run by its `wf_…` id, which is what an agent's transcript is filed under, so a run
 * both report keeps that id and the stream's fresher progress. `onDisk` is read as for an ended
 * session: a run without a record that the stream does not report went down with an earlier
 * process, unless it began after this one started and its first event is still on the way.
 */
export function mergeLiveWorkflows(streamed: readonly WorkflowRun[], onDisk: readonly WorkflowRun[], processStartedAt: string | null): WorkflowRun[] {
  const pending = new Set(streamed);
  const take = (match: (s: WorkflowRun) => boolean): WorkflowRun | undefined => {
    const found = [...pending].find(match);
    if (found) pending.delete(found);
    return found;
  };
  const agentIds = (run: WorkflowRun) => new Set(run.agents.map((a) => a.agentId).filter((id): id is string => id !== null));
  const out: WorkflowRun[] = [];
  // Strongest evidence first, so a weaker rule never takes the stream's run another disk run owns
  const rules: Array<(disk: WorkflowRun) => (s: WorkflowRun) => boolean> = [
    (disk) => (s) => disk.taskId !== null && s.taskId === disk.taskId,
    (disk) => {
      const ids = agentIds(disk);
      return (s) => s.agents.some((a) => a.agentId !== null && ids.has(a.agentId));
    },
    // The same script may have run before this process: only a run begun since can be the one it streams
    (disk) => (s) => disk.script !== null && s.script === disk.script && (processStartedAt === null || disk.startedAt >= processStartedAt),
  ];
  let remaining = [...onDisk];
  const pairs = new Map<WorkflowRun, WorkflowRun>();
  // onDisk is newest first, so a script that ran twice pairs with its latest run
  for (const rule of rules) {
    remaining = remaining.filter((disk) => {
      const live = take(rule(disk));
      if (live) pairs.set(disk, live);
      return !live;
    });
  }
  for (const disk of onDisk) {
    const live = pairs.get(disk);
    if (live) {
      out.push(joinRun(disk, live));
      continue;
    }
    const recent = processStartedAt !== null && disk.startedAt >= processStartedAt;
    // A record is final; a journal-only run is running only if this process can be the one running it
    out.push(disk.taskId === null && disk.status === 'stopped' && recent ? { ...disk, status: 'running', endedAt: null } : disk);
  }
  out.push(...pending);
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** One run both the files and the stream report: the files' id, and whichever knows more of the rest. */
function joinRun(disk: WorkflowRun, live: WorkflowRun): WorkflowRun {
  // The record is written when the run ends, and has its result and final progress
  const recorded = disk.taskId !== null;
  const base = recorded ? disk : { ...disk, status: live.status, endedAt: live.endedAt };
  return {
    ...base,
    taskId: live.taskId ?? disk.taskId,
    name: disk.name ?? live.name,
    startedAt: live.startedAt < disk.startedAt ? live.startedAt : disk.startedAt,
    phases: recorded && disk.phases.length ? disk.phases : live.phases.length ? live.phases : disk.phases,
    agents: recorded && disk.agents.length ? disk.agents : live.agents.length ? live.agents : disk.agents,
    summary: disk.summary ?? live.summary,
    totalTokens: disk.totalTokens ?? live.totalTokens,
    script: disk.script ?? live.script,
  };
}

/**
 * One agent of a workflow run, as the run's record reports it, or — for a run without a record yet —
 * whether its journal has a result for it. `agent` is null when neither knows it.
 */
export async function readWorkflowAgent(
  transcript: string,
  runId: string,
  agentId: string,
): Promise<{ agent: WorkflowAgentState | null; journalDone: boolean }> {
  const base = transcript.slice(0, -'.jsonl'.length);
  const record = await readJson(join(base, 'workflows', `${runId}.json`));
  const fromRecord = record ? readProgress(record.workflowProgress).agents.find((a) => a.agentId === agentId) : undefined;
  if (fromRecord) return { agent: fromRecord, journalDone: false };
  const journal = await readLines(join(base, 'subagents', 'workflows', runId, 'journal.jsonl'));
  const started = journal.find((e) => e.type === 'started' && e.agentId === agentId);
  const journalDone = journal.some((e) => e.type === 'result' && e.agentId === agentId);
  if (!started) return { agent: null, journalDone };
  return {
    agent: {
      index: 0,
      label: text(started.label) ?? agentId,
      state: journalDone ? 'done' : 'progress',
      agentId,
      phaseTitle: text(started.phase),
      model: null,
      startedAt: null,
      durationMs: null,
      tokens: null,
      toolCalls: null,
      promptPreview: null,
      resultPreview: null,
    },
    journalDone,
  };
}

/** The scripts of one `.claude/workflows/` directory, named as the Workflow tool names them: by `meta.name`, else the file's. */
export async function listWorkflowDirectory(dir: string, scope: WorkflowDefinition['scope']): Promise<WorkflowDefinition[]> {
  const out: WorkflowDefinition[] = [];
  const seen = new Set<string>();
  for (const file of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (!/\.(m?js)$/.test(file)) continue;
    const path = join(dir, file);
    const meta = scriptMeta(await readFile(path, 'utf8').catch(() => ''));
    const name = meta.name ?? basename(file).replace(/\.m?js$/, '');
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: meta.description, scope, path });
  }
  return out;
}

/**
 * Saved workflows the Workflow tool can run by name: the project's `.claude/workflows/` and the
 * user's. A project one shadows a user one of the same name, as the CLI resolves them.
 */
export async function listWorkflowDefinitions(configDir: string, cwd?: string): Promise<WorkflowDefinition[]> {
  const project = cwd ? await listWorkflowDirectory(join(cwd, '.claude', 'workflows'), 'project') : [];
  const taken = new Set(project.map((w) => w.name));
  const user = (await listWorkflowDirectory(join(configDir, 'workflows'), 'user')).filter((w) => !taken.has(w.name));
  return [...project, ...user];
}
