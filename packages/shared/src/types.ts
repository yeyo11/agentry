// Contract shared between core, API and UI.

// ---------- System ----------

export interface CliInfo {
  installed: boolean;
  version: string | null;
  path: string | null;
  error?: string;
}

/**
 * `wrapper-*`: configured through the API; `env-*`: passed through the container environment;
 * `cswap`: claude-swap owns the credential file and the wrapper injects nothing.
 */
export type TokenSource =
  | 'wrapper-oauth-token'
  | 'wrapper-api-key'
  | 'env-oauth-token'
  | 'env-api-key'
  | 'credentials-file'
  | 'cswap'
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
  /** Agentry's own version */
  version: string;
  uptimeSec: number;
}

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

export type PermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';

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
  /** Original type/subtype of the stream-json event */
  type: string;
  subtype?: string;
  entry?: TranscriptEntry;
  status?: RunStatus;
  text?: string;
  /** For `partial` events: which kind of block is streaming */
  block?: 'text' | 'thinking';
  data?: Record<string, unknown>;
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
  /** Pinned claude-swap account, when it did not use the active one */
  account: string | null;
  /** Ceiling on what it could spend */
  maxBudgetUsd: number | null;
  /** Null when the CLI reported none: cost is only known for what Agentry launched */
  costUsd: number | null;
  tokens: TokenUsage;
  turns: number;
}

/** How full the conversation is, as of its last response. */
export interface ChatContext {
  /** Tokens the last response read: `input + cache`. A snapshot, so compaction shows as a drop. */
  used: number;
  /** The model's context window; null when the model is not known, so no percentage is invented */
  window: number | null;
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

/** The orchestration a chat works for. */
export interface ChatOrchestration {
  id: string;
  name: string;
  /** Null for the synthesis report, which belongs to no task */
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
 * One Claude Code conversation: the root entity of the product. Always exactly one session id, which
 * is also the chat's id. Subagents and workflows are branches of a chat, not chats.
 */
export interface Chat {
  /** The session id */
  id: string;
  title: string;
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
  state: ChatState;
  control: ChatControl;
  /** The live execution, when Agentry has a process on the chat; also the last of `executions` */
  execution: Execution | null;
  /** Every execution, oldest first */
  executions: Execution[];
  /** Null until the chat has had a response */
  context: ChatContext | null;
  cost: ChatCost;
  children: ChatChildren;
  /** Null when nothing has reported it yet */
  environment: ChatEnvironment | null;
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
export type ChatSummary = Omit<Chat, 'children' | 'environment'>;

/** Which chat a branch belongs to, for the aggregates that list branches of many chats together. */
export interface ChatRef {
  id: string;
  title: string;
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

/** What can be chosen when a process starts on a chat, whether it is new, resumed or a fork. */
export interface ChatStartOptions {
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  /** Ceiling on what this execution may spend */
  maxBudgetUsd?: number;
  /** `host` sends permissions, questions and plans to the panel; `none`, the default, denies them */
  permissionPrompts?: 'host' | 'none';
  /** Pin it to a claude-swap account (slot number, email or alias) instead of the active one */
  account?: string;
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

/** A nudge sent to a task that is still running, from the orchestration board. */
export interface TaskHintRequest {
  text: string;
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
}

export interface UpdateProjectRequest {
  name: string;
}

// ---------- Orchestration ----------

export interface OrchestrationTaskSpec {
  id: string;
  name: string;
  prompt: string;
  dependsOn?: string[];
  cwd?: string;
  model?: string;
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

export interface OrchestrationTaskState extends OrchestrationTaskSpec {
  status: OrchestrationTaskStatus;
  /** Git worktree this task works in, when the orchestration isolates its workers */
  worktree?: string | null;
  /** Branch created for that worktree */
  branch?: string | null;
  /** Commit the wrapper made of work the worker left uncommitted, when there was any */
  commit?: string | null;
  /** Executions of its chat so far, the first included */
  attempts: number;
  runId: string | null;
  sessionId: string | null;
  result: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  costUsd: number;
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
  /** The synthesis run, so its report can be continued like any other conversation */
  synthesisRunId?: string | null;
  engine?: OrchestrationEngine;
  engineReason?: string | null;
  /** The workflow engine's run and script, when the graph runs as a workflow */
  workflow?: OrchestrationWorkflow | null;
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
}

export interface PlanRequest {
  objective: string;
  cwd?: string;
  model?: string;
  maxTasks?: number;
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

// ---------- Accounts (claude-swap) ----------

/** The `cswap` binary that owns the account credentials, when it is installed. */
export interface CswapInfo {
  installed: boolean;
  version: string | null;
  path: string | null;
  error?: string;
}

/** One rate-limit window as claude-swap reports it. */
export interface AccountUsageWindow {
  /** Share of the window already consumed (0-100) */
  pct: number;
  resetsAt: string | null;
  /** Human countdown to the reset, e.g. `3h 4m` */
  countdown: string | null;
  /** Per-model windows carry the model name */
  name?: string;
}

export interface AccountUsage {
  fiveHour: AccountUsageWindow | null;
  sevenDay: AccountUsageWindow | null;
  /** Per-model weekly windows (Fable, Opus…) when the account reports them */
  scoped: AccountUsageWindow[];
}

export interface AccountSummary {
  /** Slot number: the identifier every action accepts, alongside the email and the alias */
  number: number;
  email: string;
  organizationName: string | null;
  alias: string | null;
  active: boolean;
  /** Held out of the auto-rotation */
  disabled: boolean;
  /** `ok`, `token_expired`, `unavailable`… as reported by claude-swap */
  usageStatus: string;
  usage: AccountUsage | null;
  usageFetchedAt: string | null;
  /** Quota left in the binding window (0-100); null when the usage is unknown */
  headroomPct: number | null;
}

/** Target selection when no explicit account is given */
export type SwitchStrategy = 'best' | 'next-available';

export interface SwitchResult {
  switched: boolean;
  from: string | null;
  to: string | null;
  reason: string | null;
}

/** Settings of the supervised `cswap auto` process. */
export interface AutoSwitchSettings {
  /** Run `cswap auto` in the background and rotate before the active account runs out */
  enabled: boolean;
  /** Utilization that triggers a proactive switch (50-99.9) */
  threshold: number;
  /** `best` stays until the limit; `consume-first` spends the soonest-resetting account first */
  strategy: 'best' | 'consume-first';
  /** Per-model weekly windows to watch too, e.g. `['Fable']` or `['all']` */
  models: string[];
  /** Poll interval of the supervisor, in seconds (minimum 15) */
  intervalSec: number;
  /** Rotate and resume a run that dies against its rate limit */
  rotateOnLimit: boolean;
}

/** One `cswap auto --json` line, plus the rotations the wrapper drives itself. */
export interface AutoSwitchEvent {
  seq: number;
  ts: string;
  /** `poll`, `switch`, `no-switch`, `account-quarantined`, `all-exhausted`, `error`, or `rotate` when the wrapper drove it */
  event: string;
  reason?: string;
  detail?: string;
  from?: string;
  to?: string;
  /** The raw claude-swap payload */
  data?: Record<string, unknown>;
}

export interface AccountsOverview {
  cswap: CswapInfo;
  accounts: AccountSummary[];
  activeNumber: number | null;
  autoSwitch: AutoSwitchSettings;
  /** The `cswap auto` supervisor is alive */
  autoSwitchRunning: boolean;
  /** Most recent rotation events, newest last */
  events: AutoSwitchEvent[];
}

/** What the dashboard needs about accounts, without the full list. */
export interface AccountsSnapshot {
  installed: boolean;
  total: number;
  active: AccountSummary | null;
  autoSwitchRunning: boolean;
}

export interface SwitchAccountRequest {
  /** Slot number, email or alias; omitted rotates to the next account */
  target?: string;
  strategy?: SwitchStrategy;
}

export interface AddAccountTokenRequest {
  /** Token from `claude setup-token`, or an API key */
  token: string;
  /** Slot to register it in; the next free one when omitted */
  slot?: number;
  /** Label shown until claude-swap resolves the real email */
  email?: string;
}

export interface SetAccountAliasRequest {
  /** Short name for the account; `null` removes it */
  alias: string | null;
}

// ---------- Overview ----------

export interface Overview {
  system: SystemInfo;
  rateLimit: RateLimitInfo | null;
  /** Null when claude-swap is not installed */
  accounts: AccountsSnapshot | null;
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
}

export interface ApiError {
  error: string;
  detail?: string;
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
}

/** Rotation moved the wrapper to another account after a run hit its limit. */
export interface RunAccountRotatedEvent extends AgentryEventBase, RunEventRef {
  type: 'run.accountRotated';
  from: string | null;
  to: string | null;
  /** The interrupted turn was replayed on the new account */
  resumed: boolean;
}

/** The active account changed, by whatever means (manual switch, `cswap auto`, rotation). */
export interface AccountSwitchedEvent extends AgentryEventBase {
  type: 'account.switched';
  from: string | null;
  to: string | null;
  reason: string | null;
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

/** Files under the CLI's projects directory changed: a session was created, grew or ended. */
export interface SessionsChangedEvent extends AgentryEventBase {
  type: 'sessions.changed';
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
  | RunAccountRotatedEvent
  | AccountSwitchedEvent
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
  | SessionsChangedEvent;

export type AgentryEventType = AgentryEvent['type'];

/** Sent first on every connection, without an SSE id: it is not part of the replay buffer. */
export interface StreamHelloEvent {
  type: 'stream.hello';
  /** Id of the newest event the server has emitted */
  lastEventId: number;
  /** Changes on every server start; ids restart from 1 with it, so a new one means a full resync */
  bootId: string;
  serverTime: string;
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
