import type {
  ChatBackgroundTask,
  ChatBranchStatus,
  ChatChildren,
  ChatEnvironment,
  ChatSubagent,
  ChatWorkflow,
  ChatWorkflowAgent,
  EffectiveEnvironment,
  McpHealthStatus,
} from '@agentry/shared';
import type { BackgroundTask, SubagentInfo, WorkflowAgentState, WorkflowRun } from './cli-facts.ts';

// What a chat delegated, in Agentry's words. The CLI reports the same work three ways (its stream,
// the files beside the transcript, its task notifications) and names the states differently in each;
// this is where they become one vocabulary, so nothing above it needs to know which pipe a record
// came through.

/**
 * The CLI's task states, in the four a person reads. A word it has not said before is read as
 * `stopped`, never as work in progress: an unknown state must not keep a chat looking busy.
 */
export function branchStatus(status: string): ChatBranchStatus {
  if (status === 'running' || status === 'pending' || status === 'started' || status === 'in_progress') return 'running';
  if (status === 'completed' || status === 'done') return 'completed';
  if (status === 'failed' || status === 'error') return 'failed';
  return 'stopped';
}

export function toChatTask(task: BackgroundTask): ChatBackgroundTask {
  return {
    id: task.id,
    kind: task.type,
    description: task.description,
    command: task.command ?? null,
    status: branchStatus(task.status),
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    summary: task.summary,
    byPerson: task.backgroundedByUser === true,
    ownerId: task.ownerAgentId ?? null,
  };
}

/** The id a subagent goes by inside its chat: its transcript's, or its launching call's until it has one. */
const subagentId = (sub: SubagentInfo): string => sub.agentId ?? sub.toolUseId;

export function toChatSubagent(sub: SubagentInfo, tasks: ChatBackgroundTask[], sessionId: string): ChatSubagent {
  const id = subagentId(sub);
  return {
    id,
    sessionId,
    kind: sub.subagentType,
    description: sub.description,
    status: sub.status,
    startedAt: sub.startedAt,
    endedAt: sub.endedAt,
    lastActivityAt: sub.lastActivityAt ?? null,
    cwd: sub.cwd ?? null,
    tasks: tasks.filter((t) => t.ownerId === id),
  };
}

const agentStatus = (state: string): ChatWorkflowAgent['status'] => (state === 'done' ? 'completed' : state === 'error' ? 'failed' : 'running');

function toWorkflowAgent(agent: WorkflowAgentState): ChatWorkflowAgent {
  return {
    index: agent.index,
    label: agent.label,
    status: agentStatus(agent.state),
    id: agent.agentId,
    phase: agent.phaseTitle,
    model: agent.model,
    startedAt: agent.startedAt,
    durationMs: agent.durationMs,
    tokens: agent.tokens,
    toolCalls: agent.toolCalls,
    promptPreview: agent.promptPreview,
    resultPreview: agent.resultPreview,
  };
}

export function toChatWorkflow(workflow: WorkflowRun): ChatWorkflow {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    startedAt: workflow.startedAt,
    endedAt: workflow.endedAt,
    phases: workflow.phases,
    agents: workflow.agents.map(toWorkflowAgent),
    ...(workflow.result !== undefined ? { result: workflow.result } : {}),
    summary: workflow.summary,
    totalTokens: workflow.totalTokens,
    script: workflow.script,
  };
}

/** What the CLI reported delegated, wherever it was read from. */
export interface BranchFacts {
  subagents: SubagentInfo[];
  tasks: BackgroundTask[];
  workflows: WorkflowRun[];
}

/**
 * A chat's branches. A command a subagent launched belongs to that subagent and is listed under
 * it; the chat's own are the ones nobody else launched. Running work comes first.
 */
export function toChildren({ subagents, tasks, workflows }: BranchFacts, sessionId: string): ChatChildren {
  const mapped = tasks.map(toChatTask);
  const owners = new Set(subagents.map(subagentId));
  const running = (a: { status: string; startedAt: string }, b: { status: string; startedAt: string }) =>
    Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt.localeCompare(a.startedAt);
  return {
    subagents: subagents.map((s) => toChatSubagent(s, mapped, sessionId)).sort(running),
    backgroundTasks: mapped.filter((t) => t.ownerId === null || !owners.has(t.ownerId)).sort(running),
    workflows: workflows.map(toChatWorkflow).sort(running),
  };
}

const MCP_STATUSES: readonly McpHealthStatus[] = ['connected', 'failed', 'needs-auth', 'pending', 'unknown'];

/** What Claude loaded when a chat last started in its directory, without the CLI's provenance fields. */
export function toChatEnvironment(env: EffectiveEnvironment): ChatEnvironment {
  return {
    observedAt: env.observedAt,
    model: env.model,
    permissionMode: env.permissionMode,
    outputStyle: env.outputStyle,
    tools: env.tools,
    mcpServers: env.mcpServers.map((s) => ({ name: s.name, status: MCP_STATUSES.find((k) => k === s.status) ?? 'unknown' })),
    agents: env.agents,
    skills: env.skills,
    slashCommands: env.slashCommands,
    plugins: env.plugins.map((p) => ({ name: p.name, ...(p.path ? { path: p.path } : {}) })),
    memoryPaths: env.memoryPaths,
  };
}
