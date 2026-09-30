import { type ModelOption, type PermissionDecision, type PermissionMode, type PolicyTranslation, type ToolPolicy } from '@agentry/shared';
import { authFreeEnv } from '../../accounts.ts';
import { drivesSession, streamJsonProcesses } from '../../processes.ts';
import { composeContent } from '../../uploads.ts';
import { modelOptions } from './models.ts';
import type {
  AccountSupport,
  BranchTracker,
  CapabilityConfirmation,
  DriverEvent,
  DriverSession,
  LaunchPlan,
  ProviderDriver,
  SessionInit,
  SessionIO,
  SessionLaunch,
  UserTurn,
} from '../driver.ts';
import { buildArgs, command } from './args.ts';
import { ClaudeBranches } from './branches.ts';
import { ControlChannel } from './control.ts';
import { confirmClaudeInit } from './handshake.ts';
import { claudeCodeManifest } from './manifest.ts';
import { translateClaudePolicy } from './policy.ts';
import { ClaudeStream } from './stream.ts';

/** The session a `claude -p --input-format stream-json` process drives, read from its arguments. */
function sessionOf(argv: readonly string[]): string | null {
  const flag = (name: string) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  if (flag('--input-format') !== 'stream-json') return null;
  if (argv.includes('--fork-session')) return flag('--session-id') ?? null;
  return flag('--resume') ?? flag('--session-id') ?? null;
}

class ClaudeCodeSession implements DriverSession {
  private readonly control: ControlChannel;
  private readonly stream: ClaudeStream;

  constructor(
    private readonly io: SessionIO,
    sink: (event: DriverEvent) => void,
    branches: BranchTracker,
  ) {
    this.control = new ControlChannel(io);
    this.stream = new ClaudeStream(sink, branches, this.control);
  }

  send(turn: UserTurn): string {
    const { text, attachments, read } = turn;
    const content = attachments.length && read ? composeContent(text, attachments, read) : text;
    this.control.write({ type: 'user', message: { role: 'user', content } });
    return Array.isArray(content) ? String((content.at(-1) as { text: string }).text) : text;
  }

  async interrupt(): Promise<void> {
    await this.control.request({ subtype: 'interrupt' });
  }

  async setOption(option: { permissionMode: PermissionMode } | { model: string }): Promise<void> {
    if ('permissionMode' in option) await this.control.request({ subtype: 'set_permission_mode', mode: option.permissionMode });
    else await this.control.request({ subtype: 'set_model', model: option.model });
  }

  answerPermission(requestId: string, decision: PermissionDecision): void {
    this.control.answer(requestId, decision);
  }

  readLine(line: string): void {
    this.stream.line(line);
  }

  readError(line: string): void {
    this.stream.error(line);
  }

  endInput(): void {
    this.io.end();
  }

  dispose(reason: string): void {
    this.control.dispose(reason);
  }
}

/**
 * Claude Code behind the driver interface: the CLI's own stream-json protocol, moved here as it was.
 * The binary is the one the configuration names; claude-swap is supplied by Core through `accounts`.
 */
export class ClaudeCodeDriver implements ProviderDriver {
  readonly manifest = claudeCodeManifest;
  accounts: AccountSupport | null = null;

  /** Where the CLI lists what the account may run, and the names chats learned for the aliases; set by the manager */
  modelSource: { file: string; seen: () => Readonly<Record<string, string>> } | null = null;

  constructor(private readonly claudeBin: string) {}

  translatePolicy(policy: ToolPolicy): PolicyTranslation {
    return translateClaudePolicy(policy);
  }

  models(): ModelOption[] {
    return modelOptions(this.modelSource?.file ?? '', this.modelSource?.seen() ?? {});
  }

  launch(spec: SessionLaunch): LaunchPlan {
    const launch = this.accounts?.managed ? this.accounts.launchFor({ account: spec.account, cwd: spec.cwd }) : { account: null, configDir: null };
    const [bin, args] = command(this.claudeBin, this.accounts, launch, buildArgs(spec));
    // A chat on an account must never inherit a token from the environment: it would override the account
    const env: NodeJS.ProcessEnv = { ...(launch.account || launch.configDir || spec.account ? authFreeEnv() : process.env) };
    if (launch.configDir) env.CLAUDE_CONFIG_DIR = launch.configDir;
    return { bin, args, env, unsetEnv: [] };
  }

  attach(io: SessionIO, sink: (event: DriverEvent) => void, branches: BranchTracker): DriverSession {
    return new ClaudeCodeSession(io, sink, branches);
  }

  createBranches(): BranchTracker {
    return new ClaudeBranches();
  }

  sessionHolders(sessionId: string): number[] {
    return streamJsonProcesses()
      .filter((p) => drivesSession(p.argv, sessionId))
      .map((p) => p.pid);
  }

  liveSessions(): Array<{ pid: number; sessionId: string }> {
    return streamJsonProcesses().flatMap((p) => {
      const sessionId = sessionOf(p.argv);
      return sessionId ? [{ pid: p.pid, sessionId }] : [];
    });
  }

  confirm(init: SessionInit): CapabilityConfirmation {
    return confirmClaudeInit(init);
  }
}
