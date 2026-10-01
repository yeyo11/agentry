import type { ModelOption, PermissionMode, PolicyTranslation, ToolPolicy } from '@agentry/shared';
import type { BackgroundTask, SubagentInfo, WorkflowRun } from '../../cli-facts.ts';
import { agentryChildren } from '../../processes.ts';
import {
  binaryOf,
  type BinarySource,
  type BranchTracker,
  type CapabilityConfirmation,
  type DriverEvent,
  type DriverSession,
  type HandshakeResult,
  type LaunchPlan,
  type ProviderDriver,
  type SessionInit,
  type SessionIO,
  type SessionLaunch,
} from '../driver.ts';
import type { TranscriptStore } from '../transcripts.ts';
import { codexHandshake, confirmCodexInit } from './handshake.ts';
import { codexManifest } from './manifest.ts';
import { DEFAULT_MODELS } from './models.ts';
import { translateCodexPolicy } from './policy.ts';
import { CodexSession } from './session.ts';

/** What Codex delegates is reported as task events as it happens; there is nothing to track across processes. */
class CodexBranches implements BranchTracker {
  readonly tasks = new Map<string, BackgroundTask>();
  readonly foregroundTasks = new Map<string, BackgroundTask>();
  readonly subagents = new Map<string, SubagentInfo>();
  readonly workflows = new Map<string, WorkflowRun>();
  sessionId = '';
  message(): void {}
  task(): void {}
  endAll(): void {}
}

/**
 * The modes Codex honours, each with its native value: the approval policy and the sandbox it is
 * asked for. `auto` has no Codex equivalent and is not offered.
 */
const MODES: Array<{ mode: PermissionMode; native: string }> = [
  { mode: 'manual', native: 'on-request + workspace-write' },
  { mode: 'acceptEdits', native: 'on-request + workspace-write, file changes accepted' },
  { mode: 'plan', native: 'on-request + read-only' },
  { mode: 'dontAsk', native: 'on-request + workspace-write, answered by the policy' },
  { mode: 'bypassPermissions', native: 'never + danger-full-access' },
];

/**
 * Codex behind the driver interface: `codex app-server`, JSON-RPC over stdio, one process per chat
 * execution. The binary is the one on the `PATH` unless a path, or where to read one, is given.
 */
export class CodexDriver implements ProviderDriver {
  readonly manifest = codexManifest;
  /** The server names the thread (`thread/start` answers its id), so Agentry records that id as the native one */
  readonly sessionIds = 'assigned';
  /** Codex's history, read from its own API; set where the chat service wires the stores */
  transcripts: TranscriptStore | null = null;

  private catalog: ModelOption[] = DEFAULT_MODELS;
  /** What `launch` was asked for, for the `attach` that follows it at once: the protocol needs the session's settings, argv carries none */
  private launched: SessionLaunch | null = null;

  constructor(private readonly bin: BinarySource = codexManifest.commands.names[0] ?? 'codex') {}

  /** The account's models, as a handshake listed them */
  setCatalog(models: ModelOption[]): void {
    this.catalog = models.length > 0 ? models : DEFAULT_MODELS;
  }

  translatePolicy(policy: ToolPolicy): PolicyTranslation {
    return translateCodexPolicy(policy);
  }

  models(): ModelOption[] {
    return this.catalog;
  }

  permissionModes(): Array<{ mode: PermissionMode; native: string }> {
    return MODES;
  }

  launch(spec: SessionLaunch): LaunchPlan {
    this.launched = spec;
    const { args, env, unsetEnv } = codexManifest.launch ?? { args: [], env: {}, unsetEnv: [] };
    return { bin: binaryOf(this.bin), args: [...args], env: { ...process.env, ...env }, unsetEnv: [...unsetEnv] };
  }

  attach(io: SessionIO, sink: (event: DriverEvent) => void, _branches: BranchTracker): DriverSession {
    const spec = this.launched;
    if (!spec) throw new Error('attach without a launch: the session has no settings to start the thread with');
    this.launched = null;
    return new CodexSession(io, sink, spec);
  }

  createBranches(): BranchTracker {
    return new CodexBranches();
  }

  /** The `app-server` processes Agentry started for this chat, found by the chat id in their environment */
  sessionHolders(sessionId: string): number[] {
    return this.liveSessions()
      .filter((s) => s.sessionId === sessionId)
      .map((s) => s.pid);
  }

  liveSessions(): Array<{ pid: number; sessionId: string }> {
    return agentryChildren()
      .filter((p) => p.argv.includes('app-server'))
      .map((p) => ({ pid: p.pid, sessionId: p.chatId }));
  }

  confirm(init: SessionInit): CapabilityConfirmation {
    return confirmCodexInit(init);
  }

  handshake(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<HandshakeResult> {
    return codexHandshake(binaryOf(this.bin), [...(codexManifest.launch?.args ?? [])], { ...env, ...codexManifest.launch?.env }, signal);
  }
}
