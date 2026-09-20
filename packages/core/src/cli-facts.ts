// What Claude Code reports in its own words: transcript summaries, delegated work as its stream and
// its sidecar files describe it, the process list. These shapes stop at `packages/core`: the API and
// the web speak `Chat` and its branches, which `chat-branches.ts` derives from these, so a field the
// CLI writes differently tomorrow reaches no browser.

import type { TranscriptEntry } from '@agentry/shared';

/** One transcript folded into what a list needs, before Agentry adds what it knows itself. */
export interface TranscriptSummary {
  /** The session id: the file's name without its extension */
  id: string;
  /** Encoded directory name inside ~/.claude/projects the transcript sits in */
  projectId: string;
  /** The cwd the first line that records one gives */
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
  /** From the CLI's own record, when the session ran in a worktree it created */
  worktree: { name: string | null; branch: string | null; path: string; parentPath: string } | null;
}

/** A window of a transcript, oldest first, with where it sits in the whole. */
export interface TranscriptPage {
  summary: TranscriptSummary;
  entries: TranscriptEntry[];
  /** Index of the first entry in `entries` within the whole transcript */
  from: number;
  /** Entries the transcript holds in total */
  total: number;
}

/**
 * Work the CLI runs in the background: a Bash command sent there (by the model or by the person at
 * the terminal), a monitor, a remote agent. The CLI calls every delegated piece of work a task, and
 * reports foreground commands that way too; those are left out, and so are subagents and workflows,
 * which have lists of their own.
 */
export interface BackgroundTask {
  id: string;
  type: string;
  description: string;
  /** The CLI's words: `running`, `completed`, `failed`, `killed`, `stopped`… */
  status: string;
  toolUseId: string | null;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  /** Session that launched it */
  sessionId?: string;
  /** The shell command, when it is a backgrounded Bash call */
  command?: string | null;
  /** Sent to the background by the person at the terminal rather than by the model */
  backgroundedByUser?: boolean;
  /** Launched by a subagent rather than by the main agent (`owned_by_subagent` on the stream event) */
  fromSubagent?: boolean;
  /**
   * The subagent that launched it, when known. The stream event only says a subagent did, so this
   * comes from the subagent's own transcript, where the launch result is recorded.
   */
  ownerAgentId?: string | null;
}

/** An agent a session spawned with the Agent tool, in the foreground or the background. */
export interface SubagentInfo {
  toolUseId: string;
  subagentType: string;
  description: string;
  /** `stopped` when its session ended before the agent reported back */
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: string;
  endedAt: string | null;
  /** The CLI's own id for the agent, which is also the name of its transcript */
  agentId?: string;
  /** Last time the agent wrote to its transcript */
  lastActivityAt?: string | null;
  /** Directory the agent works in, from its own transcript: a worktree when started with isolation */
  cwd?: string | null;
  /** Launched to run in the background, rather than awaited by its parent */
  background?: boolean;
}

/** One agent a workflow launched, as its progress reports it. */
export interface WorkflowAgentState {
  index: number;
  label: string;
  /** As the CLI reports it: `start`, `progress`, `done` or `error` */
  state: string;
  agentId: string | null;
  phaseTitle: string | null;
  model: string | null;
  startedAt: string | null;
  durationMs: number | null;
  tokens: number | null;
  toolCalls: number | null;
  promptPreview: string | null;
  resultPreview: string | null;
}

/**
 * A run of a Claude Code workflow: a script started with the Workflow tool that orchestrates
 * subagents inside one session. Read from the live stream (`local_workflow` tasks) or from the
 * files the CLI keeps beside the session's transcript.
 */
export interface WorkflowRun {
  /** The CLI's workflow run id (`wf_…`) when known, the task id otherwise */
  id: string;
  taskId: string | null;
  /** The `name` in the script's meta */
  name: string | null;
  description: string;
  /** `stopped` when its session ended before the workflow reported back */
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: string;
  endedAt: string | null;
  sessionId?: string;
  phases: string[];
  agents: WorkflowAgentState[];
  /** What the script returned, once it finished */
  result?: unknown;
  summary: string | null;
  totalTokens: number | null;
  script: string | null;
}

/** One entry of `claude agents --json`: a CLI process that is not necessarily one of ours. */
export interface CliSession {
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
}
