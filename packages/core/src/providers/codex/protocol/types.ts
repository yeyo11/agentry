// The part of the `codex app-server` protocol the driver speaks, written out from the types
// `codex app-server generate-ts` produced for codex-cli 0.159.3 (the full output is committed under
// test/fixtures/recordings/codex/0.159.3/ts). A new version of the CLI is recorded again and this
// file is checked against it; the driver never guesses a shape that is not in that output.
//
// One method the driver would have liked is left out on purpose: the server lists
// `thread/settings/update` among its methods (recorded), but its params are in no generated type, so
// a mode change travels in the next `turn/start` instead, whose overrides are documented.

export type AskForApproval = 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
}

export interface AccountReadResponse {
  account: { type: 'chatgpt'; email?: string | null; planType?: string } | { type: 'apiKey' } | null;
  requiresOpenaiAuth: boolean;
}

export interface ModelEntry {
  id: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
}

/** What `thread/start`, `thread/resume` and `thread/fork` answer */
export interface ThreadResponse {
  thread: { id: string };
  model: string;
  cwd: string;
  sandbox: { type: string };
  reasoningEffort?: string | null;
  instructionSources?: string[];
}

export type CodexErrorInfo = string | Record<string, unknown>;

export interface TurnError {
  message: string;
  codexErrorInfo?: CodexErrorInfo | null;
}

export interface TurnView {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error?: TurnError | null;
  durationMs?: number | null;
}

export interface FileUpdateChange {
  path: string;
  kind: { type: 'add' | 'delete' | 'update'; move_path?: string | null };
  diff: string;
}

export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | { type: 'plan'; id: string; text: string }
  | { type: 'commandExecution'; id: string; command: string; cwd: string; status: string; aggregatedOutput: string | null; exitCode: number | null; durationMs: number | null }
  | { type: 'fileChange'; id: string; changes: FileUpdateChange[]; status: string }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: string; arguments: unknown; result: unknown; error: unknown }
  | { type: 'dynamicToolCall'; id: string; namespace: string | null; tool: string; arguments: unknown; status: string; contentItems: unknown; success: boolean | null }
  | {
      type: 'collabAgentToolCall';
      id: string;
      tool: string;
      status: string;
      prompt: string | null;
      receiverThreadIds: string[];
      agentsStates: Record<string, { status: string; message: string | null }>;
    }
  | { type: string; id: string };

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  rateLimitReachedType?: string | null;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

/** What a person's answer to an approval is, on the wire */
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
