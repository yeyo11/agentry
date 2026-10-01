import type { PermissionDecision, PermissionMode, PolicyTranslation, ToolPolicy } from '@agentry/shared';
import { judge } from '../../policy-judge.ts';
import type { DriverEvent, DriverSession, SessionIO, SessionLaunch, UserTurn } from '../driver.ts';
import { approvalFor, type Approval } from './approvals.ts';
import { CodexEvents } from './events.ts';
import { launchSettings, translateCodexPolicy } from './policy.ts';
import type { AccountReadResponse, AskForApproval, InitializeResponse, SandboxMode, SandboxPolicy, ThreadResponse, TurnView } from './protocol/types.ts';
import { JsonRpc, RpcError, type RpcId } from './rpc.ts';

/** What each of Agentry's modes is, in Codex's approval policy and sandbox. */
export function modeSettings(mode: PermissionMode): { approvalPolicy: AskForApproval; sandbox: SandboxMode } | null {
  switch (mode) {
    case 'manual':
    case 'acceptEdits':
    case 'dontAsk':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'read-only' };
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    default:
      return null;
  }
}

const REACH: Record<SandboxMode, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 };

/** The mode's sandbox, narrowed by the policy's: Agentry's policy never lets a run reach further than it says. */
export function effectiveSandbox(mode: PermissionMode, translation: PolicyTranslation | null): { approvalPolicy: AskForApproval; sandbox: SandboxMode } {
  const base = modeSettings(mode) ?? { approvalPolicy: 'on-request' as const, sandbox: 'workspace-write' as const };
  const policySandbox = launchSettings(translation).sandbox;
  if (base.sandbox === 'danger-full-access' || !policySandbox) return base;
  return { ...base, sandbox: REACH[policySandbox] < REACH[base.sandbox] ? policySandbox : base.sandbox };
}

/** The sandbox as a policy object, the shape `turn/start` takes (recorded: `workspace-write` has no extra roots). */
function sandboxPolicy(sandbox: SandboxMode): SandboxPolicy {
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false };
  return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

/** The version a `userAgent` carries: `agentry/0.159.3 (Ubuntu 24.4.0; x86_64) …` */
export function versionOfUserAgent(userAgent: string): string | null {
  return /^[^/\s]+\/(\d+\.\d+\.\d+\S*)/.exec(userAgent)?.[1] ?? null;
}

const text = (turn: UserTurn): { shown: string; images: string[] } => {
  const images = turn.attachments.filter((a) => a.kind === 'image').map((a) => a.path);
  if (!turn.attachments.length) return { shown: turn.text, images };
  const list = turn.attachments.map((a) => `- ${a.name} | ${a.mediaType} | ${a.sizeBytes} bytes | ${a.path}`).join('\n');
  const note = `Files attached to this message (read them from their path):\n${list}`;
  return { shown: turn.text.trim() ? `${turn.text}\n\n${note}` : note, images };
};

/** One `codex app-server` process: its handshake, its turns, and what it asks of the host. */
export class CodexSession implements DriverSession {
  private readonly rpc: JsonRpc;
  private readonly events: CodexEvents;
  private readonly translation: PolicyTranslation | null;
  private readonly policy: ToolPolicy | null;
  /** Turns sent before the handshake is over, or while one is running; delivered in order */
  private readonly queue: UserTurn[] = [];
  private readonly pending = new Map<string, { rpcId: RpcId; approval: Approval }>();
  private ready = false;
  private ended = false;
  private busy = false;
  private threadId: string | null = null;
  private turnId: string | null = null;
  /** Resolved when the running turn's id is known: an interrupt has nothing to name before it */
  private turnStarted: Promise<void> | null = null;
  private model: string | null;
  private pendingModel: string | null = null;
  private effort: string | null;
  private mode: PermissionMode;
  /** The mode changed since the thread started: the next turn carries it */
  private modeDirty = false;
  private cwd: string;

  constructor(
    private readonly io: SessionIO,
    private readonly sink: (event: DriverEvent) => void,
    private readonly spec: SessionLaunch,
  ) {
    this.cwd = spec.cwd;
    this.model = spec.model ?? null;
    this.effort = spec.effort ?? null;
    this.mode = spec.permissionMode;
    this.policy = spec.policy;
    this.translation = spec.policy ? translateCodexPolicy(spec.policy) : null;
    this.events = new CodexEvents(sink, () => this.model);
    this.rpc = new JsonRpc((line) => io.write(line), {
      request: (id, method, params) => this.serverRequest(id, method, params),
      notification: (method, params) => this.notification(method, params),
      unreadable: (line) => sink({ kind: 'unreadable', text: line }),
    });
    void this.handshake();
  }

  private fail(reason: 'auth-required' | 'protocol' | 'version', message: string): void {
    if (this.ended) return;
    this.sink({ kind: 'failed', reason: `${reason}: ${message}` });
  }

  /** `initialize`, then the account, then the thread: the turn goes out only after all three. */
  private async handshake(): Promise<void> {
    try {
      const hello = await this.rpc.request<InitializeResponse>('initialize', {
        clientInfo: { name: 'agentry', title: 'Agentry', version: '0.0.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      this.rpc.notify('initialized');
      // A session that cannot sign in would fail its first turn after retries: say so now (spends nothing)
      const account = await this.rpc.request<AccountReadResponse>('account/read', {});
      if (account.account === null && account.requiresOpenaiAuth) {
        this.fail('auth-required', 'Codex is not signed in. Sign in with `codex login` and try again.');
        return;
      }
      const { config } = launchSettings(this.translation);
      const effective = effectiveSandbox(this.mode, this.translation);
      const common = {
        cwd: this.spec.cwd,
        approvalPolicy: effective.approvalPolicy,
        sandbox: effective.sandbox,
        ...(this.model ? { model: this.model } : {}),
        ...(Object.keys(config).length ? { config } : {}),
        ...(this.spec.appendSystemPrompt ? { developerInstructions: this.spec.appendSystemPrompt } : {}),
      };
      let thread: ThreadResponse;
      if (this.spec.forkFrom) thread = await this.rpc.request<ThreadResponse>('thread/fork', { threadId: this.spec.forkFrom, ...common, excludeTurns: true });
      else if (this.spec.created && this.spec.nativeId) thread = await this.rpc.request<ThreadResponse>('thread/resume', { threadId: this.spec.nativeId, ...common, excludeTurns: true });
      else thread = await this.rpc.request<ThreadResponse>('thread/start', common);
      if (this.ended) return;
      this.threadId = thread.thread.id;
      this.model = thread.model ?? this.model;
      this.cwd = thread.cwd ?? this.cwd;
      const sources = thread.instructionSources ?? [];
      this.sink({
        kind: 'init',
        sessionId: this.threadId,
        nativeSessionId: this.threadId,
        model: this.model,
        permissionMode: this.mode,
        cwd: this.cwd,
        environment: { cliVersion: versionOfUserAgent(hello.userAgent), model: this.model, permissionMode: this.mode, outputStyle: null, tools: [], mcpServers: [], agents: [], skills: [], slashCommands: [], plugins: [], memoryPaths: Object.fromEntries(sources.map((s) => [s, s])) },
        run: { kind: 'init', init: { sessionId: this.threadId, model: this.model ?? '', cwd: this.cwd, permissionMode: this.mode, tools: [], mcpServers: [] } },
      });
      this.ready = true;
      this.pump();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(error instanceof RpcError && /authentication required|unauthorized/i.test(message) ? 'auth-required' : 'protocol', message);
    }
  }

  send(turn: UserTurn): string {
    this.queue.push(turn);
    this.pump();
    return text(turn).shown;
  }

  /** Starts the next queued turn when the thread exists and nothing runs. */
  private pump(): void {
    if (!this.ready || this.busy || this.ended) return;
    const turn = this.queue.shift();
    if (!turn || !this.threadId) return;
    this.busy = true;
    const { shown, images } = text(turn);
    const schema = this.spec.jsonSchema;
    this.events.startTurn(schema !== undefined);
    const params: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: 'text', text: shown, text_elements: [] }, ...images.map((path) => ({ type: 'localImage', path }))],
      ...(this.pendingModel ? { model: this.pendingModel } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(schema !== undefined ? { outputSchema: schema } : {}),
    };
    if (this.modeDirty) {
      const effective = effectiveSandbox(this.mode, this.translation);
      params.approvalPolicy = effective.approvalPolicy;
      params.sandboxPolicy = sandboxPolicy(effective.sandbox);
    }
    this.turnStarted = this.rpc.request<{ turn: TurnView }>('turn/start', params).then(
      (reply) => {
        this.pendingModel = null;
        this.modeDirty = false;
        // The effort sticks to the thread from here: it is not sent again
        this.effort = null;
        this.turnId = reply.turn.id;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // The turn never started: it ends as a failed one, and the next queued turn may go
        this.endTurn({ id: '', status: 'failed', error: { message } });
      },
    );
  }

  private endTurn(turn: TurnView): void {
    this.busy = false;
    this.turnId = null;
    this.turnStarted = null;
    this.events.completedTurn(turn);
    this.pump();
  }

  private notification(method: string, params: Record<string, unknown>): void {
    if (method === 'turn/completed') {
      this.settleApprovals();
      this.endTurn((params.turn ?? { id: '', status: 'failed' }) as TurnView);
      return;
    }
    if (method === 'turn/started') {
      const id = (params.turn as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string') this.turnId = id;
      return;
    }
    this.events.notification(method, params);
  }

  /** The turn is over: whatever approval was still open is moot, for the server and for the host. */
  private settleApprovals(): void {
    for (const id of this.pending.keys()) this.sink({ kind: 'permission-withdrawn', id });
    this.pending.clear();
  }

  private serverRequest(rpcId: RpcId, method: string, params: Record<string, unknown>): void {
    const approval = approvalFor(method, params, this.cwd, this.events.changes);
    if (!approval) {
      // Questions, elicitations, tool calls and refreshes have no shape recorded here: a refusal is
      // an answer, and the turn goes on instead of waiting for one that never comes
      this.rpc.fail(rpcId, -32601, `Agentry does not handle ${method}`);
      this.sink({ kind: 'notice', text: 'Codex asked for something Agentry does not handle; it was refused.' });
      return;
    }
    const id = `codex-${String(rpcId)}`;
    const request = approval.question.request;
    if (this.mode === 'dontAsk') {
      // Nothing reaches a person: the policy answers, and what it does not allow is declined
      const verdict = this.policy && request ? judge(this.policy, request) : 'deny';
      this.rpc.respond(rpcId, approval.reply(verdict === 'allow' ? { behavior: 'allow' } : { behavior: 'deny' }));
      this.sink({ kind: 'notice', text: `${verdict === 'allow' ? 'Allowed' : 'Denied'} by the chat's policy: ${approval.question.toolName}` });
      return;
    }
    const judged = this.translation?.host?.includes('edit') === true;
    if (this.mode === 'acceptEdits' && approval.kind === 'edit' && !judged) {
      this.rpc.respond(rpcId, approval.reply({ behavior: 'allow' }));
      return;
    }
    this.pending.set(id, { rpcId, approval });
    this.sink({ kind: 'permission-request', question: { id, ...approval.question } });
  }

  async interrupt(): Promise<void> {
    if (!this.busy) return;
    // The server holds the turn on its question: it is answered `cancel`, and the host forgets it
    for (const [id, open] of this.pending) {
      this.pending.delete(id);
      this.rpc.respond(open.rpcId, open.approval.cancel);
      this.sink({ kind: 'permission-withdrawn', id });
    }
    await this.turnStarted;
    if (!this.busy || !this.threadId || !this.turnId) return;
    try {
      await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
    } catch (error) {
      // Answering `cancel` may already have ended the turn: the server then has nothing to interrupt
      if (!(error instanceof RpcError)) throw error;
    }
  }

  async setOption(option: { permissionMode: PermissionMode } | { model: string }): Promise<void> {
    if ('model' in option) {
      // The next turn carries it (Codex compacts on a switch); the chat shows it at once
      this.pendingModel = option.model;
      this.model = option.model;
      return;
    }
    if (!modeSettings(option.permissionMode)) throw new Error(`Codex has no mode for ${option.permissionMode}`);
    this.mode = option.permissionMode;
    this.modeDirty = true;
    this.sink({ kind: 'mode-changed', mode: this.mode });
  }

  answerPermission(requestId: string, decision: PermissionDecision): void {
    const open = this.pending.get(requestId);
    if (!open) return;
    this.pending.delete(requestId);
    if (!this.io.up()) return;
    this.rpc.respond(open.rpcId, open.approval.reply(decision));
  }

  readLine(line: string): void {
    this.rpc.line(line);
  }

  readError(line: string): void {
    if (line.trim()) this.sink({ kind: 'stderr', text: line });
  }

  endInput(): void {
    this.io.end();
  }

  dispose(reason: string): void {
    this.ended = true;
    this.rpc.dispose(reason);
    this.pending.clear();
  }
}
