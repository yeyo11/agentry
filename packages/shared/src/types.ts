// Contract shared between core, API and UI.

import type { NotificationKind, NotificationLevel, NotificationPriority } from './notifications.ts';

// ---------- System ----------

export interface CliInfo {
  installed: boolean;
  version: string | null;
  path: string | null;
  error?: string;
}

/**
 * Which Claude Code the wrapper runs and whether a newer one exists. The check costs a registry
 * read, so it happens on demand or once a day, never on a page load: `checkedAt` says how old the
 * answer is.
 */
export interface CliVersionInfo {
  /** The CLI on the PATH, as it reports itself; null when it is not installed */
  current: string | null;
  /** The version the image pins, when it pins one */
  pinned: string | null;
  /** Newest published version; null when the check has never run or could not reach the registry */
  latest: string | null;
  checkedAt: string | null;
  /** `latest` is newer than `current`; false whenever either of them is unknown */
  updateAvailable: boolean;
  /** Why the last check failed (registry unreachable, unexpected answer); the previous `latest` is kept */
  error?: string;
}

/**
 * How this Agentry was installed, from `AGENTRY_DISTRIBUTION`: what decides which way to update it
 * a client offers. `source` is a checkout run with pnpm, and whatever the variable does not name.
 */
export type AgentryDistribution = 'docker' | 'appimage' | 'deb' | 'source';

export interface AgentryReleaseInfo {
  /** The version this server runs */
  current: string;
  /** Newest published release, without the tag's `v`; null when the check has never succeeded */
  latest: string | null;
  publishedAt: string | null;
  /** The release's page on GitHub, with its notes */
  url: string | null;
  checkedAt: string | null;
  /** `latest` is newer than `current`; false while `latest` is unknown */
  updateAvailable: boolean;
  distribution: AgentryDistribution;
  /** Why the last check failed (GitHub unreachable, unexpected answer); the previous `latest` is kept */
  error?: string;
}

/**
 * `wrapper-*`: configured through the API; `env-*`: passed through the container environment;
 */
export type TokenSource =
  | 'wrapper-oauth-token'
  | 'wrapper-api-key'
  | 'env-oauth-token'
  | 'env-api-key'
  | 'credentials-file'
  | 'none';

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  tokenSource: TokenSource;
  error?: string;
}

export interface SystemInfo {
  cli: CliInfo;
  auth: AuthStatus;
  configDir: string;
  workspaceDir: string;
  defaultPermissionMode: PermissionMode;
  /** What `--model` may be given, as the CLI offers it to the account in use */
  models: ModelOption[];
  /** Agentry's own version */
  version: string;
  uptimeSec: number;
}

/** One choice for `--model`. */
export interface ModelOption {
  /** What the flag takes: an alias (`opus`) or a model's full name (`claude-fable-5-1[1m]`) */
  value: string;
  /**
   * The model ids an alias stands for, as chats that ran on it reported them (`claude-sonnet-5` for
   * `sonnet`). Suggestions, moves and accepted mappings carry the id, the catalogue lists the alias:
   * match a row on its `value` or on any of its `ids`. Absent where the value is already the id.
   */
  ids?: string[];
  /**
   * What the CLI calls it, where it says so; for an alias, the name of the model a chat started on
   * it reported in its `system/init` event ("Sonnet 5" for `claude-sonnet-5`), once one has
   */
  label?: string;
  /** The line the CLI shows under it */
  description?: string;
  /** The CLI names it but cannot run it (it is too old for it, say); `description` says why */
  disabled?: boolean;
  /** How capable it is among its provider's models, where the provider says; a model with no rank has none */
  tier?: ModelTier;
}

/** A provider's models by how fast or how strong they are; what model mapping across providers builds on. */
export type ModelTier = 'fast' | 'balanced' | 'strong';

export interface RateLimitWindow {
  utilization: number;
  resetsAt: number;
}

export interface RateLimitInfo {
  status: string;
  rateLimitType?: string;
  resetsAt?: number;
  windows: Record<string, RateLimitWindow>;
  observedAt: string;
}

// ---------- Transcripts (read from ~/.claude/projects) ----------

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  /** Metadata only: the bytes stay in the transcript or the upload store, never in a response */
  | { type: 'image'; mediaType: string; name?: string; uploadId?: string }
  | { type: 'document'; mediaType: string; name?: string; uploadId?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

/**
 * A file uploaded to attach to a message. Images and PDFs reach Claude as content blocks; any other
 * file by its path, which every run can read.
 */
export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  kind: 'image' | 'pdf' | 'file';
  sizeBytes: number;
  /** Absolute path on the machine the wrapper runs on */
  path: string;
  createdAt: string;
}

export interface TranscriptEntry {
  uuid: string;
  role: 'user' | 'assistant';
  timestamp: string | null;
  model: string | null;
  /** Belongs to a subagent */
  isSidechain: boolean;
  parentToolUseId: string | null;
  blocks: ContentBlock[];
}

/** How many transcript entries a window holds when the caller does not say. */
export const TRANSCRIPT_PAGE = 200;

/** The most a single page may carry, however large a `limit` asks for. */
export const TRANSCRIPT_PAGE_MAX = 1000;

/** The most hits one search returns; past it the newest ones are kept and `truncated` is set. */
export const TRANSCRIPT_SEARCH_MAX_HITS = 500;

/** One entry whose text contains the query. */
export interface TranscriptSearchHit {
  /** Index of the entry or event, in the same index space as `from` and `total` of a page */
  index: number;
  /** The text around the first match, whitespace collapsed */
  snippet: string;
  /** Where the match starts within `snippet` */
  start: number;
  /** Length of the match within `snippet` */
  length: number;
}

export interface TranscriptSearchResult {
  query: string;
  /** Hits in transcript order, oldest first: one per entry, however many times it matches */
  hits: TranscriptSearchHit[];
  /** Entries searched, the same `total` a page of the transcript reports */
  total: number;
  /** More entries matched than `hits` carries; the oldest ones were left out */
  truncated: boolean;
}

// ---------- Runs (`claude -p` processes managed by the wrapper) ----------

/** Every mode the CLI's `--permission-mode` takes: one list, so the API and the orchestrator cannot drift apart. */
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** What `--model` takes: an alias or a full id, `[1m]` variants included; nothing a shell or a flag could misread. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

export type RunStatus = 'starting' | 'busy' | 'idle' | 'completed' | 'failed' | 'stopped';

/** Captured output of a background task, as the CLI wrote it. */
export interface BackgroundTaskOutput {
  taskId: string;
  /**
   * Without `offset`, the tail of the file (at most 64 KiB); with it, up to 64 KiB of what follows
   * that byte, so a longer gap takes several reads (`offset` < `bytes` means more is waiting)
   */
  output: string;
  /** `output` is the tail of a longer file, not its start. Never set on a read that resumed from `offset`. */
  truncated: boolean;
  /** Size of the output file in bytes */
  bytes: number;
  /** Byte position just after `output`: pass it back as `?offset=` to read only what came since */
  offset: number;
  /** The requested `offset` was past the end of the file (it was replaced), so `output` restarts from the tail */
  reset?: boolean;
}

/** Tokens counted in the four ways the API bills them. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** `input + output + cacheRead + cacheCreation` */
  total: number;
}

/**
 * Everything one subagent or workflow agent did, from the transcript and meta the CLI keeps for it
 * beside the session's transcript: what it was asked, how it went, and its whole conversation.
 */
export interface AgentTranscript {
  agentId: string;
  sessionId: string;
  kind: 'subagent' | 'workflow';
  /** The workflow run (`wf_…`) a workflow agent belongs to */
  workflowRunId: string | null;
  /** The CLI's `agentType` (`Explore`, `general-purpose`, `workflow-subagent`…) */
  subagentType: string | null;
  /** The description given at launch; a workflow agent's is its label */
  description: string | null;
  workflowPhase: string | null;
  /** Its first message: the prompt it was given */
  prompt: string | null;
  /** `stopped` when its session ended before the agent reported back */
  status: 'running' | 'completed' | 'failed' | 'stopped';
  background: boolean;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  lastActivityAt: string | null;
  model: string | null;
  usage: TokenUsage;
  toolCalls: number;
  cwd: string | null;
  /** Text of the agent's last assistant message: what it reported back */
  result: string | null;
  /** Entries of the transcript, from index `from` on (all of it unless `?after=` asked for a tail) */
  entries: TranscriptEntry[];
  /** Index of the first entry returned */
  from: number;
  /** Entries in the whole transcript: pass it back as `?after=` to read only what was appended */
  total: number;
  /** Background tasks this agent launched, where the transcripts say so (subagents only) */
  tasks: ChatBackgroundTask[];
}

/** A saved workflow the Workflow tool can run by name, from a `.claude/workflows/` directory. */
export interface WorkflowDefinition {
  name: string;
  description: string | null;
  /** `project` from the directory's `.claude/workflows/`, `user` from `~/.claude/workflows/` */
  scope: 'project' | 'user';
  path: string;
}

/** Starts a chat that runs a saved workflow. */
export interface RunWorkflowRequest {
  name: string;
  /** Project to run it in; its `.claude/workflows/` must hold it unless it is a user workflow */
  cwd?: string;
  /** Handed to the script as its `args` */
  args?: string;
  model?: string;
}

/**
 * `partial` events are ephemeral: they carry the text generated so far for the block being
 * streamed, reuse the seq of the last stored event, are never buffered or replayed, and are
 * superseded by the next `message` event.
 */
export type RunEventKind = 'message' | 'init' | 'result' | 'task' | 'status' | 'stderr' | 'notice' | 'other' | 'partial';

export interface RunEvent {
  seq: number;
  ts: string;
  kind: RunEventKind;
  /** For `message` events */
  entry?: TranscriptEntry;
  /** For `status` events */
  status?: RunStatus;
  /** For `partial`, `result`, `stderr`, `notice` and `other` events; for `other`, a stdout line the driver could not read */
  text?: string;
  /** For `partial` events: which kind of block is streaming */
  block?: 'text' | 'thinking';
  /** For `init` events, in the provider's neutral words */
  init?: RunInit;
  /** For `result` events */
  outcome?: RunOutcome;
  /** For `task` events */
  task?: RunTaskChange;
  /** For `notice` events only: Agentry's own words, never a provider's */
  data?: Record<string, unknown>;
}

/** What a session reports about itself when it starts. */
export interface RunInit {
  sessionId: string;
  model: string;
  cwd: string;
  permissionMode: string;
  /** The names of the tools the session has, as the provider calls them */
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
}

/** How a turn ended. */
export interface RunOutcome {
  isError: boolean;
  turns: number;
  durationMs: number;
  costUsd: number;
  structuredOutput?: unknown;
  permissionDenials: Array<{ toolName: string; toolUseId: string }>;
  /**
   * Why a failed result is not one to try again blindly: the budget ran out, the account hit its
   * limit or someone stopped it.
   */
  cause?: 'budget' | 'rate-limit' | 'stopped';
  /** The main agent's last stop reason in the turn (`end_turn`, `tool_use`, `max_tokens`…), when the provider said */
  stopReason?: string;
}

/** A background task starting, moving or ending, or the whole list being replaced. */
export interface RunTaskChange {
  /** Absent for a change of the whole list */
  taskId?: string;
  change: 'started' | 'updated' | 'progress' | 'ended' | 'listed';
  taskKind: 'command' | 'agent' | 'workflow' | 'other';
  status?: string;
  description?: string;
  summary?: string;
}

// ---------- Chats, executions and projects (Agentry's own model) ----------
//
// What the web and the API speak. Nothing here exists because the Claude Code CLI happens to write
// it that way: the CLI's facts are translated in `packages/core` (`chat-model.ts`, `usage.ts`) and
// stop there.

/** What is happening in a chat right now, whoever is driving it. */
export type ChatState = 'working' | 'waiting' | 'idle';

/**
 * What a person can do with a chat right now, and why not when they cannot. Where the chat was born
 * says nothing about this: an `external` chat nobody holds is `resumable`.
 *
 * `readOnly` always says why in words a person reads, and names the one way forward:
 * `fork` continues in a copy, `hint` (a task that is still running) sends the worker a nudge from
 * the orchestration board without typing into its conversation.
 */
export type ChatControl =
  | { mode: 'interactive' }
  | { mode: 'resumable' }
  | { mode: 'readOnly'; reason: string; action: 'fork' | 'hint' };

/** Where a chat was born. Never changes, even when resuming adopts the chat. */
export type ChatOrigin = 'agentry' | 'external' | 'orchestration' | 'internal';

/** How an execution ended. `interrupted`: its process was lost (the wrapper restarted or crashed) rather than stopped or finished. */
export type ExecutionOutcome = 'completed' | 'failed' | 'stopped' | 'interrupted';

/** Tokens counted the four ways the API bills them, for one model. */
export interface ChatModelTokens extends TokenUsage {
  /** Model id, variant suffix included; null for messages that did not say */
  model: string | null;
}

/** One stretch of a chat during which Agentry had a process working on it; a chat has several and at most one is live. */
export interface Execution {
  id: string;
  startedAt: string;
  /** Null while it is live */
  endedAt: string | null;
  /** Null while it is live */
  outcome: ExecutionOutcome | null;
  /** Why it failed, when it did */
  error: string | null;
  permissionMode: PermissionMode;
  model: string | null;
  /** Ceiling on what it could spend */
  maxBudgetUsd: number | null;
  /** Null when the CLI reported none: cost is only known for what Agentry launched */
  costUsd: number | null;
  /**
   * What the CLI reported per model (`modelUsage[model].costUSD`), the only honest split of
   * `costUsd`: absent on an execution recorded before Agentry kept it or one the CLI reported none for.
   */
  modelCosts?: Record<string, number>;
  tokens: TokenUsage;
  turns: number;
}

/** From here on the CLI is close enough to compacting that a person should know before it happens. */
export const CONTEXT_WARN = 0.8;
export const CONTEXT_FULL = 0.92;

/** How full the conversation is, as of its last response. */
export interface ChatContext {
  /** Tokens the last response read: `input + cache`. A snapshot, so compaction shows as a drop. */
  used: number;
  /** The model's context window; null when the model is not known, so no percentage is invented */
  window: number | null;
}

/** How worrying a signal is. */
export type HealthLevel = 'ok' | 'warn' | 'bad';

/**
 * What a signal noticed. Only what Agentry can tell from what it already receives is here: a command
 * that runs far longer than it should, a chat that has gone quiet while it should be working, and
 * facts of the chat itself (how its last execution ended, that it waits for a person, that its
 * context is nearly full, that a branch failed).
 *
 * The second group comes from docs/plans/agent-observability.md and is about a worker that is busy
 * without getting anywhere: the same tool call over and over (`repeat-stall`), no commit and no
 * file touched for a long stretch (`no-progress`), the same few steps in a cycle (`loop`), a test
 * edited so that it stops asserting what it asserted (`weakened-test`), and the ceiling of
 * {@link TaskLimits} coming close (`budget`).
 */
export type HealthSignalKind =
  | 'hung-command'
  | 'silence'
  | 'last-execution'
  | 'waiting'
  | 'context'
  | 'branches'
  | 'repeat-stall'
  | 'no-progress'
  | 'loop'
  | 'weakened-test'
  | 'budget';

export interface HealthSignal {
  kind: HealthSignalKind;
  /** Never `ok`: a signal that fired is a warning or a problem */
  level: Exclude<HealthLevel, 'ok'>;
  /** One line a person reads, with the figures that made it fire */
  reason: string;
  /**
   * Stable key of `reason`, so a client can say it in its own language; the English stays in
   * `reason` for readers that do not translate. See {@link Localized} for the shape this follows.
   */
  reasonCode?: string;
  /** Stable key of `hint`, the same way */
  hintCode?: string;
  /** The figures `reason` and `hint` were built from: the command, the minutes, the file, the count */
  params?: LocalizedParams;
  /** When the condition started, for the signals that measure a stretch of time */
  since?: string;
  /** What made it fire, when the line is not enough: the command, the file, the figures */
  detail?: string;
  /**
   * Text the panel prefills the hint box with. Agentry writes it, not the model: a suggestion per
   * signal is worth more than an empty box to someone who has just been told a worker is stuck.
   */
  hint?: string;
  /** The tool call to cancel, when the signal is about one command that is still running */
  toolUseId?: string;
}

/**
 * Whether a chat is working as it should, computed in core at the moment it is read (a command that
 * has been running for too long is a fact of the clock, so a snapshot ages: readers of a live chat
 * read it again). `level` is the worst of the `signals`, ordered worst first, and `reason` is the
 * first one's; with no signal the chat is `ok` and `reason` says so.
 */
export interface ChatHealth {
  level: HealthLevel;
  reason: string;
  signals: HealthSignal[];
  /** What the supervisor proposed for the worst signal, when it is on and has answered; null when it has not */
  proposal?: SupervisorProposal | null;
}

/** The same verdict on anything that works: a chat, or an orchestration task. */
export type Health = ChatHealth;

/** What a task may spend before Agentry stops it. */
export interface TaskLimits {
  /** Wall-clock ceiling, enforced by Agentry: the CLI has no flag for it */
  maxMinutes?: number;
  /** Passed to the CLI as `--max-budget-usd`, so the CLI itself ends the turn */
  maxCostUsd?: number;
}

/** What a chat has cost. Only real data: nothing is estimated from a price table. */
export interface ChatCost {
  /** Null when there is no figure to give (a chat started from a terminal): read as "not available" */
  usd: number | null;
  /** Everything the chat spent, subagents included, split by model */
  tokens: ChatModelTokens[];
  /** The same, summed over models */
  total: TokenUsage;
}

/** What was spent over some stretch of chats. Tokens are real and cover every chat; the cost only covers the chats that reported one. */
export interface UsageTotals {
  /** Sum of what the CLI reported; null when it reported nothing for any chat in it: read as "not available" */
  costUsd: number | null;
  /** Chats in these totals whose cost the CLI never reported (started from a terminal), so `costUsd` leaves them out */
  chatsWithoutCost: number;
  tokens: ChatModelTokens[];
  total: TokenUsage;
}

export interface UsageDay extends UsageTotals {
  /** `YYYY-MM-DD`, in the server's time zone */
  day: string;
}

export interface UsageProject extends UsageTotals {
  /** Null for the chats under no imported project */
  project: ChatProject | null;
}

export interface UsageOrchestration extends UsageTotals {
  orchestration: { id: string; name: string };
}

/** What the chats spent, per day, per project and per orchestration. */
export interface UsageReport {
  /** The days asked for, inclusive; null when unbounded */
  from: string | null;
  to: string | null;
  total: UsageTotals;
  /** Oldest first, only days something was spent on */
  days: UsageDay[];
  /** Most spent first */
  projects: UsageProject[];
  /** Most spent first; only the chats that work for an orchestration */
  orchestrations: UsageOrchestration[];
}

/** How wide one point of a usage series is. */
export type UsageBucket = 'day' | 'week';

export interface UsagePoint {
  /** Start of the bucket, `YYYY-MM-DD` in the server's time zone */
  at: string;
  /** Null when no chat in the bucket reported a cost; never estimated from a price table */
  costUsd: number | null;
  tokens: number;
  chats: number;
}

/** Cost and usage over time, for a chart. */
export interface UsageSeries {
  bucket: UsageBucket;
  /** Oldest first, one point per bucket of the range, empty ones included so a chart has no gaps */
  points: UsagePoint[];
}

/** What one project or one model spent over a range. */
export interface UsageSlice {
  /** Project id, or model id */
  key: string;
  /** What to show: the project's name, or the model id as the CLI writes it */
  label: string;
  costUsd: number | null;
  tokens: number;
  chats: number;
}

/** The same range cut two ways. Most spent first in both. */
export interface UsageBreakdown {
  byProject: UsageSlice[];
  byModel: UsageSlice[];
}

/** How a transcript is exported: Markdown for a person, JSON faithful to the events. */
export type ExportFormat = 'markdown' | 'json';

/** A chat exported as JSON: the chat as the API shows it and every transcript entry, subagents included, in order. */
export interface ChatExport {
  /** When the export was made */
  exportedAt: string;
  chat: Chat;
  entries: TranscriptEntry[];
}

/** A project exported as JSON: the project and every chat under it, each as its own {@link ChatExport}. */
export interface ProjectExport {
  /** When the export was made */
  exportedAt: string;
  project: Project;
  chats: ChatExport[];
}

/** Where a fork came from. */
export interface ChatFork {
  chatId: string;
  /** When it was forked */
  at: string;
}

/** The project a chat belongs to. */
export interface ChatProject {
  id: string;
  name: string;
}

/** The git worktree a chat works in, when it is not the project's own checkout. */
export interface ChatWorktree {
  path: string;
  name: string | null;
  branch: string | null;
}

/** What a chat does for the orchestration it works for. */
export type OrchestrationChatRole = 'task' | 'integration' | 'verification' | 'synthesis' | 'workflow';

/** The orchestration a chat works for. */
export interface ChatOrchestration {
  id: string;
  name: string;
  /** What the chat does for the graph; `task` is the only role with a taskId */
  role: OrchestrationChatRole;
  taskId: string | null;
  taskName: string | null;
}

/** How far a piece of work a chat delegated has got. */
export type ChatBranchStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** A command or agent a chat sent off to run beside it. */
export interface ChatBackgroundTask {
  id: string;
  kind: string;
  description: string;
  /** The shell command, when it is a backgrounded Bash call */
  command: string | null;
  status: ChatBranchStatus;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  /** Sent to the background by the person, not by the model */
  byPerson: boolean;
  /** The subagent that launched it; null when the chat itself did */
  ownerId: string | null;
}

/** A branch of a chat that works on its own: its messages live inside the chat's transcript. */
export interface ChatSubagent {
  /** Id of its transcript inside the chat */
  id: string;
  /**
   * The session it belongs to, which is the chat's id. On every route that reports a subagent, so
   * the one nested in `GET /chats/:id` and the ones `GET /subagents` lists read the same.
   */
  sessionId: string;
  kind: string;
  description: string;
  status: ChatBranchStatus;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string | null;
  /** Where it works, when that is not the chat's directory (a worktree) */
  cwd: string | null;
  tasks: ChatBackgroundTask[];
}

/** One agent of a workflow. */
export interface ChatWorkflowAgent {
  index: number;
  label: string;
  status: 'running' | 'completed' | 'failed';
  /** Id of its transcript inside the chat, when it has one */
  id: string | null;
  phase: string | null;
  model: string | null;
  startedAt: string | null;
  durationMs: number | null;
  tokens: number | null;
  toolCalls: number | null;
  promptPreview: string | null;
  resultPreview: string | null;
}

/** A script that orchestrates subagents inside a chat. */
export interface ChatWorkflow {
  id: string;
  name: string | null;
  description: string;
  status: ChatBranchStatus;
  startedAt: string;
  endedAt: string | null;
  phases: string[];
  agents: ChatWorkflowAgent[];
  /** What the script returned, once it finished */
  result?: unknown;
  summary: string | null;
  totalTokens: number | null;
  script: string | null;
}

/** What a chat spawned: branches of it, not chats of their own. */
export interface ChatChildren {
  subagents: ChatSubagent[];
  backgroundTasks: ChatBackgroundTask[];
  workflows: ChatWorkflow[];
}

/** What a live execution is doing right now, from its latest stream-json events. */
export interface ChatActivity {
  /** `tool`: a tool call without its result yet; `writing`/`thinking`: a text or thinking block is streaming; `waiting`: blocked on a permission prompt */
  kind: 'tool' | 'writing' | 'thinking' | 'waiting';
  /** The CLI's tool name (`Edit`, `Bash`, `Grep`, `Task`…) when `kind` is `tool` */
  tool?: string;
  /** A short human label for the tool's input: a path relative to the chat's cwd, a command's description or its first 80 characters, a pattern, a subagent's description, a URL's host */
  target?: string;
  /** When this activity started (ISO) */
  since: string;
}

/** What Claude loaded when the chat last started. */
export interface ChatEnvironment {
  observedAt: string;
  model: string | null;
  permissionMode: string | null;
  outputStyle: string | null;
  tools: string[];
  mcpServers: Array<{ name: string; status: McpHealthStatus }>;
  agents: string[];
  skills: string[];
  slashCommands: string[];
  plugins: Array<{ name: string; path?: string }>;
  memoryPaths: Record<string, string>;
}

/**
 * The other end of a provider move, as a chat links to it. A move is always a new chat (a session
 * belongs to its provider), so the old chat and the new one point at each other.
 */
export interface ChatContinuation {
  chatId: string;
  /** The provider of the chat at the other end */
  provider: ProviderId;
  action: 'handoff' | 'restart';
  at: string;
  /** The {@link ProviderMove} that recorded it */
  moveId: string;
}

/**
 * One Claude Code conversation: the root entity of the product. Always exactly one session id, which
 * is also the chat's id. Subagents and workflows are branches of a chat, not chats.
 */
export interface Chat {
  /** The session id */
  id: string;
  title: string;
  /** The provider that runs the chat; a chat read from Claude's transcripts is `claude-code` */
  provider: ProviderId;
  /** The id the provider chose for its own session; null on Claude, where the chat id is the session id */
  providerSessionId: string | null;
  firstPrompt: string | null;
  messageCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  model: string | null;
  cliVersion: string | null;
  /** Null for a loose chat: its directory is under no imported project */
  project: ChatProject | null;
  cwd: string;
  worktree: ChatWorktree | null;
  origin: ChatOrigin;
  /** The orchestration it works for, when its origin is `orchestration` */
  orchestration: ChatOrchestration | null;
  /** Set on a fork: where it started from */
  derivedFrom: ChatFork | null;
  /** The chat this one continues after a provider move; null when it is not a continuation */
  continuedFrom?: ChatContinuation | null;
  /** The chat that continues this one after a provider move; null while none does */
  continuedIn?: ChatContinuation | null;
  /**
   * The chat's last turn died on its provider's usage limit. Kept in the server's memory only: after
   * a restart it is absent, and the page falls back on the provider's reading.
   */
  atLimit?: boolean;
  state: ChatState;
  control: ChatControl;
  /** The live execution, when Agentry has a process on the chat; also the last of `executions` */
  execution: Execution | null;
  /** What that execution is doing right now; `null` whenever none is live */
  activity?: ChatActivity | null;
  /** Every execution, oldest first */
  executions: Execution[];
  /** Null until the chat has had a response */
  context: ChatContext | null;
  cost: ChatCost;
  children: ChatChildren;
  /** Null when nothing has reported it yet */
  environment: ChatEnvironment | null;
  health: ChatHealth;
  /** What it was started with, when Agentry started it: absent for a chat born in a terminal */
  tools?: ChatToolConfig | null;
}

/** A page of a chat's transcript with the chat it belongs to. */
export interface ChatDetail {
  chat: Chat;
  /** The window of the transcript this page carries, oldest first */
  entries: TranscriptEntry[];
  /** Index of the first entry in `entries` within the whole transcript */
  from: number;
  /** Entries the transcript holds in total, so a caller knows what is still above `from` */
  total: number;
}

/**
 * A chat as the list shows it: everything but what only its own page needs, which costs a read of
 * its transcript and its sidecar files per chat.
 */
export type ChatSummary = Omit<Chat, 'children' | 'environment' | 'health'>;

/** Which chat a branch belongs to, for the aggregates that list branches of many chats together. */
export interface ChatRef {
  id: string;
  title: string;
  /** The chat's first prompt, which a screen shows as its title when `title` is only a generated name */
  firstPrompt: string | null;
  project: ChatProject | null;
  cwd: string;
  worktree: ChatWorktree | null;
}

/** A background command or agent, listed with the chat that sent it off. */
export type ChatBackgroundTaskEntry = ChatBackgroundTask & { chat: ChatRef };

/** A subagent, listed with the chat it belongs to. */
export type ChatSubagentEntry = ChatSubagent & { chat: ChatRef };

/** A workflow run, listed with the chat it belongs to. */
export type ChatWorkflowEntry = ChatWorkflow & { chat: ChatRef };

/**
 * Which of the configured MCP servers a chat starts with. Agentry writes the file the CLI reads and
 * passes it as `--mcp-config` / `--strict-mcp-config`; there is no other way in.
 */
export interface McpSelection {
  /** Names of configured servers, as `GET /config/mcp` lists them; empty starts the chat with none */
  servers: string[];
  /** Path of the config file Agentry wrote for the CLI, reported back so a chat can be explained */
  config?: string;
}

/** A shell command a policy allows or denies, in Agentry's words. */
export type CommandRule =
  /** Exactly this command, no arguments */
  | { command: string; args: 'none' }
  /** This command followed by arguments */
  | { command: string; args: 'some' }
  /** Anything starting with these words */
  | { command: string; args: 'prefix' }
  /** A command line with `*` wildcards */
  | { pattern: string };

/**
 * What a session may do, in Agentry's words. Each provider's driver translates it into its own
 * rules and lists the parts it cannot enforce.
 */
export interface ToolPolicy {
  /** `denyPaths` are path globs never read */
  read: { allow: boolean; denyPaths?: string[] };
  /** Paths are relative to the project; `deny` is denial outright, for a mode that would otherwise ask */
  edit: { allow: 'none' | 'any' | string[]; deny?: boolean };
  commands: { allow: 'none' | 'any' | CommandRule[]; deny?: 'all' | CommandRule[] };
  /** Web fetch and search tools */
  network: 'allow' | 'omit' | 'deny';
  /** Subagents */
  delegate?: 'deny';
  /** The orchestrator's workflow engine */
  workflow?: 'allow';
  gitPush: 'deny' | 'omit';
  /** Nothing outside the policy exists for the session: no person's settings, hooks or servers */
  exclusive?: boolean;
}

/** The parts of a {@link ToolPolicy} a provider enforces in its own way. */
export type PolicyPart =
  | 'read'
  | 'edit'
  | 'commands'
  | 'network'
  | 'delegate'
  | 'workflow'
  | 'gitPush'
  | 'exclusive';

/** A policy in a provider's own terms, and the parts it cannot enforce. */
export interface PolicyTranslation {
  rules: { allowedTools: string[]; disallowedTools: string[]; tools?: string[] };
  /** Native settings the launch applies (a sandbox mode, inline config, a policy file), each with the part it enforces */
  settings?: Array<{ part: PolicyPart; key: string; value: unknown }>;
  /** Parts Agentry enforces by answering the agent's permission requests itself, through the policy judge */
  host?: PolicyPart[];
  /** The policy parts the provider cannot enforce, by field (`gitPush`, `commands`…) */
  unsupported: string[];
}

/** A named set of `--allowedTools` / `--disallowedTools`, picked when a chat starts or resumes. */
export interface ToolPreset {
  id: string;
  name: string;
  /** One line saying what it is for, shown next to the name when picking */
  description?: string;
  allowedTools: string[];
  disallowedTools?: string[];
  /** What a shipped preset states in Agentry's words; each provider translates it into its own rules */
  policy?: ToolPolicy;
  /** Shipped with Agentry. Editable like any other, but a fresh install has it again. */
  builtIn?: boolean;
}

/** Settings about the presets as a whole, kept in `tool-presets.json` beside them. */
export interface ToolPresetsConfig {
  /** Taken by a new chat that names neither `toolPreset` nor `allowedTools`; null leaves such a chat with the CLI's own tools */
  defaultPresetId: string | null;
}

/** What `GET /config/tool-presets` answers: the presets, and the settings about them beside the list. */
export interface ToolPresetsOverview extends ToolPresetsConfig {
  presets: ToolPreset[];
}

/** What a chat is running with, shown on its detail because it is what explains a refusal. */
export interface ChatToolConfig {
  /** The preset in force, when one was chosen; editing a preset later does not change a live chat */
  preset: ToolPreset | null;
  allowedTools: string[];
  disallowedTools: string[];
  /** Null when the chat takes whatever the CLI loads on its own */
  mcp: McpSelection | null;
  /** The policy the chat was started with, so a resume enforces the same one */
  policy?: ToolPolicy;
}

/** What can be chosen when a process starts on a chat, whether it is new, resumed or a fork. */
export interface ChatStartOptions {
  /** The provider to run on; the first one in the person's order that can run chats when absent */
  provider?: ProviderId;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /**
   * Id of a stored {@link ToolPreset}; an explicit `allowedTools` wins over it. A new chat that names
   * neither this nor `allowedTools` takes the default preset; `null` opts out of it (and, on a resume
   * or a fork, drops the preset the chat had).
   */
  toolPreset?: string | null;
  /** MCP servers this chat starts with; absent keeps what it has, `null` goes back to what the CLI loads on its own */
  mcp?: McpSelection | null;
  /** Ceiling on what this execution may spend */
  maxBudgetUsd?: number;
  /** `host` sends permissions, questions and plans to the panel; `none`, the default, denies them */
  permissionPrompts?: 'host' | 'none';
}

/** Starts a new chat. */
export interface NewChatRequest extends ChatStartOptions {
  prompt: string;
  /** Uploads (`POST /uploads`) attached to the first message */
  attachments?: string[];
  /** Working directory; defaults to the wrapper workspace */
  cwd?: string;
  /** Run inside a new git worktree of this name */
  worktree?: string;
  /** JSON Schema for structured output */
  jsonSchema?: unknown;
}

/** Continues a chat nobody holds, in place: it keeps its id. */
export interface ResumeChatRequest extends ChatStartOptions {
  prompt: string;
  attachments?: string[];
}

/** Continues a chat in a copy of it, which is a new chat that records where it came from. */
export interface ForkChatRequest extends ChatStartOptions {
  prompt: string;
  attachments?: string[];
}

/** A message to a chat that has a live execution. */
export interface ChatMessageRequest {
  text: string;
  attachments?: string[];
}

/** What can be changed on a live execution without restarting it. */
export interface ChatSettingsUpdate {
  permissionMode?: PermissionMode;
  model?: string;
}

/**
 * A nudge sent to something that is still running, without typing into its conversation: the text
 * reaches the worker as its next user message.
 */
export interface HintRequest {
  text: string;
}

/** A nudge sent to a task that is still running, from the orchestration board. */
export type TaskHintRequest = HintRequest;

/**
 * Kills one command's process tree without ending the turn: the descendants of the CLI process that
 * belong to that tool call, found by pid, never by matching a command line. The worker gets a
 * failed tool result and carries on. Which call is in the path.
 */
export interface CancelCommandRequest {
  /**
   * Told to the worker as its next message, so it knows a person stopped the command and why. The
   * CLI writes the failed tool result itself (an exit status, nothing more), so the reason cannot
   * ride in it.
   */
  reason?: string;
}

/** What cancelling a command did. */
export interface CancelCommandResult {
  toolUseId: string;
  /** The command, as the worker wrote it */
  command: string;
  /** How many processes of its tree were ended */
  processes: number;
}

/** A git worktree of a project. */
export interface ProjectWorktree {
  path: string;
  name: string | null;
  branch: string | null;
  /** The orchestration task that created it, when one did */
  createdBy: { orchestrationId: string; orchestrationName: string; taskId: string; taskName: string } | null;
}

/** A directory the person imported, with the worktrees that belong to it. */
export interface Project {
  /** Ours: not derived from the path or from anything the CLI writes */
  id: string;
  name: string;
  path: string;
  worktrees: ProjectWorktree[];
  /** The directory is still on disk */
  exists: boolean;
  /** Chats under the project and its worktrees */
  chatCount: number;
  lastActivity: string | null;
  /** Prefix of its work items' keys (`AGN` in `AGN-12`), from {@link ProjectSettings.keyPrefix} */
  key: string;
  /** The modules switched on, from {@link ProjectSettings.modules}; empty for a project that never had one */
  modules: ProjectModule[];
}

/** A directory chats have run in that is not imported, offered on first start. */
export interface ProjectCandidate {
  path: string;
  name: string;
  chatCount: number;
  lastActivity: string | null;
}

/** Imports a directory; every chat under it is adopted, retroactively. */
export interface ImportProjectRequest {
  path: string;
  /** Defaults to the directory's name */
  name?: string;
  /** Configures the project from a template; without one, and without `modules`, every module is off */
  template?: ProjectTemplateId;
  /** The modules to switch on; when given, it replaces the template's choice instead of adding to it */
  modules?: ProjectModule[];
}

/** Every field is optional, so a rename alone (`{ name }`) keeps working as it always has. */
export interface UpdateProjectRequest {
  name?: string;
  /** New key prefix; the keys of existing work items follow, since only their number is stored */
  key?: string;
  /** The whole set of modules that are on afterwards; switching one off hides it and keeps its data */
  modules?: ProjectModule[];
}

// ---------- Project modules ----------
//
// A project is more than a directory once the person switches modules on: a board of work items, a
// team of agents, its documents, a shared memory (docs/plans/project-ecosystem.md). What a project
// configures lives in a settings document per project, a JSON file keyed by its id, so the project
// record itself stays a name and a path. Switching a module off only hides it: nothing it holds is
// deleted, and switching it on again brings everything back. A project with no document reads as
// every module off, which is how the projects imported before this existed stay as they were.
//
// Lists (`modules`, `types`) rather than one boolean per member, so a module or a type added later
// is simply absent from older documents and requests instead of a missing required key.

export type ProjectModule = 'board' | 'team' | 'documents' | 'memory';

/**
 * The built-in templates. `simple` switches nothing on and `custom` starts from everything off for
 * the person to choose; the other three are presets. There are no user-saved templates.
 */
export type ProjectTemplateId = 'simple' | 'software' | 'library' | 'research' | 'custom';

/** How the Board module is configured. The five columns and the four types are fixed; this only picks and limits. */
export interface BoardSettings {
  /** The types a new work item may take in this project, in the order a form offers them */
  types: WorkItemType[];
  /**
   * Work in progress limit per column. A column without an entry has none. Going over a limit is
   * allowed and only shown as a warning: it never blocks a move.
   */
  columnLimits: Partial<Record<WorkItemStatus, number>>;
}

/**
 * A role of the project's team as a template or the settings describe it. `role` is free text
 * (`product-owner`, `developer`, `qa`…) until the Team module defines its roles.
 */
export interface ProjectTeamRole {
  role: string;
  /** Model alias or id of the agent that plays it (`opus`, `sonnet`) */
  model: string;
  /** One line on what it answers for */
  responsibility: string;
}

/**
 * The Team module's metadata. A member is a CLI agent file in the project's `.claude/agents/`, so it
 * also works from a terminal; this is what Agentry keeps beside it. `GET /projects/:id/team` serves
 * each member with the state of its file ({@link TeamMember}).
 */
export interface ProjectTeamSettings {
  members: ProjectTeamMember[];
}

export interface ProjectTeamMember extends ProjectTeamRole {
  /** Name of the agent file in the project's `.claude/agents/`, without `.md` */
  agent: string;
  /**
   * Paths or globs, relative to the project, the member may write; absent means no restriction of
   * Agentry's own. Enforced on the chats Agentry starts for it through the CLI's permission rules;
   * from a terminal it is only what the agent file says.
   */
  writes?: string[];
  /**
   * The shell commands the member may run in the flow's work stage, as patterns the CLI's permission
   * rules take (`npm test`, `pnpm *`: each becomes `Bash(<pattern>)`). Absent means `Bash` is not
   * restricted there, as before; present means only these, and an empty list means no shell at all.
   * The refine and verify stages keep their own tool sets. Checked with {@link isTeamCommandPattern}.
   */
  commands?: string[];
}

/**
 * The flow by column. Each column may have a responsible role that acts when a card enters it;
 * agents move cards, and a person approves `done`. Only while `enabled` and the Team module is on.
 */
export interface ProjectFlowSettings {
  enabled: boolean;
  /** Responsible role per column, matching {@link ProjectTeamRole.role}; `done` never has one */
  columns: Partial<Record<WorkItemStatus, string>>;
  /** Times QA may send an item back to `in_progress` before it waits for the person */
  maxBounces: number;
  /**
   * Flow runs of the project at once; the rest wait in order, so the flow cannot drain the accounts'
   * quota on its own. Absent reads as 2 (`DEFAULT_FLOW_MAX_PARALLEL`).
   */
  maxParallel?: number;
  /**
   * What one run may spend, in USD, passed to the CLI as `--max-budget-usd`: the CLI stops the run
   * once it is reached. Absent (the default) means no limit of Agentry's own.
   */
  maxCostUsd?: number;
  /**
   * Fixes of failing checks Agentry may start on its own for one head commit (`checks.fix`). Absent
   * reads as 2 (`DEFAULT_CHECKS_FIX_ATTEMPTS`); a person's click is never counted against it.
   */
  checksFixAttempts?: number;
}

/** The Documents module: the repository's documents folder, and documents tied to work items. */
export interface ProjectDocumentsSettings {
  /** The documents folder, relative to the project (`docs`) */
  path: string;
}

/**
 * The settings document of a project, read and written whole (`GET`/`PUT /projects/:id/settings`).
 * Later orchestrations add their configuration as optional fields, so a document written today
 * stays valid.
 */
export interface ProjectSettings {
  /** The modules switched on */
  modules: ProjectModule[];
  /** The template the project was created from, for reference only: editing the settings never re-applies it */
  template: ProjectTemplateId | null;
  /**
   * Prefix of the work items' keys: upper case letters and digits, starting with a letter
   * (`WORK_ITEM_KEY_PREFIX_PATTERN`), unique among projects. Derived from the name on first read.
   */
  keyPrefix: string;
  board: BoardSettings;
  team?: ProjectTeamSettings;
  flow?: ProjectFlowSettings;
  documents?: ProjectDocumentsSettings;
  /** Per-project overrides of the decision engine; consent is never here, it stays global */
  decisions?: ProjectDecisionSettings;
  /** The project's issue tracker; absent or null when it has none */
  tracker?: ProjectTrackerSettings | null;
  /** Per-project overrides of the provider order and of what happens at a limit; a missing field inherits */
  providers?: ProjectProvidersSettings;
}

/**
 * What a project overrides of `providers.json`: the order its work picks providers in, and the
 * fields of `rotation.onLimit` it sets itself. The model mapping stays global.
 */
export interface ProjectProvidersSettings {
  order?: ProviderId[];
  onLimit?: Partial<RotationSettings['onLimit']>;
}

/**
 * A built-in template: configuration, not only switches. `name` and `description` are the English
 * copy; a client that knows the `id` shows its own translation.
 */
export interface ProjectTemplate {
  id: ProjectTemplateId;
  name: string;
  description: string;
  modules: ProjectModule[];
  board: BoardSettings;
  /** The starting team, offered when the Team module is switched on and there is nothing in the project to read */
  team: ProjectTeamRole[];
}

// ---------- Work items ----------
//
// What a project needs done, followed on its board. Named `WorkItem` because "task" already means an
// orchestration task and a background command (`GET /tasks`); the interface still says "Task".
//
// A work item carries no time: no due date, no estimate, no sprint. `createdAt`, `updatedAt` and
// `closedAt` are facts about what happened, never a plan, and no other date field is added.
//
// The key (`AGN-12`) is composed when read from the project's current prefix and the item's number,
// which is what is stored and never reused inside a project, even after a delete. So changing the
// prefix renames every key at once, history included.

export type WorkItemType = 'epic' | 'story' | 'task' | 'bug';

/** The five columns of the board, in order; fixed, not editable. */
export type WorkItemStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';

/** Not a status: only `urgent` may be shown in a colour. */
export type WorkItemPriority = 'low' | 'medium' | 'high' | 'urgent';

/**
 * Who a work item is assigned to: the person, or a team role once the Team module exists. A
 * discriminated union, so a kind added later (a named member) leaves the existing ones as they are.
 */
export type WorkItemAssignee = { kind: 'person' } | { kind: 'role'; role: string };

/** `system` is Agentry itself acting on a chat's or a node's behalf; the cause beside it says which. */
export type WorkItemActorKind = 'person' | 'agent' | 'system';

/** Who did something to a work item: made a change, wrote a comment, checked a criterion. */
export interface WorkItemActor {
  kind: WorkItemActorKind;
  /** The team role an agent acted as, once the Team module exists */
  role?: string | null;
}

/**
 * What acts on a work item on an agent's behalf: a chat, or a task of an orchestration. Final: a team
 * role acts through a chat (the actor names the role), the person acts with no source at all, and a
 * document never acts, it is only linked (see {@link WorkItemLinkKind}).
 */
export type WorkItemSourceKind = 'chat' | 'orchestration';

/**
 * A chat or an orchestration task, as the source of a comment, the cause of a change or the other end
 * of a link. Flat rather than a union so it maps onto one row; the ids that do not apply are null.
 */
export interface WorkItemSource {
  kind: WorkItemSourceKind;
  /** The chat's session id; for an orchestration task, the chat of its worker once it has one */
  chatId: string | null;
  orchestrationId: string | null;
  taskId: string | null;
}

/**
 * Why an automatic change happened: the source, and what happened there as a stable code a client
 * translates (`chat.started`, `chat.turn-completed`, `orchestration.task.completed`…).
 */
export interface WorkItemCause extends WorkItemSource {
  event: string;
}

/** Another work item as a field refers to it: enough to draw its chip without fetching it. */
export interface WorkItemRef {
  id: string;
  key: string;
  title: string;
  type: WorkItemType;
  status: WorkItemStatus;
}

/** One entry of the acceptance checklist, checked on its own. Its position is its order in the list. */
export interface AcceptanceCriterion {
  id: string;
  text: string;
  checked: boolean;
  /** Who checked it; null while unchecked */
  checkedBy: WorkItemActor | null;
}

/**
 * `blocks` and `blocked_by` only. Stored once, as `blocks`, and reported from both ends: the item
 * that blocks shows `blocks`, the other `blocked_by`. Orchestrating a selection turns them into the
 * graph's `dependsOn`.
 */
export type WorkItemRelationType = 'blocks' | 'blocked_by';

export interface WorkItemRelation {
  type: WorkItemRelationType;
  item: WorkItemRef;
}

/** Written by the person or by an agent; Markdown, no attachments. */
export interface WorkItemComment {
  id: string;
  itemId: string;
  author: WorkItemActor;
  /** The chat or orchestration task an agent wrote it from; null for the person */
  source: WorkItemSource | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a history entry, or a `workitem.updated` event, says changed. `created` opens every history;
 * `comment` only appears on events, since comments are their own list. `waiting` is the flow's
 * {@link WorkItemWaitReason} starting or ending, from and to the reason or null.
 */
export type WorkItemChange =
  | 'created'
  | 'type'
  | 'title'
  | 'description'
  | 'status'
  | 'priority'
  | 'labels'
  | 'assignee'
  | 'epic'
  | 'milestone'
  | 'criterion'
  | 'relation'
  | 'link'
  | 'comment'
  | 'waiting'
  | 'pull_request';

/**
 * A referenced thing (an epic, a milestone, a link) as it was when the entry was written, so the
 * history still reads after it is renamed or deleted. For a work item, `key` is composed when read,
 * like every key.
 */
export interface WorkItemHistoryRef {
  id: string;
  label: string;
  key?: string;
}

/** A criterion as a history entry records it. */
export interface WorkItemHistoryCriterion {
  id: string;
  text: string;
  checked: boolean;
}

/** A pull request as a history entry records it: opened, conflicted, merged or closed. */
export interface WorkItemHistoryPullRequest {
  phase: WorkItemPullRequestPhase;
  /** The host that holds it; absent reads as `github` (entries written before hosts existed) */
  host?: CodeHostId;
  number: number | null;
  /** How the host writes the number: `#12` or `!12`; null without a number */
  ref?: string | null;
  url: string | null;
  /** The conflicting paths, for `conflict` */
  conflicts: string[];
}

/** A plain value for a scalar field, the list for `labels`, and a snapshot for everything else. */
export type WorkItemHistoryValue =
  | string
  | string[]
  | WorkItemHistoryPullRequest
  | WorkItemAssignee
  | WorkItemHistoryRef
  | WorkItemHistoryCriterion
  | WorkItemRelation
  | null;

/**
 * One change to one field. Written by the service, never by the caller: an update that changes
 * three fields writes three entries.
 */
export interface WorkItemHistoryEntry {
  id: string;
  itemId: string;
  change: WorkItemChange;
  /** Null when there was nothing before: `created`, a criterion or a relation added */
  from: WorkItemHistoryValue;
  /** Null when there is nothing after: a criterion or a relation removed */
  to: WorkItemHistoryValue;
  actor: WorkItemActor;
  /** Set when a chat or an orchestration made the change, rather than someone acting on the item */
  cause: WorkItemCause | null;
  createdAt: string;
}

/**
 * What a work item can be linked to: what can act on it ({@link WorkItemSourceKind}), and a document
 * of the project (a specification, an architecture decision) tied to it by the Documents module.
 */
export type WorkItemLinkKind = WorkItemSourceKind | 'document';

/**
 * The part a linked chat, orchestration task or document played in the item's life. The roles past
 * `origin` follow the fixed columns, so they cannot grow with the flow: whichever team role a
 * project puts on a column, its chat is `refine` in `backlog` and `todo`, `work` in `in_progress` and
 * `verify` in `in_review`.
 *
 * - `origin`: the item was created from it (the chat of "Create a task from this message", or a
 *   document the assistant proposed items from).
 * - `refine`: refined it before work started; for a document, the specification refinement wrote.
 * - `work`: worked on it ("Work on it", a node of an orchestration built from it); for a document,
 *   one written while working, such as an architecture decision.
 * - `verify`: verified it against its acceptance criteria; for a document, the verification report.
 * - `reference`: tied to it by hand, without playing a part in its life. Documents only, in practice.
 *
 * `refine`, `work` and `verify` are also what a flow run's chat gets, by its {@link FlowStage}; a
 * client handles every member all the same.
 */
export type WorkItemLinkRole = 'origin' | 'refine' | 'work' | 'verify' | 'reference';

/** A chat, an orchestration task or a document tied to a work item. An item keeps every link, not only the last. */
export interface WorkItemLink extends Omit<WorkItemSource, 'kind'> {
  id: string;
  itemId: string;
  kind: WorkItemLinkKind;
  role: WorkItemLinkRole;
  /** For a `document` link, its path relative to the project; absent or null for the others */
  documentPath?: string | null;
  /** For a `document` link, what kind of document it is; absent or null for the others */
  documentKind?: DocumentKind | null;
  /**
   * The team role whose flow run made the link (the Product Owner's specification, QA's chat);
   * absent or null for a link a person or a chat outside the flow made
   */
  teamRole?: string | null;
  /** The chat's title or the task's name, filled in when read; null when it is gone */
  name?: string | null;
  /** Filled in when read, for a chat */
  chatState?: ChatState | null;
  /** Filled in when read, for an orchestration task */
  taskStatus?: OrchestrationTaskStatus | null;
  createdAt: string;
}

/**
 * Why an item waits for the person under the flow by column: `approval`, an agent finished and asks
 * for the move to `done`, which only a person makes; `bounces`, verification sent it back more times
 * than the project allows; `merge`, the person approved it and its pull request is open on GitHub,
 * waiting for the person to merge it there. Each ends when a person moves it; `merge` also ends when
 * the PR is merged (the item reaches `done`) or closed unmerged (back to `approval`).
 */
export type WorkItemWaitReason = 'approval' | 'bounces' | 'merge';

/**
 * Where an item's pull request stands (docs/plans/work-item-pull-requests.md):
 *
 * - `preparing`: approved, and Agentry is committing, updating, pushing and opening it;
 * - `conflict`: updating the branch with the default branch conflicted, and the merge waits in the
 *   item's worktree for the Developer (or the person) to resolve it;
 * - `awaiting-verify`: the conflict was handed to the Developer, and QA's next pass opens the PR
 *   without a second approval;
 * - `open`: on GitHub, waiting for the person to merge it;
 * - `merged` and `closed`: GitHub's own outcome;
 * - `failed`: a step failed, and {@link WorkItemPullRequest.error} says which and why.
 */
export type WorkItemPullRequestPhase = 'preparing' | 'conflict' | 'awaiting-verify' | 'open' | 'merged' | 'closed' | 'failed';

/** A PR's checks, from `gh pr view --json statusCheckRollup`: none, any still running, any failed, or all green. */
export type WorkItemPullRequestCi = 'none' | 'pending' | 'passing' | 'failing';

/**
 * Where a fix of failing checks stands while the change request is still open on the host
 * (docs/plans/code-hosts.md, phase 2): `fixing`, an agent has the failures in its prompt;
 * `awaiting-verify`, the Developer's run ended and QA verifies it; `awaiting-push`, verified and
 * waiting for the person's **Push the fix**. Null when no fix is under way.
 */
export type ChangeRequestFixState = 'fixing' | 'awaiting-verify' | 'awaiting-push';

/** Who asked for the fix: a person's click, or the `checks.fix` decision. */
export type ChangeRequestFixOrigin = 'person' | 'decision';

/** What the fix answers: failing checks (what a row without a kind means) or review comments. */
export type ChangeRequestFixKind = 'checks' | 'review';

/** An item's pull request, the newest of its rows: an item keeps every PR it had, closed ones too. */
export interface WorkItemPullRequest {
  /** The row id the `/change-requests/:id/…` routes take; the server always sends it */
  id?: string;
  phase: WorkItemPullRequestPhase;
  /** The host that holds it; absent reads as `github` (rows opened before hosts existed) */
  host?: CodeHostId;
  /** Null until the host's CLI answered the create */
  number: number | null;
  /** How the host writes the number: `#12` or `!12`; null without a number */
  ref?: string | null;
  url: string | null;
  /** The item's branch, `task/<key>` */
  branch: string;
  /** The default branch it is proposed to */
  base: string;
  /** Null until the watcher first read it */
  ci: WorkItemPullRequestCi | null;
  /** The paths the update left conflicted, while `phase` is `conflict` or `awaiting-verify` */
  conflicts: string[];
  /** Why the last attempt failed: a step or readiness code, and git's or gh's first line of error */
  error: { code: string; detail: string } | null;
  openedAt: string | null;
  closedAt: string | null;
  /** When the watcher last asked gh about it */
  checkedAt: string | null;
  /** The fix of failing checks under way; absent or null when none */
  fixState?: ChangeRequestFixState | null;
  fixOrigin?: ChangeRequestFixOrigin | null;
  /** Absent or null reads as `checks` */
  fixKind?: ChangeRequestFixKind | null;
  /** Fixes started for `fixHead`, a person's and the decision's together */
  fixAttempts?: number;
  /** The head commit the failures were seen on */
  fixHead?: string | null;
  /**
   * The push the last address of review comments made: the head it left and the threads it was handed.
   * Null when it made none (a card taken over drops the fix without one), or after another fix started.
   */
  addressed?: { head: string; threadIds: string[] } | null;
}

/**
 * Why a project cannot open pull requests (or merge requests); `ready` when it can. "Pull request"
 * in these types means a PR or an MR: the host decides the word.
 */
export type PullRequestNotReadyReason =
  | 'not-git'
  | 'no-remote'
  | 'unsupported-host'
  | 'no-default-branch'
  | 'cli-missing'
  | 'cli-incompatible'
  | 'cli-signed-out';

/** What a person can do about a not-ready project: a link to follow, never a command to copy. */
export interface PullRequestRemedy {
  kind: 'install' | 'sign-in' | 'docs' | 'settings';
  url: string | null;
}

/**
 * Whether approving an item of this project opens its pull request. Computed from git and the
 * host's CLI and cached for 60 s, so a board read never waits on an auth probe.
 */
export interface PullRequestReadiness {
  status: 'ready' | PullRequestNotReadyReason;
  /** The raw line git or the CLI answered with, shown in mono beside the worded reason; null when ready */
  detail: string | null;
  /** The default branch, when it could be found */
  defaultBranch: string | null;
  /** The code host the remote belongs to; null when none could be told */
  host: CodeHostId | null;
  /** The remote's host name, without user, secret or port; null when there is none */
  hostname: string | null;
  /** The one thing to do about a not-ready status; null when ready or when nothing can be done */
  remedy: PullRequestRemedy | null;
}

/**
 * Why the project's main checkout is behind `origin/<default>`: on another branch, carrying changes
 * to tracked files, or holding commits the default branch lacks.
 */
export type CheckoutBehindReason = 'not-on-default' | 'dirty' | 'diverged';

/** The project's main checkout against the default branch, from local git only (no fetch on read). */
export interface BoardCheckout {
  defaultBranch: string;
  /** Null on a detached head */
  branch: string | null;
  /** Commits `origin/<default>` has that the checkout lacks */
  behind: number;
  /** Why it was not brought forward; null when it is up to date or can be */
  reason: CheckoutBehindReason | null;
}

export interface WorkItem {
  /** Ours and stable: the key changes with the prefix, the id never does */
  id: string;
  projectId: string;
  /** Never reused inside the project */
  number: number;
  /** `<prefix>-<number>`, composed when read */
  key: string;
  type: WorkItemType;
  title: string;
  /**
   * Markdown. Left out of board and list payloads (the board, the lists and their pages, a chat's
   * items), where it is `''` and {@link WorkItem.hasDescription} says whether there is one: the
   * item's own page fetches it (`GET /work-items/:itemId`, `GET /work-items/by-key/:key`).
   */
  description: string;
  /**
   * Whether the item has a description, set wherever `description` is left out. Absent where the
   * description is served whole, where it reads as `description !== ''`.
   */
  hasDescription?: boolean;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  /** Free text, in the order they were given */
  labels: string[];
  assignee: WorkItemAssignee | null;
  /** Always null for an epic: there is one level of hierarchy */
  epicId: string | null;
  /** The epic, filled in when read, so a card can show its label */
  epic?: WorkItemRef | null;
  milestoneId: string | null;
  acceptanceCriteria: AcceptanceCriterion[];
  relations: WorkItemRelation[];
  /**
   * Order inside its column, compared as plain strings. Opaque to clients, which move an item by
   * naming its neighbour ({@link MoveWorkItemRequest}), so the order a person drags survives.
   */
  rank: string;
  /** The item's own git worktree, once something worked on it, on branch `task/<key>` in lower case */
  worktree: string | null;
  branch: string | null;
  /**
   * The chat or orchestration task working on it right now, filled in when read: what makes a card
   * live. Null when nothing is.
   */
  activeLink?: WorkItemLink | null;
  /**
   * Times the verifying role sent it back to `in_progress` in the current round of work, compared with
   * {@link ProjectFlowSettings.maxBounces}; a person moving it starts a new round. Written by the
   * flow by column: absent reads as 0.
   */
  bounces?: number;
  /**
   * What it waits for from the person, which the board shows in the idle colour with a word. Written
   * by the flow by column: absent reads as null, waiting for nothing.
   */
  waiting?: WorkItemWaitReason | null;
  /** Its newest pull request; absent or null when it never had one */
  pullRequest?: WorkItemPullRequest | null;
  /** The tracker issues it was imported from or linked to; absent reads as none */
  issues?: IssueRef[];
  createdAt: string;
  updatedAt: string;
  /** When it last entered `done`; null while it is anywhere else */
  closedAt: string | null;
}

/**
 * One work item with what its page shows beyond the card: `GET /work-items/:itemId`, or
 * `GET /work-items/by-key/:key` for its key (`AGN-12`, in any case; 404 when no project's item has
 * it, since a key prefix is unique among projects).
 */
export interface WorkItemDetail extends WorkItem {
  /** For an epic, the items it groups */
  children: WorkItemRef[];
  links: WorkItemLink[];
  /** Oldest first */
  comments: WorkItemComment[];
  /** Oldest first */
  history: WorkItemHistoryEntry[];
  /** Whether approving it opens a pull request; absent or null for an item of a project that is not imported */
  pullRequestReadiness?: PullRequestReadiness | null;
}

/** The answer of `POST /work-items/:itemId/pull-request`: 202 while it is prepared, 200 when one was open already. */
export interface WorkItemPullRequestResult {
  item: WorkItem;
  pullRequest: WorkItemPullRequest;
}

/** A new entry of the acceptance checklist: an object, so fields can join the text later. */
export interface NewAcceptanceCriterion {
  text: string;
}

export interface CreateWorkItemRequest {
  title: string;
  /** Default `task` */
  type?: WorkItemType;
  description?: string;
  /** Default `backlog` */
  status?: WorkItemStatus;
  /** Default `medium` */
  priority?: WorkItemPriority;
  labels?: string[];
  assignee?: WorkItemAssignee | null;
  /** Must name an epic of the same project; not allowed on an epic */
  epicId?: string | null;
  milestoneId?: string | null;
  acceptanceCriteria?: NewAcceptanceCriterion[];
}

/** An entry of a replaced checklist: one with an `id` keeps its check, one without is new. */
export interface AcceptanceCriterionInput {
  id?: string;
  text: string;
}

/**
 * Only the fields present change, and `null` clears a nullable one. The status and the order change
 * through {@link MoveWorkItemRequest}, and one criterion is checked through
 * {@link CheckAcceptanceCriterionRequest}.
 */
export interface UpdateWorkItemRequest {
  type?: WorkItemType;
  title?: string;
  description?: string;
  priority?: WorkItemPriority;
  labels?: string[];
  assignee?: WorkItemAssignee | null;
  epicId?: string | null;
  milestoneId?: string | null;
  /** Replaces the whole checklist, in this order */
  acceptanceCriteria?: AcceptanceCriterionInput[];
}

/**
 * Moves an item to a column and a place in it. The place is named by a neighbour rather than an
 * index, so two people reordering at once do not land items on top of each other.
 */
export interface MoveWorkItemRequest {
  status: WorkItemStatus;
  /** The item it goes right after in the target column; null puts it first, absent puts it last */
  afterId?: string | null;
}

/** A move always succeeds; going over the column's limit is reported, never refused. */
export interface MoveWorkItemResult {
  item: WorkItem;
  column: BoardColumnSummary;
}

export interface CheckAcceptanceCriterionRequest {
  checked: boolean;
}

export interface CreateWorkItemCommentRequest {
  /** Markdown */
  body: string;
}

/** Refused when it points at the item itself or closes a cycle of `blocks`. */
export interface CreateWorkItemRelationRequest {
  type: WorkItemRelationType;
  itemId: string;
}

/**
 * Every kind and role is accepted by the contract. A document is tied by hand through
 * `POST /work-items/:itemId/documents` ({@link TieDocumentRequest}), with the role `reference`.
 */
export interface CreateWorkItemLinkRequest {
  kind: WorkItemLinkKind;
  role: WorkItemLinkRole;
  chatId?: string | null;
  orchestrationId?: string | null;
  taskId?: string | null;
  /** For a `document` link: the document's path, relative to the project */
  documentPath?: string | null;
}

/**
 * What a list, a search or the board is narrowed to. Every field is optional; the values of a list
 * are alternatives (any of them) and fields combine (all of them). In a query string, a list is
 * comma separated.
 */
export interface WorkItemFilter {
  /** Left out for every project: the All projects view */
  projectId?: string;
  status?: WorkItemStatus[];
  type?: WorkItemType[];
  priority?: WorkItemPriority[];
  /** Items carrying any of these labels */
  labels?: string[];
  /** `person`, `none`, or `role:<role>` */
  assignee?: string[];
  epicId?: string;
  milestoneId?: string;
  /** Searched in the title and the description, and matched against the key */
  q?: string;
}

/**
 * `GET /projects/:id/work-items/page` and `GET /work-items/page` (All projects): the list a page at a
 * time, in the same order as the whole list, with the same filter. `GET /projects/:id/work-items`
 * and `GET /work-items` still answer the whole list as an array.
 */
export interface WorkItemPageQuery extends Omit<WorkItemFilter, 'projectId'> {
  /** Default `WORK_ITEMS_PAGE` (100), at most `WORK_ITEMS_PAGE_MAX` */
  limit?: number;
  /** `nextCursor` of the previous page; absent for the first */
  cursor?: string;
}

/** A page of work items, descriptions left out. */
export interface WorkItemPage {
  items: WorkItem[];
  /** Every item that passes the filter, across the pages */
  total: number;
  /** Opaque: pass as `cursor` for the next page; null on the last */
  nextCursor: string | null;
}

export type MilestoneState = 'open' | 'closed';

/** Derived from the milestone's work items, epics left out: they group work, they are not work. */
export interface MilestoneProgress {
  total: number;
  done: number;
  byStatus: Record<WorkItemStatus, number>;
}

/** A named goal (`v0.19`) with no date: open or closed, and how far its work items are. */
export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  /** Markdown */
  description: string;
  state: MilestoneState;
  progress: MilestoneProgress;
  createdAt: string;
  updatedAt: string;
  /** When it was last closed; null while open */
  closedAt: string | null;
}

export interface CreateMilestoneRequest {
  name: string;
  description?: string;
}

export interface UpdateMilestoneRequest {
  name?: string;
  description?: string;
  state?: MilestoneState;
}

// ---------- Board ----------
//
// Everything one request returns to draw a board: the five columns in order, each with its limit,
// how many items it holds and those items in rank order. A filter narrows `items` but not `count`,
// since a limit is about the real load of a column, not about what a search shows.

/** A column without its items: what a move reports. */
export interface BoardColumnSummary {
  status: WorkItemStatus;
  /** Null when the column has no limit */
  limit: number | null;
  /** Every item in the column but its epics, whatever the filter: an epic takes no place under the limit */
  count: number;
  /** `count` is over `limit`: shown in the warn colour with a word, never a block */
  overLimit: boolean;
}

export interface BoardColumn extends BoardColumnSummary {
  /**
   * The items that pass the filter, in rank order, descriptions left out. The Done column holds
   * only the most recently closed of them, `doneLimit` ({@link BoardQuery}), newest first
   */
  items: WorkItem[];
  /**
   * Items that pass the filter and are left out of `items`: "and N more", which asks the board again
   * with a larger `doneLimit`. Only the Done column leaves any out; absent reads as 0.
   */
  more?: number;
}

/**
 * `GET /projects/:id/work-items/board` and `GET /work-items/board` take the filter
 * ({@link WorkItemFilter}) and this. The Done column grows without end, so it is paged: a board
 * holds its newest closed items, and "and N more" asks again with the next multiple of the page.
 * Asking for a larger limit rather than a cursor keeps one board per query, which the event feed
 * refreshes whole.
 */
export interface BoardQuery {
  /** Items of the Done column to hold; default `BOARD_DONE_PAGE`, at most `WORK_ITEMS_PAGE_MAX` */
  doneLimit?: number;
}

export interface Board {
  /** Null for the All projects board, whose columns carry no limit */
  projectId: string | null;
  /** Always the five columns, in {@link WorkItemStatus} order */
  columns: BoardColumn[];
  /** A project's board: whether approving opens a pull request. Absent on the All projects board */
  pullRequestReadiness?: PullRequestReadiness | null;
  /** A project's board: its checkout against the default branch; null when the project is not ready */
  checkout?: BoardCheckout | null;
}

// ---------- Work items with chats and orchestrations ----------
//
// "Work on it" starts a chat on an item, "Orchestrate" turns a selection into a graph, and "Create a
// task from this message" turns a chat's message into an item. The item then follows what works on
// it: it enters `in_progress` when the chat's turn or the node starts and `in_review` when it ends
// well. Only forward, never out of `done`, and never over a person who moved the item since the
// work began: those moves are recorded in its history with the chat or the node as the cause.

/**
 * What a chat started on a work item may be given. The prompt is built from the item (its title,
 * description and acceptance criteria) and the directory is its worktree, so neither is taken here.
 */
export type WorkOnWorkItemRequest = ChatStartOptions;

export interface WorkOnWorkItemResult {
  /** The item as it is once the chat started: in its worktree, and in `in_progress` unless a person had it elsewhere */
  item: WorkItem;
  chat: ChatSummary;
  link: WorkItemLink;
}

/** A draft work item to triage: what the person has typed so far. */
export interface TriageWorkItemRequest {
  title: string;
  description?: string;
}

/**
 * What `board.triage` suggests for a draft: a prefill for the person to keep or change, and a
 * warning. It is the answer of the decision `decisionId`, which the form marks as decided.
 */
export interface WorkItemTriage {
  type: Exclude<WorkItemType, 'epic'>;
  priority: WorkItemPriority;
  /** An open item already seems to cover the draft; the warning does not name which */
  duplicate: boolean;
  decisionId: string | null;
}

/** `triage` is null unless the point is active and answered in time: the form then stays as it is. */
export interface TriageWorkItemResult {
  triage: WorkItemTriage | null;
}

/** A selection of work items of one project to orchestrate, in the order they were picked. */
export interface OrchestrateWorkItemsRequest {
  itemIds: string[];
}

/**
 * A graph to review, not a launched one: one node per item, each naming its item in `workItemId`,
 * and `dependsOn` from the `blocks` relations inside the selection. `POST /orchestrations` launches it.
 */
export interface WorkItemOrchestrationDraft {
  spec: OrchestrationSpec;
  /** Items outside the selection, not done yet, that block an item of it: the graph cannot wait for them */
  externalBlockers: WorkItemRef[];
}

/** Creates a work item in `backlog` from a message of a chat, linked to that chat. */
export interface CreateWorkItemFromMessageRequest {
  /** The message, which becomes the description */
  text: string;
  /** Default: the message's first line */
  title?: string;
  /** Default `task` */
  type?: WorkItemType;
  /** Default `medium` */
  priority?: WorkItemPriority;
}

/** What the item's own branch changed, read from git the way a chat's worktree is. */
export interface WorkItemChanges {
  worktree: string | null;
  branch: string | null;
  /** Null while nothing has worked on it in a worktree, or once its branch is gone */
  summary: ChangeSummary | null;
}

// ---------- Team, flow by column, journal, memory proposals and documents ----------
//
// Orchestration 3 of docs/plans/project-ecosystem.md. A team member is a CLI agent file in the
// project's `.claude/agents/` plus the metadata in `settings.team`; it runs as `claude --agent` with
// its model, so the same member works from a terminal. The flow starts a member's run when a card
// enters the column it answers for, and every run ends with a structured result
// ({@link FlowRunResult}) through `--json-schema`: its comment, QA's verdict, the memory entries it
// proposes and the documents it wrote. Nothing reaches the memory before the person approves it.

/**
 * The member's agent file as it is on disk: `ok`, it matches the metadata; `missing`, it was deleted
 * (the member still shows, and its file can be written again); `drifted`, its frontmatter says
 * something the metadata does not ({@link TeamAgentFile.drift}). A drifted or hand-edited file is
 * reported, never overwritten.
 */
export type TeamAgentFileState = 'ok' | 'missing' | 'drifted';

/** A frontmatter field of the agent file that disagrees with the member's metadata. */
export type TeamAgentDriftField = 'name' | 'description' | 'model';

export interface TeamAgentFile {
  /** Relative to the project: `.claude/agents/<agent>.md` */
  path: string;
  state: TeamAgentFileState;
  /** Empty unless `state` is `drifted` */
  drift: TeamAgentDriftField[];
  /** As the file's frontmatter says them; null when the file is missing or leaves them out */
  description: string | null;
  model: string | null;
  updatedAt: string | null;
}

/** A member as `GET /projects/:id/team` serves it: the metadata, its file, and what it is doing. */
export interface TeamMember extends ProjectTeamMember {
  file: TeamAgentFile;
  /** The columns it answers for under the flow, in board order; empty for a role that is only consulted */
  columns: WorkItemStatus[];
  /** Its flow runs working now, oldest first; empty when it is idle */
  running: FlowRun[];
  /** How many of its flow runs wait for a free place */
  queued: number;
  /** Its latest run that ended, for "refined AGN-47 1 h ago"; null when it never ran */
  lastRun: FlowRun | null;
}

export interface Team {
  projectId: string;
  /** The Team module is on; with it off the members are still served, and the client hides them */
  enabled: boolean;
  members: TeamMember[];
  /** Agent files in the project's `.claude/agents/` that no member uses, which "add a member" offers */
  unassignedAgents: string[];
}

/**
 * Writes the members of the project's template (`ProjectTemplate.team`). The person accepts them one
 * by one, so `roles` names the ones accepted; absent means every role of the template. An agent file
 * that already exists is kept as it is, and a role already on the team is left alone.
 *
 * `POST /projects/:id/team/from-template` answers the whole {@link Team}: with 201 when it added at
 * least one member, and with 200 when nothing changed (every role was already on the team), like
 * the other creating routes. Sending it twice is harmless either way.
 */
export interface TeamFromTemplateRequest {
  roles?: string[];
}

/**
 * Creates or replaces a member's metadata (`PUT /projects/:id/team/:agent`). The agent file itself is
 * edited through `/config/resources/agents/:name?project=`.
 */
export interface PutTeamMemberRequest extends ProjectTeamRole {
  writes?: string[];
  /** Absent or null leaves the shell unrestricted in the work stage ({@link ProjectTeamMember.commands}) */
  commands?: string[] | null;
  /** Write a starting agent file for the role when there is none; an existing file is never overwritten */
  createFile?: boolean;
}

/**
 * What a flow run does, named after the link role its chat gets: `refine` in `backlog` and `todo`,
 * `work` in `in_progress`, `verify` in `in_review`.
 */
export type FlowStage = 'refine' | 'work' | 'verify';

/**
 * A stage as the person reads it, by the column it runs in: `refine` covers two, and what the
 * Product Owner does differs between them. In `backlog` it refines the item (`refine`, "refinado");
 * in `todo` it only checks the item is ready (`check`, "comprobación"). `work` and `verify` are
 * their stage. See `FLOW_STEP_OF_COLUMN`.
 */
export type FlowStep = 'refine' | 'check' | 'work' | 'verify';

/** `queued` waits for a place under `maxParallel`; `running` has its chat; `ended` has an outcome. */
export type FlowRunState = 'queued' | 'running' | 'ended';

/**
 * How a run ended: `passed`, it finished well (and for QA, the item held); `rejected`, QA's verdict
 * failed the item; `failed`, the chat failed or its result was unreadable; `cancelled`, a person's
 * move or the flow being switched off made it moot before it started.
 */
export type FlowRunOutcome = 'passed' | 'rejected' | 'failed' | 'cancelled';

/**
 * Why a run failed or was cancelled, as a stable code a client words in the person's language; the
 * run's `error` keeps the raw text beside it. A run stored before causes were kept gets the one its
 * error reads as, or none.
 *
 * Failed:
 * - `budget`: it reached `flow.maxCostUsd` (`--max-budget-usd`);
 * - `no-account`: the account hit its rate limit and no other account could take the run over;
 * - `rate-limit`: the account hit its rate limit and the rotation was off;
 * - `stopped`: its chat was stopped;
 * - `restarts`: Agentry restarted past `MAX_FLOW_RESTARTS` times while it worked;
 * - `unreadable`: it ended without a readable structured result;
 * - `no-verdict`: a verification ended without a verdict;
 * - `max-tokens`: its last turn stopped on the output token limit, so its result is cut short even when it parses;
 * - `not-started`: its chat did not start;
 * - `not-continued`: its chat could not be continued after a restart;
 * - `chat-ended`: its chat ended, or was removed, without a result;
 * - `chat-failed`: its chat ended in an error the CLI reported (the error is the CLI's text);
 * - `conflict-unresolved`: a work run that was to resolve the merge of the default branch into the
 *   item's branch ended with conflicted paths left (the error names them).
 *
 * Cancelled:
 * - `item-moved`: the item left the column before the run started, or while a restart cut it off;
 * - `item-removed` and `item-done`: the item was removed, or moved to `done`;
 * - `replaced`: the item entered a column again before the run started, and the newer run took its place;
 * - `flow-off`: the flow, the Team module or the Board module was switched off;
 * - `no-provider`: no provider could take the run: none is ready, or none can enforce its policy;
 * - `limit-wait-expired`: the run waited for a provider's limit to reset and the reset never came
 *   within the wait cap;
 * - `no-member`: nobody on the team answers for the column any more;
 * - `refined`: a todo check would repeat a refine that passed, on an item unchanged since;
 * - `chat-busy`: a chat of the person's was already working on the item.
 */
export type FlowRunCause =
  | 'budget'
  | 'no-account'
  | 'no-provider'
  | 'limit-wait-expired'
  | 'rate-limit'
  | 'stopped'
  | 'restarts'
  | 'unreadable'
  | 'no-verdict'
  | 'max-tokens'
  | 'not-started'
  | 'not-continued'
  | 'chat-ended'
  | 'chat-failed'
  | 'item-moved'
  | 'item-removed'
  | 'item-done'
  | 'replaced'
  | 'flow-off'
  | 'no-member'
  | 'refined'
  | 'chat-busy'
  /** A work run that was to resolve a merge of the default branch left conflicted paths behind */
  | 'conflict-unresolved';

/** Another run as a run refers to it: enough to say what it did and open its chat. */
export interface FlowRunRef {
  id: string;
  state: FlowRunState;
  outcome: FlowRunOutcome | null;
  chatId: string | null;
  queuedAt: string;
  endedAt: string | null;
}

/** One run of a team member on a work item, queued, running or ended. Rows, so it survives a restart. */
export interface FlowRun {
  id: string;
  projectId: string;
  itemId: string;
  /** Filled in when read; null once the item is gone */
  item: WorkItemRef | null;
  /** The team role, matching {@link ProjectTeamRole.role} */
  role: string;
  /** The member's agent file name, as `claude --agent` takes it */
  agent: string;
  model: string;
  /** The provider the run's chat is on; `claude-code` on a run written before providers were chosen */
  provider?: ProviderId;
  /** Set while the run waits for its provider's limit to reset; null otherwise */
  waiting?: LimitWait | null;
  stage: FlowStage;
  /** The stage as the person reads it, by its column: `check` is a `refine` in `todo` */
  step: FlowStep;
  /** The column the card entered that started it */
  column: WorkItemStatus;
  state: FlowRunState;
  /** The chat it runs in; null while queued. A Developer's run continues the item's work chat when there is one */
  chatId: string | null;
  /** What the chat is doing now, filled in when read while it runs */
  activity?: ChatActivity | null;
  /** Null until it ends */
  outcome: FlowRunOutcome | null;
  /** The result's summary, once it ended with one */
  summary: string | null;
  /** Why it failed or was cancelled, in English, as the core or the CLI said it; null otherwise */
  error: string | null;
  /** Why it failed or was cancelled, as a code to word; null otherwise, and on an old run whose error reads as none */
  cause: FlowRunCause | null;
  /** The failed run a person retried with this one (`POST /flow-runs/:runId/retry`); null for a run a card entering its column started */
  retryOf: string | null;
  /**
   * Who queued it when it was not a card entering its column: `person` for a run a person started
   * from the Flow screen's "start the waiting cards" (`POST /projects/:id/flow/start-waiting`). Null
   * for a run a card's entry queued, and for a retry, which `retryOf` names.
   */
  queuedBy: FlowRunQueuedBy | null;
  /**
   * On a run that did not pass, the next run of the same step on the item, whatever started it (a
   * retry or the card entering the column again): what the person's retry, or the flow, did next.
   * Null until there is one.
   */
  retriedBy: FlowRunRef | null;
  /**
   * Whether `POST /flow-runs/:runId/retry` would queue it again now: it failed, nothing has run that
   * step on the item since, the item is still in the run's column, and the flow is on with a member
   * answering for the column.
   */
  retryable: boolean;
  /** Times a restart cut it off and it went on in its chat; past `MAX_FLOW_RESTARTS` it fails */
  restarts: number;
  /**
   * Times the flow sent it back to its chat because its turn ended with work still owed (no
   * structured result, uncommitted changes, or a last message that offers, asks or announces instead
   * of doing): at most `MAX_CONTINUATIONS`, after which the result it has is judged as it is
   */
  continuations: number;
  /**
   * The person's language, which the first line of its chat's prompt (`<Role> · <KEY>`, the title the
   * chat is listed by) is written in, kept so a restart words it the same. Absent on a run stored
   * before it was kept, which reads as `en`.
   */
  language?: AgentryLanguage;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** Who queued a flow run by hand, when a card entering its column did not. */
export type FlowRunQueuedBy = 'person';

/** One column of {@link FlowWaiting}: how many of its cards wait, and the role that answers for it. */
export interface FlowWaitingColumn {
  column: WorkItemStatus;
  /** The team role that answers for the column, matching {@link ProjectTeamRole.role} */
  role: string;
  count: number;
}

/**
 * `GET /projects/:id/flow/waiting`: the cards a flow switched on would not start by itself. A card
 * waits when it is not an epic nor done, its column has a role with a member playing it, it has no
 * run queued or running, and, in todo, it was not refined and left unchanged since.
 */
export interface FlowWaiting {
  /** 0 while the flow, the Team module or the Board module is off */
  total: number;
  /** In board order; only the columns with at least one waiting card */
  columns: FlowWaitingColumn[];
}

/** `POST /projects/:id/flow/start-waiting`: what queuing the waiting cards did. */
export interface FlowStartWaitingResult {
  /** Runs queued, one per waiting card */
  queued: number;
  /** Of those, how many the project's `maxParallel` lets start now: `min(queued, maxParallel − running)` */
  startingNow: number;
  /** `queued − startingNow`: they start as places come free */
  waiting: number;
}

/** `GET /projects/:id/flow`: what the flow is doing in a project now. */
export interface ProjectFlow {
  projectId: string;
  /** `flow.enabled`, with the Team module on */
  enabled: boolean;
  maxParallel: number;
  /** Oldest first */
  running: FlowRun[];
  /** In the order they will start */
  queued: FlowRun[];
}

/**
 * A run's state and outcome in one word, what the team's activity filters and shows: `queued` and
 * `running` while it has not ended, its {@link FlowRunOutcome} once it has (`flowRunStatus`).
 */
export type FlowRunStatus = Exclude<FlowRunState, 'ended'> | FlowRunOutcome;

/**
 * `GET /work-items/:itemId/runs` answers every flow run of an item as `FlowRun[]`, newest first
 * (by `queuedAt`), whatever its state: an older failed run still shows as failed on the item, and a
 * failed run's chat page finds its run (by `chatId`) to say why it failed and which item it was for.
 *
 * `GET /projects/:id/flow/runs` pages every flow run of a project, newest first, for the team's
 * activity ("See all"). Every field is optional; the values of a list are alternatives and fields
 * combine. In a query string, a list is comma separated.
 */
export interface FlowRunQuery {
  /** Members, by agent file name */
  agent?: string[];
  /** Members, by team role ({@link ProjectTeamRole.role}) */
  role?: string[];
  /** `outcome` in a query string is another name for it */
  status?: FlowRunStatus[];
  /** Runs queued before this moment (ISO 8601): a page of the activity from a day back */
  before?: string;
  /** Runs of one work item */
  itemId?: string;
  /** Default `FLOW_RUNS_PAGE`, at most `FLOW_RUNS_PAGE_MAX` */
  limit?: number;
  /** `nextCursor` of the previous page; absent for the first */
  cursor?: string;
}

/** A page of a project's flow runs, newest first. */
export interface FlowRunPage {
  runs: FlowRun[];
  /** Every run that passes the filter, across the pages */
  total: number;
  /** Opaque: pass as `cursor` for the next page; null on the last */
  nextCursor: string | null;
}

/** QA's verdict: `pass` leaves the item waiting for the person's approval, `fail` sends it back to `in_progress`. */
export type FlowVerdict = 'pass' | 'fail';

/**
 * QA's judgement of one acceptance criterion. A met criterion is checked on the item as the agent;
 * the run passes only when every criterion of the item is met or needs a person.
 */
export interface FlowCriterionResult {
  /** The criterion's id, as the run's prompt lists it */
  id: string;
  met: boolean;
  /** What was checked, or what is missing */
  note: string;
  /**
   * No flow run can check it: it needs a push, a pull request, a tool or service the run does not
   * have, or a person's eyes. It is left unchecked for the person who approves the item and does not
   * reject the run (refines decision 18).
   */
  needsPerson?: boolean;
}

/** A memory entry a flow run proposes, as its result carries it. */
export interface FlowMemoryProposal {
  target: MemoryProposalTarget;
  text: string;
  /** Why the team should remember it */
  reason: string;
}

/** A document a flow run wrote in the item's worktree, reported so Agentry ties it to the item. */
export interface FlowRunDocument {
  /** Relative to the project, inside the documents folder (`docs/specs/agn-28-board.md`) */
  path: string;
  kind: DocumentKind;
}

/**
 * The structured result every flow run ends with, through the CLI's `--json-schema`. `summary`
 * becomes the member's comment on the item; `verdict` is QA's only.
 */
export interface FlowRunResult {
  summary: string;
  verdict?: FlowVerdict;
  /** Verification only: every acceptance criterion of the item, each judged on its own */
  criteria?: FlowCriterionResult[];
  memoryProposals: FlowMemoryProposal[];
  documents: FlowRunDocument[];
}

/**
 * What a journal entry records: `closed`, an item reached `done` (written once per item); `decision`,
 * a decision taken; `memory`, an approved memory proposal addressed to the journal; `note`, anything
 * else a person wrote by hand.
 */
export type JournalEntryKind = 'closed' | 'decision' | 'memory' | 'note';

/**
 * One entry of a project's journal, Agentry's own record of decisions and closed items. The newest
 * are handed to every flow run with `--append-system-prompt`.
 */
export interface JournalEntry {
  id: string;
  projectId: string;
  kind: JournalEntryKind;
  /** Markdown; for `closed`, the item's title as it was */
  text: string;
  itemId: string | null;
  /** Filled in when read; null when there is no item or it is gone */
  item: WorkItemRef | null;
  /** Who wrote or proposed it: the person, or the agent and its role */
  author: WorkItemActor;
  /** Who approved it: the move to `done` for `closed`, the proposal for `memory`; null for what a person wrote */
  approvedBy: WorkItemActor | null;
  /** The proposal it came from */
  proposalId: string | null;
  /** A document it refers to (an architecture decision), relative to the project */
  documentPath: string | null;
  /** For `closed`: the chats and orchestration tasks that worked on the item */
  sources: WorkItemSource[];
  createdAt: string;
}

/** `GET /projects/:id/journal?limit=&before=`, newest first. */
export interface JournalPage {
  entries: JournalEntry[];
  /** Every entry of the project */
  total: number;
  /** What a flow run is handed: the newest entries that fit the cap */
  handed: { entries: number; bytes: number };
  /** Pass as `before` for the next page; null on the last */
  nextBefore: string | null;
}

/** An entry written by hand. `closed` and `memory` are Agentry's to write. */
export interface CreateJournalEntryRequest {
  text: string;
  /** Default `note` */
  kind?: Extract<JournalEntryKind, 'decision' | 'note'>;
  itemId?: string | null;
  documentPath?: string | null;
}

/**
 * Where an approved proposal is written: `instructions`, the project's `CLAUDE.md` (under `section`
 * when given, a heading of it); `memory`, a file of the project's CLI memory directory (`file`,
 * appended to, or created and indexed in `MEMORY.md`); `journal`, a `memory` entry of the journal.
 */
export type MemoryProposalTargetKind = 'instructions' | 'memory' | 'journal';

/** Flat rather than a union so it maps onto one row; the fields that do not apply are null. */
export interface MemoryProposalTarget {
  kind: MemoryProposalTargetKind;
  /** For `memory`: the file name (`tests.md`) */
  file: string | null;
  /** For `instructions`: the heading it goes under; null appends at the end */
  section: string | null;
}

export type MemoryProposalStatus = 'pending' | 'approved' | 'rejected';

/** A memory entry a team member proposed. Nothing is written until the person approves it. */
export interface MemoryProposal {
  id: string;
  projectId: string;
  target: MemoryProposalTarget;
  /** As proposed */
  text: string;
  reason: string;
  status: MemoryProposalStatus;
  /** The agent and its role */
  proposedBy: WorkItemActor;
  /** The chat it came from */
  source: WorkItemSource | null;
  flowRunId: string | null;
  itemId: string | null;
  /** Filled in when read; null when there is no item or it is gone */
  item: WorkItemRef | null;
  /** What was written, when the person edited it before approving; null otherwise */
  approvedText: string | null;
  /** The person, once decided */
  decidedBy: WorkItemActor | null;
  decidedAt: string | null;
  /** Why it was rejected, when the person said */
  rejectReason: string | null;
  /** The journal entry an approval to the journal wrote */
  journalEntryId: string | null;
  createdAt: string;
}

export interface ApproveMemoryProposalRequest {
  /** The text to write instead of the proposed one */
  text?: string;
}

export interface RejectMemoryProposalRequest {
  reason?: string;
}

/**
 * What a document tied to a work item is: `spec`, a specification (the Product Owner's, refining);
 * `adr`, an architecture decision; `report`, a verification report (QA's); `doc`, anything else.
 */
export type DocumentKind = 'spec' | 'adr' | 'report' | 'doc';

/** A work item a document is tied to, as a `document` link. */
export interface DocumentTie {
  linkId: string;
  item: WorkItemRef;
  kind: DocumentKind;
  /** The part it played in the item's life; `reference` when tied by hand */
  linkRole: WorkItemLinkRole;
  /** The team role that wrote it; null when a person tied it */
  teamRole: string | null;
  /** The chat that wrote it */
  chatId: string | null;
  createdAt: string;
}

/** A file or directory of the documents folder. Only Markdown files are listed. */
export interface DocumentNode {
  name: string;
  /** Relative to the project, `/`-separated (`docs/specs/agn-28-board.md`) */
  path: string;
  type: 'file' | 'dir';
  /** For a directory, its entries, directories first; absent for a file */
  children?: DocumentNode[];
  /** For a directory, the Markdown files under it at any depth */
  fileCount?: number;
  /** For a file: its first `# ` heading, when it has one */
  title?: string | null;
  size?: number;
  updatedAt?: string | null;
  /** For a file, the items it is tied to; empty for a directory */
  ties: DocumentTie[];
}

/** `GET /projects/:id/documents`: the tree of the documents folder. */
export interface ProjectDocuments {
  projectId: string;
  /** `documents.path`, relative to the project (`docs`) */
  root: string;
  /** The folder is on disk */
  exists: boolean;
  /** The folder's entries, directories first */
  tree: DocumentNode[];
  fileCount: number;
  /** Files tied to at least one item */
  tiedCount: number;
}

/** `GET /projects/:id/documents/file?path=`. */
export interface DocumentFile {
  /** Relative to the project */
  path: string;
  content: string;
  title: string | null;
  size: number;
  updatedAt: string | null;
  ties: DocumentTie[];
}

/** `PUT /projects/:id/documents/file?path=`: creates or replaces a Markdown file of the documents folder. */
export interface WriteDocumentRequest {
  content: string;
  /**
   * The `updatedAt` the editor started from; when the file changed since (an agent wrote it), the
   * write is refused with 409 instead of overwriting it. Absent writes whatever is there.
   */
  baseUpdatedAt?: string | null;
}

/** `POST /work-items/:itemId/documents`: ties a document of the project to an item by hand, role `reference`. */
export interface TieDocumentRequest {
  /** Relative to the project, inside the documents folder */
  path: string;
  /** Default `doc` */
  kind?: DocumentKind;
}

// ---------- The project assistant: suggested team, resources and work items ----------
//
// Orchestration 4 of docs/plans/project-ecosystem.md (decisions 35 to 37). An assistant run is a chat
// through the CLI in the project's directory, read-only (the read tools, and `Bash` limited to
// `git log`, `git status` and `ls`), that answers through `--json-schema`. It never writes a file:
// each proposal is accepted or discarded on its own, and only an accept makes Agentry write
// something, through the service that owns it (the team, the work items, the resources). It runs on
// demand or when a project is created, never on a schedule.

/**
 * `project`: team, resources and first work items, after creating a project or on demand from its
 * page. `work-items`: "Suggest tasks" on the board. `resources`: "Suggest" on the Resources tab, or
 * "Create with AI" for one resource from a description.
 */
export type AssistantRunKind = 'project' | 'work-items' | 'resources';

/**
 * `running` has its chat, or is about to; `completed` answered and its proposals are served;
 * `failed` ended without a readable answer (the chat failed, the result did not match the schema, or
 * a restart cut it and it could not be started again); `stopped` a person stopped it. A finished run
 * never runs again: "Suggest again" is a new run.
 */
export type AssistantRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** The resources an assistant proposes or creates: the ones a project's `.claude/` holds as Markdown. */
export type AssistantResourceKind = Extract<ResourceKind, 'agents' | 'skills' | 'commands'>;

/**
 * What an entry of "what it read" is: the project's files (`file`, `dir`), the CLI's `instructions`
 * (`CLAUDE.md`) and `memory`, Agentry's `journal`, `work-items` and `milestones` (so it does not
 * propose them again), the `team`, the `resources`, the CLI's `chats` in the directory and the `git`
 * history.
 */
export type AssistantSourceKind =
  | 'file'
  | 'dir'
  | 'instructions'
  | 'memory'
  | 'journal'
  | 'work-items'
  | 'milestones'
  | 'team'
  | 'resources'
  | 'chats'
  | 'git';

/**
 * `pending`: it will read it later ("after"); `reading`: now; `read`: all of it; `partial`: some of
 * it (`count` of `total`); `missing`: it looked and there is none (`CLAUDE.md` does not exist).
 */
export type AssistantSourceState = 'pending' | 'reading' | 'read' | 'partial' | 'missing';

/** What `count` and `total` count, which a client words ("142 lines", "23 chats", "14 of 20"). */
export type AssistantSourceUnit = 'lines' | 'files' | 'documents' | 'chats' | 'commits' | 'items' | 'entries' | 'members';

/**
 * One entry of what a run read ("See what it read"): kept on the run, filled in from the chat's tool
 * calls and from what Agentry handed it (its journal, its work items, its team, its resources).
 */
export interface AssistantSource {
  kind: AssistantSourceKind;
  /** Relative to the project, `/`-separated, a directory ending in `/` (`docs/`); null for what is not a path */
  path: string | null;
  state: AssistantSourceState;
  count: number | null;
  /** For `partial`, how many there were */
  total: number | null;
  unit: AssistantSourceUnit | null;
  /** A few names a client may list beside it: the open milestones (`v0.20`), the files of a group */
  names: string[];
}

/**
 * Something a `project` run found, shown as a tag ("TypeScript", "Fastify"): `stack` is what the
 * project uses, `gap` is what it lacks ("no CI").
 */
export interface AssistantFinding {
  kind: 'stack' | 'gap';
  label: string;
}

/** `pending` waits for the person; `superseded` was pending when the person asked to suggest again. */
export type AssistantProposalStatus = 'pending' | 'accepted' | 'discarded' | 'superseded';

export type AssistantProposalKind = 'team-member' | 'resource' | 'work-item';

/** How many proposals of a kind a run made, by status: "2 of 6 accepted", "3 to review". */
export interface AssistantProposalCount {
  total: number;
  pending: number;
  accepted: number;
  discarded: number;
  superseded: number;
}

/** An assistant run as `GET /projects/:id/assistant/runs` lists it; `GET /assistant/runs/:runId` adds its proposals. */
export interface AssistantRun {
  id: string;
  projectId: string;
  kind: AssistantRunKind;
  status: AssistantRunStatus;
  /** Model alias or id the chat ran with; `sonnet` unless the request chose another */
  model: string;
  /** What the person described: the one resource "Create with AI" builds, or what an empty project is for */
  description: string | null;
  /**
   * For a `work-items` run, what to look for ("Suggest tasks"'s focus, {@link StartAssistantRunRequest.focus});
   * absent or null otherwise, and on a run stored before it was its own field
   */
  focus?: string | null;
  /**
   * The person's language when it started, which its chat's title is written in, kept so a run
   * started again after a restart words it the same. Absent on a run stored before it was kept,
   * which reads as `en`.
   */
  language?: AgentryLanguage;
  /** For a `resources` run from a description, the kind of the one resource it builds; null otherwise */
  resourceKind: AssistantResourceKind | null;
  /**
   * The chat it runs in, which counts in Usage like any other. Null while starting, and for a run with
   * nothing to read ({@link AssistantRun.empty}), which starts no chat.
   */
  chatId: string | null;
  /** What the chat is doing now, filled in when read while it runs */
  activity?: ChatActivity | null;
  /**
   * The project had nothing to read: no files, no chats, no git history. No chat was started; a
   * `project` run offers the template's team, and asks for a description to propose work items.
   */
  empty: boolean;
  /** The template whose team it offered as the starting point; null when it proposed none */
  template: ProjectTemplateId | null;
  /** What it read, in the order it read it; entries still `pending` while it runs */
  sources: AssistantSource[];
  /** For a `project` run; empty for the others and until the answer comes */
  findings: AssistantFinding[];
  /** Proposals by kind; a kind the run does not propose counts zero */
  counts: Record<AssistantProposalKind, AssistantProposalCount>;
  /** The chat's cost so far, then its total; null when the CLI reported none (or no chat was started) */
  costUsd: number | null;
  /** From start to end; null while it runs */
  durationMs: number | null;
  /** Why it failed; null unless `failed` */
  error: Localized | null;
  /** The finished run of the same kind whose pending proposals this one superseded ("Suggest again") */
  supersedes: string | null;
  /** The run that superseded this one's pending proposals; null while none has */
  supersededBy: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** `GET /assistant/runs/:runId`, and what starting or stopping one answers. */
export interface AssistantRunDetail extends AssistantRun {
  /** Every proposal it made, whatever its status, by kind then in the order it proposed them */
  proposals: AssistantProposal[];
  /**
   * "Create with AI" while it runs: the one resource as the chat is writing it, read from its partial
   * structured output or its stream, so the editor opens at once and fills in. Absent or null for
   * every other run, and once the run ended (its proposal carries the whole file). Refreshed through
   * `assistant.run` events with the action `read`.
   */
  draft?: AssistantResourceDraft | null;
}

/** The resource a running "Create with AI" has written so far; nothing of it is saved. */
export interface AssistantResourceDraft {
  kind: AssistantResourceKind;
  /** Null until the chat has written it */
  name: string | null;
  /** What it has written of the whole file so far, frontmatter included; empty before the first part */
  content: string;
}

/**
 * `POST /projects/:id/assistant/runs`. One run at a time per project and kind: a second one while
 * one runs is refused with 409. A new run leaves the previous one's pending proposals as they are,
 * unless `supersede` says to set them aside ("Suggest again").
 */
export interface StartAssistantRunRequest {
  kind: AssistantRunKind;
  /** Default `sonnet` (`DEFAULT_ASSISTANT_MODEL`) */
  model?: string;
  /**
   * For a `resources` run, the one resource to build ("Create with AI"), with `resourceKind`; for a
   * `project` or `work-items` run, what the project is for when there is nothing to read
   */
  description?: string;
  /**
   * For a `work-items` run ("Suggest tasks"), what to look for ("the checkout's error handling"): the
   * prompt words it as the area to propose work in, not as what the project is for. Refused on
   * the other kinds. The language is not a field: it is the request's `Accept-Language`.
   */
  focus?: string;
  /** Required with a `resources` run's `description` */
  resourceKind?: AssistantResourceKind;
  /** Mark the pending proposals of the latest finished run of this kind `superseded`. Default false */
  supersede?: boolean;
}

/** A role of the team the assistant proposes, as the member it would add. */
export interface ProposedTeamMember extends ProjectTeamRole {
  /** Name of the agent file it would write in `.claude/agents/`, without `.md` */
  agent: string;
  /** Paths or globs it may write; empty means nothing but work items ("writes: nothing, only tasks") */
  writes: string[];
  /** One of the template's roles; false for one the project needs beyond it ("outside the template") */
  fromTemplate: boolean;
  /** The agent file's `description`, what the CLI picks it by */
  description: string;
  /** The agent file's body; empty lets the team service write its starting one */
  instructions: string;
}

/** A resource the assistant proposes: a whole file, opened in the editor before anything is saved. */
export interface ProposedResource {
  kind: AssistantResourceKind;
  /** File or directory name, without extension; a command's without its `/` */
  name: string;
  /** One line, as its frontmatter says it */
  description: string;
  /** The whole file, frontmatter included (a skill's `SKILL.md`) */
  content: string;
  /** Where it is meant to go: the project by default (decision 37) */
  scope: ConfigScopeKind;
  /**
   * Where it would be saved, relative to its scope's root: the project (`.claude/agents/x.md`, a
   * skill's directory `.claude/skills/x/`), or the Claude config dir for `user` (`agents/x.md`)
   */
  path: string;
}

/** A work item the assistant proposes, created in `backlog` when accepted. */
export interface ProposedWorkItem {
  type: WorkItemType;
  title: string;
  /** Markdown */
  description: string;
  priority: WorkItemPriority;
  labels: string[];
  acceptanceCriteria: NewAcceptanceCriterion[];
  /** An existing epic of the project it belongs to */
  epicId: string | null;
  /** Filled in when read; null without one or once it is gone */
  epic: WorkItemRef | null;
  /**
   * An existing item it resembles ("Similar to AGN-45"), filled in when read; such a proposal starts
   * unselected where a client offers a selection
   */
  similarTo: WorkItemRef | null;
}

/** What every proposal carries, whatever its kind. */
export interface AssistantProposalBase {
  id: string;
  runId: string;
  projectId: string;
  status: AssistantProposalStatus;
  /** Why it proposes it, one or two sentences; for a work item, its first comment once accepted */
  reason: string;
  /** Its place among the run's proposals of the same kind */
  position: number;
  /** Who accepted or discarded it last; null while pending (and again once restored) */
  decidedBy: WorkItemActor | null;
  decidedAt: string | null;
  createdAt: string;
}

/** Accepting it adds the member through the team service, agent file included. */
export interface AssistantTeamMemberProposal extends AssistantProposalBase {
  kind: 'team-member';
  member: ProposedTeamMember;
  /** The member as added, by agent file name, once accepted; null otherwise */
  acceptedAgent: string | null;
}

/**
 * Accepting it is saving it: the editor opens the proposal unsaved, and its save is the accept, with
 * what the person edited ({@link AcceptAssistantProposalRequest.resource}).
 */
export interface AssistantResourceProposal extends AssistantProposalBase {
  kind: 'resource';
  resource: ProposedResource;
  /** Where it was saved, once accepted: its scope and its path there; null otherwise */
  saved: { scope: ConfigScopeKind; name: string; path: string } | null;
}

/** Accepting it creates the item in `backlog`, with the reason as its first comment. */
export interface AssistantWorkItemProposal extends AssistantProposalBase {
  kind: 'work-item';
  workItem: ProposedWorkItem;
  /** The item it created, once accepted ("created · PAG-1"); null otherwise, or once it is gone */
  created: WorkItemRef | null;
}

/** One proposal of a run, accepted or discarded on its own (decision 36). */
export type AssistantProposal = AssistantTeamMemberProposal | AssistantResourceProposal | AssistantWorkItemProposal;

/**
 * `POST /assistant/proposals/:proposalId/accept`, with what the person changed before accepting;
 * only the part that matches the proposal's kind is read, and a field left out keeps the proposed
 * value. Accepting a proposal that is not `pending` is refused with 409.
 */
export interface AcceptAssistantProposalRequest {
  member?: Partial<Omit<ProposedTeamMember, 'fromTemplate'>>;
  /** The editor's save: the name, content and scope the person left */
  resource?: { name?: string; content?: string; scope?: ConfigScopeKind };
  workItem?: Partial<Omit<ProposedWorkItem, 'epic' | 'similarTo'>>;
}

// ---------- What changed on disk ----------
//
// An agent's real output is the diff, not its report. Everything here comes from `git` (`log`,
// `diff --numstat`, `--name-status`, `status --porcelain`) except {@link TouchedFile}, which is
// what is left when there is no repository to ask.

/** One commit, as `git log` reports it. */
export interface Commit {
  hash: string;
  subject: string;
  author: string;
  /** Author date, ISO 8601 */
  at: string;
}

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  path: string;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
  /** Where a rename came from */
  previousPath?: string;
  /** Git printed `-` for both counts: there are no lines to count, and no diff to draw */
  binary?: boolean;
}

/** What a branch has done: the work it committed, and what it has not committed yet. */
export interface ChangeSummary {
  /** Null when the worktree is on a detached head */
  branch: string | null;
  /** What `branch` is compared against: the commit the worktree branched from */
  base: string | null;
  /** Commits on `branch` that `base` does not have */
  ahead: number;
  /** Newest first */
  commits: Commit[];
  /** Files the commits changed, against `base` */
  files: ChangedFile[];
  /** Working-tree changes that are in no commit, staged or not */
  uncommitted: ChangedFile[];
  /**
   * Every file that differs between `base` and the working tree, committed or not, untracked
   * included, with those counts: what the default diff of a file shows. Left out of a summary
   * scoped to one commit or to the uncommitted work.
   */
  working?: ChangedFile[];
}

/**
 * How many unchanged lines a diff keeps around each change: a number (0–500), or `full` for the
 * whole file.
 */
export type DiffContext = number | 'full';

/** One file's diff, unified, exactly as git prints it. */
export interface FileDiff {
  path: string;
  diff: string;
  /** True when the diff carries the whole file: `context=full` was asked for and honoured */
  full: boolean;
}

/** The tools whose calls become the steps of the Step by step lens. */
export type EditStepTool = 'Edit' | 'MultiEdit' | 'Write' | 'NotebookEdit';

/** One successful edit of a chat's main transcript, with the patch the CLI stored for it. */
export interface EditStep {
  /** The `tool_use` id */
  id: string;
  /** 1-based, in the order the calls were made */
  index: number;
  /** When the call was made (ISO 8601); null when the entry carries no timestamp */
  at: string | null;
  tool: EditStepTool;
  /**
   * Relative to the git top level when the chat works in a checkout, to the chat's directory
   * otherwise; absolute when the file is outside it
   */
  path: string;
  additions: number;
  deletions: number;
  /** Unified diff (`@@` hunks only); `''` when the transcript kept no patch */
  diff: string;
  /** A `Write` that created the file */
  created: boolean;
  /** The last thing the assistant wrote before the call, clipped to 280 characters; null when none */
  intent: string | null;
  /**
   * 0-based index, in the space `GET /chats/:id` pages with sidechains off, of the entry that holds
   * the `tool_use`; null when unknown
   */
  entryIndex: number | null;
  /** The call has no result yet: the chat is still working on it */
  pending: boolean;
}

/** A file a chat wrote where git cannot answer, read from the chat's own transcript. */
export interface TouchedFile {
  path: string;
  /** When the tool call that touched it ran */
  at: string;
  /** The tool that did it: `Write`, `Edit`, `NotebookEdit` */
  tool: string;
}

/**
 * What a chat changed. A chat in a git checkout has a `summary`; one working somewhere else has
 * none, and then the transcript is the only honest record of what it wrote.
 */
export interface ChatChanges {
  /** Null when the chat's directory is not a git checkout */
  summary: ChangeSummary | null;
  /** What the chat's `Write`/`Edit`/`NotebookEdit` calls touched, newest first */
  touched: TouchedFile[];
}

/** One item of a worker's own checklist, from its `TaskCreate`/`TaskUpdate`/`TodoWrite` calls. */
export interface ChecklistItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** A worker's plan for itself, as of its last update. */
export interface Checklist {
  items: ChecklistItem[];
  /** When the worker last rewrote it; null when it never wrote one */
  updatedAt: string | null;
}

// ---------- Server strings ----------

/** The figures a server string was built from, so a translation can put them back in its own order. */
export type LocalizedParams = Record<string, string | number>;

/**
 * A sentence the server writes, with a stable key beside it. The API answers in English and reads
 * as it is; a client that knows the code says the same thing in its own language, and one that
 * does not shows `text`.
 */
export interface Localized {
  /** Stable across releases: a translation is keyed by it */
  code: string;
  params?: LocalizedParams;
  /** The English sentence, always present */
  text: string;
}

/**
 * The languages Agentry speaks. A chat Agentry starts on its own is listed by the first line of its
 * prompt, so that line is written in the person's language, read from the request's
 * `Accept-Language` (`agentryLanguage`) and kept on what runs later or again (an assistant run, a
 * flow run); the instructions for Claude after it may stay in English.
 */
export type AgentryLanguage = 'en' | 'es';

// ---------- Orchestration ----------

export interface OrchestrationTaskSpec {
  id: string;
  name: string;
  prompt: string;
  dependsOn?: string[];
  cwd?: string;
  model?: string;
  /** What this worker may spend before Agentry stops it; the graph's default when absent */
  limits?: TaskLimits;
  /**
   * The work item this node works on, as a draft built from a selection names it. Launching links
   * the node to the item, which then follows the node's status. Must be a work item of a project
   * whose Board module is on, and at most one node per item.
   */
  workItemId?: string;
}

/**
 * How a graph runs:
 *   graph     every task is its own `claude -p` process, optionally in its own worktree and branch,
 *             merged into one integration branch at the end
 *   workflow  every task is a subagent of one Claude Code session, driven by a workflow script
 *             Agentry generates from the graph: cheaper and resumable from cache, but in the
 *             project directory, so for work that does not change files in parallel
 */
export type OrchestrationEngine = 'graph' | 'workflow';

export interface OrchestrationSpec {
  name: string;
  /** The planner run whose draft filled this form; absent for a template, a relaunch or a work item */
  plannerRunId?: string | null;
  objective?: string;
  /** Default `graph` */
  engine?: OrchestrationEngine;
  /** Why the planner chose the engine, shown next to it in the draft */
  engineReason?: string;
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** Max agents running in parallel (default 3) */
  concurrency?: number;
  /** Launch a final agent that synthesizes the results */
  synthesize?: boolean;
  /**
   * Give every task its own git worktree and branch, so parallel workers never write over each
   * other — and never edit the checkout the wrapper itself is running from.
   */
  worktree?: boolean;
  /** Attempts a failed task gets in total, the first included, before a person has to decide (default 2) */
  maxAttempts?: number;
  /**
   * Tools every worker may use without being asked. A worker has no one to ask unless
   * `permissionPrompts` sends its prompts to the panel, so anything it needs beyond editing files
   * has to be pre-authorised here or approved there.
   */
  allowedTools?: string[];
  /** `host` routes each worker's permission prompts to the panel for a person to answer */
  permissionPrompts?: 'host' | 'none';
  /** Default ceiling for every task that does not set its own */
  limits?: TaskLimits;
  /** Checks to run on the integration branch once the graph is merged; none when absent */
  verification?: VerificationSpec;
  tasks: OrchestrationTaskSpec[];
}

/**
 * `failed` is final: the task's attempts ran out (or it failed in a way a retry cannot mend), and a
 * person decides what happens to it. `blocked`: a task waiting behind one that failed, which is not
 * the same as `pending`, waiting for its turn. `skipped`: that decision, giving the branch up so the
 * graph can finish without it. `stopped` is someone's decision and is never retried on its own;
 * `interrupted` is a task whose execution a wrapper restart cut off, which is: the chat goes on in a
 * new execution, in the worktree it left, while attempts remain.
 */
export type OrchestrationTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped' | 'stopped' | 'interrupted';
/** `waiting`: nothing runs and a task failed for good, so integration and synthesis are held back until a person decides. */
export type OrchestrationStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';

/** One chat of a task's chain: the provider and model it ran on, and how it got there. */
export interface TaskChainEntry {
  chatId: string;
  provider: ProviderId;
  model: string | null;
  /** How this chat came to be; the first chat of a task has none */
  action: LimitAction | null;
}

/** Work that stopped to wait for a provider's limit to reset. */
export interface LimitWait {
  provider: ProviderId;
  /** ISO time the limit resets; null when unknown, and the wait ends at the cap */
  resetsAt: string | null;
  moveId: string;
}

export interface OrchestrationTaskState extends OrchestrationTaskSpec {
  status: OrchestrationTaskStatus;
  /** Git worktree this task works in, when the orchestration isolates its workers */
  worktree?: string | null;
  /** Branch created for that worktree */
  branch?: string | null;
  /**
   * The commit the worker started from: where its branch was cut, after any dependencies' branches
   * were merged in. What it changed is everything since; absent on graphs older than this field,
   * which are compared against the graph's `baseCommit`.
   */
  baseCommit?: string | null;
  /** Commit the wrapper made of work the worker left uncommitted, when there was any */
  commit?: string | null;
  /** Executions of its chat so far, the first included */
  attempts: number;
  /**
   * Times the orchestrator sent the worker back to its chat because its turn ended as a report with
   * work still owed (`openItems`), at most three; absent on a task that never needed it. These are
   * not attempts: nothing failed.
   */
  continuations?: number;
  runId: string | null;
  sessionId: string | null;
  /** The provider its current chat is on; absent on a task written before providers were chosen */
  provider?: ProviderId;
  /** The chats the task went through, oldest first, one entry per provider move */
  chain?: TaskChainEntry[];
  /** Set while the task waits for its provider's limit to reset; it stays `running` and keeps its place */
  waiting?: LimitWait | null;
  result: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  costUsd: number;
  /** Computed while it runs, from the same signals as a chat's; absent once it has ended */
  health?: Health | null;
  /** What the worker's live execution is doing right now; absent once the task has ended */
  activity?: ChatActivity | null;
  /**
   * Where the task's time limit counts from: when it first started, or when a person last sent it
   * around again. `startedAt` cannot serve, since it survives a retry and the limit would trip the
   * moment the person decided the task was worth another go.
   */
  clockStartedAt?: string | null;
  /** What the task had cost when that clock started, so a cost limit counts from the same moment */
  clockCostUsd?: number;
}

export interface Orchestration {
  id: string;
  name: string;
  objective: string | null;
  status: OrchestrationStatus;
  cwd: string;
  model: string | null;
  permissionMode: PermissionMode;
  concurrency: number;
  synthesize: boolean;
  /** Each task gets its own git worktree and branch instead of sharing the checkout */
  worktree: boolean;
  /** Attempts a failed task gets in total, the first included, before it is left for a person to decide */
  maxAttempts: number;
  /** Tools pre-authorised for every worker */
  allowedTools: string[];
  /** Where a worker's permission prompts go */
  permissionPrompts: 'host' | 'none';
  createdAt: string;
  endedAt: string | null;
  tasks: OrchestrationTaskState[];
  finalResult: string | null;
  costUsd: number;
  /** Commit every worktree branches from, recorded when the graph starts */
  baseCommit?: string | null;
  /** The one branch a worktree graph delivers, built once its tasks finish */
  integration?: OrchestrationIntegration | null;
  /** The newest change request opened for the integration branch; null or absent before one */
  pullRequest?: OrchestrationPullRequest | null;
  /** The synthesis run, so its report can be continued like any other conversation */
  synthesisRunId?: string | null;
  /** When the synthesis run started and ended; absent on graphs stored before they were recorded */
  synthesisStartedAt?: string | null;
  synthesisEndedAt?: string | null;
  engine?: OrchestrationEngine;
  engineReason?: string | null;
  /** The workflow engine's run and script, when the graph runs as a workflow */
  workflow?: OrchestrationWorkflow | null;
  /** Default ceiling for every task that does not set its own */
  limits?: TaskLimits | null;
  /** The checks the graph asked for, kept so a relaunch, a template and a re-run of the checks start from them */
  verificationSpec?: VerificationSpec | null;
  /** What the checks on the integration branch did; absent when the graph asked for none */
  verification?: VerificationState | null;
  /**
   * Why the graph failed when its tasks did not: its checks failed and it was launched with
   * `verification.failGraph`. Null or absent otherwise.
   */
  error?: string | null;
  /** The orchestration this one was relaunched from, when it was */
  relaunchedFrom?: string | null;
  /** The template it was launched from, when it was */
  templateId?: string | null;
  /** The planner run whose draft filled the form it was launched from; lets `orchestration.model` compare its suggestion */
  plannerRunId?: string | null;
}

/** A task as a list shows it: its prompt and its result are left out, and the graph's own page has them. */
export type OrchestrationTaskSummary = Omit<OrchestrationTaskState, 'prompt' | 'result'>;

/** A check as a list shows it: what it printed is left out. */
export type VerificationCommandSummary = Omit<VerificationCommand, 'output'>;

export interface VerificationSummary extends Omit<VerificationState, 'commands'> {
  commands: VerificationCommandSummary[];
}

/**
 * An orchestration as `GET /orchestrations` serves it. The long texts (each task's prompt and
 * result, the synthesis, what the checks printed) were over nine tenths of the list, and every
 * screen that shows it wants statuses, counts and costs; `GET /orchestrations/:id` has them whole.
 */
export interface OrchestrationSummary extends Omit<Orchestration, 'tasks' | 'finalResult' | 'verification'> {
  tasks: OrchestrationTaskSummary[];
  /** Whether the graph has a synthesis, which its own page shows */
  hasFinalResult: boolean;
  verification?: VerificationSummary | null;
}

// ---------- Verification ----------
//
// Workers run typecheck and unit tests; the whole suite runs once, here, on the integration branch.
// Running a browser suite in every worktree in parallel is what makes it hang.

/** Checks to run once the graph is integrated, and what may happen to what fails. */
export interface VerificationSpec {
  /**
   * Run in order on the integration branch, each one under a timeout. An entry that is a list runs
   * its commands at the same time; the next entry starts once all of them have ended.
   */
  commands: Array<string | string[]>;
  /** Launch an agent to fix what fails, instead of only reporting it */
  fixer: boolean;
  /** Fixer attempts per failing command before it stops and reports */
  maxAttempts: number;
  /** Model for the fixer; the graph's when absent */
  model?: string;
  /** Minutes each command may run before it is killed and counts as failed (default 20) */
  timeoutMinutes?: number;
  /**
   * What the fixer may spend over all its attempts, passed to the CLI as `--max-budget-usd` with
   * what is left after each one; once spent, the verification is `failed` and the report says so
   */
  maxCostUsd?: number;
  /**
   * Run before the checks, as its own row in the state. Absent: detected from the lockfile of the
   * integration worktree (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`); `null`: no install
   * step; a string: that command instead.
   */
  install?: string | null;
  /** A failed verification ends the orchestration as `failed` and no pull request is offered (default false) */
  failGraph?: boolean;
}

/** Runs the checks on a finished graph's integration branch, or runs them again. */
export interface VerifyOrchestrationRequest {
  /** Replaces the checks the graph was launched with; required for a graph launched without any */
  verification?: VerificationSpec;
}

/** `fixed`: it failed, the fixer mended it, and the re-run passed. */
export type VerificationStatus = 'pending' | 'running' | 'passed' | 'fixed' | 'failed';

export interface VerificationCommand {
  command: string;
  /** The install step that runs before the checks: detected from the lockfile, or the spec's `install` */
  install?: boolean;
  /** Index of the `commands` entry it came from; commands of one parallel group share it. Absent on the install step */
  group?: number;
  status: VerificationStatus;
  /** Tail of what it printed: enough to see why it failed, not the whole log */
  output: string;
  /** The last run's; every run is in `runs` */
  durationMs: number;
  /** Every execution of this command, in order; absent on graphs stored before it was recorded */
  runs?: VerificationRun[];
}

/** One execution of a verification command. */
export interface VerificationRun {
  /** 1 for the first pass over the checks, one more each time a fix sends them all back to pending */
  pass: number;
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed';
  timedOut?: boolean;
  cancelled?: boolean;
}

/** One attempt of the verification fixer. */
export interface VerificationFix {
  /** Null when the fixer could not start */
  runId: string | null;
  command: string;
  /** 1-based, over every command */
  attempt: number;
  startedAt: string;
  endedAt: string | null;
  costUsd: number;
}

export interface VerificationState {
  status: VerificationStatus;
  /** When the checks started and ended; absent on graphs stored before they were recorded */
  startedAt?: string | null;
  endedAt?: string | null;
  /** Every fixer attempt, in order */
  fixes?: VerificationFix[];
  /** Fixer attempts spent, over every command */
  attempts: number;
  commands: VerificationCommand[];
  /** What the fixer committed on the integration branch */
  commits: Commit[];
  /** The head of the integration branch the checks last ran on; when it moves, they are stale */
  commit?: string | null;
  /** What happened, in words: shown before the pull request is offered */
  report: string;
  /** What the fixer spent, as the CLI reported it; counted in the graph's cost */
  costUsd: number;
}

export interface OrchestrationWorkflow {
  /** Script generated from the graph, in the wrapper's data directory */
  scriptPath: string;
  /** The run whose session runs the workflow; a resume continues it */
  runId: string | null;
  /** The CLI's workflow run id (`wf_…`), which a resume replays from cache */
  workflowRunId: string | null;
}

/** Copies the script a workflow graph ran into the project's `.claude/workflows/`. */
export interface SaveOrchestrationWorkflowRequest {
  /** File and workflow name; defaults to one derived from the graph's */
  name?: string;
  /** Replace a saved workflow of the same name */
  overwrite?: boolean;
}

/**
 * - `merging`: task branches are being merged into the integration branch
 * - `resolving`: a merge conflicted and an integrator agent is resolving it
 * - `merged`: every completed task's work is on the branch
 * - `conflicted`: the integrator could not finish; the branch is left for a person
 * - `failed`: integration could not run at all
 */
export type IntegrationStatus = 'merging' | 'resolving' | 'merged' | 'conflicted' | 'failed';

export interface OrchestrationIntegration {
  branch: string;
  /** Worktree the branch is checked out in, until the worktrees are removed */
  worktree: string | null;
  status: IntegrationStatus;
  /** Tasks whose branch is contained in the integration branch */
  merged: string[];
  /** Merges that conflicted, with the paths that did */
  conflicts: Array<{ taskId: string; paths: string[] }>;
  /** Head of the integration branch once merged */
  commit: string | null;
  error: string | null;
  integratorRunId: string | null;
  pullRequestUrl?: string | null;
  /** When the last integration started and ended; absent on graphs stored before they were recorded */
  startedAt?: string | null;
  endedAt?: string | null;
}

// ---------- Orchestration timings ----------

export type OrchestrationPhaseName = 'tasks' | 'integration' | 'verification' | 'synthesis';
/**
 * - `slot`: ready (its dependencies done) but waiting for a free place under the concurrency
 * - `limit`: an execution ended on a rate limit or with no account, until the next one started
 * - `retry`: any other failed or interrupted execution, until a person or the automatic retry sent it again
 */
export type TaskWaitKind = 'slot' | 'limit' | 'retry';

export interface TaskWait {
  taskId: string;
  kind: TaskWaitKind;
  startedAt: string;
  /** Null while the wait goes on */
  endedAt: string | null;
  durationMs: number;
  /** The error that started a limit or retry wait */
  reason: string | null;
}

export interface OrchestrationPhaseTiming {
  phase: OrchestrationPhaseName;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
}

export interface CriticalPathLink {
  taskId: string;
  taskName: string;
  startedAt: string;
  endedAt: string | null;
  /** Sum of the task's executions */
  workMs: number;
  /** From the previous link's end (or the graph's creation) to this link's first start */
  waitBeforeMs: number;
  waits: TaskWait[];
}

export interface VerificationTimings {
  /** Every run of every command */
  checksMs: number;
  /** Every fixer attempt */
  fixerMs: number;
  /** The highest pass */
  passes: number;
  commands: Array<{ command: string; install: boolean; totalMs: number; runs: VerificationRun[] }>;
  fixes: VerificationFix[];
}

/** Where a graph's time went, computed on read from what it and its chats recorded. */
export interface OrchestrationTimings {
  orchestrationId: string;
  /** When the figures were computed; durations of what is still running count up to here */
  at: string;
  createdAt: string;
  endedAt: string | null;
  wallMs: number;
  /** Phases in order; one that did not happen is left out */
  phases: OrchestrationPhaseTiming[];
  /** From the last task's end to the graph's end (or now) */
  afterTasksMs: number;
  /** Sum of every task's working time divided by the tasks phase */
  parallelism: number | null;
  criticalPath: { durationMs: number; links: CriticalPathLink[] };
  waits: { slotMs: number; limitMs: number; retryMs: number; items: TaskWait[] };
  verification: VerificationTimings | null;
  /** Figures an older graph could not give, e.g. `integration.startedAt` or `verification.runs` */
  missing: string[];
}

/** A planner run's draft, kept so a plan is never lost with the response that carried it. */
export interface PlanDraftSummary {
  runId: string;
  createdAt: string;
  name: string;
  objective: string | null;
  taskCount: number;
}

/**
 * A tool call the CLI is holding until someone decides. Questions (`AskUserQuestion`) and plan
 * approval (`ExitPlanMode`) arrive this way too: they are answered by allowing them, with the
 * answers in `updatedInput`.
 */
export interface PermissionRequest {
  id: string;
  runId: string;
  toolName: string;
  /** The CLI's id for the tool call this decides */
  toolUseId: string;
  /** Arguments the tool would be called with, e.g. the shell command */
  input: Record<string, unknown>;
  requestedAt: string;
  /** The CLI's own one-line description of the call */
  description?: string;
  /** Rules the CLI offers to remember, e.g. switching to acceptEdits; send them back to accept */
  suggestions?: PermissionUpdate[];
  /** Waits on a person by design (a question), rather than on an approval */
  requiresUserInteraction?: boolean;
}

/** A permission rule or mode change, exactly as the CLI proposes it. */
export interface PermissionUpdate {
  type: string;
  [key: string]: unknown;
}

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  /** Shown to the model when denying, so it can adapt instead of guessing */
  message?: string;
  /** Lets the approver edit the arguments before allowing them, or carries a question's answers */
  updatedInput?: Record<string, unknown>;
  /** Suggestions from the request to apply when allowing ("always allow") */
  updatedPermissions?: PermissionUpdate[];
}

/**
 * Settings that can be corrected when resuming, so a graph started with the wrong ones is fixed and
 * picked up instead of rebuilt. Only what shapes the workers still to run; completed work is kept.
 */
export interface ResumeOrchestrationRequest {
  worktree?: boolean;
  permissionPrompts?: 'host' | 'none';
  allowedTools?: string[];
  permissionMode?: PermissionMode;
  /**
   * What a task may spend from here on. An object replaces the graph's default and leaves the
   * limits individual tasks were given; `null` lifts every ceiling, those included, because a
   * graph stopped by a budget is not freed by raising one half of it.
   */
  limits?: TaskLimits | null;
  /** Attempts a failed task gets from here on, the first included */
  maxAttempts?: number;
}

export interface PlanRequest {
  objective: string;
  cwd?: string;
  model?: string;
  maxTasks?: number;
}

/**
 * Runs a finished graph again with corrections, as a new orchestration that records where it came
 * from. What is left out keeps the original's value; `tasks` replaces the whole list, because
 * merging two graphs by task id is guesswork nobody asked for.
 */
export interface RelaunchOrchestrationRequest {
  spec?: Partial<OrchestrationSpec>;
  tasks?: OrchestrationTaskSpec[];
}

/** A graph saved to be run again on another objective. Settings-shaped, so a JSON file. */
export interface OrchestrationTemplate {
  id: string;
  name: string;
  description?: string;
  spec: OrchestrationSpec;
  createdAt: string;
  updatedAt: string;
}

/** The graph to save is given as a spec (a draft plan) or named by the orchestration it is taken from. */
export interface SaveOrchestrationTemplateRequest {
  name: string;
  description?: string;
  spec?: OrchestrationSpec;
  /** Id of an orchestration whose graph is saved, as it was launched */
  fromOrchestration?: string;
}

export interface UpdateOrchestrationTemplateRequest {
  name?: string;
  description?: string;
  spec?: OrchestrationSpec;
}

/** Launches a template. What is given here overrides the template's spec for this run only. */
export interface LaunchOrchestrationTemplateRequest {
  objective?: string;
  cwd?: string;
  /** Name of the orchestration; the template's when absent */
  name?: string;
  model?: string;
}

// ---------- Configuration ----------

/**
 * Every /config route takes an optional `?project=<projectId>`: absent means the user scope
 * (the Claude config dir), present means that project's own files.
 */
export type ConfigScopeKind = 'user' | 'project';

/** `shared` files are meant to be committed; `local` ones are personal (settings.local.json, CLAUDE.local.md). Project scope only. */
export type ConfigFileVariant = 'shared' | 'local';

export interface SettingsDoc {
  path: string;
  exists: boolean;
  settings: Record<string, unknown>;
}

export interface InstructionsDoc {
  path: string;
  exists: boolean;
  content: string;
}

/** user: ~/.claude.json · project: <project>/.mcp.json · local: private to you within one project */
export type McpScope = 'user' | 'project' | 'local';

export interface McpServerEntry {
  name: string;
  scope: McpScope;
  config: Record<string, unknown>;
}

export type McpHealthStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'unknown';

export interface McpServerHealth {
  name: string;
  status: McpHealthStatus;
  /** Raw status text printed by `claude mcp list` */
  detail: string;
}

export type ResourceKind = 'agents' | 'skills' | 'commands' | 'output-styles' | 'rules' | 'workflows';

/** What a resource's file is, which is what an editor highlights it as. */
export type ResourceFormat = 'markdown' | 'javascript';

/** Saved workflows are scripts; every other kind is markdown. */
export const RESOURCE_FORMATS: Record<ResourceKind, ResourceFormat> = {
  agents: 'markdown',
  skills: 'markdown',
  commands: 'markdown',
  'output-styles': 'markdown',
  rules: 'markdown',
  workflows: 'javascript',
};

export interface ConfigResource {
  kind: ResourceKind;
  name: string;
  path: string;
  format: ResourceFormat;
  description: string | null;
  content: string;
  updatedAt: string | null;
}

// ---------- Config file explorer ----------

export interface ConfigFileRoot {
  /** 'user' or a project id */
  id: string;
  label: string;
  /** Absolute directory: the Claude config dir, or <project>/.claude */
  path: string;
  exists: boolean;
}

export interface ConfigFileNode {
  name: string;
  /** Path relative to the root, '/'-separated */
  path: string;
  type: 'file' | 'dir';
  size?: number;
  updatedAt?: string;
  children?: ConfigFileNode[];
}

export interface ConfigFileContent {
  root: string;
  path: string;
  absolutePath: string;
  content: string;
  size: number;
  updatedAt: string | null;
  executable: boolean;
}

export interface WriteConfigFileRequest {
  root: string;
  path: string;
  content: string;
  /** chmod +x (hook scripts) */
  executable?: boolean;
}

// ---------- Security ----------

/**
 * `none` is the default and is what a local install has always done. `token` is a bearer token,
 * accepted as a query parameter only on `GET /api/events`, which `EventSource` cannot set headers
 * on. `oidc` validates a JWT against the issuer's JWKS.
 */
export type AuthMode = 'none' | 'token' | 'oidc';

export interface OidcConfig {
  issuer: string;
  audience: string;
  clientId: string;
}

/**
 * How the API is guarded. The token is **never** in this document: only its hash is stored, and the
 * token itself is shown once, when it is set. `token?: never` says so in the type, so no route can
 * leak it by echoing the configuration back.
 */
export interface AuthConfig {
  mode: AuthMode;
  token?: never;
  /** A token has been set, which is all a reader may know about it */
  tokenSet: boolean;
  oidc?: OidcConfig;
  /** Reject every mutating method with 405, except answering a permission prompt */
  readOnly: boolean;
}

export interface UpdateAuthConfigRequest {
  mode?: AuthMode;
  /** Null clears it */
  oidc?: OidcConfig | null;
  readOnly?: boolean;
}

/** Sets or rotates the bearer token. Omit it to have Agentry generate one. */
export interface SetAuthTokenRequest {
  token?: string;
}

/** The only time the token is ever returned. */
export interface AuthTokenResult {
  token: string;
  createdAt: string;
}

/**
 * Stands in for a secret the API will not return (an MCP server's `env` and `headers` values). Sent
 * back unchanged on a write it means "keep what is stored": that is how a configuration is edited
 * in the panel without the secret ever leaving the process.
 */
export const REDACTED = '__agentry_redacted__';

/** One mutating request. Never the body: prompts and secrets live there. */
export interface AuditEntry {
  id: string;
  at: string;
  /**
   * `token:<id>` for the owner's token, the OIDC subject, `desktop`, `chat:<chatId>` for a chat's own
   * token (`AGENTRY_API_TOKEN`), `env` or `agentry` for what the wrapper did itself; `local` when no
   * authentication is configured
   */
  actor: string;
  method: string;
  path: string;
  status: number;
  /** One line about what it did, built from the route, not from the payload */
  summary: string;
}

/** The query of `GET /audit`; every field narrows the page and its `total`. */
export interface AuditFilter {
  /** Matches anywhere in the path; `%`, `_` and `\` are taken literally */
  path?: string;
  /** Exact, case-insensitive: `POST` */
  method?: string;
  /** A code (`404`) or a class (`4xx`) */
  status?: string;
}

export interface AuditPage {
  /** Newest first */
  entries: AuditEntry[];
  /** Entries matching the filter, so a caller knows what is left below `from` */
  total: number;
  /** Offset of the first entry within the filtered set */
  from: number;
}

// ---------- Layered settings ----------

// Some settings used to be read from the environment once, at startup. They can now also be
// changed at runtime from a JSON file the UI edits, with a fixed order of precedence: the
// environment, then the file, then the default. A value the environment set is still shown, but
// read-only, the same way `AGENTRY_AUTH_TOKEN` already works for the guard: whoever deployed the
// install decided it, and the UI must not quietly override a deploy.

/**
 * Where a layered setting's current value comes from. `env` means the UI may show it but not change
 * it, except for `allowedHosts`, whose layers add up instead of replacing one another: there `env`
 * only says the environment names some of the hosts, and `allowedHostLayers` tells which.
 */
export type AppSettingSource = 'env' | 'file' | 'default';

/** The values of the settings that can change at runtime, without their sources. */
export interface AppSettingValues {
  /**
   * Host names this wrapper answers to besides loopback, each a name or a `*.domain` pattern with
   * at least two labels below the wildcard. Read, it is the configured allowlist: the environment's
   * hosts followed by the ones added in the UI. Written (`PUT`), it is the UI's part only, which
   * adds to the environment's: a host the environment already names is not stored again. The exact
   * names a running tunnel adds for itself are in neither, because nobody may edit them.
   */
  allowedHosts: string[];
  /** How many runs may work at once; a change applies to the next run, without a restart */
  maxConcurrentRuns: number;
  /** The `--permission-mode` of a run that does not ask for one; applies to the next run */
  defaultPermissionMode: PermissionMode;
  /**
   * The first-run Providers step was shown and answered (continued or skipped). Kept here rather than
   * in the browser so a second browser, a phone or the desktop app does not ask again; the step still
   * returns whenever no provider is ready.
   */
  providersStepSeen: boolean;
}

/**
 * The hosts the guard answers to besides loopback, by who put each one there. Unlike the other
 * settings, the layers add up: what the guard answers is all three together.
 */
export interface AllowedHostLayers {
  /** From `AGENTRY_ALLOWED_HOSTS`: fixed by whoever deployed the install, read-only in the UI */
  env: string[];
  /** From `app-settings.json`: added in the UI, and what a `PUT` of `allowedHosts` replaces */
  file: string[];
  /** Exact names lent while their owner runs (a running tunnel's host): memory only, never editable */
  runtime: string[];
}

/** `GET /settings/app`: every layered setting, and where each one's value comes from. */
export interface AppSettings extends AppSettingValues {
  /**
   * For `allowedHosts`, the highest layer that names any host (`env`, then `file`, then
   * `default`); it does not make the list read-only, `allowedHostLayers` does that per host.
   */
  sources: Record<keyof AppSettingValues, AppSettingSource>;
  allowedHostLayers: AllowedHostLayers;
}

/**
 * `PUT /settings/app`: the settings to change, and only those. A setting the environment set is
 * refused rather than written to the file, where it would do nothing until the variable goes away
 * and then change behaviour by surprise. `allowedHosts` is the exception: it replaces the UI's
 * hosts, which add to the environment's, so it is accepted whatever the environment says.
 */
export type UpdateAppSettingsRequest = Partial<AppSettingValues>;

// ---------- Tunnel ----------

// Reaching Agentry from a phone or another computer on the person's tailnet, through the Tailscale
// CLI (`tailscale serve`, tailnet-only, never Funnel): one provider, the person's own Tailscale
// session, reached only through its CLI flags and `--json` output (docs/plans/tunnel.md). The
// tunnel only exists while the guard asks for authentication, and only its exact host joins the
// allowlist.

/**
 * `starting`: Agentry is adding its Serve rule. `verifying`: the rule was sent, and Agentry reads
 * the node's Serve config back to make sure it holds and points at this server before showing the
 * address.
 */
export type TunnelState = 'stopped' | 'starting' | 'verifying' | 'active' | 'stopping' | 'failed';

/**
 * Whether this machine's Tailscale can carry the tunnel. The whole Remote access section depends
 * on it, so each way it is not ready is its own state, with a reason the UI explains:
 *
 * - `missing`: no `tailscale` CLI to run;
 * - `unsupported`: a CLI older than 1.52, whose `serve` takes other arguments;
 * - `daemonDown`: the CLI is there but `tailscaled` does not answer it;
 * - `loggedOut`: the node is not signed in to a tailnet (`NeedsLogin`, `NeedsMachineAuth`);
 * - `stopped`: signed in but not connected (`Stopped`, or any state other than `Running`);
 * - `httpsDisabled`: MagicDNS or HTTPS certificates are off for the tailnet, so Serve has no
 *   `https://<node>.<tailnet>.ts.net` to answer on;
 * - `ready`: Serve can be used.
 *
 * Agentry never signs in, starts or configures Tailscale itself: it says what to run.
 */
export type TailscaleReadinessState = 'missing' | 'unsupported' | 'daemonDown' | 'loggedOut' | 'stopped' | 'httpsDisabled' | 'ready';

export interface TailscaleReadiness {
  state: TailscaleReadinessState;
  /** The CLI's version (`tailscale version`, first line); null when there is no CLI to ask */
  version: string | null;
  /** This node's MagicDNS name, without the trailing dot; null until the daemon reports one */
  host: string | null;
  /** What is missing, with a code a client translates; null while `ready` */
  reason: Localized | null;
}

/** What the tunnel may be told to do beside starting and stopping it. */
export interface TunnelSettings {
  /** Open the tunnel whenever Agentry starts; off unless the person turns it on */
  startWithAgentry: boolean;
}

/** `PUT /tunnel/settings`: the settings to change, and only those. */
export type UpdateTunnelSettingsRequest = Partial<TunnelSettings>;

/** `GET /tunnel`, and what `tunnel.changed` carries. */
export interface TunnelStatus {
  state: TunnelState;
  /**
   * The tailnet HTTPS address (`https://<node>.<tailnet>.ts.net:<port>`), reachable only from the
   * person's own tailnet; null unless `state` is `active`, so nobody is sent to one that does not
   * answer yet
   */
  url: string | null;
  /** When the tunnel last became active; null unless `state` is `active` */
  since: string | null;
  /** Why the tunnel failed, with a code a client translates; null unless `state` is `failed` */
  reason: Localized | null;
  /**
   * Whether this deploy offers the tunnel at all (`AGENTRY_TUNNEL`). Off by default in the Docker
   * image and the Helm chart: the container sees neither the host's `tailscale` CLI nor its
   * daemon, and a way in that goes around the operator's published port and proxy is the
   * operator's call. While false, `start` is refused and the UI says who can turn it on instead of
   * offering a button
   */
  enabled: boolean;
  /** Whether Tailscale can carry the tunnel, and if not, why; the UI shows nothing else until it is `ready` */
  tailscale: TailscaleReadiness;
  /** The HTTPS port on the tailnet name that Agentry's Serve rule uses (`AGENTRY_TUNNEL_PORT`, 8443 by default) */
  port: number;
  settings: TunnelSettings;
}

// ---------- Effective environment ----------

/**
 * What Claude Code actually loaded for a directory, taken from the `init` event of the most
 * recent chat Agentry started there (the CLI only reports it when a session starts).
 */
export interface EffectiveEnvironment {
  cwd: string;
  observedAt: string;
  /** The chat whose start reported it */
  chatId: string;
  cliVersion: string | null;
  model: string | null;
  permissionMode: string | null;
  outputStyle: string | null;
  tools: string[];
  mcpServers: Array<{ name: string; status: string; source?: string }>;
  agents: string[];
  skills: string[];
  slashCommands: string[];
  plugins: Array<{ name: string; path?: string; source?: string }>;
  memoryPaths: Record<string, string>;
}

// ---------- Memory (Claude Code's per-project file memory) ----------

export interface MemoryFile {
  projectId: string;
  /** File name, e.g. `feedback-style.md`; `MEMORY.md` is the index loaded into every session */
  name: string;
  path: string;
  isIndex: boolean;
  description: string | null;
  /** `metadata.type` from the frontmatter: user | feedback | project | reference */
  type: string | null;
  content: string;
  updatedAt: string | null;
}

export interface MemoryProjectSummary {
  projectId: string;
  projectPath: string;
  projectName: string;
  fileCount: number;
  lastUpdated: string | null;
}

// ---------- Plugins ----------

export type PluginScope = 'user' | 'project' | 'local';

export interface InstalledPlugin {
  /** name@marketplace */
  id: string;
  name: string;
  marketplace: string;
  version: string | null;
  scope: string;
  enabled: boolean;
  installPath: string | null;
  installedAt: string | null;
  lastUpdated: string | null;
}

export interface AvailablePlugin {
  pluginId: string;
  name: string;
  description: string;
  marketplaceName: string;
  version: string | null;
  installed: boolean;
}

export interface PluginMarketplace {
  name: string;
  source: string;
  /** repo, url or path depending on the source */
  location: string;
}

export interface PluginsOverview {
  installed: InstalledPlugin[];
  marketplaces: PluginMarketplace[];
}

export interface PluginActionRequest {
  plugin: string;
  scope?: PluginScope;
}

export interface CliTextResult {
  ok: boolean;
  output: string;
}

// ---------- claude.ai connectors ----------
//
// Read from what the CLI reports about its MCP servers, never from claude.ai. Authorisation happens
// in an interactive CLI session (`claude mcp`, `/mcp`) or in claude.ai's connector settings: there
// is no command that does it for someone. Web artifacts and claude.ai memory have no CLI surface at
// all, which the page says out loud instead of leaving a gap.

export type ConnectorKind = 'docs' | 'gmail' | 'calendar' | 'other';

/** `unknown`: the CLI lists the server but says nothing about its session. */
export type ConnectorStatus = 'connected' | 'needs-auth' | 'unknown';

export interface Connector {
  /** The MCP server's name, which is how the CLI knows it */
  id: string;
  name: string;
  kind: ConnectorKind;
  status: ConnectorStatus;
  /** What it was granted, when the CLI reports it */
  scopes?: string[];
  /** The CLI's own words for the state (`Connected`, `Needs authentication`, a failure…) */
  detail?: string;
  /** Prepared prompts for this connector; none while it needs authorisation */
  actions?: ConnectorAction[];
}

/** A button that opens a new chat with a prompt already written. Nothing more magic than that. */
export interface ConnectorAction {
  id: string;
  label: string;
  prompt: string;
}

/** Something the CLI offers no command for. Said in the page, not left as a silent gap. */
export interface ConnectorLimit {
  id: 'web-artifacts' | 'claude-ai-memory';
  name: string;
  reason: Localized;
}

/** What a person has to do: Agentry cannot authorise a connector on anyone's behalf. */
export interface ConnectorGuide {
  steps: Localized[];
  links: Array<{ label: Localized; url: string }>;
}

export interface ConnectorsOverview {
  /** The claude.ai connectors `claude mcp list` reports, in the CLI's order */
  connectors: Connector[];
  /** Docs, Gmail and Calendar are the kinds Agentry has prepared actions for: those not listed at all */
  notListed: ConnectorKind[];
  authorisation: ConnectorGuide;
  unavailable: ConnectorLimit[];
  checkedAt: string;
  /** Set when the CLI could not be asked, so an empty list is not read as "no connectors" */
  error?: string;
}

// ---------- Scheduling ----------

/** What a schedule starts when it fires. */
export type ScheduleTarget =
  | { kind: 'chat'; chat: NewChatRequest }
  | { kind: 'orchestration'; spec: OrchestrationSpec };

/**
 * What happens when a slot fires while the last run is still going (its chat is `working` or its
 * orchestration `running`). `parallel` starts it anyway; `skip` writes a run as `overlapped` and
 * starts nothing; `queue` starts it when the previous run ends, one pending at most: a slot that
 * arrives while one is queued replaces it.
 */
export type ScheduleOverlap = 'parallel' | 'skip' | 'queue';

/**
 * A recurring chat or orchestration. The definition is settings-shaped, so it lives in a JSON file;
 * the runs accumulate, so they are rows. A window missed while the wrapper was down is skipped, not
 * replayed: firing a week of cron slots at once on boot is never what anyone meant.
 */
export interface Schedule {
  id: string;
  name: string;
  /** Five fields: minute, hour, day of month, month, day of week */
  cron: string;
  /** IANA zone the expression is read in; the server's when absent */
  timezone?: string;
  target: ScheduleTarget;
  enabled: boolean;
  /** `parallel` unless it was set: what every schedule did before there was a choice */
  overlap: ScheduleOverlap;
  /** Null until it has fired once */
  lastRunAt: string | null;
  /** Null when it is disabled, or when the expression will never fire again */
  nextRunAt: string | null;
  createdAt: string;
}

/**
 * `started`: it launched, and what happened next belongs to the chat or the orchestration.
 * `skipped`: the slot passed while the wrapper was down.
 * `overlapped`: the slot fired while the last run was still going and the policy was `skip`, or it
 * was `queue` and a newer slot took its place before it could start.
 * `queued`: the slot fired while the last run was still going and the policy was `queue`; it becomes
 * `started` (keeping its `slot`) when that run ends.
 */
export type ScheduleRunStatus = 'started' | 'failed' | 'skipped' | 'overlapped' | 'queued';

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  /** When this row was written: the moment it fired, or the moment the wrapper noticed it had skipped */
  at: string;
  /** The cron slot this run answers, as an ISO time; absent for a run started by hand */
  slot?: string;
  status: ScheduleRunStatus;
  chatId?: string;
  orchestrationId?: string;
  error?: string;
}

/** What an expression will do, for a form to show before it is saved. */
export interface SchedulePreview {
  valid: boolean;
  /** Which field is wrong, when it is not valid */
  error?: string;
  /** The expression in words */
  description?: string;
  /** The zone it was read in */
  timezone: string;
  /** The next fires, ISO times */
  next: string[];
}

export interface CreateScheduleRequest {
  name: string;
  cron: string;
  timezone?: string;
  target: ScheduleTarget;
  /** Starts enabled unless this says otherwise */
  enabled?: boolean;
  /** `parallel` when absent */
  overlap?: ScheduleOverlap;
}

export interface UpdateScheduleRequest {
  name?: string;
  cron?: string;
  /** Null goes back to the server's zone */
  timezone?: string | null;
  target?: ScheduleTarget;
  enabled?: boolean;
  overlap?: ScheduleOverlap;
}

// ---------- Overview ----------

export interface Overview {
  system: SystemInfo;
  /** One reading per provider that has one */
  limits: ProviderLimit[];
  counts: {
    projects: number;
    chats: number;
    chatsWorking: number;
    chatsWaiting: number;
    /** Commands and agents running in the background, whichever chat sent them */
    backgroundTasks: number;
    subagents: number;
    /** Claude Code workflows running right now */
    workflows: number;
    orchestrationsRunning: number;
  };
  recentChats: ChatSummary[];
}

export interface SetCredentialsRequest {
  /** Token from `claude setup-token` */
  oauthToken?: string;
  apiKey?: string;
}

export interface AuthVerification {
  ok: boolean;
  /** Model reply, or the CLI error */
  detail: string;
  auth: AuthStatus;
}

export interface CreateProjectRequest {
  name: string;
  /** Clone this repository instead of creating an empty directory */
  gitUrl?: string;
  /** Configures the project from a template; without one, and without `modules`, every module is off */
  template?: ProjectTemplateId;
  /** The modules to switch on; when given, it replaces the template's choice instead of adding to it */
  modules?: ProjectModule[];
}

export interface ApiError {
  error: string;
  detail?: string;
}

// ---------- Supervisor ----------
//
// The optional supervisor of docs/plans/agent-observability.md §3: a small model that reads a
// worker's last steps when its health turns bad and proposes a hint, which a person or `autoSend`
// sends on. Off by default, and a housekeeping chat of the CLI like every other model call.

/** `supervisor.json` in the data directory: settings-shaped. */
export interface SupervisorConfig {
  enabled: boolean;
  /** Model of the housekeeping chat; `haiku` by default, because it reads a few lines and writes two */
  model: string;
  /** Send the proposal to the worker on its own instead of waiting for a person */
  autoSend: boolean;
  /** Passed to the housekeeping chat as `--max-budget-usd` */
  maxCostUsd: number;
}

/** Replaces the whole document (`PUT /settings/supervisor`). */
export type UpdateSupervisorConfigRequest = SupervisorConfig;

/** `sent`: it reached the worker, by hand or through `autoSend`. */
export type SupervisorProposalStatus = 'proposed' | 'sent' | 'dismissed';

/** One answer of the supervisor. A row, because they accumulate; at most one per signal per chat. */
export interface SupervisorProposal {
  id: string;
  chatId: string;
  /** Set when the worker is a task of an orchestration */
  taskId?: string;
  orchestrationId?: string;
  /** The signal that woke it */
  signal: HealthSignalKind;
  /** One or two lines for the worker, ready to send or to edit first */
  hint: string;
  /** What the housekeeping chat cost, as the CLI reported it; added to the graph's when the worker is a task */
  costUsd: number;
  at: string;
  status: SupervisorProposalStatus;
}

// ---------- Web Push ----------

/**
 * What a browser needs before it can subscribe. The private half of the keypair never leaves the
 * server, so this is the whole of what a client may know about it.
 */
export interface PushKeyInfo {
  /** False when the server could not make itself a keypair; no route will send while it is false */
  configured: boolean;
  /** URL-safe base64 VAPID public key, or null when there is none */
  publicKey: string | null;
}

/** The two keys a browser's `PushSubscription` carries, used to encrypt the payload (RFC 8291). */
export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

/**
 * `POST /push/subscriptions`: the browser's `PushSubscription` JSON plus what this install wants.
 * Sent again whenever the browser rotates the subscription, and an endpoint that is already
 * registered is refreshed rather than duplicated.
 */
export interface RegisterPushSubscriptionRequest {
  endpoint: string;
  keys: PushSubscriptionKeys;
  /** Kinds worth waking this install for; every kind when omitted */
  kinds?: NotificationKind[];
  /** How much this install may be interrupted; `important` when omitted */
  level?: NotificationLevel;
  /** What the Settings list calls this install, e.g. "Pixel 8 · Chrome". Derived from the user agent */
  label?: string;
}

/**
 * One registered install. The endpoint is truncated: a full push endpoint URL is a capability to
 * notify that install, and a list route is not the place to hand it out. `id` is derived from the
 * endpoint, so the browser that registered recognises itself by the id its own registration returned.
 */
export interface PushSubscriptionSummary {
  id: string;
  /** Origin of the push service and an elided tail — enough to tell two installs apart */
  endpoint: string;
  label: string;
  kinds: NotificationKind[];
  level: NotificationLevel;
  createdAt: string;
  /** Last time this install registered or refreshed */
  lastSeenAt: string;
}

/** `DELETE /push/subscriptions`: the endpoint a browser is unsubscribing, or the id of a row in the list. */
export interface RemovePushSubscriptionRequest {
  endpoint?: string;
  id?: string;
}

/** `POST /push/test`: one install by endpoint or id, or every registered install when both are omitted. */
export interface SendTestPushRequest {
  endpoint?: string;
  id?: string;
}

/** What a send attempt did, so the UI can say more than "sent". */
export interface PushSendResult {
  /** Installs the push service accepted the notification for */
  sent: number;
  /** Installs whose endpoint was gone (404/410) and whose row was deleted */
  removed: number;
  /** Installs the push service refused for any other reason; the row is kept */
  failed: number;
  /**
   * What the push service said about the first install it refused, when it said anything: the
   * status and body of the refusal, so a person reading "it failed" can tell a misconfigured VAPID
   * subject from a phone that is simply offline.
   */
  reason?: string;
}

/**
 * What travels in a push payload, and deliberately no more: it passes through a push service we do
 * not run, so it holds only what a lock screen shows anyway — no prompt text, no tool arguments,
 * no secrets. It is the small, non-private part of a `NotificationDraft`.
 */
export interface PushPayload {
  kind: NotificationKind;
  /** The dedupe key, shown as the notification `tag` so a chat replaces its own notification */
  key: string;
  title: string;
  body: string;
  /** Path to open, e.g. `/chats/<id>?prompt=<id>`; null when there is nothing but the app to open */
  href: string | null;
  /**
   * The same place as `href`, as an absolute URL on the tunnel's tailnet address at the moment the
   * push was sent; null while no tunnel is active. An install made on a tunnel address that has
   * since moved (another node name or port) still receives its pushes, so its worker opens this
   * instead of its own dead origin (docs/plans/tunnel.md, "Answer: notifications after a domain
   * change")
   */
  url: string | null;
  at: string;
  priority: NotificationPriority;
  runId: string | null;
  orchestrationId: string | null;
}

// ---- Live events (GET /api/events) ----

/** Why a run is waiting for a person: a tool call to approve, a question to answer, a plan to approve. */
export type RunWaitingReason = 'permission' | 'question' | 'plan';

/** Fields every event on the feed carries. */
export interface AgentryEventBase {
  /** Monotonic per server process; what `Last-Event-ID` resumes from */
  id: number;
  at: string;
  /** One line a notification can show as it is */
  title: string;
}

/** What a run-scoped event says about the run it belongs to. */
export interface RunEventRef {
  runId: string;
  runName: string;
  /** Null until the CLI reports the session id */
  sessionId: string | null;
  /** Set for a worker of an orchestration */
  orchestrationId: string | null;
  /** Housekeeping runs (planner, auth check) that consumers usually leave out of notifications */
  internal: boolean;
}

export type RunEndStatus = 'completed' | 'failed' | 'stopped';

/** Where an event about work delegated inside a run belongs. `runId` is empty for a terminal session. */
export interface ActivityEventRef {
  runId: string;
  runName: string;
  sessionId: string | null;
}

export interface RunCreatedEvent extends AgentryEventBase, RunEventRef {
  type: 'run.created';
  status: RunStatus;
}

/**
 * The run's status, turns, cost, last text, or pending prompts changed. A status change is sent as
 * it happens (`previousStatus` says from what: busy → idle is a finished turn); other changes are
 * coalesced to one event every ~250 ms per run.
 */
export interface RunUpdatedEvent extends AgentryEventBase, RunEventRef {
  type: 'run.updated';
  status: RunStatus;
  previousStatus: RunStatus | null;
  turns: number;
  costUsd: number;
  pendingPrompts: number;
}

/** The process ended for good (until a message resumes it). */
export interface RunEndedEvent extends AgentryEventBase, RunEventRef {
  type: 'run.ended';
  status: RunEndStatus;
  error: string | null;
  turns: number;
  costUsd: number;
}

export interface RunRemovedEvent extends AgentryEventBase {
  type: 'run.removed';
  runId: string;
}

/** The run cannot go on until a person answers; `permissionId` is the request to answer. */
export interface RunWaitingEvent extends AgentryEventBase, RunEventRef {
  type: 'run.waiting';
  reason: RunWaitingReason;
  permissionId: string;
  toolName: string;
}

export interface PermissionRequestedEvent extends AgentryEventBase, RunEventRef {
  type: 'permission.requested';
  permissionId: string;
  toolName: string;
  reason: RunWaitingReason;
  description: string | null;
}

export interface PermissionResolvedEvent extends AgentryEventBase, RunEventRef {
  type: 'permission.resolved';
  permissionId: string;
  toolName: string;
  /** `withdrawn` when the CLI took the question back; a timeout resolves as `deny` */
  outcome: 'allow' | 'deny' | 'withdrawn';
}

/** A turn died against the account's rate limit. */
export interface RunRateLimitedEvent extends AgentryEventBase, RunEventRef {
  type: 'run.rateLimited';
  /** The provider that hit its limit; absent on an event from before limits were per provider */
  provider?: ProviderId;
  /** ISO time the limit resets; null or absent when unknown */
  resetsAt?: string | null;
}

/** Work went on in a new chat on another provider after a limit. */
export interface RunProviderMovedEvent extends AgentryEventBase, RunEventRef {
  type: 'run.providerMoved';
  from: ProviderId;
  to: ProviderId;
  action: 'handoff' | 'restart';
  decidedBy: ProviderMoveDecider;
}

/** Work stopped to wait for its provider's limit to reset. */
export interface RunLimitWaitingEvent extends AgentryEventBase, RunEventRef {
  type: 'run.limitWaiting';
  provider: ProviderId;
  resetsAt: string | null;
}

export interface TaskStartedEvent extends AgentryEventBase, ActivityEventRef {
  type: 'task.started';
  taskId: string;
  taskType: string;
  description: string;
  toolUseId: string | null;
  /** Launched by a subagent rather than the main agent, when the CLI said so */
  fromSubagent: boolean;
}

export interface TaskEndedEvent extends AgentryEventBase, ActivityEventRef {
  type: 'task.ended';
  taskId: string;
  taskType: string;
  description: string;
  /** As the CLI reports it: `completed`, `failed`, `killed`, `stopped`… */
  status: string;
  summary: string | null;
  fromSubagent: boolean;
}

export interface SubagentStartedEvent extends AgentryEventBase, ActivityEventRef {
  type: 'subagent.started';
  toolUseId: string;
  /** The CLI's id for the agent; may only arrive with `subagent.updated` */
  agentId: string | null;
  subagentType: string;
  description: string;
  background: boolean;
}

/** The agent got its CLI id (which names its transcript) or was sent to the background. */
export interface SubagentUpdatedEvent extends AgentryEventBase, ActivityEventRef {
  type: 'subagent.updated';
  toolUseId: string;
  agentId: string | null;
  subagentType: string;
  background: boolean;
}

export interface SubagentEndedEvent extends AgentryEventBase, ActivityEventRef {
  type: 'subagent.ended';
  toolUseId: string;
  agentId: string | null;
  subagentType: string;
  description: string;
  status: 'completed' | 'failed' | 'stopped';
}

/** A workflow's phases, agents or token count moved while it runs. */
export interface WorkflowProgressEvent extends AgentryEventBase, ActivityEventRef {
  type: 'workflow.progress';
  /** The CLI's workflow run id (`wf_…`) when known, the task id otherwise */
  workflowId: string;
  taskId: string | null;
  name: string | null;
  agentsRunning: number;
  agentsDone: number;
  agentsTotal: number;
  totalTokens: number | null;
}

export interface WorkflowEndedEvent extends AgentryEventBase, ActivityEventRef {
  type: 'workflow.ended';
  workflowId: string;
  taskId: string | null;
  /**
   * The agent that ended it, so a link can open that agent instead of the whole workflow: the one
   * that failed when the workflow failed, otherwise the last one to report back. Null when no
   * agent has a transcript of its own.
   */
  agentId: string | null;
  name: string | null;
  status: 'completed' | 'failed' | 'stopped';
  summary: string | null;
  totalTokens: number | null;
}

/** An orchestration was created, changed status, or its integration moved. */
export interface OrchestrationUpdatedEvent extends AgentryEventBase {
  type: 'orchestration.updated';
  orchestrationId: string;
  orchestrationName: string;
  status: OrchestrationStatus;
  previousStatus: OrchestrationStatus | null;
  integrationStatus: IntegrationStatus | null;
  /** Where the checks on the integration branch stand; set on the event that announces their change */
  verificationStatus?: VerificationStatus | null;
  costUsd: number;
}

export interface OrchestrationRemovedEvent extends AgentryEventBase {
  type: 'orchestration.removed';
  orchestrationId: string;
}

export interface OrchestrationTaskEvent extends AgentryEventBase {
  type: 'orchestration.task';
  orchestrationId: string;
  orchestrationName: string;
  taskId: string;
  taskName: string;
  status: OrchestrationTaskStatus;
  previousStatus: OrchestrationTaskStatus | null;
  runId: string | null;
  error: string | null;
}

/** Merging the tasks' branches conflicted; `paths` are what could not be merged. */
export interface OrchestrationConflictEvent extends AgentryEventBase {
  type: 'orchestration.conflict';
  orchestrationId: string;
  orchestrationName: string;
  integrationStatus: IntegrationStatus;
  branch: string;
  paths: string[];
  /** An integrator agent is resolving it; false when the person has to */
  resolving: boolean;
}

/**
 * A worker committed, or its uncommitted work moved: what `GET …/changes` answers is stale. Sent for
 * a running task and for the integration branch while it is built, at most once per few seconds each,
 * so a commit is one event and a burst of edits is not many.
 */
export interface ChangesUpdatedEvent extends AgentryEventBase {
  type: 'changes.updated';
  orchestrationId: string;
  orchestrationName: string;
  /** Null for the integration branch */
  taskId: string | null;
  branch: string;
  /** Commits on the branch that its base lacks */
  ahead: number;
  /** Files with changes that are in no commit */
  uncommitted: number;
}

/**
 * A chat or an orchestration task moved to another level of health, or its signals changed while it
 * stayed at one. Sent when a worker starts to look stuck and again when it recovers, never once per
 * check: the notification centre shows each of them as news.
 */
export interface HealthChangedEvent extends AgentryEventBase, RunEventRef {
  type: 'health.changed';
  /** Set for a worker of an orchestration */
  taskId: string | null;
  taskName: string | null;
  level: HealthLevel;
  previousLevel: HealthLevel;
  /** The first (worst) signal's line, or `Nothing unusual.` when the chat recovered */
  reason: string;
  /** Stable key of `reason` (`health.ok` when the chat recovered), as on {@link HealthSignal} */
  reasonCode?: string;
  /** The figures `reason` was built from */
  params?: LocalizedParams;
  signals: HealthSignalKind[];
}

/**
 * What a chat's live execution is doing right now changed: a tool call started or was answered, a
 * text or thinking block began streaming, or a permission prompt blocked it. Sent at most once per
 * chat per second, and carrying the whole {@link ChatActivity}, so a list patches the line it shows
 * instead of reading every chat again. `activity` is null when the chat stopped doing anything
 * nameable: its turn ended, or its process is gone.
 */
export interface ChatActivityEvent extends AgentryEventBase, RunEventRef {
  type: 'chat.activity';
  /** Set for a worker of an orchestration, so its board patches the task too */
  taskId: string | null;
  activity: ChatActivity | null;
}

/** Files under the CLI's projects directory changed: a session was created, grew or ended. */
export interface SessionsChangedEvent extends AgentryEventBase {
  type: 'sessions.changed';
}

/**
 * An agent provider, by the id its manifest declares (`claude-code`, `codex`, …). A string and not
 * a closed union, so adding a provider is adding a folder in core and never a change here.
 */
export type ProviderId = string;

/** How Agentry talks to a provider's CLI: each one needs its own driver to read events and send input. */
export type ProviderTransport = 'stream-json' | 'json-rpc' | 'acp';

/**
 * What a provider's driver can do. Declared by its manifest and confirmed by the handshake for the
 * installed version, so a feature asks for a capability and the UI hides or explains what is
 * missing instead of failing.
 */
export type ProviderCapability =
  | 'interactivePermissions'
  | 'structuredOutput'
  | 'resume'
  | 'fork'
  | 'interrupt'
  | 'setModel'
  | 'subagents'
  | 'mcp'
  | 'worktreeFlag'
  | 'budgetLimit'
  | 'effort'
  | 'costReport'
  | 'rateLimitWindows'
  | 'transcriptFiles'
  | 'workflowTool';

/**
 * Where a provider stands on this host. Detection returns one of these, never a raw error, so the
 * UI can offer the one remedy that fits:
 * - `ready`: installed, compatible version, signed in, handshake passed.
 * - `degraded`: works, with a warning (version outside the tested range, a limit near).
 * - `signed-out`: installed and compatible, no credentials.
 * - `incompatible`: installed, but too old or too new for the driver.
 * - `used-before`: its config home exists but the binary was not found.
 * - `not-installed`: no trace of it.
 * - `unknown`: the check could not run (timeout, permissions).
 */
export type ProviderReadinessState =
  | 'ready'
  | 'degraded'
  | 'signed-out'
  | 'incompatible'
  | 'used-before'
  | 'not-installed'
  | 'unknown';

/**
 * Why a provider is not `ready`, in one taxonomy for every provider. The UI words each code itself,
 * so a state never shows the text of an exception.
 */
export type ProviderReasonCode =
  | 'missing-credentials'
  | 'stale-token'
  | 'version-below-range'
  | 'version-above-range'
  | 'version-unreadable'
  | 'probe-timeout'
  | 'spawn-denied'
  | 'spawn-failed'
  | 'binary-not-found'
  | 'config-home-only'
  | 'missing-required-command'
  | 'unsupported-platform'
  | 'handshake-failed'
  | 'capability-missing'
  | 'no-probe'
  | 'auth-required'
  | 'schema-untested'
  | 'busy'
  | 'disabled'
  /** The provider's usage limit is exhausted and has not reset yet */
  | 'limit-reached'
  /** The provider's binding window is above 60 % */
  | 'limit-near';

/** The code hosts Agentry reaches through their own CLI. Closed: adding one is a code change. */
export type CodeHostId = 'github' | 'gitlab';

/** `degraded`: installed and signed in, but on a release the facts were not recorded on. */
export type CodeHostState = 'ready' | 'degraded' | 'signed-out' | 'incompatible' | 'not-installed' | 'unknown';

export type CodeHostReason = 'version-untested' | 'below-minimum' | 'no-hosts' | 'probe-failed' | 'timeout';

/** One host name a CLI knows, and who is signed in to it. */
export interface CodeHostHostEntry {
  hostname: string;
  /** The CLI's own default host (`github.com`, `gitlab.com`) */
  default: boolean;
  /** Null while the host has not been probed */
  signedIn: boolean | null;
  user: string | null;
}

/** One code host's CLI as detected on this machine, served from the detector's cache. */
export interface CodeHostStatus {
  id: CodeHostId;
  label: string;
  cli: string;
  /** The binary that was resolved: the override, or the first match on the PATH or an install directory */
  binaryPath: string | null;
  version: string | null;
  /** The oldest release Agentry works with */
  minimum: string;
  /** The releases the CLI facts were recorded on */
  recorded: string[];
  state: CodeHostState;
  /** Why the state is not `ready`; null when it is */
  reason: CodeHostReason | null;
  hosts: CodeHostHostEntry[];
  /** ISO timestamp of the detection this status came from */
  checkedAt: string;
}

/** What a person chose for one code host. */
export interface CodeHostSettingsEntry {
  enabled: boolean;
  /** Absolute path of the binary to use instead of searching for one; null searches */
  binaryPath: string | null;
}

/** `hosts.json` in the data directory. A disabled host's projects read `unsupported-host`. */
export interface CodeHostsSettings {
  hosts: Record<CodeHostId, CodeHostSettingsEntry>;
}

/** A project's remote as Agentry parsed it: never the URL, which can carry a user and a secret. */
export interface ProjectCodeHostRemote {
  hostname: string;
  path: string;
  protocol: 'https' | 'ssh' | 'git';
}

/** `GET /projects/:id/code-host`: the readiness and the parsed remote. */
export interface ProjectCodeHost {
  readiness: PullRequestReadiness;
  remote: ProjectCodeHostRemote | null;
}

/**
 * Why a call to a code host did not do what was asked: one taxonomy for every phase. The web words
 * each code; the host's first line travels beside it as the detail.
 */
export type HostReason =
  | 'cli-missing'
  | 'cli-incompatible'
  | 'cli-signed-out'
  | 'unsupported-host'
  | 'no-default-branch'
  | 'timeout'
  | 'output-too-large'
  | 'unexpected-output'
  | 'auth-failed'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'slowed-down'
  | 'server-error'
  | 'unreachable'
  | 'busy'
  | 'write-unconfirmed'
  | 'already-open'
  | 'create-failed'
  | 'nothing-to-propose'
  | 'log-unavailable'
  | 'rerun-refused'
  | 'check-not-rerunnable'
  | 'nothing-to-fix'
  | 'fix-in-progress'
  | 'fix-attempts-spent'
  | 'own-change-request'
  | 'pending-review-exists'
  | 'line-not-in-diff'
  | 'not-resolvable'
  | 'review-partly-posted'
  | 'head-moved'
  | 'method-not-allowed'
  | 'merge-failed'
  | 'auto-merge-not-allowed'
  | 'auto-merge-not-needed'
  | 'waiting-for-pipeline'
  | 'tracker-signed-out'
  | 'tracker-disabled'
  | 'transition-unknown'
  | 'issue-is-pull-request'
  | 'issue-scope-unknown'
  | 'closing-unchecked'
  | 'issue-closed-unlinked'
  | 'hook-no-permission'
  | 'hook-unreachable'
  | 'not-recorded';

/**
 * A code host's detected status changed: its CLI was installed, signed in, updated or removed, or
 * the settings turned it on or off. Sent only when a status actually differs.
 */
export interface HostsChangedEvent extends AgentryEventBase {
  type: 'hosts.changed';
  hosts: CodeHostStatus[];
}

// ---------- Issue trackers (code hosts, phase 5) ----------

/**
 * The issue trackers Agentry knows. Closed: adding one is a code change. `github-issues`,
 * `gitlab-issues` and `youtrack` have an adapter; `jira` is in the registry with the readiness
 * `unknown` and the reason `not-recorded` until `acli` is recorded.
 */
export type TrackerId = 'github-issues' | 'gitlab-issues' | 'jira' | 'youtrack';

/** Readiness of a tracker; `unknown` is a tracker nobody recorded the CLI of, or one not probed yet. */
export type TrackerState = 'ready' | 'signed-out' | 'incompatible' | 'not-installed' | 'unknown';

/**
 * Why a tracker is not `ready`: the code hosts' reasons, `not-recorded` for a CLI with no recording,
 * and for a tracker that keeps its own credentials (YouTrack): `no-credentials` (no address or token
 * saved), `token-rejected` (the instance refused the token) and `host-unreachable` (no answer from
 * the address).
 */
export type TrackerReason = CodeHostReason | 'not-recorded' | 'no-credentials' | 'token-rejected' | 'host-unreachable';

/** One tracker as detected on this machine, served from the detector's cache. */
export interface TrackerStatus {
  id: TrackerId;
  label: string;
  cli: string;
  /** The code host a tracker reuses the CLI and the sign-in of; null for `jira` and `youtrack`, which have CLIs of their own */
  host: CodeHostId | null;
  binaryPath: string | null;
  version: string | null;
  /** The oldest release Agentry works with; null while the CLI is not recorded */
  minimum: string | null;
  /** The releases the CLI facts were recorded on; empty while not recorded */
  recorded: string[];
  state: TrackerState;
  /** Why the state is not `ready`; null when it is */
  reason: TrackerReason | null;
  /** The account the tracker's own credentials sign in as (YouTrack); absent for the host trackers */
  user?: string | null;
  /** ISO timestamp of the detection this status came from */
  checkedAt: string;
}

/** `GET /trackers/youtrack/credentials`: what is saved, never the token itself. */
export interface YoutrackCredentialsStatus {
  /** The instance's address, as `youtrack-app` is given it; null when nothing is saved */
  host: string | null;
  tokenSet: boolean;
  /** Whether the token is sealed with the desktop app's key; false on a server, where the file is plain 0600 */
  encrypted: boolean;
}

/** `PUT /trackers/youtrack/credentials`: the token may be left out to keep the saved one. */
export interface PutYoutrackCredentialsRequest {
  host: string;
  token?: string;
}

/** What a person chose for one tracker. */
export interface TrackerSettingsEntry {
  enabled: boolean;
  /** Absolute path of the binary to use instead of searching for one; null searches */
  binaryPath: string | null;
}

/** `trackers.json` in the data directory. */
export interface TrackersSettings {
  trackers: Record<TrackerId, TrackerSettingsEntry>;
}

/** The columns a project can map to a tracker status; GitHub and GitLab only act on `done` (close, reason completed). */
export type TrackerMappedStatus = Extract<WorkItemStatus, 'in_progress' | 'in_review' | 'done'>;

/** A project's tracker, in its settings document (`ProjectSettings.tracker`). */
export interface ProjectTrackerSettings {
  id: TrackerId;
  /** The repository for GitHub and GitLab, a Jira project key, a YouTrack project short name */
  scope: string;
  /** The tracker's own query the import starts from; empty reads as the open issues of the scope */
  query: string;
  /** Which tracker status each mapped column moves an issue to; a missing column is not synced */
  statusMap: Partial<Record<TrackerMappedStatus, string>>;
}

/** What `issue.triage` says about an issue: whether an agent can start on it as written. */
export type IssueTriageMark = 'ready' | 'needs-refining' | 'not-for-agents';

/** Where the last write to the tracker for an issue stands: `none` is nothing synced yet. */
export type IssueSyncState = 'none' | 'synced' | 'failed';

/** An issue linked to a work item (a `work_item_issues` row). */
export interface IssueRef {
  tracker: TrackerId;
  /** What the person reads: `12` on GitHub and GitLab, `PROJ-12` on Jira and YouTrack */
  key: string;
  /**
   * The tracker scope (the repository, for GitHub and GitLab) the issue was imported from. Every
   * call and every closing word about this issue uses it, whatever the project's scope is now; null
   * when it was never recorded, and Agentry then writes nothing to the issue.
   */
  scope: string | null;
  /** The tracker's own id, when it differs from the key */
  externalId: string | null;
  title: string;
  /** The state the tracker last reported, in the tracker's words */
  state: string;
  url: string | null;
  importedAt: string;
  syncedAt: string | null;
  syncState: IssueSyncState;
  /** Why the last sync failed; null unless `syncState` is `failed` */
  syncReason: HostReason | null;
}

/** One issue as a tracker lists it, before it is imported. The body is untrusted text. */
export interface TrackerIssue {
  tracker: TrackerId;
  key: string;
  externalId: string | null;
  title: string;
  body: string;
  state: string;
  labels: string[];
  /** The work item type the labels or the issue type map to, when they do */
  type: WorkItemType | null;
  url: string | null;
  updatedAt: string | null;
  /** The work item it was already imported as in this project; null when not imported */
  importedItemId: string | null;
  /** `issue.triage`'s mark; null when the point is off or has not answered */
  triage: IssueTriageMark | null;
}

/** `GET /projects/:id/tracker/issues`: one page of the tracker's own query. */
export interface TrackerIssuesPage {
  issues: TrackerIssue[];
  page: number;
  hasMore: boolean;
}

/** `POST /projects/:id/tracker/import` */
export interface TrackerImportRequest {
  keys: string[];
}

/** `POST /work-items/:itemId/issues`: links an issue of the project's tracker to an item, by its key. */
export interface LinkWorkItemIssueRequest {
  key: string;
}

export interface TrackerImportedIssue {
  key: string;
  itemId: string;
  itemKey: string;
}

export interface TrackerImportSkipped {
  key: string;
  reason: 'already-imported' | HostReason;
}

export interface TrackerImportResult {
  imported: TrackerImportedIssue[];
  skipped: TrackerImportSkipped[];
}

/** Where an orchestration's change request stands; the flow's `conflict` and `awaiting-verify` do not apply. */
export type OrchestrationPullRequestPhase = 'preparing' | 'open' | 'merged' | 'closed' | 'failed';

/** The change request opened for an orchestration's integration branch. */
export interface OrchestrationPullRequest {
  /** The row id the `/change-requests/:id/…` routes take; the server always sends it */
  id?: string;
  phase: OrchestrationPullRequestPhase;
  host: CodeHostId;
  /** How the host writes the number: `#12` or `!12`; null without a number */
  ref: string | null;
  number: number | null;
  url: string | null;
  branch: string;
  base: string;
  ci: WorkItemPullRequestCi | null;
  /** Why the last attempt failed: a step or reason code, and the first line of the host's error */
  error: { code: string; detail: string } | null;
  openedAt: string | null;
  closedAt: string | null;
  checkedAt: string | null;
  /** An orchestration has no QA stage: its fix goes `fixing`, then `awaiting-push` for the person */
  fixState?: ChangeRequestFixState | null;
  fixOrigin?: ChangeRequestFixOrigin | null;
  /** Absent or null reads as `checks` */
  fixKind?: ChangeRequestFixKind | null;
  fixAttempts?: number;
  fixHead?: string | null;
}

/** An orchestration's change request was opened, or moved to another phase or CI state. */
export interface OrchestrationPullRequestEvent extends AgentryEventBase {
  type: 'orchestration.pull-request';
  orchestrationId: string;
  pullRequest: OrchestrationPullRequest;
}

/** The answer of `POST /orchestrations/:id/pull-request`; the first three fields are what it always had. */
export interface OrchestrationPullRequestAnswer {
  branch: string;
  url: string | null;
  detail: string;
  pullRequest: OrchestrationPullRequest | null;
}

// ---------- Change requests and their checks (code hosts, phase 2) ----------

/** Whose change request it is: a work item's or an orchestration's. */
export type ChangeRequestKind = 'work-item' | 'orchestration';

/**
 * The neutral change request of `GET /change-requests/:id`; `id` is the row id of either table
 * (UUIDs, unique across both). `ref` is how the host writes the number: `#12` or `!12`.
 */
export interface ChangeRequest {
  id: string;
  kind: ChangeRequestKind;
  /** The work item's id or the orchestration's id */
  ownerId: string;
  host: CodeHostId;
  phase: WorkItemPullRequestPhase;
  number: number | null;
  ref: string | null;
  url: string | null;
  branch: string;
  base: string;
  /** The checks' rollup as the watcher last read it */
  ci: WorkItemPullRequestCi | null;
  error: { code: string; detail: string } | null;
  openedAt: string | null;
  closedAt: string | null;
  checkedAt: string | null;
  /** When it was read and when it is read next; absent where the server has no schedule for it */
  freshness?: ChangeRequestFreshness | null;
  fixState: ChangeRequestFixState | null;
  fixOrigin: ChangeRequestFixOrigin | null;
  /** Absent or null reads as `checks` */
  fixKind?: ChangeRequestFixKind | null;
  fixAttempts: number;
  fixHead: string | null;
}

/** One check's state. `neutral` is a finished check that neither passed nor failed (a notice). */
export type CheckState = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped' | 'manual' | 'neutral';

/**
 * Where a check comes from: `actions` a GitHub Actions job, `app` another app's check run, `status` a
 * commit status, `job` a GitLab job, `bridge` a GitLab job that triggers a child pipeline.
 */
export type CheckSource = 'actions' | 'app' | 'status' | 'job' | 'bridge';

/** One check of a change request's head commit. */
export interface Check {
  /** The host's job or check-run id, as text so a 64-bit id never loses precision */
  id: string;
  name: string;
  /** The workflow (GitHub) or stage (GitLab); null when the host names none */
  group: string | null;
  state: CheckState;
  /** A failed job that the pipeline lets fail: shown as a warning, never as a failure */
  allowedToFail: boolean;
  /** A rule of the base branch needs it to pass before a merge */
  required: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** Its page on the host */
  url: string | null;
  /** Agentry can ask the host to run it again: false for a commit status, another app's check or a bridge */
  rerunnable: boolean;
  /** A log can be read: false for a bridge, a commit status and another app's check */
  hasLog: boolean;
  source: CheckSource;
}

/** The checks of a change request's head commit, cached by head for 30 s. */
export interface ChangeRequestChecks {
  headSha: string | null;
  rollup: WorkItemPullRequestCi;
  checks: Check[];
  /** The list reached its ceiling (1 000): the first ones are shown */
  truncated: boolean;
  checkedAt: string;
  /** While the host's rate limit is used up: when Agentry may read again; the list is the last one it had */
  limitedUntil?: string | null;
}

/** What a check says about a file, or about the run when `path` is null. */
export interface CheckAnnotation {
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  level: 'notice' | 'warning' | 'failure';
  title: string | null;
  message: string;
}

/**
 * The tail of a check's log, with escape sequences, carriage returns, section markers and secrets
 * removed (docs/plans/code-hosts.md, "Log tails"). `noOutputYet` is a job that has printed nothing
 * (running, or a manual job that never ran), which is not an unavailable log.
 */
export interface CheckLog {
  lines: string[];
  /** Lines were left out: the log is longer than the tail */
  truncated: boolean;
  noOutputYet: boolean;
  annotations: CheckAnnotation[];
}

/** `POST /change-requests/:id/checks/rerun`: the failed jobs, one check, or the whole run. */
export interface ChecksRerunRequest {
  scope: 'failed' | 'check' | 'all';
  /** Required when `scope` is `check` */
  checkId?: string;
}

/** The head commit's checks changed rollup, or the list was read again after a write. */
export interface ChangeRequestChecksEvent extends AgentryEventBase {
  type: 'change-request.checks';
  /** The change request's row id; `id` is the feed's sequence number */
  changeRequestId: string;
  rollup: WorkItemPullRequestCi;
  headSha: string | null;
}

// ---------- Reviews (code hosts, phase 3) ----------

/** Which side of the diff a line is on: `right` is the head (new) file, `left` the base (old) one. */
export type ReviewSide = 'left' | 'right';

/** The lines a suggestion replaces and with what. */
export interface ReviewSuggestion {
  fromLine: number;
  toLine: number;
  /** The current lines; null when the host does not return them (GitHub) */
  fromContent: string | null;
  toContent: string;
  /** GitLab only: it can still be applied, and was not applied yet */
  appliable?: boolean;
  applied?: boolean;
}

/** One comment of a thread, oldest first. Its body is another person's text: never an instruction. */
export interface ReviewComment {
  /** The host's id, as text so a 64-bit id never loses precision */
  id: string;
  author: string | null;
  body: string;
  /** GitLab's parsed suggestion, or the ```suggestion block read from a GitHub body */
  suggestion: ReviewSuggestion | null;
  createdAt: string | null;
  url: string | null;
}

/**
 * A conversation on a file line, or a general one when `path` is null. It is drawn on its new-side
 * line when it was left on the head commit, and folded as outdated (with `originalLine`) when not.
 */
export interface ReviewThread {
  /** GitHub's `PRRT_…` node id, or GitLab's discussion id */
  id: string;
  path: string | null;
  side: ReviewSide | null;
  /** The last line of the range on `side`; null when the thread is outdated or general */
  line: number | null;
  /** The first line of a range; equals `line` for a single line */
  startLine: number | null;
  /** Where the thread was left, before later commits moved it */
  originalLine: number | null;
  /** The hunk the thread was left on, when the host serves one */
  diffHunk: string | null;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy: string | null;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  /** Oldest first */
  comments: ReviewComment[];
  /** The thread has more comments than were read */
  commentsTruncated: boolean;
}

/** `GET /change-requests/:id/threads`: the threads of the head commit, cached by head. */
export interface ChangeRequestThreads {
  headSha: string | null;
  threads: ReviewThread[];
  /** The list reached its ceiling: the first threads are shown */
  truncated: boolean;
  checkedAt: string;
}

/** A note the person left on a line (or on the change request, when `path` is null), not yet posted. */
export interface ReviewDraft {
  id: string;
  changeRequestId: string;
  path: string | null;
  side: ReviewSide | null;
  line: number | null;
  /** The first line of a range; null for a single line */
  startLine: number | null;
  body: string;
  /** `body` holds the replacement lines of a suggestion block */
  suggestion: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `POST` and `PUT /change-requests/:id/review-drafts`. */
export interface ReviewDraftInput {
  path?: string | null;
  side?: ReviewSide | null;
  line?: number | null;
  startLine?: number | null;
  body: string;
  suggestion?: boolean;
}

/** A comment (both hosts) or an approval (GitLab only); request changes is read, never offered. */
export type ReviewEvent = 'comment' | 'approve' | 'request-changes';

/** `POST /change-requests/:id/reviews`: posts the drafts as one review. */
export interface ReviewSubmitRequest {
  event: ReviewEvent;
  /** The review's own text; may be empty when there are drafts */
  body: string;
  /**
   * The head commit the person looked at. The review is posted on it and an approval is given on
   * it; a head that moved is refused with `head-moved` and nothing is posted. Without it the head
   * the host answers at that moment is taken.
   */
  headSha?: string;
}

/**
 * `posting`: the write is under way; `posted`: confirmed; `partly`: a GitLab note failed after
 * others were saved as drafts; `failed`: nothing reached the host.
 */
export type ReviewPostState = 'posting' | 'posted' | 'partly' | 'failed';

/** One attempt to post a review. Its body carries `marker`, which a recovery looks for after a timeout. */
export interface ReviewPost {
  id: string;
  changeRequestId: string;
  marker: string;
  event: ReviewEvent;
  state: ReviewPostState;
  /** The host's review id (GitHub); null on GitLab, which has no review object */
  remoteId: string | null;
  /**
   * Why it is not `posted`: a reason code and the host's first line; `saved` of `total` for `partly`,
   * with the ids of the draft notes Agentry saved (GitLab), the only ones a discard deletes
   */
  detail: { code: HostReason; detail: string; saved?: number; total?: number; draftIds?: string[] } | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET /change-requests/:id/review-posts`: the attempts to post a review, newest first, so a post
 * that stopped partway is known after a reload.
 */
export interface ChangeRequestReviewPosts {
  posts: ReviewPost[];
  /**
   * For each `partly` post, how many of the draft notes Agentry saved are still waiting on the host
   * (GitLab); empty when no post is partly posted, null when the host could not be read
   */
  savedOnHost: Record<string, number> | null;
}

export type ReviewerState = 'requested' | 'approved' | 'changes-requested' | 'commented';

export interface ChangeRequestReviewer {
  login: string;
  state: ReviewerState;
}

/** Where the review stands, re-read after every write. */
export interface ChangeRequestReviewers {
  /** The host's decision in Agentry's words; null when no rule asks for one */
  decision: 'approved' | 'changes-requested' | 'review-required' | null;
  reviewers: ChangeRequestReviewer[];
  unresolvedThreads: number;
}

/** `POST /change-requests/:id/reviewers`. Agentry adds and removes; it never replaces the list. */
export interface ReviewersRequest {
  add: string[];
  remove?: string[];
}

/**
 * Whether the viewer approved. `canApprove` is Agentry's rule, never the host's `user_can_approve`
 * (false for an author whose approval succeeds, recorded); it is false on GitHub, where Agentry
 * does not approve.
 */
export interface ApprovalState {
  approved: boolean;
  approvalsRequired: number | null;
  approvalsLeft: number | null;
  viewerHasApproved: boolean;
  canApprove: boolean;
  /** Revoke exists on GitLab only */
  canRevoke: boolean;
  approvedBy: string[];
  /** The head an approval is given on; a head that moved answers `head-moved` */
  headSha: string | null;
}

/** `POST /change-requests/:id/approval`: the head the person looked at. */
export interface ApprovalRequest {
  sha: string;
}

/** `POST /change-requests/:id/threads/:threadId/reply`. */
export interface ReviewReplyRequest {
  body: string;
}

/** `POST /change-requests/:id/address`: the threads handed to an agent. */
export interface AddressReviewRequest {
  threadIds: string[];
}

/** The threads or the review decision of a change request changed. */
export interface ChangeRequestReviewEvent extends AgentryEventBase {
  type: 'change-request.review';
  /** The change request's row id; `id` is the feed's sequence number */
  changeRequestId: string;
  unresolvedThreads: number;
  decision: ChangeRequestReviewers['decision'];
}

// ---------- Merging (code hosts, phase 4) ----------

/** Agentry turned a change request's auto-merge off before a push of its own: the person arms it again afterwards. */
export interface ChangeRequestAutoMergeOffEvent extends AgentryEventBase {
  type: 'change-request.auto-merge-off';
  /** The change request's row id; `id` is the feed's sequence number */
  changeRequestId: string;
  why: AutoMergeOffWhy;
}

/** How a change request is merged. The host's own words differ (`rebase_merge`, `ff`); this is Agentry's. */
export type MergeMethod = 'squash' | 'merge' | 'rebase';

/**
 * Why a merge is not offered, in the order docs/plans/code-hosts.md lists them: the first that
 * applies is the state's `blocker`, the rest are `others`. A value the host sends that no row knows
 * is `blocked-by-policy`.
 */
export type MergeBlockerCode =
  | 'not-open'
  | 'computing'
  | 'draft'
  | 'conflicts'
  | 'nothing-to-merge'
  | 'behind'
  | 'checks-running'
  | 'checks-failing'
  | 'checks-missing'
  | 'external-checks'
  | 'review-required'
  | 'changes-requested'
  | 'threads-unresolved'
  | 'tracker-key-missing'
  | 'title-rejected'
  | 'blocked-by-dependency'
  | 'not-yet'
  | 'locked-files'
  | 'merge-queue'
  | 'blocked-by-policy';

/**
 * The one thing the person can do about a blocker. Each is an Agentry action or a link, never a
 * command to copy: `update-from-base` is Agentry's own merge of the base into the branch,
 * `rebase-on-host` a host-side rebase (GitLab `ff` projects only).
 */
export type MergeBlockerAction =
  | 'mark-ready'
  | 'update-from-base'
  | 'rebase-on-host'
  | 'close'
  | 'auto-merge'
  | 'fix-checks'
  | 'rerun-checks'
  | 'request-reviewers'
  | 'address-review'
  | 'show-threads'
  | 'edit-title'
  | 'open-on-host'
  | 'refresh';

export interface MergeBlocker {
  code: MergeBlockerCode;
  /** The host's own words, or the name that makes the sentence exact (a check's name); null when there are none */
  detail: string | null;
  action: MergeBlockerAction | null;
}

/** Whether an auto-merge may be armed, and whether one is. */
export interface AutoMergeState {
  /**
   * Agentry may arm one now: the repository allows it (GitHub `allow_auto_merge`; GitLab always)
   * and something is left to wait for. When false, `reason` says why.
   */
  available: boolean;
  reason: Extract<HostReason, 'auto-merge-not-allowed' | 'auto-merge-not-needed' | 'waiting-for-pipeline'> | null;
  armed: boolean;
  /** The method it will merge with; null when it is not armed or the host does not say */
  method: MergeMethod | null;
  /** Who armed it and when, as the host says; null when it is not armed or the host does not say */
  armedBy: string | null;
  armedAt: string | null;
}

/** Why Agentry turned auto-merge off: before it pushed to the branch (a fix, an address, the first push), or to update it from its base */
export type AutoMergeOffWhy = 'push' | 'update';

/** The fact that Agentry turned auto-merge off, until the person arms it again */
export interface AutoMergeOff {
  /** Who: `agentry` for its own push, the person who clicked for Update from base */
  by: string;
  at: string;
  why: AutoMergeOffWhy;
  /** The push is still going on: arming is refused (`busy`) until it ends */
  pushing: boolean;
}

/** `GET /change-requests/:id/merge`: what the person may do about merging, read from the host. */
export interface MergeState {
  changeRequestId: string;
  host: CodeHostId;
  /** The head commit (full id) this state was read at; a merge carries it back as `expectedHead` */
  headSha: string | null;
  /** What the repository's settings and rules allow, in the order Agentry offers them; empty when none is allowed */
  methods: MergeMethod[];
  /** The method to preselect: the first of `methods`; null when there is none */
  defaultMethod: MergeMethod | null;
  /** The branch box's default: `delete_branch_on_merge` / `remove_source_branch_after_merge` */
  deleteBranchDefault: boolean;
  /** Merge now is possible: no blocker, and on GitLab the pipeline guard allows it */
  canMerge: boolean;
  /** The first blocker, or null */
  blocker: MergeBlocker | null;
  /** The blockers after the first, in order */
  others: MergeBlocker[];
  /** `UNSTABLE` on GitHub: a check that is not required failed; Merge stays on */
  warning: 'optional-checks-failing' | null;
  autoMerge: AutoMergeState;
  /** Agentry turned auto-merge off for a push; null once the person arms it again (or turns it off themselves) */
  autoMergeOff: AutoMergeOff | null;
  /** GitLab: the head's pipeline has not appeared yet; Agentry re-reads every 10 s */
  waitingForPipeline: boolean;
  /** GitLab `ff` project: Rebase on GitLab is an option for `behind` */
  canRebaseOnHost: boolean;
  /** Rebase on GitLab would apply but is not offered: it would drop what is only in the checkout (uncommitted changes, or commits never pushed) */
  rebaseOnHostWhy: 'uncommitted-changes' | 'unpushed-commits' | null;
  readAt: string;
  /** While the host's rate limit is used up: when Agentry may read again; the state is the last one it had */
  limitedUntil?: string | null;
}

/** `POST /change-requests/:id/merge`. The merge is the person's click: a chat token gets 403. */
export interface MergeRequestBody {
  method: MergeMethod;
  /** The full id of the head the person looked at; a head that moved is `head-moved` and nothing is merged */
  expectedHead: string;
  deleteBranch: boolean;
  /** The commit's subject and body, for `squash` and `merge`; the host's own when absent */
  subject?: string;
  body?: string;
}

/** `POST /change-requests/:id/auto-merge`. */
export interface AutoMergeRequestBody {
  method: MergeMethod;
  expectedHead: string;
}

/** What `POST /change-requests/:id/merge` answers once the host merged. */
export interface MergeResult {
  state: MergeState;
  merged: true;
  /** Whether the source branch is gone from the host; null when nobody asked or the host did not say */
  branchDeleted: boolean | null;
}

/** What `POST /change-requests/:id/update-branch` answers when the branch was updated. */
export interface UpdateBranchResult {
  state: MergeState;
  /** Empty: a conflicting update is a 409 that names the paths */
  conflicts: string[];
  /** Agentry's own merge of the base into the branch, or a host-side rebase */
  via: 'merge' | 'rebase';
}

/** `POST /change-requests/:id/ready`: mark ready for review, or back to a draft. */
export interface MergeReadyRequest {
  ready: boolean;
}

export type ChangeRequestMergeAction = 'merge' | 'arm' | 'disarm';

/** What became of one merge click or arming. `requested` is written before the host is called. */
export type ChangeRequestMergeOutcome = 'requested' | 'merged' | 'armed' | 'disarmed' | 'failed';

/**
 * One row of the audit of merge clicks and armings (`change_request_merges`): who asked, with which
 * method and head, and what the host answered.
 */
export interface ChangeRequestMerge {
  id: string;
  changeRequestId: string;
  action: ChangeRequestMergeAction;
  /** Null for a disarm */
  method: MergeMethod | null;
  expectedHead: string | null;
  deleteBranch: boolean;
  requestedAt: string;
  /** The person who clicked; `agentry` for the disarm Agentry does before it pushes */
  requestedBy: string;
  outcome: ChangeRequestMergeOutcome;
  /** Why it failed: a reason code, and the host's first line */
  reason: HostReason | null;
  detail: string | null;
}

/** One provider's detected state on this host, as served from the detector's cache. */
export interface ProviderStatus {
  id: ProviderId;
  label: string;
  state: ProviderReadinessState;
  /** Why the state is not `ready`; null when it is */
  reason: ProviderReasonCode | null;
  /** The installed version as the CLI reports it; null when there is no binary or it was unreadable */
  version: string | null;
  /** The version range the driver is tested against (semver range), shown next to an incompatible version */
  compatibleRange: string;
  /** The binary that was resolved: the override, or the first match on the PATH or an install directory */
  binaryPath: string | null;
  /** The directory the provider keeps its state in, when it exists on this host */
  configHome: string | null;
  /** The signed-in account's label, when the provider can tell one */
  account: string | null;
  /** The capabilities the handshake confirmed for the installed version (the declared ones until then) */
  capabilities: ProviderCapability[];
  /** The permission modes the provider offers, in the order to list them; absent on a provider that has none */
  permissionModes?: PermissionMode[];
  /** What the first event of a real session confirmed for the installed version; null until one has */
  confirmed?: { at: string; version: string; capabilities: ProviderCapability[] } | null;
  /** The provider's usage limit as last read; null when nothing was read yet, absent on an old server */
  limit?: ProviderLimit | null;
  /** ISO timestamp of the detection this status came from */
  checkedAt: string;
}

/** What a person chose for one provider. */
export interface ProviderSettingsEntry {
  enabled: boolean;
  /** Absolute path of the binary to use instead of searching for one; null searches */
  binaryPath: string | null;
}

/**
 * `providers.json` in the data directory: which providers are on, in what order they are offered,
 * which one new work starts with, and where a binary lives when the search cannot find it.
 */
export interface ProvidersSettings {
  providers: Record<ProviderId, ProviderSettingsEntry>;
  /** Provider ids in the order the UI lists them */
  order: ProviderId[];
  /** The provider a new chat starts with; null takes the first ready one in `order` */
  defaultProvider: ProviderId | null;
  /** What happens at a usage limit, and the model mapping; absent on a file written before it, read as the defaults */
  rotation?: RotationSettings;
}

/** What work does when its provider reaches a usage limit. */
export type LimitAction = 'handoff' | 'restart' | 'wait';

export interface RotationSettings {
  onLimit: {
    /** What automated work does at a limit; a person's chat offers it first */
    action: LimitAction;
    /** What a decision point may choose among; always includes `action` */
    allowed: LimitAction[];
    /** How long a wait with no known reset lasts before the run fails, 1..48 */
    maxWaitHours: number;
    /** Moves per run before it waits, 0..5 */
    maxMoves: number;
  };
  /** Global only; never filled without a person */
  modelMap: ModelMapEntry[];
}

/** One model standing in for another across two providers. */
export interface ModelMapEntry {
  from: { provider: ProviderId; model: string };
  to: { provider: ProviderId; model: string };
  /** `decision`: a suggestion of the `provider.model-map` point that a person accepted */
  origin: 'person' | 'decision';
  at: string;
}

/** `unknown`: nothing was read, or the reset has passed since; never `ok` without a new reading. */
export type ProviderLimitState = 'ok' | 'near' | 'exhausted' | 'unknown';

/** One provider's usage limit, folded from what its driver reports. */
export interface ProviderLimit {
  provider: ProviderId;
  state: ProviderLimitState;
  /** The window that binds (`5h`, `7d`, `primary`), when the provider names windows */
  window: string | null;
  /** Use of that window, 0..1; null when the provider reports none */
  utilization: number | null;
  /** ISO time the binding window resets; null when unknown */
  resetsAt: string | null;
  windows: Record<string, RateLimitWindow>;
  /** When the reading was taken: the UI says how old it is */
  observedAt: string;
  /** `stream`: a live run reported it; `probe`: a read that spends nothing; `failure`: a turn died on it */
  source: 'stream' | 'probe' | 'failure';
}

export type ProviderMoveState = 'waiting' | 'resuming' | 'moved' | 'resumed' | 'failed' | 'cancelled';

/** Who chose a move: the person, the settings, or a decision point. */
export type ProviderMoveDecider = 'person' | 'setting' | 'decision';

export type ProviderMoveSubjectKind = 'chat' | 'flow_run' | 'task' | 'assistant_run';

/**
 * A row of `provider_moves`: a move to another provider, or a wait for a reset. History and the
 * wait queue in one.
 */
export interface ProviderMove {
  id: string;
  at: string;
  subjectKind: ProviderMoveSubjectKind;
  subjectId: string;
  projectId: string | null;
  fromChat: string;
  /** The new chat; null for a wait */
  toChat: string | null;
  fromProvider: ProviderId;
  toProvider: ProviderId | null;
  fromModel: string | null;
  toModel: string | null;
  action: LimitAction;
  state: ProviderMoveState;
  decidedBy: ProviderMoveDecider;
  /** The decision point's answer, when `decidedBy` is `decision` */
  decisionId: string | null;
  /** ISO time the wait ends; null when unknown or not a wait */
  resetsAt: string | null;
  reason: string | null;
  updatedAt: string;
}

/** Why a provider cannot take a run, as the candidates say it; the UI words each one. */
export type Exclusion =
  | 'disabled'
  | 'not-ready'
  | 'no-driver'
  | 'capability'
  | 'policy'
  | 'policy-not-portable'
  | 'no-mapping'
  | 'exhausted'
  | 'left-already'
  | 'not-in-order';

/** A provider that can take a run, or one that cannot and why. */
export type CandidateView =
  | { provider: ProviderId; model: string | null; utilization: number | null; resetsAt: string | null }
  | { provider: ProviderId; excluded: Exclusion };

/** `POST /chats/:id/move`: a person moves a chat that reached a limit. */
export interface MoveChatRequest {
  provider: ProviderId;
  action: 'handoff' | 'restart';
  /** A model of the target provider; absent takes the mapped one */
  model?: string;
}

/** `GET /providers/candidates`: who could take a chat at a limit, and why each of the others cannot. */
export interface ProviderCandidates {
  candidates: Array<Extract<CandidateView, { model: string | null }>>;
  excluded: Array<Extract<CandidateView, { excluded: Exclusion }>>;
  /** The work made every move it may: nothing is offered however many are ready */
  movesCapped: boolean;
}

/** An open `provider.model-map` suggestion: a counterpart the engine proposed that no person has answered yet. */
export interface ModelMapSuggestion {
  /** The decision's id: what `POST /providers/model-map/suggestions/:id` answers */
  id: string;
  from: { provider: ProviderId; model: string };
  to: { provider: ProviderId; model: string };
  at: string;
}

/** `POST /providers/model-map/suggest`: ask `provider.model-map` now for a counterpart of one model on one target. */
export interface SuggestModelMapRequest {
  from: { provider: ProviderId; model: string };
  /** The provider the counterpart would be on */
  target: ProviderId;
}

/** `POST /providers/model-map/suggestions/:id`: accepting writes the entry; dismissing only closes the suggestion. */
export interface AnswerModelMapSuggestionRequest {
  accept: boolean;
}

/** What claude-swap left behind, for the one-time notice. */
export interface CswapRetirement {
  found: Array<'accounts' | 'account-config' | 'managed-copy' | 'cswap-bin'>;
  /** Agentry's own copy of claude-swap is on disk: the one thing the notice offers to remove */
  managedCopy: boolean;
  /** Projects that had a rotation policy; their provider order is what applies now */
  policyProjects: string[];
}

/** `GET /providers/cswap-retirement`: `notice` is null when there is nothing to say or the person dismissed it. */
export interface CswapRetirementState {
  notice: CswapRetirement | null;
}

/** `GET /chats/:id/handoff`: the text as it would be sent, built locally and not sent. */
export interface HandoffPreview {
  text: string;
  bytes: number;
  provider: ProviderId;
  model: string | null;
  /** The headers of the sections the text contains */
  sections: string[];
}

/**
 * A provider's detected status changed: it was installed, signed in, updated or removed, or the
 * settings turned it on or off. Sent only when a status actually differs, so one listener keeps
 * every page in step without polling.
 */
export interface ProvidersChangedEvent extends AgentryEventBase {
  type: 'providers.changed';
  providers: ProviderStatus[];
}

/**
 * A release check found a newer Agentry than the last one it announced. Sent once per version, and
 * never a notification: a release is not worth waking a phone for.
 */
export interface SystemReleaseEvent extends AgentryEventBase {
  type: 'system.release';
  release: AgentryReleaseInfo;
}

/** `rescheduled`: nothing was edited, but `nextRunAt` was computed again (after a fire, or on boot). */
export type ScheduleChangeAction = 'created' | 'updated' | 'deleted' | 'enabled' | 'disabled' | 'rescheduled';

/** A schedule was created, edited, deleted, switched, or had its next fire recomputed: the list is stale. */
export interface ScheduleChangedEvent extends AgentryEventBase {
  type: 'schedule.changed';
  scheduleId: string;
  scheduleName: string;
  action: ScheduleChangeAction;
  /** As the schedule reports it after the change; null when it is disabled or deleted */
  nextRunAt: string | null;
}

/** A run row was written for a schedule: it started something, failed to, or recorded a slot it did not take. */
export interface ScheduleFiredEvent extends AgentryEventBase {
  type: 'schedule.fired';
  scheduleId: string;
  scheduleName: string;
  runId: string;
  status: ScheduleRunStatus;
  chatId: string | null;
  orchestrationId: string | null;
}

/** The supervisor answered a bad signal with a hint; the same `proposal` hangs on the chat's health. */
export interface SupervisorProposedEvent extends AgentryEventBase, RunEventRef {
  type: 'supervisor.proposed';
  /** Set for a worker of an orchestration */
  taskId: string | null;
  taskName: string | null;
  proposal: SupervisorProposal;
}

/** What every work item event names, so a client knows which item, board and list to refetch. */
export interface WorkItemEventRef {
  projectId: string;
  itemId: string;
  key: string;
}

export interface WorkItemCreatedEvent extends AgentryEventBase, WorkItemEventRef {
  type: 'workitem.created';
  itemType: WorkItemType;
  status: WorkItemStatus;
  /** Set when a chat created it, from one of its messages */
  source: WorkItemSource | null;
}

/** An item's fields, criteria, relations, links or comments changed; its column and place did not. */
export interface WorkItemUpdatedEvent extends AgentryEventBase, WorkItemEventRef {
  type: 'workitem.updated';
  changes: WorkItemChange[];
  actor: WorkItemActor;
  cause: WorkItemCause | null;
}

/** An item changed column or place: a person dragged it, or it moved on its own and `cause` says why. */
export interface WorkItemMovedEvent extends AgentryEventBase, WorkItemEventRef {
  type: 'workitem.moved';
  status: WorkItemStatus;
  /** Equal to `status` when only its place in the column changed */
  previousStatus: WorkItemStatus;
  /** The target column is over its limit after the move */
  overLimit: boolean;
  actor: WorkItemActor;
  cause: WorkItemCause | null;
}

export interface WorkItemRemovedEvent extends AgentryEventBase, WorkItemEventRef {
  type: 'workitem.removed';
}

export type MilestoneChangeAction = 'created' | 'updated' | 'closed' | 'reopened' | 'deleted';

/**
 * A milestone was created, edited, closed, reopened or deleted. Its progress moving because an item
 * did is not announced here: that item's own event already makes it stale.
 */
export interface MilestoneChangedEvent extends AgentryEventBase {
  type: 'milestone.changed';
  projectId: string;
  milestoneId: string;
  milestoneName: string;
  action: MilestoneChangeAction;
}

/**
 * A directory was imported as a project, or a new one created in the workspace. A directory imported
 * again after it was removed takes its old id back, and is announced as created all the same.
 */
export interface ProjectCreatedEvent extends AgentryEventBase {
  type: 'project.created';
  projectId: string;
  projectName: string;
}

/** A project was removed from Agentry. Its directory, settings and work items are left where they are. */
export interface ProjectRemovedEvent extends AgentryEventBase {
  type: 'project.removed';
  projectId: string;
  projectName: string;
}

/** What `project.updated` says changed; `settings` is anything else in the settings document. */
export type ProjectChange = 'name' | 'key' | 'modules' | 'settings';

/** A project was renamed, its key prefix or its modules changed, or its settings document was replaced. */
export interface ProjectUpdatedEvent extends AgentryEventBase {
  type: 'project.updated';
  projectId: string;
  projectName: string;
  changes: ProjectChange[];
  /** The modules on after the change */
  modules: ProjectModule[];
}

/**
 * `created` and `updated` are a member's metadata written through `PUT`, `template` the members a
 * template wrote, `removed` a member taken off the team (its agent file stays), and `file` an agent
 * file of a member written, deleted or found drifted: saved or deleted through the resources route
 * (`/config/resources/agents/:name?project=`), whose `agents` names the member, or rewritten by the
 * team service to follow the metadata.
 */
export type TeamChangeAction = 'created' | 'updated' | 'removed' | 'template' | 'file';

/** A project's team changed. */
export interface TeamChangedEvent extends AgentryEventBase {
  type: 'team.changed';
  projectId: string;
  action: TeamChangeAction;
  /** The members it touched, by agent file name */
  agents: string[];
}

export type JournalChangeAction = 'added' | 'removed';

/** An entry was added to a project's journal, or removed from it. */
export interface JournalChangedEvent extends AgentryEventBase {
  type: 'journal.changed';
  projectId: string;
  entryId: string;
  action: JournalChangeAction;
  kind: JournalEntryKind;
  itemId: string | null;
}

export type MemoryProposalAction = 'created' | 'approved' | 'rejected';

/**
 * A memory proposal was made, approved or rejected. An approval also wrote its target: the journal
 * announces its entry on its own, the CLI's memory and `CLAUDE.md` are read again from `target`.
 */
export interface MemoryProposalEvent extends AgentryEventBase {
  type: 'memory.proposal';
  projectId: string;
  proposalId: string;
  action: MemoryProposalAction;
  target: MemoryProposalTarget;
  /** The role that proposed it */
  role: string | null;
  itemId: string | null;
}

/** `written` and `removed` are the file; `tied` and `untied` a link between it and a work item. */
export type DocumentChangeAction = 'written' | 'removed' | 'tied' | 'untied';

/** A document of a project's documents folder changed, or was tied to or untied from an item. */
export interface DocumentChangedEvent extends AgentryEventBase {
  type: 'document.changed';
  projectId: string;
  /** Relative to the project */
  path: string;
  action: DocumentChangeAction;
  /** The item of a `tied` or `untied`; for a file written by a flow run, the item it was written for */
  itemId: string | null;
}

export type FlowRunAction = 'queued' | 'started' | 'ended' | 'moved' | 'waiting';

/**
 * A flow run was queued, started or ended, moved to another provider's chat at a usage limit, or
 * began waiting for the limit to reset. What it did to the item (a comment, a move, the waiting
 * state) comes as that item's own `workitem.*` events.
 */
export interface FlowRunEvent extends AgentryEventBase, WorkItemEventRef {
  type: 'flow.run';
  runId: string;
  action: FlowRunAction;
  role: string;
  agent: string;
  stage: FlowStage;
  step: FlowStep;
  /** Set once started */
  chatId: string | null;
  /** Set when ended */
  outcome: FlowRunOutcome | null;
  /** Set when it failed or was cancelled */
  cause: FlowRunCause | null;
  /** The failed run this one retries, when a person retried it */
  retryOf: string | null;
  /** `person` when a person queued it from the waiting cards; null otherwise */
  queuedBy: FlowRunQueuedBy | null;
  /** On `moved`: the provider the run goes on with; on `waiting`: the one whose limit it waits for */
  provider?: ProviderId;
  /** On `waiting`: when that limit resets, ISO; null when unknown */
  resetsAt?: string | null;
}

/**
 * `started` and `failed` as they say; `ended` a run that completed or was stopped (its `status`
 * says which); `read` a running one's {@link AssistantRun.sources}, cost or
 * {@link AssistantRunDetail.draft} changed, at most every few seconds, so "what it has read" and the
 * file "Create with AI" writes fill in without polling.
 */
export type AssistantRunAction = 'started' | 'read' | 'ended' | 'failed';

/** An assistant run started, read something, ended or failed. */
export interface AssistantRunEvent extends AgentryEventBase {
  type: 'assistant.run';
  projectId: string;
  runId: string;
  kind: AssistantRunKind;
  action: AssistantRunAction;
  status: AssistantRunStatus;
  /** Set once its chat started; null for a run with nothing to read */
  chatId: string | null;
  /** The run whose pending proposals this one superseded when it started, which reads again */
  supersedes: string | null;
}

export type AssistantProposalAction = 'accepted' | 'discarded' | 'restored';

/**
 * A proposal was accepted, discarded or restored. What an accept wrote announces itself too where
 * it has an event (`workitem.created`, `team.changed`); a saved resource has none, so this names it.
 */
export interface AssistantProposalEvent extends AgentryEventBase {
  type: 'assistant.proposal';
  projectId: string;
  runId: string;
  proposalId: string;
  proposalKind: AssistantProposalKind;
  action: AssistantProposalAction;
  /** For an accepted work item, the item it created */
  itemId: string | null;
  /** For an accepted team member, its agent file name */
  agent: string | null;
  /** For an accepted resource, where it was saved */
  resource: { kind: AssistantResourceKind; name: string; scope: ConfigScopeKind } | null;
}

/** A layered setting changed, from the UI or the file: the whole document as it now stands. */
export interface SettingsChangedEvent extends AgentryEventBase {
  type: 'settings.changed';
  settings: AppSettings;
}

/**
 * The tunnel moved to another state, got a new address, or had its settings changed. Carries the
 * whole status, so a client that follows the feed never has to refetch it.
 */
export interface TunnelChangedEvent extends AgentryEventBase {
  type: 'tunnel.changed';
  tunnel: TunnelStatus;
}

// ---------- Webhooks (code hosts, phase 6) ----------

/**
 * Where a registered hook stands. `active`: it delivers, or has not failed yet. `failing`: the host
 * reports its last delivery as refused or unanswered. `stale`: its URL is no longer Agentry's
 * public address and Agentry could not re-point it. `removed`: the person removed it.
 */
export type WebhookState = 'active' | 'failing' | 'stale' | 'removed';

/**
 * Why a project's repository has no webhooks to manage: `no-public-url` has no public origin a
 * code host could deliver to (the tunnel is tailnet-only, so it is not one); `no-remote` is a
 * project without a code host remote.
 */
export type WebhookUnavailableReason = 'no-public-url' | 'no-remote';

/** What the host last answered when it delivered to the hook, as it reports it. */
export interface WebhookLastResponse {
  code: number | null;
  status: string | null;
}

/**
 * A hook Agentry registered on a project's repository. The secret that signs its deliveries is kept
 * on the server and is never part of this document.
 */
export interface WebhookRegistration {
  /** Agentry's id for it; the receiver's address ends with it */
  id: string;
  projectId: string;
  host: CodeHostId;
  hostname: string;
  /** `owner/name` (GitHub) or the namespaced path (GitLab) */
  repoPath: string;
  /** The host's id for the hook, as text so a 64-bit id never loses precision */
  remoteHookId: string | null;
  /** Where the host delivers: the public address plus the receiver's path */
  url: string;
  /** The event names the hook subscribes to, in the host's words */
  events: string[];
  state: WebhookState;
  lastDeliveryAt: string | null;
  lastPingAt: string | null;
  /** The host's own report of the last delivery; null until it said */
  lastResponse: WebhookLastResponse | null;
  /**
   * Only in the answer that registered it, in words for the person: another Agentry install's hook
   * is on the repository and was left alone. Never stored.
   */
  notice?: string;
  createdAt: string;
  updatedAt: string;
}

/** `GET /projects/:id/webhooks`: the registrations, and what the person needs to register one. */
export interface ProjectWebhooks {
  /** False while the project cannot have a hook; `reason` says why */
  available: boolean;
  reason: WebhookUnavailableReason | null;
  /** The public origin a hook would deliver to; null without one (the tailnet-only tunnel is not public) */
  publicUrl: string | null;
  /** The events a registration subscribes to */
  events: string[];
  /** Redelivery needs a scope the CLI may not have; the UI offers it only when true */
  canRedeliver: boolean;
  registrations: WebhookRegistration[];
}

/**
 * How fresh a change request's data is. `source` is what caused the last read: `webhook` a delivery
 * moved it to now, `poll` the pacer's schedule or a person's refresh.
 */
export interface ChangeRequestFreshness {
  /** When the host was last read for it; null before the first read */
  checkedAt: string | null;
  /** When the pacer reads it next; null while it is closed or reads are paused */
  nextCheckAt: string | null;
  source: 'webhook' | 'poll';
}

/** A registration was created, adopted, tested, re-pointed, changed state or was removed. Carries the whole registration. */
export interface WebhookChangedEvent extends AgentryEventBase {
  type: 'webhook.changed';
  projectId: string;
  registration: WebhookRegistration;
}

/** Everything the buffered feed carries, discriminated by `type`. */
export type AgentryEvent =
  | RunCreatedEvent
  | RunUpdatedEvent
  | RunEndedEvent
  | RunRemovedEvent
  | RunWaitingEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | RunRateLimitedEvent
  | RunProviderMovedEvent
  | RunLimitWaitingEvent
  | TaskStartedEvent
  | TaskEndedEvent
  | SubagentStartedEvent
  | SubagentUpdatedEvent
  | SubagentEndedEvent
  | WorkflowProgressEvent
  | WorkflowEndedEvent
  | OrchestrationUpdatedEvent
  | OrchestrationRemovedEvent
  | OrchestrationTaskEvent
  | OrchestrationConflictEvent
  | ChangesUpdatedEvent
  | ChatActivityEvent
  | HealthChangedEvent
  | SessionsChangedEvent
  | SystemReleaseEvent
  | ProvidersChangedEvent
  | HostsChangedEvent
  | OrchestrationPullRequestEvent
  | ChangeRequestChecksEvent
  | ChangeRequestReviewEvent
  | ChangeRequestAutoMergeOffEvent
  | ScheduleChangedEvent
  | ScheduleFiredEvent
  | SupervisorProposedEvent
  | WorkItemCreatedEvent
  | WorkItemUpdatedEvent
  | WorkItemMovedEvent
  | WorkItemRemovedEvent
  | MilestoneChangedEvent
  | ProjectCreatedEvent
  | ProjectUpdatedEvent
  | ProjectRemovedEvent
  | TeamChangedEvent
  | JournalChangedEvent
  | MemoryProposalEvent
  | DocumentChangedEvent
  | FlowRunEvent
  | AssistantRunEvent
  | AssistantProposalEvent
  | SettingsChangedEvent
  | TunnelChangedEvent
  | WebhookChangedEvent;

export type AgentryEventType = AgentryEvent['type'];

/** Sent first on every connection, without an SSE id: it is not part of the replay buffer. */
export interface StreamHelloEvent {
  type: 'stream.hello';
  /** Id of the newest event the server has emitted */
  lastEventId: number;
  /** Changes on every server start; ids restart from 1 with it, so a new one means a full resync */
  bootId: string;
  serverTime: string;
  /** The Agentry version the server runs; a page built for another one is out of date */
  version: string;
}

/**
 * Sent instead of a replay when the client's `Last-Event-ID` is not one this server can continue
 * from (it fell out of the buffer, or is newer than anything emitted, as after a restart): whatever
 * the client cached may be stale, so it must refetch everything live.
 */
export interface StreamResyncEvent {
  type: 'stream.resync';
  lastEventId: number;
  reason: 'buffer-overflow' | 'server-restarted';
}

/** Names of the SSE `event:` lines the feed uses besides the ones of {@link AgentryEventType}. */
export type StreamControlEventType = StreamHelloEvent['type'] | StreamResyncEvent['type'];

// ---------- Decision engine ----------

/** The three typed questions, named as Jev names them: a choice, a score on a rubric, a yes/no. */
export type DecisionPrimitive = 'choice' | 'score' | 'noul';
export type DecisionProviderId = 'cli' | 'jev';
/** `off` asks nothing, `shadow` asks and records, `active` may change what happens (or, for a suggestion, what is shown) */
export type DecisionMode = 'off' | 'shadow' | 'active';
/** A suggest point prepares something a person decides; an act point changes what happens next */
export type DecisionPointKind = 'suggest' | 'act';
/** `global`: settings only global; `project`: a project may override them */
export type DecisionScope = 'global' | 'project';

export type DecisionPointId =
  | 'flow.refine-needed'
  | 'flow.bounce'
  | 'orchestration.retry'
  | 'supervisor.intervene'
  | 'memory.triage'
  | 'assistant.rerank'
  | 'assistant.sources'
  | 'journal.relevance'
  | 'board.triage'
  | 'team.assign'
  | 'flow.scope-drift'
  | 'flow.criteria-precheck'
  | 'flow.criteria-merge'
  | 'flow.restart'
  | 'run.continuation'
  | 'orchestration.model'
  | 'orchestration.fixer'
  | 'health.semantic-loop'
  | 'health.test-weakening'
  | 'changes.unexplained-hunk'
  | 'palette.intent'
  | 'notification.urgency'
  | 'checks.fix'
  | 'review.triage'
  | 'issue.triage'
  | 'provider.on-limit'
  | 'provider.pick'
  | 'provider.model-map';

/** What a decision was about; the `subject_kind` column of the history */
export type DecisionSubjectKind =
  | 'work_item'
  | 'change_request'
  | 'flow_run'
  | 'task'
  | 'chat'
  | 'memory_proposal'
  | 'assistant_run'
  | 'notification'
  | 'palette'
  | 'tracker_issue'
  | 'model';

/** Questions and rubrics are English (D4): providers read `label` and `description`, never a translation */
export interface DecisionChoiceQuestion {
  kind: 'choice';
  id: string;
  question: string;
  /** 2..255 options; ids are stable, labels are what the provider reads */
  options: Array<{ id: string; label: string }>;
}

export interface DecisionScoreQuestion {
  kind: 'score';
  id: string;
  question: string;
  /** A rubric of 2..10 levels, lowest first */
  levels: Array<{ id: string; description: string }>;
}

export interface DecisionNoulQuestion {
  kind: 'noul';
  id: string;
  /** Answered yes/no */
  question: string;
}

export type DecisionQuestion = DecisionChoiceQuestion | DecisionScoreQuestion | DecisionNoulQuestion;

/**
 * Every answer is a value plus a confidence in [0, 1]. The `cli` provider has no calibrated
 * confidence, so it always returns null, and a null never clears a threshold.
 */
export interface DecisionChoiceAnswer {
  kind: 'choice';
  value: string;
  probabilities: Record<string, number> | null;
  confidence: number | null;
}

export interface DecisionScoreAnswer {
  kind: 'score';
  value: string;
  probabilities: Record<string, number> | null;
  confidence: number | null;
}

export interface DecisionNoulAnswer {
  kind: 'noul';
  value: boolean;
  probability: number | null;
  confidence: number | null;
}

export type DecisionAnswer = DecisionChoiceAnswer | DecisionScoreAnswer | DecisionNoulAnswer;

/** Why a provider gave no answer; the point then runs today's behaviour */
export type DecisionUnavailableReason =
  | 'no-key'
  | 'timeout'
  | 'rate-limited'
  | 'no-quota'
  | 'max-tokens'
  | 'server-error'
  | 'network'
  | 'invalid-answer';

/** What a point tells the engine once what really happened is known (shadow accuracy) */
export interface DecisionResolution {
  /** What happened, in words the History row shows; the point's resolver writes it */
  summary: string;
  /** True when the answer matched what happened; the person's feedback overrides the inference */
  agreed: boolean;
  /** Point-specific facts (a status, a count), for the row's detail */
  detail?: Record<string, unknown>;
}

/** The person's word on a decision (D13) */
export type DecisionFeedback = 'useful' | 'not_useful';

export interface DecisionPointSettings {
  /** Absent reads as `off` for every point */
  mode: DecisionMode;
  /** Act points only, 0.5..0.99; absent reads as the point's default */
  threshold: number;
  /**
   * Set when the owner consents after seeing the preview; cleared when the state shape changes.
   * `providers` names what the consent covers: consent given while the point ran on `cli` does not
   * cover `jev`.
   */
  consent: { at: string; stateVersion: number; providers: DecisionProviderId[] } | null;
}

export interface DecisionSettings {
  /** The global default provider */
  provider: DecisionProviderId;
  cli: { model: string; effort: string; maxCostUsd: number };
  /** The key itself is never returned, only whether one is saved and its last four characters */
  jev: { model: 'jev-1.13.0'; keySet: boolean; keyHint: string | null };
  points: Partial<Record<DecisionPointId, DecisionPointSettings>>;
  /** Days of history kept, 1..365 */
  historyDays: number;
}

/** `PUT /decisions/settings` replaces the whole document; the key travels apart, in the credentials */
export interface DecisionSettingsUpdate {
  provider: DecisionProviderId;
  cli: { model: string; effort: string; maxCostUsd: number };
  points: Partial<Record<DecisionPointId, DecisionPointSettings>>;
  historyDays: number;
}

/** Only points of scope `project` accept an override; consent is never part of it */
export interface ProjectDecisionSettings {
  /** `jev` is allowed while the global provider is `cli`, using the global key */
  provider?: 'inherit' | DecisionProviderId;
  points?: Partial<Record<DecisionPointId, Partial<Pick<DecisionPointSettings, 'mode' | 'threshold'>>>>;
}

export interface DecisionCredentialsUpdate {
  /** The Jev key; saved with mode 0600 and never returned */
  key: string;
}

export interface DecisionCredentialsResult {
  keySet: boolean;
  keyHint: string | null;
  /** The general privacy notice (D12): what leaves the machine when a point runs on Jev */
  notice: string;
}

export interface DecisionTestRequest {
  provider: DecisionProviderId;
}

export interface DecisionTestResult {
  provider: DecisionProviderId;
  ok: boolean;
  latencyMs: number;
  model: string | null;
  /** Set when `ok` is false */
  reason: DecisionUnavailableReason | null;
}

/** The catalogue entry the UI needs, with the settings in force for a scope */
export interface DecisionPointInfo {
  id: DecisionPointId;
  kind: DecisionPointKind;
  scope: DecisionScope;
  primitives: DecisionPrimitive[];
  defaultThreshold: number;
  /** True when acting on it avoids a Claude run (feeds "Claude runs saved") */
  savesRun: boolean;
  /** The provider must be fast enough for the call site (the palette needs Jev) */
  needsLowLatency: boolean;
  /** Bumps when the shape of the state changes, which clears the consent given for an older one */
  stateVersion: number;
  /** Mode, threshold and consent after project, then global, then the point's defaults */
  effective: {
    mode: DecisionMode;
    threshold: number;
    provider: DecisionProviderId;
    consent: DecisionPointSettings['consent'];
    /** True when the mode is `active` but the point behaves as `shadow` (act point on `cli`, or no consent) */
    limited: boolean;
  };
}

/** What the palette's person did with the proposal, classified against the row's `command` answer */
export interface DecisionPaletteAction {
  action: 'proposed' | 'other' | 'dismissed';
  /** The command that ran; null when the palette closed without one */
  commandId: string | null;
  at: string;
}

/** A row of the history as the API serves it */
export interface DecisionRecord {
  id: string;
  point: DecisionPointId;
  kind: DecisionPointKind;
  projectId: string | null;
  subjectKind: DecisionSubjectKind;
  subjectId: string | null;
  provider: DecisionProviderId;
  model: string;
  /** `off` writes no row */
  mode: 'shadow' | 'active';
  status: 'answered' | 'unavailable';
  unavailable: DecisionUnavailableReason | null;
  /** The exact state that was sent */
  state: Record<string, unknown>;
  questions: DecisionQuestion[];
  answers: Record<string, DecisionAnswer> | null;
  /** The lowest confidence of the batch; null for `cli` */
  confidence: number | null;
  /** The threshold in force, act points only */
  threshold: number | null;
  /** True when the answer changed what happened */
  acted: boolean;
  /** True when it changed something a person sees (shows the mark) */
  visible: boolean;
  /** True when acting avoided a Claude run */
  savedRun: boolean;
  latencyMs: number;
  inputTokens: number | null;
  costUsd: number | null;
  outcome: DecisionResolution | null;
  /** Null while unknown */
  agreed: boolean | null;
  resolvedAt: string | null;
  feedback: DecisionFeedback | null;
  feedbackAt: string | null;
  /** When the app was opened from the notification this row was about; null until then */
  openedAt: string | null;
  /** What the palette's person did with the proposal; null until they ran or dismissed */
  paletteAction: DecisionPaletteAction | null;
  at: string;
}

export interface DecisionFilter {
  point?: DecisionPointId;
  projectId?: string;
  /** What the decision was about: the mark reads the rows of one subject */
  subjectKind?: DecisionSubjectKind;
  subjectId?: string;
  /** Only rows that changed something a person sees */
  visible?: boolean;
  provider?: DecisionProviderId;
  mode?: 'shadow' | 'active';
  status?: 'answered' | 'unavailable';
  /** ISO timestamps, inclusive */
  since?: string;
  until?: string;
}

export interface DecisionPageQuery extends DecisionFilter {
  cursor?: string;
  limit?: number;
}

export interface DecisionPage {
  items: DecisionRecord[];
  /** Pass as `cursor` for the next page; null at the end */
  nextCursor: string | null;
}

export interface DecisionFeedbackRequest {
  feedback: DecisionFeedback;
}

/** What the palette did with the proposal: the command that ran, or null when it closed without one */
export interface DecisionPaletteActionRequest {
  commandId: string | null;
}

/** The app was opened from the push notification with this key */
export interface DecisionNotificationOpenedRequest {
  key: string;
}

/** The decision the open was recorded on; null when no row matched, which is not an error */
export interface DecisionNotificationOpenedResult {
  decisionId: string | null;
}

/** Grants or withdraws consent for a point, bound to the state version the person previewed */
export interface DecisionConsentRequest {
  granted: boolean;
  stateVersion: number;
  providers: DecisionProviderId[];
}

export interface DecisionClearResult {
  deleted: number;
}

export interface DecisionPointStats {
  point: DecisionPointId;
  count: number;
  acted: number;
  unavailable: number;
  /** Mean confidence of the rows that have one; null when none do */
  meanConfidence: number | null;
  resolved: number;
  agreed: number;
  useful: number;
  notUseful: number;
  costUsd: number;
  runsSaved: number;
}

export interface DecisionStats {
  /** ISO start of the window the numbers cover */
  since: string;
  points: DecisionPointStats[];
  jevCostUsd: number;
  claudeRunsSaved: number;
}

/** The state a point would send, or sent last, and where it would go */
export interface DecisionPreview {
  point: DecisionPointId;
  provider: DecisionProviderId;
  stateVersion: number;
  /** `last` is what the latest request sent; `built` is built locally now and not sent */
  source: 'last' | 'built';
  state: Record<string, unknown>;
  bytes: number;
}

export interface DecisionPaletteRequest {
  query: string;
  commands: Array<{ id: string; title: string }>;
}

export interface DecisionPaletteResult {
  /** The command the query most likely means; null when the point is off, unavailable or unsure */
  commandId: string | null;
  confidence: number | null;
  decisionId: string | null;
}
