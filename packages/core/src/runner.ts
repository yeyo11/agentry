import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  entryText,
  normalizeMessage,
  type Attachment,
  type BackgroundTask,
  type EffectiveEnvironment,
  type PermissionDecision,
  type PermissionMode,
  type PermissionUpdate,
  type RateLimitInfo,
  type RunEvent,
  type RunOptions,
  type RunSettingsUpdate,
  type RunStatus,
  type RunSummary,
  type SubagentInfo,
  type WorkflowRun,
} from '@agentry/shared';
import { authFreeEnv } from './accounts.ts';
import type { Db } from './db.ts';
import type { CoreConfig } from './paths.ts';
import type { PermissionBroker } from './permissions.ts';
import type { SessionStore } from './sessions.ts';
import { composeContent, type UploadStore } from './uploads.ts';
import { readProgress, workflowStatus } from './workflows.ts';

/** A control request the CLI has not answered by then is not going to be answered */
const CONTROL_TIMEOUT_MS = 15_000;
const MAX_EVENTS_PER_RUN = 5000;
const MAX_PERSISTED_RUNS = 200;
const PARTIAL_THROTTLE_MS = 50;
const IDLE_TIMEOUT_MS = Number(process.env.AGENTRY_IDLE_TIMEOUT_MS ?? 10 * 60_000);
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
// High-frequency events that add nothing to the UI
const IGNORED_SUBTYPES = new Set(['thinking_tokens', 'hook_started', 'hook_response', 'commands_changed']);
/** Wording the CLI uses when the subscription window is spent (`result` text and stderr) */
const RATE_LIMIT_RE = /usage limit|rate limit|session limit|out of (?:usage|quota)|quota exceeded/i;
/** One rotate-and-resume per run: a second failure is a real one, not a quota one */
const MAX_ROTATION_RETRIES = 1;
const MAX_ATTACHMENTS = 20;

/** The CLI takes `manual` on the command line but reports that same mode as `default`. */
const reportedMode = (mode: string): PermissionMode => (mode === 'default' ? 'manual' : (mode as PermissionMode));

/** A person's decision in the shape `can_use_tool` expects; allowing always carries the input. */
function toControlDecision(decision: PermissionDecision, input: Record<string, unknown>): Record<string, unknown> {
  if (decision.behavior === 'deny') return { behavior: 'deny', message: decision.message ?? 'denied' };
  return {
    behavior: 'allow',
    updatedInput: decision.updatedInput ?? input,
    ...(decision.updatedPermissions?.length ? { updatedPermissions: decision.updatedPermissions } : {}),
  };
}

export interface RunResult {
  isError: boolean;
  result: string;
  structuredOutput: unknown;
  costUsd: number;
}

export interface RunMeta {
  orchestrationId?: string;
  orchestrationTaskId?: string;
}

const now = () => new Date().toISOString();

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const named = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? { name: x } : ((x ?? {}) as Record<string, unknown>))) : [];

function toEnvironment(cwd: string, runId: string, raw: Record<string, unknown>): EffectiveEnvironment {
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  const memory = raw.memory_paths && typeof raw.memory_paths === 'object' ? (raw.memory_paths as Record<string, unknown>) : {};
  return {
    cwd,
    observedAt: now(),
    runId,
    cliVersion: text(raw.claude_code_version),
    model: text(raw.model),
    permissionMode: text(raw.permissionMode),
    outputStyle: text(raw.output_style),
    tools: strings(raw.tools),
    mcpServers: named(raw.mcp_servers).map((s) => ({ name: String(s.name ?? ''), status: String(s.status ?? ''), source: text(s.source) ?? undefined })),
    // agents/skills are plain names on some versions and objects on others
    agents: named(raw.agents).map((a) => String(a.name ?? a.agentType ?? '')).filter(Boolean),
    skills: named(raw.skills).map((s) => String(s.name ?? '')).filter(Boolean),
    slashCommands: strings(raw.slash_commands),
    plugins: named(raw.plugins).map((p) => ({ name: String(p.name ?? ''), path: text(p.path) ?? undefined, source: text(p.source) ?? undefined })),
    memoryPaths: Object.fromEntries(Object.entries(memory).filter((e): e is [string, string] => typeof e[1] === 'string')),
  };
}

class Run {
  id: string = randomUUID();
  readonly emitter = new EventEmitter();
  readonly events: RunEvent[] = [];
  readonly tasks = new Map<string, BackgroundTask>();
  /** Long commands the CLI reports as tasks while they run in the foreground; listed once sent to the background */
  readonly foregroundTasks = new Map<string, BackgroundTask>();
  readonly subagents = new Map<string, SubagentInfo>();
  readonly workflows = new Map<string, WorkflowRun>();
  proc: ChildProcessWithoutNullStreams | null = null;
  seq = 0;
  status: RunStatus = 'starting';
  sessionId: string | null;
  model: string | null;
  name: string;
  cwd: string;
  permissionMode: PermissionMode;
  createdAt = now();
  updatedAt = now();
  endedAt: string | null = null;
  turns = 0;
  costUsd = 0;
  lastText: string | null = null;
  /** Where the CLI says it works, from its init event: a worktree when it was given one */
  workingDir: string | null = null;
  error: string | null = null;
  lastResult: RunResult | null = null;
  stopRequested = false;
  idleTimer: NodeJS.Timeout | null = null;
  partial: { block: 'text' | 'thinking'; text: string } | null = null;
  partialTimer: NodeJS.Timeout | null = null;
  /** Control requests sent to the CLI, by request_id, waiting for its control_response */
  readonly controls = new Map<string, { resolve: (response: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  controlSeq = 0;
  /** Prompts the CLI is holding for a person */
  pendingPrompts = 0;
  /** The turn is ending because someone interrupted it, not because it failed */
  interruptRequested = false;
  /** The last turn sent, files included, so a turn lost to a rate limit is replayed whole */
  lastUserTurn: { text: string; attachments: string[] } | null = null;
  /** The turn died against the account's rate limit */
  rateLimited = false;
  /** A rotation was already asked for this attempt */
  rotationRequested = false;
  rotationRetries = 0;

  constructor(
    readonly opts: RunOptions,
    readonly meta: RunMeta,
    config: CoreConfig,
  ) {
    this.cwd = resolve(opts.cwd ?? config.workspaceDir);
    this.permissionMode = opts.permissionMode ?? config.defaultPermissionMode;
    this.model = opts.model ?? null;
    this.sessionId = opts.resumeSessionId ?? null;
    this.name = opts.name ?? `${basename(this.cwd)}-${this.id.slice(0, 6)}`;
    this.emitter.setMaxListeners(100);
  }

  /** Rebuilds a run persisted by a previous wrapper process; it has no process until a message resumes it. */
  static restore(saved: RunSummary, config: CoreConfig): Run {
    const run = new Run(
      {
        prompt: saved.prompt,
        cwd: saved.cwd,
        name: saved.name,
        model: saved.model ?? undefined,
        permissionMode: saved.permissionMode,
        internal: saved.internal,
        account: saved.account ?? undefined,
        permissionPrompts: saved.permissionPrompts,
      },
      { orchestrationId: saved.orchestrationId ?? undefined, orchestrationTaskId: saved.orchestrationTaskId ?? undefined },
      config,
    );
    run.id = saved.id;
    run.sessionId = saved.sessionId;
    // Anything that was alive when the wrapper stopped is gone now
    run.status = ['completed', 'failed'].includes(saved.status) ? saved.status : 'stopped';
    run.createdAt = saved.createdAt;
    run.updatedAt = saved.updatedAt;
    run.endedAt = saved.endedAt ?? saved.updatedAt;
    run.turns = saved.turns;
    run.costUsd = saved.costUsd;
    run.lastText = saved.lastText;
    run.error = saved.error;
    run.workingDir = saved.workingDir ?? null;
    return run;
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  summary(): RunSummary {
    return {
      id: this.id,
      name: this.name,
      sessionId: this.sessionId,
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
      status: this.status,
      pid: this.alive ? (this.proc?.pid ?? null) : null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      endedAt: this.endedAt,
      turns: this.turns,
      costUsd: this.costUsd,
      prompt: this.opts.prompt,
      lastText: this.lastText,
      error: this.error,
      orchestrationId: this.meta.orchestrationId ?? null,
      orchestrationTaskId: this.meta.orchestrationTaskId ?? null,
      internal: this.opts.internal === true,
      account: this.opts.account ?? null,
      backgroundTasks: [...this.tasks.values()],
      subagents: [...this.subagents.values()],
      workflows: [...this.workflows.values()],
      workingDir: this.workingDir ?? (this.opts.worktree ? join(this.cwd, '.claude', 'worktrees', this.opts.worktree) : this.cwd),
      permissionPrompts: this.opts.permissionPrompts === 'host' ? 'host' : 'none',
      pendingPrompts: this.pendingPrompts,
    };
  }

  push(event: Omit<RunEvent, 'seq' | 'ts'>): void {
    const full: RunEvent = { ...event, seq: ++this.seq, ts: now() };
    this.events.push(full);
    if (this.events.length > MAX_EVENTS_PER_RUN) this.events.splice(0, this.events.length - MAX_EVENTS_PER_RUN);
    this.updatedAt = full.ts;
    this.emitter.emit('event', full);
  }

  /** Streams the in-progress block to live subscribers only: not stored, not replayed, seq untouched. */
  emitPartial(): void {
    if (this.partialTimer) return;
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null;
      if (!this.partial) return;
      this.emitter.emit('event', {
        seq: this.seq,
        ts: now(),
        kind: 'partial',
        type: 'stream_event',
        block: this.partial.block,
        text: this.partial.text,
      } satisfies RunEvent);
    }, PARTIAL_THROTTLE_MS);
  }

  setStatus(status: RunStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.push({ kind: 'status', type: 'status', status });
  }
}

/**
 * Manages `claude -p` processes using stream-json input/output.
 * Each Run is a live conversation: it accepts multiple turns over stdin and, if the
 * process already exited, it is respawned with `--resume` when a new message arrives.
 */
/** What the runner needs to know about claude-swap, injected by Core to avoid a cycle. */
export interface AccountResolver {
  /** claude-swap is installed and has at least one account registered */
  readonly managed: boolean;
  isActive(identifier: string): boolean;
}

export class RunManager extends EventEmitter {
  private readonly runs = new Map<string, Run>();
  lastRateLimit: RateLimitInfo | null = null;
  /** Set when claude-swap manages the accounts; null leaves runs on the active credential */
  accounts: AccountResolver | null = null;
  /** Where runs with `permissionPrompts: 'host'` send what they ask; null means nobody answers */
  permissions: PermissionBroker | null = null;
  /** Files attached to messages; every run may read them */
  uploads: UploadStore | null = null;
  /** Latest `init` snapshot per working directory */
  readonly environments = new Map<string, EffectiveEnvironment>();

  private readonly file: string;

  constructor(
    private readonly config: CoreConfig,
    private readonly db: Db,
  ) {
    super();
    this.file = join(config.dataDir, 'runs.json');
    for (const env of db.loadEnvironments()) this.environments.set(env.cwd, env);
  }

  private persist(): void {
    // Internal runs are persisted too. The flag means "housekeeping: no transcript, hidden from
    // the session list", not "disposable": the orchestration planner is internal and costs real
    // money, and dropping it on restart took the only record of that work with it. The other
    // internal run, the auth check, removes itself as soon as it finishes.
    const summaries = this.list()
      .slice(0, MAX_PERSISTED_RUNS)
      .map((r) => ({ ...r, backgroundTasks: [], subagents: [], workflows: [] }));
    try {
      this.db.saveRuns(summaries, MAX_PERSISTED_RUNS);
    } catch {
      // persistence is best-effort: losing a save must never take the live run down with it
    }
  }

  /** Carries a pre-SQLite `runs.json` into the store once, then renames it out of the way. */
  private importLegacy(): void {
    if (!existsSync(this.file)) return;
    try {
      this.db.saveRuns(JSON.parse(readFileSync(this.file, 'utf8')) as RunSummary[], MAX_PERSISTED_RUNS);
    } catch {
      // corrupt file: there is nothing to carry over
    }
    try {
      renameSync(this.file, `${this.file}.migrated`);
    } catch {
      // another process got there first
    }
  }

  /**
   * Loads the runs of previous wrapper processes. Their event buffers are rebuilt from the
   * session transcripts, so a restored run can be opened and continued like a live one.
   */
  async restore(sessions: SessionStore): Promise<void> {
    this.importLegacy();
    for (const summary of this.db.loadRuns()) {
      if (this.runs.has(summary.id)) continue;
      const run = Run.restore(summary, this.config);
      this.runs.set(run.id, run);
      const detail = run.sessionId ? await sessions.getSession(run.sessionId, { includeSidechains: true }).catch(() => null) : null;
      for (const entry of detail?.entries ?? []) run.push({ kind: 'message', type: entry.role, entry });
      run.updatedAt = summary.updatedAt; // push() bumped it
    }
  }

  list(): RunSummary[] {
    return [...this.runs.values()].map((r) => r.summary()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): RunSummary | null {
    return this.runs.get(id)?.summary() ?? null;
  }

  events(id: string, sinceSeq = 0): RunEvent[] {
    return this.runs.get(id)?.events.filter((e) => e.seq > sinceSeq) ?? [];
  }

  activeCount(): number {
    return [...this.runs.values()].filter((r) => r.alive).length;
  }

  subscribe(id: string, listener: (event: RunEvent) => void): () => void {
    const run = this.runs.get(id);
    if (!run) return () => {};
    run.emitter.on('event', listener);
    return () => run.emitter.off('event', listener);
  }

  start(opts: RunOptions, meta: RunMeta = {}): RunSummary {
    if (!opts.prompt?.trim() && !opts.attachments?.length) throw new Error('prompt is required');
    if (opts.account && !this.accounts?.managed) {
      throw new Error('no claude-swap account is registered: a run cannot be pinned to one');
    }
    if (this.activeCount() >= this.config.maxConcurrentRuns) {
      throw new Error(`Concurrent run limit reached (${this.config.maxConcurrentRuns})`);
    }
    const attachments = this.resolveAttachments(opts.attachments);
    const run = new Run(opts, meta, this.config);
    if (!existsSync(run.cwd)) mkdirSync(run.cwd, { recursive: true });
    this.runs.set(run.id, run);
    this.spawnProcess(run, opts.prompt, attachments);
    return run.summary();
  }

  /** Sends a new turn. If the process is gone, the session is resumed with --resume. */
  send(id: string, text: string, attachmentIds: string[] = []): RunSummary {
    const run = this.runs.get(id);
    if (!run) throw new Error('run not found');
    const attachments = this.resolveAttachments(attachmentIds);
    if (!text.trim() && attachments.length === 0) throw new Error('text is required');
    if (run.alive) {
      this.writeUserMessage(run, text, attachments);
    } else {
      if (!run.sessionId) throw new Error('The run ended without a sessionId; it cannot be resumed');
      this.spawnProcess(run, text, attachments);
    }
    return run.summary();
  }

  /** Looks the uploads up before anything starts, so a bad id fails the request, not the turn. */
  private resolveAttachments(ids: string[] = []): Attachment[] {
    if (ids.length === 0) return [];
    if (!this.uploads) throw new Error('attachments are not available');
    if (ids.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} files can be attached to one message`);
    const uploads = this.uploads;
    return ids.map((id) => uploads.get(String(id)));
  }

  stop(id: string): RunSummary {
    const run = this.runs.get(id);
    if (!run) throw new Error('run not found');
    run.stopRequested = true;
    if (run.alive) {
      run.proc?.kill('SIGTERM');
      setTimeout(() => run.alive && run.proc?.kill('SIGKILL'), 5000).unref();
    }
    return run.summary();
  }

  /**
   * Ends the current turn and keeps the process: the CLI withdraws any prompt it was holding and
   * waits for the next message, unlike `stop`, which takes the process down.
   */
  async interrupt(id: string): Promise<RunSummary> {
    const run = this.runs.get(id);
    if (!run) throw new Error('run not found');
    if (!run.alive) throw new Error('the run has no live process to interrupt');
    if (run.status !== 'busy' && run.status !== 'starting') return run.summary();
    run.interruptRequested = true;
    try {
      await this.control(run, { subtype: 'interrupt' });
    } catch (err) {
      run.interruptRequested = false;
      throw err;
    }
    return run.summary();
  }

  /**
   * Changes the permission mode or the model. A live process switches at once; one that has
   * exited gets them when the next message resumes it.
   */
  async updateSettings(id: string, update: RunSettingsUpdate): Promise<RunSummary> {
    const run = this.runs.get(id);
    if (!run) throw new Error('run not found');
    const { permissionMode, model } = update;
    if (permissionMode !== undefined) {
      if (run.alive) await this.control(run, { subtype: 'set_permission_mode', mode: permissionMode });
      run.permissionMode = permissionMode;
    }
    if (model !== undefined) {
      const next = model.trim();
      if (!next) throw new Error('model must not be empty');
      if (run.alive) await this.control(run, { subtype: 'set_model', model: next });
      run.opts.model = next;
      run.model = next;
    }
    this.persist();
    return run.summary();
  }

  /** Sends a control request down the run's stdin and resolves with the CLI's response. */
  private control(run: Run, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = `agentry-${String(++run.controlSeq)}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        run.controls.delete(requestId);
        reject(new Error(`the CLI did not answer ${String(request.subtype)} in time`));
      }, CONTROL_TIMEOUT_MS);
      timer.unref();
      run.controls.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolvePromise(response);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.write(run, { type: 'control_request', request_id: requestId, request });
    });
  }

  private write(run: Run, message: unknown): void {
    run.proc?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** The CLI asks the host something: a tool permission, a question, a plan to approve. */
  private handleControlRequest(run: Run, requestId: string, request: Record<string, unknown>): void {
    const reply = (response: Record<string, unknown>) =>
      this.write(run, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    if (request.subtype !== 'can_use_tool') {
      // Hooks and SDK MCP servers are never registered, so nothing else should arrive; an answer
      // still has to, or the CLI waits for it
      this.write(run, {
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: `Agentry does not handle ${String(request.subtype)}` },
      });
      return;
    }
    const input = (request.input ?? {}) as Record<string, unknown>;
    const broker = this.permissions;
    if (!broker || run.opts.permissionPrompts !== 'host') {
      reply({ behavior: 'deny', message: 'Nobody is answering permission prompts for this run' });
      return;
    }
    run.pendingPrompts++;
    void broker
      .ask({
        id: requestId,
        runId: run.id,
        toolName: String(request.tool_name ?? 'unknown'),
        toolUseId: typeof request.tool_use_id === 'string' ? request.tool_use_id : '',
        input,
        requestedAt: now(),
        ...(typeof request.description === 'string' ? { description: request.description } : {}),
        ...(Array.isArray(request.permission_suggestions) ? { suggestions: request.permission_suggestions as PermissionUpdate[] } : {}),
        ...(request.requires_user_interaction === true ? { requiresUserInteraction: true } : {}),
      })
      .then((decision) => {
        run.pendingPrompts = Math.max(0, run.pendingPrompts - 1);
        // Withdrawn by the CLI, or the process is gone: nobody is waiting for an answer
        if (!decision || !run.alive) return;
        reply(toControlDecision(decision, input));
      });
  }

  remove(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.alive) return false;
    this.runs.delete(id);
    this.db.deleteRun(id);
    this.persist();
    return true;
  }

  stopAll(): void {
    for (const run of this.runs.values()) if (run.alive) this.stop(run.id);
  }

  /** Resolves with the first `result` after the call, or when the process exits. */
  /** The result of a run that is already over, or null while it can still produce one. */
  private static settled(run: Run): RunResult | null {
    if (run.lastResult) return run.lastResult;
    if (!['completed', 'failed', 'stopped'].includes(run.status)) return null;
    return {
      isError: true,
      result: run.error ?? `The process ended (${run.status}) without a result`,
      structuredOutput: undefined,
      costUsd: run.costUsd,
    };
  }

  waitForResult(id: string): Promise<RunResult> {
    const run = this.runs.get(id);
    if (!run) return Promise.reject(new Error('run not found'));
    // A run that has already ended emits nothing further, so subscribing alone would wait for an
    // event that never comes. Anything awaiting it — the planner holds an HTTP request open —
    // would hang until the process dies.
    const ended = RunManager.settled(run);
    if (ended) return Promise.resolve(ended);
    return new Promise((resolvePromise) => {
      const onEvent = (event: RunEvent) => {
        if (event.kind === 'result' && run.lastResult) finish(run.lastResult);
        else if (event.kind === 'status' && ['completed', 'failed', 'stopped'].includes(event.status ?? '')) {
          finish(
            run.lastResult ?? {
              isError: true,
              result: run.error ?? `The process ended (${event.status}) without a result`,
              structuredOutput: undefined,
              costUsd: run.costUsd,
            },
          );
        }
      };
      const finish = (result: RunResult) => {
        run.emitter.off('event', onEvent);
        resolvePromise(result);
      };
      run.emitter.on('event', onEvent);
    });
  }

  private buildArgs(run: Run, resuming: boolean): string[] {
    const { opts } = run;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', run.permissionMode,
      // Makes bypassPermissions a mode the run can be switched to later, without starting in it: the
      // CLI refuses the switch otherwise. Starting a run in that mode is already open to the same caller.
      '--allow-dangerously-skip-permissions',
    ];
    if (resuming && run.sessionId) {
      args.push('--resume', run.sessionId);
    } else {
      run.sessionId = randomUUID();
      args.push('--session-id', run.sessionId, '--name', run.name);
    }
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
    if (opts.allowedTools?.length) args.push(`--allowedTools=${opts.allowedTools.join(',')}`);
    // Attached files live outside every project; this is what lets Claude open them by path
    if (this.uploads) args.push('--add-dir', this.uploads.dir);
    // The CLI creates, names and locks the worktree itself, and works in it for the session
    if (opts.worktree) args.push('--worktree', opts.worktree);
    // The CLI stops the run itself once the ceiling is reached, which no amount of watching from
    // out here could do reliably
    if (typeof opts.maxBudgetUsd === 'number' && opts.maxBudgetUsd > 0) {
      args.push('--max-budget-usd', String(opts.maxBudgetUsd));
    }
    // Prompts go to a host only when something is listening: a run waiting on an answer that never
    // comes is worse than one told plainly that it was denied. `stdio` makes the CLI ask on its own
    // stdout as control requests, the same channel the Agent SDK uses, and read the answer on stdin.
    if (opts.permissionPrompts === 'host' && this.permissions) {
      args.push('--permission-prompts', 'host', '--permission-prompt-tool', 'stdio');
    } else {
      args.push('--permission-prompts', 'none');
    }
    if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));
    if (opts.internal) args.push('--no-session-persistence');
    return args;
  }

  /**
   * `cswap run <account> --share-history -- <claude args>` execs Claude Code against that
   * account's session profile; `--share-history` symlinks `projects/` back to the real config
   * dir, so the transcript still lands where the session store reads it. Pinning to the account
   * that is already active would create a second credential copy that can drift, so it is
   * spawned as a plain `claude` instead.
   */
  private command(run: Run, args: string[]): [string, string[]] {
    const account = run.opts.account;
    if (!account || !this.accounts?.managed || this.accounts.isActive(account)) return [this.config.claudeBin, args];
    return [this.config.cswapBin, ['run', account, '--share-history', '--', ...args]];
  }

  private spawnProcess(run: Run, prompt: string, attachments: Attachment[] = []): void {
    const resuming = run.sessionId !== null;
    const args = this.buildArgs(run, resuming);
    run.stopRequested = false;
    run.endedAt = null;
    run.error = null;
    run.rateLimited = false;
    run.setStatus('starting');

    const [bin, argv] = this.command(run, args);
    // A pinned run must never inherit a token from the environment: it would override the account
    const proc = spawn(bin, argv, { cwd: run.cwd, env: run.opts.account ? authFreeEnv() : process.env, stdio: 'pipe' });
    run.proc = proc;

    createInterface({ input: proc.stdout }).on('line', (line) => this.handleLine(run, line));
    createInterface({ input: proc.stderr }).on('line', (line) => {
      if (!line.trim()) return;
      if (RATE_LIMIT_RE.test(line)) run.rateLimited = true;
      run.push({ kind: 'stderr', type: 'stderr', text: line });
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => {
      run.error = err.message;
      this.finalize(run, 'failed');
    });
    proc.on('exit', (code) => {
      if (run.stopRequested) this.finalize(run, 'stopped');
      else if (code === 0) this.finalize(run, 'completed');
      else {
        run.error ??= run.events.filter((e) => e.kind === 'stderr').slice(-3).map((e) => e.text).join('\n') || `exit code ${code}`;
        this.finalize(run, 'failed');
      }
    });

    this.writeUserMessage(run, prompt, attachments);
  }

  private writeUserMessage(run: Run, text: string, attachments: Attachment[] = []): void {
    run.lastUserTurn = { text, attachments: attachments.map((a) => a.id) };
    if (run.idleTimer) clearTimeout(run.idleTimer);
    const uploads = this.uploads;
    const content = attachments.length && uploads ? composeContent(text, attachments, (id) => uploads.read(id).bytes) : text;
    const payload = { type: 'user', message: { role: 'user', content } };
    run.proc?.stdin.write(`${JSON.stringify(payload)}\n`);
    run.push({
      kind: 'message',
      type: 'user',
      entry: {
        uuid: randomUUID(),
        role: 'user',
        timestamp: now(),
        model: null,
        isSidechain: false,
        parentToolUseId: null,
        blocks: [
          ...attachments
            .filter((a) => a.kind !== 'file')
            .map((a) => ({ type: a.kind === 'image' ? ('image' as const) : ('document' as const), mediaType: a.mediaType, name: a.name, uploadId: a.id })),
          { type: 'text', text: Array.isArray(content) ? String((content.at(-1) as { text: string }).text) : text },
        ],
      },
    });
    run.setStatus('busy');
  }

  private finalize(run: Run, status: RunStatus): void {
    if (run.endedAt) return;
    if (run.idleTimer) clearTimeout(run.idleTimer);
    run.endedAt = now();
    // A prompt still waiting belongs to a process that is gone: nobody can act on the answer.
    this.permissions?.denyAllFor(run.id);
    for (const control of run.controls.values()) control.reject(new Error('the run ended before the CLI answered'));
    run.controls.clear();
    for (const task of run.tasks.values()) {
      if (task.status === 'running') Object.assign(task, { status: 'stopped', endedAt: run.endedAt });
    }
    for (const sub of run.subagents.values()) {
      if (sub.status === 'running') Object.assign(sub, { status: 'failed', endedAt: run.endedAt });
    }
    for (const workflow of run.workflows.values()) {
      if (workflow.status === 'running') Object.assign(workflow, { status: 'stopped', endedAt: run.endedAt });
    }
    run.setStatus(status);
    this.persist();
    this.emit('run-ended', run.summary());
    this.maybeRotate(run);
  }

  /**
   * Asks for one account rotation per attempt. The turn can die against the limit while the
   * process stays alive (keepAlive) or by taking it down, so both paths end up here.
   */
  private maybeRotate(run: Run): void {
    if (!run.rateLimited || run.rotationRequested || !run.lastUserTurn) return;
    if (run.rotationRetries >= MAX_ROTATION_RETRIES) return;
    run.rotationRequested = true;
    this.emit('rate-limited', run.summary());
  }

  /** A wrapper-generated line in the transcript (account rotations, retries). */
  notice(id: string, text: string, data?: Record<string, unknown>): void {
    this.runs.get(id)?.push({ kind: 'notice', type: 'notice', text, ...(data ? { data } : {}) });
  }

  /**
   * Re-sends the turn that died against the rate limit. The process is gone by now, so `send`
   * respawns it with `--resume` — on whichever account is active at that point.
   */
  async replayLastTurn(id: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || !run.lastUserTurn || !run.sessionId || run.rotationRetries >= MAX_ROTATION_RETRIES) return false;
    run.rotationRetries++;
    run.rateLimited = false;
    run.rotationRequested = false;
    // A live process holds the old account's token in memory: only a respawn picks up the new one
    if (run.alive) {
      const proc = run.proc;
      this.stop(id);
      if (proc) await once(proc, 'exit');
    }
    this.send(id, run.lastUserTurn.text, run.lastUserTurn.attachments);
    return true;
  }

  private handleLine(run: Run, line: string): void {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (line.trim()) run.push({ kind: 'other', type: 'stdout', text: line });
      return;
    }
    const type = String(raw.type ?? 'unknown');
    const subtype = typeof raw.subtype === 'string' ? raw.subtype : undefined;
    if (subtype && IGNORED_SUBTYPES.has(subtype)) return;

    if (type === 'control_request') {
      if (typeof raw.request_id === 'string') this.handleControlRequest(run, raw.request_id, (raw.request ?? {}) as Record<string, unknown>);
      return;
    }
    if (type === 'control_cancel_request') {
      if (typeof raw.request_id === 'string') this.permissions?.withdraw(raw.request_id);
      return;
    }
    if (type === 'control_response') {
      const response = (raw.response ?? {}) as Record<string, unknown>;
      const control = typeof response.request_id === 'string' ? run.controls.get(response.request_id) : undefined;
      if (!control || typeof response.request_id !== 'string') return;
      run.controls.delete(response.request_id);
      if (response.subtype === 'error') control.reject(new Error(String(response.error ?? 'the CLI refused the request')));
      else control.resolve((response.response ?? {}) as Record<string, unknown>);
      return;
    }

    // The mode changes under the run's feet: set from the panel, or by the model leaving plan mode
    if (type === 'system' && subtype === 'status' && typeof raw.permissionMode === 'string') {
      run.permissionMode = reportedMode(raw.permissionMode);
      run.updatedAt = now();
      return;
    }

    if (type === 'stream_event') {
      // Token-level deltas of the main agent; the full block follows as a regular `assistant` event
      if (raw.parent_tool_use_id != null) return;
      const event = (raw.event ?? {}) as Record<string, unknown>;
      if (event.type === 'content_block_start') {
        const blockType = (event.content_block as Record<string, unknown> | undefined)?.type;
        run.partial = blockType === 'text' || blockType === 'thinking' ? { block: blockType, text: '' } : null;
      } else if (event.type === 'content_block_delta' && run.partial) {
        const delta = (event.delta ?? {}) as Record<string, unknown>;
        const chunk = delta.type === 'text_delta' ? delta.text : delta.type === 'thinking_delta' ? delta.thinking : null;
        if (typeof chunk === 'string' && chunk) {
          run.partial.text += chunk;
          run.emitPartial();
        }
      } else if (event.type === 'content_block_stop') {
        run.partial = null;
      }
      return;
    }

    if (type === 'assistant' || type === 'user') {
      const entry = normalizeMessage(raw);
      if (!entry) return;
      this.trackSubagents(run, entry);
      // The CLI can start a turn on its own (e.g. after a background task notification)
      if (entry.role === 'assistant' && run.status === 'idle') {
        if (run.idleTimer) clearTimeout(run.idleTimer);
        run.setStatus('busy');
      }
      if (entry.role === 'assistant' && !entry.isSidechain) {
        const text = entryText(entry);
        if (text) run.lastText = text.slice(0, 2000);
        if (entry.model) run.model = entry.model;
      }
      run.push({ kind: 'message', type, entry });
      return;
    }

    if (type === 'system' && subtype === 'init') {
      if (typeof raw.session_id === 'string') run.sessionId = raw.session_id;
      if (typeof raw.permissionMode === 'string') run.permissionMode = reportedMode(raw.permissionMode);
      if (typeof raw.model === 'string') run.model = raw.model;
      if (typeof raw.cwd === 'string') run.workingDir = raw.cwd;
      const environment = toEnvironment(run.cwd, run.id, raw);
      this.environments.set(run.cwd, environment);
      try {
        this.db.saveEnvironment(environment);
      } catch {
        // the panel only loses this directory until its next run
      }
      run.push({
        kind: 'init',
        type,
        subtype,
        data: { model: raw.model, cwd: raw.cwd, permissionMode: raw.permissionMode, mcp_servers: raw.mcp_servers, tools: raw.tools },
      });
      return;
    }

    if (type === 'system' && subtype && (subtype.startsWith('task_') || subtype === 'background_tasks_changed')) {
      this.trackTask(run, subtype, raw);
      run.push({ kind: 'task', type, subtype, data: raw });
      return;
    }

    if (type === 'rate_limit_event') {
      const info = raw.rate_limit_info as Record<string, unknown> | undefined;
      if (String(info?.status ?? '') === 'rejected') run.rateLimited = true;
      if (info) {
        this.lastRateLimit = {
          status: String(info.status ?? ''),
          rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
          resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
          windows: (info.unifiedWindows as RateLimitInfo['windows'] | undefined) ?? {},
          observedAt: now(),
        };
      }
      return;
    }

    if (type === 'result') {
      run.turns += typeof raw.num_turns === 'number' ? raw.num_turns : 1;
      if (typeof raw.total_cost_usd === 'number') run.costUsd = Math.max(run.costUsd, raw.total_cost_usd);
      const isError = raw.is_error === true;
      const result = typeof raw.result === 'string' ? raw.result : '';
      if (isError && (raw.api_error_status === 429 || RATE_LIMIT_RE.test(result))) run.rateLimited = true;
      run.lastResult = { isError, result, structuredOutput: raw.structured_output, costUsd: run.costUsd };
      // An interrupted turn ends as an error by the CLI's account, but nothing went wrong
      if (isError && !run.interruptRequested) run.error = result || String(subtype ?? 'error');
      run.interruptRequested = false;
      this.persist();
      run.push({
        kind: 'result',
        type,
        subtype,
        text: result,
        data: {
          is_error: isError,
          num_turns: raw.num_turns,
          duration_ms: raw.duration_ms,
          total_cost_usd: raw.total_cost_usd,
          structured_output: raw.structured_output,
          permission_denials: raw.permission_denials,
        },
      });
      if (run.opts.keepAlive === false) {
        run.proc?.stdin.end();
      } else {
        run.setStatus('idle');
        run.idleTimer = setTimeout(() => run.proc?.stdin.end(), IDLE_TIMEOUT_MS);
        run.idleTimer.unref();
      }
      this.maybeRotate(run);
      return;
    }

    run.push({ kind: 'other', type, subtype, data: raw });
  }

  private trackSubagents(run: Run, entry: NonNullable<ReturnType<typeof normalizeMessage>>): void {
    if (entry.isSidechain) return;
    for (const block of entry.blocks) {
      if (block.type === 'tool_use' && SUBAGENT_TOOLS.has(block.name)) {
        const input = (block.input ?? {}) as Record<string, unknown>;
        run.subagents.set(block.id, {
          toolUseId: block.id,
          runId: run.id,
          runName: run.name,
          subagentType: String(input.subagent_type ?? 'general-purpose'),
          description: String(input.description ?? input.prompt ?? '').slice(0, 200),
          status: 'running',
          startedAt: now(),
          endedAt: null,
        });
      } else if (block.type === 'tool_result') {
        const sub = run.subagents.get(block.toolUseId);
        // A background agent's tool result only says it was launched; its task notification ends it
        if (sub && sub.status === 'running' && !sub.background) {
          sub.status = block.isError ? 'failed' : 'completed';
          sub.endedAt = now();
        }
      }
    }
  }

  /**
   * Everything the CLI delegates is a task to it, told apart by `task_type`: shell commands
   * (`local_bash`, reported even while they run in the foreground), subagents (`local_agent`) and
   * workflows (`local_workflow`) each go to their own list. Anything else it runs in the background
   * (monitors, remote agents…) is listed as a background task under its own type.
   */
  private trackTask(run: Run, subtype: string, raw: Record<string, unknown>): void {
    const taskId = typeof raw.task_id === 'string' ? raw.task_id : null;
    if (!taskId) return;
    if (subtype === 'task_started') {
      const type = String(raw.task_type ?? 'unknown');
      if (type === 'local_agent') return this.startAgentTask(run, taskId, raw);
      if (type === 'local_workflow') {
        run.workflows.set(taskId, {
          id: taskId,
          taskId,
          name: typeof raw.workflow_name === 'string' ? raw.workflow_name : null,
          description: String(raw.description ?? raw.workflow_name ?? taskId),
          status: 'running',
          startedAt: now(),
          endedAt: null,
          runId: run.id,
          runName: run.name,
          source: 'run',
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          phases: [],
          agents: [],
          summary: null,
          totalTokens: null,
          script: typeof raw.prompt === 'string' ? raw.prompt : null,
        });
        return;
      }
      const task: BackgroundTask = {
        id: taskId,
        runId: run.id,
        runName: run.name,
        type,
        description: String(raw.description ?? ''),
        status: 'running',
        toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : null,
        startedAt: now(),
        endedAt: null,
        summary: null,
      };
      if (raw.is_backgrounded === false) run.foregroundTasks.set(taskId, task);
      else run.tasks.set(taskId, task);
      return;
    }

    const workflow = run.workflows.get(taskId);
    if (workflow) return this.updateWorkflow(workflow, subtype, raw);
    const agent = [...run.subagents.values()].find((s) => s.agentId === taskId);
    if (agent) return this.updateAgentTask(agent, subtype, raw);

    const patch = (raw.patch ?? {}) as Record<string, unknown>;
    const waiting = run.foregroundTasks.get(taskId);
    if (waiting) {
      // Sent to the background mid-run (by the model or the person): from now on it is one
      if (subtype === 'task_updated' && patch.is_backgrounded === true) {
        run.foregroundTasks.delete(taskId);
        run.tasks.set(taskId, waiting);
      } else {
        if (subtype === 'task_notification') run.foregroundTasks.delete(taskId);
        return;
      }
    }
    const task = run.tasks.get(taskId);
    if (!task) return;
    if (subtype === 'task_updated') {
      if (typeof patch.status === 'string') task.status = patch.status;
      if (patch.end_time != null) task.endedAt = now();
    } else if (subtype === 'task_notification') {
      if (typeof raw.status === 'string') task.status = raw.status;
      if (typeof raw.summary === 'string') task.summary = raw.summary;
      task.endedAt ??= now();
    }
  }

  /** The Agent tool call it belongs to was seen first; the task adds its id and whether it runs in the background. */
  private startAgentTask(run: Run, taskId: string, raw: Record<string, unknown>): void {
    const toolUseId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '';
    const background = raw.is_backgrounded === true;
    const known = run.subagents.get(toolUseId);
    if (known) {
      Object.assign(known, { agentId: taskId, background });
      if (typeof raw.subagent_type === 'string') known.subagentType = raw.subagent_type;
      // Its launch result may have closed it already; a background agent is only done when it says so
      if (background && known.status !== 'running') Object.assign(known, { status: 'running', endedAt: null });
      return;
    }
    // Spawned by a subagent rather than the main agent: no tool call of its own reached the stream
    run.subagents.set(toolUseId || taskId, {
      toolUseId,
      runId: run.id,
      runName: run.name,
      subagentType: String(raw.subagent_type ?? 'general-purpose'),
      description: String(raw.description ?? '').slice(0, 200),
      status: 'running',
      startedAt: now(),
      endedAt: null,
      agentId: taskId,
      background,
    });
  }

  private updateAgentTask(agent: SubagentInfo, subtype: string, raw: Record<string, unknown>): void {
    const patch = (raw.patch ?? {}) as Record<string, unknown>;
    const status = subtype === 'task_notification' ? raw.status : subtype === 'task_updated' ? patch.status : undefined;
    if (status === 'completed') Object.assign(agent, { status: 'completed', endedAt: agent.endedAt ?? now() });
    else if (status === 'failed' || status === 'killed') Object.assign(agent, { status: status === 'killed' ? 'stopped' : 'failed', endedAt: agent.endedAt ?? now() });
  }

  private updateWorkflow(workflow: WorkflowRun, subtype: string, raw: Record<string, unknown>): void {
    const usage = (raw.usage ?? {}) as Record<string, unknown>;
    if (typeof usage.total_tokens === 'number') workflow.totalTokens = usage.total_tokens;
    if (subtype === 'task_progress') {
      // Some progress events only carry usage; the agent list comes with the others
      if (Array.isArray(raw.workflow_progress)) Object.assign(workflow, readProgress(raw.workflow_progress));
      return;
    }
    const patch = (raw.patch ?? {}) as Record<string, unknown>;
    const status = subtype === 'task_notification' ? raw.status : patch.status;
    if (typeof status === 'string') workflow.status = workflowStatus(status);
    if (workflow.status !== 'running') workflow.endedAt ??= now();
    if (subtype === 'task_notification' && typeof raw.summary === 'string') workflow.summary = raw.summary;
  }
}
