import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { ModelOption, PermissionDecision, PermissionMode } from '@agentry/shared';
import { runsGitPush } from '../../policy-judge.ts';
import type { BranchTracker, DriverEvent, DriverSession, SessionIO, SessionLaunch, UserTurn } from '../driver.ts';
import { optionFor, optionsOf, questionOf, type AcpToolCall, type PermissionOption } from './permissions.ts';
import type { AcpProfile } from './profiles.ts';
import { AUTH_REQUIRED, JsonRpc, METHOD_NOT_FOUND, RpcError } from './rpc.ts';
import { UpdateTranslator } from './updates.ts';

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** What `initialize` says the agent can do. */
export interface AgentFacts {
  version: string | null;
  loadSession: boolean;
  resume: boolean;
  fork: boolean;
  image: boolean;
  /** `mcpCapabilities` was present */
  mcp: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
}

export function agentFacts(result: Record<string, unknown>): AgentFacts {
  const caps = asRecord(result.agentCapabilities);
  const sessionCaps = asRecord(caps.sessionCapabilities);
  const mcp = asRecord(caps.mcpCapabilities);
  return {
    version: asString(asRecord(result.agentInfo).version) ?? null,
    loadSession: caps.loadSession === true,
    resume: 'resume' in sessionCaps,
    fork: 'fork' in sessionCaps,
    image: asRecord(caps.promptCapabilities).image === true,
    mcp: caps.mcpCapabilities !== undefined,
    mcpHttp: mcp.http === true,
    mcpSse: mcp.sse === true,
  };
}

/** What the session reports back to the driver that owns the process's kind. */
export interface SessionHooks {
  onAgent(facts: AgentFacts): void;
  /** The session exists; `model` says whether the agent offered a model to choose */
  onSession(nativeId: string, offered: { models: ModelOption[] }): void;
  /** The native id of a chat this driver has seen, for a fork whose source is named by chat id */
  nativeOf(chatId: string): string | undefined;
  onEnd(): void;
}

type FailureReason = 'auth-required' | 'protocol' | 'version';

/**
 * One `session/new|load|resume|fork` conversation with one ACP agent process. The turn is queued
 * until the handshake has answered, because `send` is synchronous and the protocol is not.
 */
export class AcpSession implements DriverSession {
  private readonly rpc: JsonRpc;
  private readonly updates: UpdateTranslator;
  private facts: AgentFacts | null = null;
  private sessionId: string | null = null;
  private ready: Promise<void>;
  private isReady = false;
  private isFailed = false;
  private disposed = false;
  /** A `session/load` replays the history as updates; those are in the transcript already */
  private replaying = false;
  private readonly queue: UserTurn[] = [];
  private running: { startedAt: number } | null = null;
  private readonly idleWaiters: Array<() => void> = [];
  private readonly pending = new Map<string, { rpcId: number | string; options: PermissionOption[] }>();
  private mode: PermissionMode;
  private nativeModeId: string | null = null;
  private allowAll: string | null = null;
  private model: string | null = null;
  private options: unknown[] = [];

  constructor(
    private readonly io: SessionIO,
    private readonly sink: (event: DriverEvent) => void,
    _branches: BranchTracker,
    private readonly spec: SessionLaunch,
    private readonly profile: AcpProfile,
    private readonly label: string,
    private readonly hooks: SessionHooks,
  ) {
    this.mode = spec.permissionMode;
    this.rpc = new JsonRpc(this.io, {
      request: (id, method, params) => this.agentRequest(id, method, params),
      notification: (method, params) => this.agentNotification(method, params),
      unreadable: (line) => this.sink({ kind: 'unreadable', text: line }),
    });
    this.updates = new UpdateTranslator(
      sink,
      () => this.model,
      (modeId) => this.modeChanged(modeId),
      (options) => this.readOptions(options),
    );
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Nothing awaits it until a setting changes; a failure is reported through `failed`, once
    this.ready.catch(() => {});
    this.settle = { resolve: resolveReady, reject: rejectReady };
    void this.start();
  }

  private readonly settle: { resolve(): void; reject(error: Error): void };

  // ---------- the handshake ----------

  private async start(): Promise<void> {
    try {
      const init = await this.rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'agentry', title: 'Agentry' },
      });
      const facts = agentFacts(init);
      this.facts = facts;
      this.hooks.onAgent(facts);
      const opened = await this.open(facts);
      if (!opened) return;
      await this.configure(opened.result, opened.sessionId);
    } catch (error) {
      this.failed(error);
    }
  }

  /** Starts, loads, resumes or forks the session; null when it cannot and the failure is reported. */
  private async open(facts: AgentFacts): Promise<{ result: Record<string, unknown>; sessionId: string } | null> {
    const { spec } = this;
    const base = { cwd: spec.cwd, mcpServers: this.mcpServers(facts) };
    if (spec.created && spec.nativeId) {
      const sessionId = spec.nativeId;
      // `resume` does not replay the history, so it is the better one where both are offered
      if (facts.resume) return { result: await this.rpc.request('session/resume', { sessionId, ...base }), sessionId };
      if (facts.loadSession) {
        this.replaying = true;
        try {
          return { result: await this.rpc.request('session/load', { sessionId, ...base }), sessionId };
        } finally {
          this.replaying = false;
        }
      }
      this.fail('protocol', `${this.label} cannot resume a session`);
      return null;
    }
    if (spec.forkFrom && !spec.created) {
      if (!facts.fork) {
        this.fail('protocol', `${this.label} cannot fork a session`);
        return null;
      }
      const source = this.hooks.nativeOf(spec.forkFrom) ?? spec.forkFrom;
      const result = await this.rpc.request('session/fork', { sessionId: source, ...base });
      const sessionId = asString(result.sessionId);
      if (!sessionId) {
        this.fail('protocol', `${this.label} forked a session and named none`);
        return null;
      }
      return { result, sessionId };
    }
    const result = await this.rpc.request('session/new', base);
    const sessionId = asString(result.sessionId);
    if (!sessionId) {
      this.fail('protocol', `${this.label} started a session and named none`);
      return null;
    }
    return { result, sessionId };
  }

  /** Reads what the session offers, applies the chat's mode and model, and announces it. */
  private async configure(result: Record<string, unknown>, sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    this.readOptions(Array.isArray(result.configOptions) ? result.configOptions : []);
    const modes = asRecord(result.modes);
    this.nativeModeId = asString(modes.currentModeId) ?? this.optionValue('mode') ?? this.nativeModeId;
    this.allowAll = this.optionValue('allow_all');
    const models = asRecord(result.models);
    this.model = asString(models.currentModelId) ?? this.optionValue('model') ?? this.spec.model ?? null;
    const offered = this.modelsOffered(result);
    this.hooks.onSession(sessionId, { models: offered });

    await this.applyMode();
    const wanted = this.spec.model;
    if (wanted && this.profile.setModel && wanted !== this.model && (offered.length === 0 || offered.some((m) => m.value === wanted))) {
      await this.switchModel(wanted).catch((error) => this.sink({ kind: 'stderr', text: `Could not select the model ${wanted}: ${messageOf(error)}` }));
    }

    const mode = this.currentMode();
    const mcpServers = this.mcpNames();
    this.sink({
      kind: 'init',
      sessionId,
      nativeSessionId: sessionId,
      model: this.model,
      permissionMode: mode,
      cwd: this.spec.cwd,
      environment: {
        cliVersion: this.facts?.version ?? null,
        model: this.model,
        permissionMode: this.nativeModeId,
        outputStyle: null,
        tools: [],
        mcpServers,
        agents: [],
        skills: [],
        slashCommands: this.updates.commands,
        plugins: [],
        memoryPaths: {},
      },
      run: { kind: 'init', init: { sessionId, model: this.model ?? '', cwd: this.spec.cwd, permissionMode: mode, tools: [], mcpServers } },
    });
    this.isReady = true;
    this.settle.resolve();
    this.pump();
  }

  /** Puts the agent in the mode the chat asked for, where it is not already in it. */
  private async applyMode(): Promise<void> {
    const native = this.profile.modes[this.mode] ?? this.profile.modes.manual;
    if (!native || !this.sessionId) return;
    try {
      if (native.modeId !== this.nativeModeId && this.hasMode()) {
        await this.rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: native.modeId });
        this.nativeModeId = native.modeId;
      }
      if (native.allowAll && this.allowAll !== null && native.allowAll !== this.allowAll) {
        const answer = await this.rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: 'allow_all', value: native.allowAll });
        this.allowAll = native.allowAll;
        if (Array.isArray(answer.configOptions)) this.readOptions(answer.configOptions);
      }
    } catch (error) {
      this.sink({ kind: 'stderr', text: `Could not select the ${this.mode} mode: ${messageOf(error)}` });
    }
  }

  private hasMode(): boolean {
    return this.nativeModeId !== null || this.options.some((o) => asRecord(o).id === 'mode');
  }

  private mcpNames(): Array<{ name: string; status: string }> {
    return this.mcpServers(this.facts).map((s) => ({ name: String(s.name), status: 'connected' }));
  }

  /** The chat's MCP servers as ACP's `stdio`, `http` and `sse` entries; what the agent cannot reach is left out */
  private mcpServers(facts: AgentFacts | null): Array<Record<string, unknown>> {
    const source = this.spec.mcpConfig;
    if (!source) return [];
    let servers: Record<string, unknown>;
    try {
      const text = source.trim().startsWith('{') ? source : readFileSync(source, 'utf8');
      servers = asRecord(asRecord(JSON.parse(text)).mcpServers);
    } catch {
      return [];
    }
    const pairs = (value: unknown): Array<{ name: string; value: string }> => Object.entries(asRecord(value)).map(([name, v]) => ({ name, value: String(v) }));
    return Object.entries(servers).flatMap(([name, raw]): Array<Record<string, unknown>> => {
      const server = asRecord(raw);
      const url = asString(server.url);
      if (url) {
        const type = server.type === 'sse' ? 'sse' : 'http';
        if (facts && (type === 'sse' ? !facts.mcpSse : !facts.mcpHttp)) return [];
        return [{ type, name, url, headers: pairs(server.headers) }];
      }
      const command = asString(server.command);
      if (!command) return [];
      return [{ name, command, args: Array.isArray(server.args) ? server.args.map(String) : [], env: pairs(server.env) }];
    });
  }

  // ---------- what the session offers ----------

  private readOptions(options: unknown[]): void {
    this.options = options;
  }

  private optionValue(id: string): string | null {
    const option = this.options.map(asRecord).find((o) => o.id === id);
    return option ? (asString(option.currentValue) ?? null) : null;
  }

  private modelsOffered(result: Record<string, unknown>): ModelOption[] {
    const fromOption = this.options.map(asRecord).find((o) => o.id === 'model' || o.category === 'model');
    if (fromOption && Array.isArray(fromOption.options)) {
      return fromOption.options.flatMap((o) => {
        const entry = asRecord(o);
        const value = asString(entry.value);
        return value ? [{ value, label: asString(entry.name) ?? value, ...(asString(entry.description) ? { description: asString(entry.description) } : {}) }] : [];
      });
    }
    const available = asRecord(result.models).availableModels;
    if (!Array.isArray(available)) return [];
    return available.flatMap((m) => {
      const entry = asRecord(m);
      const value = asString(entry.modelId);
      return value ? [{ value, label: asString(entry.name) ?? value, ...(asString(entry.description) ? { description: asString(entry.description) } : {}) }] : [];
    });
  }

  /** The Agentry mode the agent's native mode stands for: the chat's own when it maps to it */
  private currentMode(): PermissionMode {
    return this.fromNative(this.nativeModeId) ?? this.mode;
  }

  private fromNative(modeId: string | null): PermissionMode | null {
    if (modeId === null) return null;
    if (this.profile.modes[this.mode]?.modeId === modeId) return this.mode;
    const found = (Object.entries(this.profile.modes) as Array<[PermissionMode, { modeId: string }]>).find(([, native]) => native.modeId === modeId);
    return found ? found[0] : null;
  }

  private modeChanged(modeId: string): void {
    this.nativeModeId = modeId;
    const mode = this.fromNative(modeId);
    if (mode) this.sink({ kind: 'mode-changed', mode });
  }

  private async switchModel(model: string): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    if (this.profile.setModel === 'config-option') {
      const answer = await this.rpc.request('session/set_config_option', { sessionId, configId: 'model', value: model });
      if (Array.isArray(answer.configOptions)) this.readOptions(answer.configOptions);
    } else if (this.profile.setModel === 'set-model') {
      await this.rpc.request('session/set_model', { sessionId, modelId: model });
    } else {
      throw new Error(`${this.label} fixes its model when it starts`);
    }
    this.model = model;
  }

  // ---------- failure ----------

  private fail(reason: FailureReason, message: string): void {
    if (this.isFailed || this.disposed) return;
    this.isFailed = true;
    this.settle.reject(new Error(message));
    this.sink({ kind: 'failed', reason: `${reason}: ${message}` });
  }

  private failed(error: unknown): void {
    if (this.disposed) return;
    if (error instanceof RpcError && error.code === AUTH_REQUIRED) this.fail('auth-required', error.message);
    else this.fail('protocol', messageOf(error));
  }

  // ---------- turns ----------

  send(turn: UserTurn): string {
    this.queue.push(turn);
    this.pump();
    return turn.text;
  }

  private pump(): void {
    if (!this.isReady || this.isFailed || this.running) return;
    const turn = this.queue.shift();
    if (turn) this.dispatch(turn);
  }

  private dispatch(turn: UserTurn): void {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    this.running = { startedAt: Date.now() };
    this.updates.beginTurn();
    this.rpc.request('session/prompt', { sessionId, prompt: this.promptOf(turn) }).then(
      (reply) => this.endTurn(reply),
      (error: unknown) => this.turnFailed(error),
    );
  }

  /** The text, then each file: an image inline when the agent takes them, the rest as a link to the file */
  private promptOf(turn: UserTurn): Array<Record<string, unknown>> {
    const prompt: Array<Record<string, unknown>> = [{ type: 'text', text: turn.text }];
    for (const file of turn.attachments) {
      if (file.kind === 'image' && turn.read && this.facts?.image) prompt.push({ type: 'image', mimeType: file.mediaType, data: turn.read(file.id).toString('base64') });
      else prompt.push({ type: 'resource_link', uri: pathToFileURL(file.path).href, name: file.name, mimeType: file.mediaType });
    }
    return prompt;
  }

  private endTurn(reply: Record<string, unknown>): void {
    if (this.disposed) return;
    this.updates.endTurn();
    const stopReason = asString(reply.stopReason) ?? 'end_turn';
    const text = this.updates.lastText;
    const durationMs = this.running ? Date.now() - this.running.startedAt : 0;
    const isError = stopReason !== 'end_turn';
    const failure = stopReason === 'cancelled' ? 'cancelled' : `The agent ended the turn: ${stopReason}`;
    const context = this.updates.context;
    this.sink({ kind: 'stop-reason', reason: stopReason });
    this.sink({
      kind: 'result',
      isError,
      text,
      failure,
      turns: 1,
      modelUsage: this.model && context ? [{ model: this.model, contextWindow: context.size }] : [],
      structuredOutput: undefined,
      stopReason,
      budget: false,
      rateLimited: false,
      run: { kind: 'result', text, outcome: { isError, turns: 1, durationMs, costUsd: 0, permissionDenials: [] } },
    });
    this.idle();
  }

  private turnFailed(error: unknown): void {
    if (this.disposed) return;
    this.updates.endTurn();
    if (error instanceof RpcError && error.code !== AUTH_REQUIRED) {
      // The agent refused this turn; the session is still there for the next one
      this.sink({
        kind: 'result',
        isError: true,
        text: error.message,
        failure: error.message,
        turns: 1,
        modelUsage: [],
        structuredOutput: undefined,
        budget: false,
        rateLimited: false,
        run: { kind: 'result', text: error.message, outcome: { isError: true, turns: 1, durationMs: this.running ? Date.now() - this.running.startedAt : 0, costUsd: 0, permissionDenials: [] } },
      });
      this.idle();
      return;
    }
    this.failed(error);
    this.idle();
  }

  private idle(): void {
    this.running = null;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
    this.pump();
  }

  async interrupt(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || !this.running) return;
    const finished = new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    this.cancelPending();
    this.rpc.notify('session/cancel', { sessionId });
    // The agent ends the turn with `cancelled`; one that never does must not hold the caller forever
    const timer = setTimeout(() => this.idle(), 10_000);
    timer.unref();
    await finished;
    clearTimeout(timer);
  }

  /** A pending permission request is answered `cancelled` and withdrawn from whoever was asked */
  private cancelPending(): void {
    for (const [id, entry] of this.pending) {
      this.rpc.respond(entry.rpcId, { outcome: { outcome: 'cancelled' } });
      this.sink({ kind: 'permission-withdrawn', id });
    }
    this.pending.clear();
  }

  async setOption(option: { permissionMode: PermissionMode } | { model: string }): Promise<void> {
    if ('permissionMode' in option) {
      if (!this.profile.modes[option.permissionMode]) throw new Error(`${this.label} does not offer the ${option.permissionMode} mode`);
      this.mode = option.permissionMode;
      await this.ready;
      await this.applyMode();
      return;
    }
    if (!this.profile.setModel) throw new Error(`${this.label} fixes its model when it starts`);
    await this.ready;
    await this.switchModel(option.model);
  }

  // ---------- what the agent asks and says ----------

  private agentNotification(method: string, params: Record<string, unknown>): void {
    if (method !== 'session/update' || this.replaying) return;
    this.updates.update(asRecord(params.update));
  }

  private agentRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method !== 'session/request_permission') {
      // Agentry offers no file system and no terminal: whatever else is asked is not available
      this.rpc.respondError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
      return;
    }
    const raw = asRecord(params.toolCall);
    const call: AcpToolCall = {
      toolCallId: asString(raw.toolCallId) ?? String(id),
      ...(asString(raw.title) ? { title: asString(raw.title) } : {}),
      ...(asString(raw.kind) ? { kind: asString(raw.kind) } : {}),
      rawInput: raw.rawInput,
      ...(Array.isArray(raw.locations) ? { locations: raw.locations as AcpToolCall['locations'] } : {}),
    };
    const options = optionsOf(params.options);
    const questionId = `acp-${String(id)}`;
    const granted = this.grantedByMode(call);
    const allow = granted ? optionFor(options, { behavior: 'allow' }) : null;
    if (allow) {
      this.rpc.respond(id, { outcome: { outcome: 'selected', optionId: allow.optionId } });
      return;
    }
    this.pending.set(questionId, { rpcId: id, options });
    this.sink({ kind: 'permission-request', question: questionOf(questionId, call, this.spec.cwd) });
  }

  /**
   * The mode's own grant where the agent has no native switch for it live: edits under
   * `acceptEdits`, everything but a `git push` under `bypassPermissions`. A chat with a policy
   * never gets one, so the judge decides every request.
   */
  private grantedByMode(call: AcpToolCall): boolean {
    if (this.spec.policy) return false;
    const { hostGrants } = this.profile;
    const editing = call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move';
    if (this.mode === 'acceptEdits' && hostGrants.acceptEdits) return editing;
    if (this.mode === 'bypassPermissions' && hostGrants.bypass) {
      const command = call.kind === 'execute' ? asString(asRecord(call.rawInput).command) : undefined;
      return !(command && runsGitPush(command));
    }
    return false;
  }

  answerPermission(requestId: string, decision: PermissionDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    const option = optionFor(entry.options, decision);
    this.rpc.respond(entry.rpcId, { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } });
  }

  readLine(line: string): void {
    this.rpc.line(line);
  }

  readError(line: string): void {
    this.sink({ kind: 'stderr', text: line });
  }

  endInput(): void {
    this.io.end();
  }

  dispose(reason: string): void {
    this.disposed = true;
    this.rpc.dispose(reason);
    this.pending.clear();
    for (const resolve of this.idleWaiters.splice(0)) resolve();
    this.hooks.onEnd();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
