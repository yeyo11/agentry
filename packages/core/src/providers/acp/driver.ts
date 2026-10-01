import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ModelOption, PermissionMode, PolicyTranslation, ProviderCapability, ToolPolicy } from '@agentry/shared';
import { agentryChildren } from '../../processes.ts';
import { satisfiesRange } from '../detector.ts';
import type {
  BranchTracker,
  CapabilityConfirmation,
  DriverEvent,
  DriverSession,
  HandshakeResult,
  LaunchPlan,
  ProviderDriver,
  SessionInit,
  SessionIO,
  SessionLaunch,
} from '../driver.ts';
import type { ProviderManifest } from '../manifest.ts';
import type { TranscriptStore } from '../transcripts.ts';
import { AcpBranches } from './branches.ts';
import { ACP_PROFILES, removeLaunchFile, type AcpProfile } from './profiles.ts';
import { JsonRpc } from './rpc.ts';
import { agentFacts, AcpSession, type AgentFacts } from './session.ts';

const EMPTY_TRANSLATION: PolicyTranslation = { rules: { allowedTools: [], disallowedTools: [] }, unsupported: [] };
const HANDSHAKE_MS = 15_000;

export interface AcpDriverOptions {
  /** Where a file a launch writes goes (Gemini's policy); the system's temporary directory by default */
  dataDir?: string;
}

/**
 * What the handshake reads off `initialize` that a declared capability can be checked against. The
 * manifest's set is the ceiling and the handshake the truth: a capability the agent does not offer
 * is `missing`. `offeredModel` is known only once a session has been opened.
 */
function confirmFacts(manifest: ProviderManifest, facts: AgentFacts, offeredModel: boolean | null): CapabilityConfirmation {
  const declared = manifest.capabilities;
  const range = manifest.versions.range;
  // A version outside what the driver is tested against confirms nothing: the detector reports it
  if (facts.version && range && satisfiesRange(facts.version, range) !== 'in') return { version: facts.version, confirmed: [], missing: [] };
  const confirmed: ProviderCapability[] = [];
  const missing: ProviderCapability[] = [];
  const check = (capability: ProviderCapability, present: boolean | null): void => {
    if (!declared.includes(capability) || present === null) return;
    (present ? confirmed : missing).push(capability);
  };
  check('resume', facts.loadSession || facts.resume);
  check('fork', facts.fork);
  check('mcp', facts.mcp);
  check('setModel', offeredModel);
  return { version: facts.version, confirmed, missing };
}

/**
 * One driver for the agents that speak the Agent Client Protocol on stdio: GitHub Copilot CLI,
 * Gemini CLI and OpenCode. The manifest names the command and what it starts with, the profile the
 * few things that differ (modes, how a model is switched, the policy's native form); the protocol
 * code is shared.
 */
export class AcpDriver implements ProviderDriver {
  /** The agent names the session; the chat records its id beside Agentry's own */
  readonly sessionIds = 'assigned';
  /** Set by Core once the provider's store exists (OpenCode's database); null while the agent keeps nothing readable */
  transcripts: TranscriptStore | null = null;

  private readonly profile: AcpProfile;
  private readonly dataDir: string;
  /** What the last `initialize` said, for `confirm` */
  private agent: AgentFacts | null = null;
  private offeredModel: boolean | null = null;
  private offered: ModelOption[] = [];
  /** The agent's session id per chat, so a fork named by chat id finds its source */
  private readonly natives = new Map<string, string>();
  private readonly files = new Map<string, string[]>();
  private launched: SessionLaunch | null = null;

  constructor(
    readonly manifest: ProviderManifest,
    options: AcpDriverOptions = {},
  ) {
    const profile = ACP_PROFILES[manifest.id];
    if (!profile) throw new Error(`No ACP profile for "${manifest.id}"`);
    if (!manifest.launch) throw new Error(`The "${manifest.id}" manifest has no launch arguments`);
    this.profile = profile;
    this.dataDir = options.dataDir ?? join(tmpdir(), 'agentry-acp');
  }

  translatePolicy(policy: ToolPolicy): PolicyTranslation {
    return this.profile.translate(policy);
  }

  models(): ModelOption[] {
    const seen = new Set<string>();
    return [...this.profile.defaultModels, ...this.offered].filter((m) => !seen.has(m.value) && !!seen.add(m.value));
  }

  permissionModes(): Array<{ mode: PermissionMode; native: string }> {
    return (Object.entries(this.profile.modes) as Array<[PermissionMode, { native: string }]>).map(([mode, native]) => ({ mode, native: native.native }));
  }

  /**
   * The agent's own command with the manifest's arguments and environment, and what the policy and
   * the model add. Every Copilot process gets `--no-auto-update` and `COPILOT_AUTO_UPDATE=false`
   * from its manifest: a recording session saw it replace the person's binary.
   */
  launch(spec: SessionLaunch): LaunchPlan {
    const { launch } = this.manifest;
    if (!launch) throw new Error(`The "${this.manifest.id}" manifest has no launch arguments`);
    const translation = spec.policy ? this.profile.translate(spec.policy) : EMPTY_TRANSLATION;
    const extras = this.profile.launchExtras({ translation, model: spec.model, mode: spec.permissionMode, dataDir: this.dataDir, chatId: spec.id });
    this.launched = spec;
    this.files.set(spec.id, extras.files);
    if (spec.nativeId) this.natives.set(spec.id, spec.nativeId);
    return {
      bin: this.manifest.commands.names[0] ?? this.manifest.id,
      args: [...launch.args, ...extras.args],
      env: { ...process.env, ...launch.env, ...extras.env },
      unsetEnv: [...launch.unsetEnv],
    };
  }

  attach(io: SessionIO, sink: (event: DriverEvent) => void, branches: BranchTracker): DriverSession {
    const spec = this.launched;
    if (!spec) throw new Error('attach comes after launch');
    this.launched = null;
    return new AcpSession(io, sink, branches, spec, this.profile, this.manifest.label, {
      onAgent: (facts) => {
        this.agent = facts;
        this.offeredModel = null;
      },
      onSession: (nativeId, offered) => {
        this.natives.set(spec.id, nativeId);
        this.offeredModel = offered.models.length > 0;
        if (offered.models.length > 0) this.offered = offered.models;
      },
      nativeOf: (chatId) => this.natives.get(chatId),
      onEnd: () => {
        for (const file of this.files.get(spec.id) ?? []) removeLaunchFile(file);
        this.files.delete(spec.id);
      },
    });
  }

  createBranches(): BranchTracker {
    return new AcpBranches();
  }

  /** The chat's agent process, found by the `AGENTRY_CHAT_ID` the manager put in its environment: ACP argv names no session */
  sessionHolders(sessionId: string): number[] {
    return this.children()
      .filter((p) => p.chatId === sessionId)
      .map((p) => p.pid);
  }

  liveSessions(): Array<{ pid: number; sessionId: string }> {
    return this.children().map((p) => ({ pid: p.pid, sessionId: p.chatId }));
  }

  /** Agentry's own children running this provider's protocol command, told from another provider's by its first argument */
  private children(): Array<{ pid: number; chatId: string }> {
    const marker = this.manifest.launch?.args[0];
    return agentryChildren().filter((p) => marker !== undefined && p.argv.includes(marker));
  }

  confirm(init: SessionInit): CapabilityConfirmation {
    const facts = this.agent;
    if (!facts) return { version: init.version, confirmed: [], missing: [] };
    return confirmFacts(this.manifest, { ...facts, version: init.version ?? facts.version }, this.offeredModel);
  }

  /**
   * `initialize` and nothing else: it spends nothing and starts no session. The answer says the
   * version and what the agent can do; whether anyone is signed in is not in it (`authMethods` are
   * offered either way), so `account` stays null.
   */
  async handshake(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<HandshakeResult> {
    const { launch } = this.manifest;
    if (!launch) throw new Error(`The "${this.manifest.id}" manifest has no launch arguments`);
    const child = spawn(this.manifest.commands.names[0] ?? this.manifest.id, launch.args, { env: { ...env, ...launch.env }, stdio: 'pipe' });
    child.stdin.on('error', () => {});
    child.stderr.resume();
    const stop = (): void => {
      child.stdin.end();
      child.kill('SIGTERM');
    };
    try {
      return await new Promise<HandshakeResult>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the agent did not answer initialize')), HANDSHAKE_MS);
        const fail = (error: Error): void => {
          clearTimeout(timer);
          reject(error);
        };
        signal.addEventListener('abort', () => fail(new Error('handshake aborted')), { once: true });
        child.on('error', fail);
        child.on('exit', () => fail(new Error('the agent exited before it answered initialize')));
        const rpc = new JsonRpc(
          { write: (text) => child.stdin.write(text) },
          // Anything the agent asks before a session exists is not for a handshake to answer
          { request: (id) => rpc.respondError(id, -32601, 'Method not found'), notification: () => {}, unreadable: () => {} },
        );
        createInterface({ input: child.stdout }).on('line', (line) => rpc.line(line));
        rpc
          .request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'agentry', title: 'Agentry' },
          })
          .then((answer) => {
            clearTimeout(timer);
            const facts = agentFacts(answer);
            resolve({ version: facts.version, account: null, models: [], confirmed: confirmFacts(this.manifest, facts, null).confirmed });
          }, fail);
      });
    } finally {
      stop();
    }
  }
}
