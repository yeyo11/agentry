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

// ---------- Projects and sessions (read from ~/.claude/projects) ----------

export interface ProjectSummary {
  /** Lives under the OS temp dir (scratch/test directories) */
  temporary: boolean;
  /** Encoded directory name inside ~/.claude/projects */
  id: string;
  /** Real project cwd */
  path: string;
  name: string;
  sessionCount: number;
  lastActivity: string | null;
  /** Wrapper runs currently alive inside this project */
  activeRuns: number;
  /** CLI sessions live in this directory that no run owns — work started from a terminal */
  activeSessions?: number;
  /** The directory exists on disk */
  exists: boolean;
  /** Set when this directory is a git worktree: the repository it belongs to */
  parentId?: string | null;
  parentPath?: string | null;
  worktree?: { name: string | null; branch: string | null } | null;
  /** The orchestration task that created this worktree, when one did */
  createdBy?: { orchestrationId: string; orchestrationName: string; taskId: string; taskName: string } | null;
}

/**
 * Where a piece of work happens, resolved to the project it belongs to. A worktree resolves to its
 * repository, so work spread across worktrees still reads as one project.
 */
export interface WorkLocation {
  /** Directory the work happens in */
  path: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  /** Set when `path` is inside a git worktree of that project */
  worktree: { name: string | null; branch: string | null; path: string } | null;
}

export type SessionLiveSource = 'wrapper' | 'cli';

export interface SessionLive {
  source: SessionLiveSource;
  status: string;
  runId?: string;
  pid?: number;
}

/**
 * Who created a session, so the UI can group the wrapper's own sessions under their parent:
 *   cli           started outside the wrapper (terminal, IDE…)
 *   run           a run started from the wrapper (UI or API)
 *   orchestration a worker (or the synthesis step) of an orchestration
 *   internal      housekeeping runs of the wrapper itself (planner, auth check); hidden by default
 */
export type SessionOriginKind = 'cli' | 'run' | 'orchestration' | 'internal';

export interface SessionOrigin {
  kind: SessionOriginKind;
  runId?: string;
  runName?: string;
  orchestrationId?: string;
  orchestrationName?: string;
  /** Task id inside the orchestration; `__synthesis__` for the final report */
  taskId?: string;
  taskName?: string;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  projectPath: string;
  title: string;
  firstPrompt: string | null;
  messageCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  model: string | null;
  gitBranch: string | null;
  cliVersion: string | null;
  sizeBytes: number;
  live?: SessionLive;
  origin: SessionOrigin;
  /** From the CLI's own record, when the session ran in a worktree it created */
  worktree?: { name: string | null; branch: string | null; path: string; parentPath: string } | null;
}

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

export interface SessionDetail {
  summary: SessionSummary;
  entries: TranscriptEntry[];
}

// ---------- Runs (`claude -p` processes managed by the wrapper) ----------

export type PermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';

export type RunStatus = 'starting' | 'busy' | 'idle' | 'completed' | 'failed' | 'stopped';

export interface RunOptions {
  prompt: string;
  /** Uploads (`POST /uploads`) attached to the first message */
  attachments?: string[];
  /** Working directory; defaults to the wrapper workspace */
  cwd?: string;
  name?: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  /** Resume an existing session */
  resumeSessionId?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  /** Run inside a new git worktree of this name, created and managed by the CLI (`--worktree`) */
  worktree?: string;
  /** Hard ceiling on what this run may spend, enforced by the CLI (`--max-budget-usd`) */
  maxBudgetUsd?: number;
  /**
   * Who answers permission prompts. `none` (the default here, though the CLI's own default is
   * `host`) denies anything that would prompt, which is the only safe choice while nothing is
   * listening. `host` requires `permissionPromptTool`, or the run waits for an answer that never
   * comes.
   */
  permissionPrompts?: 'host' | 'none';
  /** MCP tool the CLI asks for approval, e.g. `mcp__agentry__approve` */
  permissionPromptTool?: string;
  /** Keep the process alive after each turn so more messages can be sent (default true) */
  keepAlive?: boolean;
  /** JSON Schema for structured output */
  jsonSchema?: unknown;
  /** Housekeeping run: no transcript is written (`--no-session-persistence`), so it cannot be resumed */
  internal?: boolean;
  /**
   * Pin the run to a claude-swap account (slot number, email or alias) instead of the active one.
   * Runs through `cswap run`, which needs claude-swap installed.
   */
  account?: string;
}

export interface BackgroundTask {
  id: string;
  /** Empty when the task belongs to a CLI session rather than a run */
  runId: string;
  runName: string;
  type: string;
  description: string;
  status: string;
  toolUseId: string | null;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  /** `run` when read from a run's live stream, `disk` when read from its session's files */
  source?: 'run' | 'disk';
  /** Session that launched it */
  sessionId?: string;
  /** The shell command, when it is a backgrounded Bash call */
  command?: string | null;
  /** Sent to the background by the person at the terminal rather than by the model */
  backgroundedByUser?: boolean;
  location?: WorkLocation | null;
}

/** Captured output of a background task, as the CLI wrote it. */
export interface BackgroundTaskOutput {
  taskId: string;
  output: string;
  /** Only the end of a long output is returned */
  truncated: boolean;
  bytes: number;
}

export interface SubagentInfo {
  toolUseId: string;
  /** Empty when the subagent belongs to a CLI session rather than a run */
  runId: string;
  runName: string;
  subagentType: string;
  description: string;
  /** `stopped` when its session ended before the agent reported back */
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: string;
  endedAt: string | null;
  /** `run` when read from a run's live stream, `cli` when read from a session's files on disk */
  source?: 'run' | 'cli';
  /** Session that spawned it; always set for `cli` subagents */
  sessionId?: string;
  /** The CLI's own id for the agent */
  agentId?: string;
  /** Last time the agent wrote to its transcript */
  lastActivityAt?: string | null;
  /** Directory the agent works in, from its own transcript: a worktree when started with isolation */
  cwd?: string | null;
  location?: WorkLocation | null;
}

export interface RunSummary {
  id: string;
  name: string;
  sessionId: string | null;
  cwd: string;
  model: string | null;
  permissionMode: PermissionMode;
  status: RunStatus;
  pid: number | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  turns: number;
  costUsd: number;
  prompt: string;
  lastText: string | null;
  error: string | null;
  orchestrationId: string | null;
  orchestrationTaskId: string | null;
  internal: boolean;
  /** claude-swap account this run is pinned to, when it is not using the active one */
  account: string | null;
  backgroundTasks: BackgroundTask[];
  subagents: SubagentInfo[];
  /** Directory the CLI actually works in, which differs from `cwd` when it runs in a worktree */
  workingDir?: string | null;
  location?: WorkLocation | null;
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

export interface RunDetail {
  run: RunSummary;
  events: RunEvent[];
}

/** CLI sessions alive on the machine/container (`claude agents --json`) */
export interface ActiveCliSession {
  pid: number;
  cwd: string;
  kind: string;
  startedAt: number;
  sessionId: string;
  name: string;
  status: string;
  /** What the CLI reports for a background agent: `done`, `blocked`… */
  state?: string;
  /**
   * Whether this is a session actually open for work. A process the CLI reports as `done`, and a
   * pre-warmed spare that never received a user turn, are both listed but not live: they still
   * hold a pid worth seeing, yet counting them was what made the panel claim sessions nobody had.
   */
  live: boolean;
  /** Set when it maps to a run managed by the wrapper */
  runId?: string;
  location?: WorkLocation | null;
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

export interface OrchestrationSpec {
  name: string;
  objective?: string;
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

export type OrchestrationTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'stopped';
export type OrchestrationStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface OrchestrationTaskState extends OrchestrationTaskSpec {
  status: OrchestrationTaskStatus;
  /** Git worktree this task works in, when the orchestration isolates its workers */
  worktree?: string | null;
  /** Branch created for that worktree */
  branch?: string | null;
  /** Commit the wrapper made of work the worker left uncommitted, when there was any */
  commit?: string | null;
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

/** A tool call the CLI is holding until someone approves it. */
export interface PermissionRequest {
  id: string;
  runId: string;
  toolName: string;
  /** The CLI's id for the tool call this decides */
  toolUseId: string;
  /** Arguments the tool would be called with, e.g. the shell command */
  input: Record<string, unknown>;
  requestedAt: string;
}

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  /** Shown to the model when denying, so it can adapt instead of guessing */
  message?: string;
  /** Lets the approver edit the arguments before allowing them */
  updatedInput?: Record<string, unknown>;
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

export type ResourceKind = 'agents' | 'skills' | 'commands' | 'output-styles' | 'rules';

export interface MarkdownResource {
  kind: ResourceKind;
  name: string;
  path: string;
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
 * recent wrapper run there (the CLI only reports it when a session starts).
 */
export interface EffectiveEnvironment {
  cwd: string;
  observedAt: string;
  runId: string;
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
    sessions: number;
    activeRuns: number;
    activeCliSessions: number;
    /** Sessions with a live process, from either source: what the Sessions page lists as active */
    liveSessions: number;
    backgroundTasks: number;
    subagents: number;
    orchestrationsRunning: number;
  };
  runs: RunSummary[];
  recentSessions: SessionSummary[];
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
