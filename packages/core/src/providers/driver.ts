import type {
  Attachment,
  EffectiveEnvironment,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PermissionUpdate,
  PolicyTranslation,
  ProviderCapability,
  RateLimitInfo,
  RunEvent,
  ToolPolicy,
  TranscriptEntry,
} from '@agentry/shared';
import type { Launch } from '../accounts.ts';
import type { BackgroundTask, SubagentInfo, WorkflowRun } from '../cli-facts.ts';
import type { ChatConfinement, NewChat } from '../live-chat.ts';
import type { ProviderManifest } from './manifest.ts';

/**
 * The code half of a provider; the manifest is the data half. Everything that is the agent's own
 * (its flags, its environment, its stream, its control protocol, the account wrapper in front of
 * it) sits behind this; everything that is Agentry's (chats, executions, queueing, tokens,
 * persistence, rotation requests) stays in `ChatManager`.
 */
export interface ProviderDriver {
  readonly manifest: ProviderManifest;

  /** Agentry's policy in the provider's own terms, and what it cannot enforce */
  translatePolicy(policy: ToolPolicy): PolicyTranslation;
  /** What the picker offers for this provider */
  models(): ModelOption[];

  /** How one process of a session starts: binary, argv and environment (claude-swap included) */
  launch(spec: SessionLaunch): LaunchPlan;
  /** Speaks the protocol to one process; events come out already neutral */
  attach(io: SessionIO, sink: (event: DriverEvent) => void, branches: BranchTracker): DriverSession;
  /** Per chat, across its processes: background tasks, subagents, workflows */
  createBranches(): BranchTracker;
  /** OS processes holding a session, for "it is still running elsewhere" and restore's leftovers */
  sessionHolders(sessionId: string): number[];
  liveSessions(): Array<{ pid: number; sessionId: string }>;

  /** What a session's first event confirms for the installed version */
  confirm(init: SessionInit): CapabilityConfirmation;

  /**
   * Optional parts, present only when the manifest declares the capability. `multiAccount` is
   * claude-swap for Claude, phase 2 only, and Core supplies it after the driver exists.
   */
  accounts?: AccountSupport | null;
}

/** What the runner needs to know about claude-swap, injected by Core to avoid a cycle. */
export interface AccountSupport {
  /** claude-swap is installed and has at least one account registered */
  readonly managed: boolean;
  /** The `cswap` a pinned chat runs through: `CSWAP_BIN`, the one on the `PATH`, or Agentry's own copy */
  readonly bin: string;
  isActive(identifier: string): boolean;
  /** Which account, and which config directory, a chat starts with */
  launchFor(chat: { account: string | null; cwd: string }): Launch;
}

/** Everything a process of a session is started from, minus what belongs to Agentry alone. */
export interface SessionLaunch {
  /** The session id, chosen by Agentry and imposed on the agent */
  id: string;
  /** The agent has confirmed the session exists: a process resumes it */
  created: boolean;
  /** The session this one is a copy of, until the copy is confirmed */
  forkFrom: string | null;
  name: string;
  cwd: string;
  permissionMode: PermissionMode;
  model?: string;
  effort?: NewChat['effort'];
  appendSystemPrompt?: string;
  /** The person's own rules, in the provider's words */
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpConfig?: string;
  confine?: ChatConfinement;
  /** Where attached files live, when this session may read them */
  uploadsDir?: string;
  worktree?: string;
  maxBudgetUsd?: number;
  /** `host` only when something is listening for what the agent asks */
  permissionPrompts: 'host' | 'none';
  jsonSchema?: unknown;
  systemPromptSnapshot?: 'off';
  internal?: boolean;
  agent?: string;
  agentsFile?: string;
  /** The account the chat is pinned to */
  account: string | null;
}

/** The process to start. `ChatManager` adds `AGENTRY_CHAT_ID`, `AGENTRY_API_URL` and the minted token itself. */
export interface LaunchPlan {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Variables the process must not inherit, removed after `env` */
  unsetEnv: string[];
}

/** The pipes of one process, as the protocol sees them. */
export interface SessionIO {
  write(text: string): void;
  /** Closes what the agent reads from */
  end(): void;
  /** The process is started and has not exited */
  up(): boolean;
}

/** A user turn: text and the files that go with it. */
export interface UserTurn {
  text: string;
  attachments: Attachment[];
  /** The bytes of an attachment, for a provider that sends images and documents inline */
  read?: (uploadId: string) => Buffer;
}

export interface DriverSession {
  /** Sends a turn; returns the text the agent received as the user's, for the transcript */
  send(turn: UserTurn): string;
  interrupt(): Promise<void>;
  setOption(option: { permissionMode: PermissionMode } | { model: string }): Promise<void>;
  answerPermission(requestId: string, decision: PermissionDecision): void;
  /** One line of stdout */
  readLine(line: string): void;
  /** One line of stderr */
  readError(line: string): void;
  /** Closes stdin: `keepAlive: false`, or the idle timeout */
  endInput(): void;
  /** Rejects pending control requests */
  dispose(reason: string): void;
}

/** Per chat, across its processes: what the agent delegated. */
export interface BranchTracker {
  readonly tasks: Map<string, BackgroundTask>;
  /** Long commands reported as tasks while they run in the foreground; listed once sent to the background */
  readonly foregroundTasks: Map<string, BackgroundTask>;
  readonly subagents: Map<string, SubagentInfo>;
  readonly workflows: Map<string, WorkflowRun>;
  /** The session the tracker belongs to; the id a task reports when it names none */
  sessionId: string;
  /** Reads the delegation out of a message the main agent or a subagent wrote */
  message(entry: TranscriptEntry): void;
  /** Applies a change of the agent's task list */
  task(change: string, raw: Record<string, unknown>): void;
  /** The process is gone: whatever still runs is over */
  endAll(at: string): void;
}

/** What a session's first event says about it. */
export interface SessionInit {
  version: string | null;
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  /** The session was started with a schema */
  structuredOutput: boolean;
}

export interface CapabilityConfirmation {
  version: string | null;
  confirmed: ProviderCapability[];
  /** Declared and contradicted by the init */
  missing: ProviderCapability[];
}

/** The request for a decision the agent is waiting on. */
export interface PermissionQuestion {
  id: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  description?: string;
  suggestions?: PermissionUpdate[];
  requiresUserInteraction?: boolean;
}

/** A per-model cost and window, as the agent reports them at the end of a turn. */
export interface ModelUsage {
  model: string;
  costUsd?: number;
  contextWindow?: number;
}

/**
 * What `ChatManager` pushes to a chat's feed: the neutral `RunEvent`, built by the driver because
 * only it knows what its protocol's event means.
 */
export type RunDraft = Omit<RunEvent, 'seq' | 'ts'>;

/** The environment an `init` describes, before the manager adds where and for which chat. */
export type EnvironmentDetails = Omit<EffectiveEnvironment, 'cwd' | 'chatId' | 'observedAt'>;

/** Internal to core: richer than `RunEvent`, and neutral. The manager folds them into `LiveChat`. */
export type DriverEvent =
  | {
      kind: 'init';
      sessionId: string | null;
      model: string | null;
      permissionMode: PermissionMode | null;
      cwd: string | null;
      environment: EnvironmentDetails;
      run: RunDraft;
    }
  | { kind: 'mode-changed'; mode: PermissionMode }
  | { kind: 'message'; entry: TranscriptEntry; mainAgent: boolean; stopReason?: string; run: RunDraft }
  | {
      kind: 'block-started';
      /** The block as the agent described it, for the activity ticker */
      block: { type?: unknown; id?: unknown; name?: unknown };
      /** What streams as text; `other` for a tool call and the like */
      streams: 'text' | 'thinking' | 'other';
      /** Its input is the structured result the session was asked for */
      structured: boolean;
    }
  | { kind: 'delta'; block: 'text' | 'thinking'; text: string }
  | { kind: 'structured-delta'; json: string }
  | { kind: 'block-stopped' }
  | { kind: 'stop-reason'; reason: string }
  | { kind: 'heartbeat'; toolUseId: string | null; elapsedSeconds: number | null }
  | { kind: 'command-started'; toolUseId: string; command: string }
  | { kind: 'command-ended'; toolUseId: string; isError: boolean }
  | { kind: 'task'; run: RunDraft }
  | { kind: 'rate-limit'; info: RateLimitInfo }
  /** The agent's wording says the account's window is spent: what a rotation is asked for on */
  | { kind: 'rate-limited' }
  | { kind: 'permission-request'; question: PermissionQuestion }
  | { kind: 'permission-withdrawn'; id: string }
  | {
      kind: 'result';
      isError: boolean;
      text: string;
      /** What a failed result is recorded as: its text, or the kind of failure when there is none */
      failure: string;
      turns: number;
      costUsd?: number;
      modelUsage: ModelUsage[];
      structuredOutput: unknown;
      stopReason?: string;
      /** The agent ended the turn because the budget ran out */
      budget: boolean;
      /** The failure was the account's rate limit */
      rateLimited: boolean;
      run: RunDraft;
    }
  | { kind: 'stderr'; text: string }
  /** A stdout line that is not the protocol */
  | { kind: 'unreadable'; text: string };
