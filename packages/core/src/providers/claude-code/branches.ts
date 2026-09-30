import { normalizeMessage, type TranscriptEntry } from '@agentry/shared';
import type { BackgroundTask, SubagentInfo, WorkflowRun } from '../../cli-facts.ts';
import { now } from '../../live-chat.ts';
import { readProgress, workflowStatus } from '../../workflows.ts';
import type { BranchTracker } from '../driver.ts';

/** What Claude Code delegates in a chat, across its processes: background tasks, subagents, workflows. */
export class ClaudeBranches implements BranchTracker {
  readonly tasks = new Map<string, BackgroundTask>();
  readonly foregroundTasks = new Map<string, BackgroundTask>();
  readonly subagents = new Map<string, SubagentInfo>();
  readonly workflows = new Map<string, WorkflowRun>();
  sessionId = '';

  message(entry: TranscriptEntry): void {
    trackSubagents(this, entry);
  }

  task(change: string, raw: Record<string, unknown>): void {
    trackTask(this, change, raw);
  }

  endAll(at: string): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') Object.assign(task, { status: 'stopped', endedAt: at });
    }
    for (const sub of this.subagents.values()) {
      if (sub.status === 'running') Object.assign(sub, { status: 'failed', endedAt: at });
    }
    for (const workflow of this.workflows.values()) {
      if (workflow.status === 'running') Object.assign(workflow, { status: 'stopped', endedAt: at });
    }
  }
}

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

function trackSubagents(chat: ClaudeBranches, entry: NonNullable<ReturnType<typeof normalizeMessage>>): void {
  if (entry.isSidechain) return;
  for (const block of entry.blocks) {
    if (block.type === 'tool_use' && SUBAGENT_TOOLS.has(block.name)) {
      const input = (block.input ?? {}) as Record<string, unknown>;
      chat.subagents.set(block.id, {
        toolUseId: block.id,
        subagentType: String(input.subagent_type ?? 'general-purpose'),
        description: String(input.description ?? input.prompt ?? '').slice(0, 200),
        status: 'running',
        startedAt: now(),
        endedAt: null,
      });
    } else if (block.type === 'tool_result') {
      const sub = chat.subagents.get(block.toolUseId);
      // A background agent's tool result only says it was launched; its task notification ends it
      if (sub && sub.status === 'running' && !sub.background) {
        sub.status = block.isError ? 'failed' : 'completed';
        sub.endedAt = now();
      }
    }
  }
}

/**
 * Everything the CLI delegates is a task to it, told apart by `task_type`: shell commands
 * (`local_bash`, reported even while they run in the foreground), subagents (`local_agent`) and
 * workflows (`local_workflow`) each go to their own list. Anything else it runs in the background
 * (monitors, remote agents…) is listed as a background task under its own type.
 */
function trackTask(chat: ClaudeBranches, subtype: string, raw: Record<string, unknown>): void {
  const taskId = typeof raw.task_id === 'string' ? raw.task_id : null;
  if (!taskId) return;
  if (subtype === 'task_started') {
    const type = String(raw.task_type ?? 'unknown');
    if (type === 'local_agent') return startAgentTask(chat, taskId, raw);
    if (type === 'local_workflow') {
      chat.workflows.set(taskId, {
        id: taskId,
        taskId,
        name: typeof raw.workflow_name === 'string' ? raw.workflow_name : null,
        description: String(raw.description ?? raw.workflow_name ?? taskId),
        status: 'running',
        startedAt: now(),
        endedAt: null,
        sessionId: chat.sessionId,
        phases: [],
        agents: [],
        summary: null,
        totalTokens: null,
        script: typeof raw.prompt === 'string' ? raw.prompt : null,
      });
      return;
    }
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id : chat.sessionId;
    const task: BackgroundTask = {
      id: taskId,
      type,
      description: String(raw.description ?? ''),
      status: 'running',
      toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : null,
      startedAt: now(),
      endedAt: null,
      summary: null,
      // The output file is found by session id, and a task read from the live stream is the one
      // the Output button needs it on: the event carries it, and the chat knows it from `init`.
      ...(sessionId ? { sessionId } : {}),
      // Only says a subagent launched it, not which one; Core resolves that from the transcripts
      ...(raw.owned_by_subagent === true ? { fromSubagent: true } : {}),
    };
    if (raw.is_backgrounded === false) chat.foregroundTasks.set(taskId, task);
    else chat.tasks.set(taskId, task);
    return;
  }

  const workflow = chat.workflows.get(taskId);
  if (workflow) return updateWorkflow(workflow, subtype, raw);
  const agent = [...chat.subagents.values()].find((s) => s.agentId === taskId);
  if (agent) return updateAgentTask(agent, subtype, raw);

  const patch = (raw.patch ?? {}) as Record<string, unknown>;
  const waiting = chat.foregroundTasks.get(taskId);
  if (waiting) {
    // Sent to the background mid-turn (by the model or the person): from now on it is one
    if (subtype === 'task_updated' && patch.is_backgrounded === true) {
      chat.foregroundTasks.delete(taskId);
      chat.tasks.set(taskId, waiting);
    } else {
      if (subtype === 'task_notification') chat.foregroundTasks.delete(taskId);
      return;
    }
  }
  const task = chat.tasks.get(taskId);
  if (!task) return;
  if (subtype === 'task_updated') {
    if (typeof patch.status === 'string') task.status = patch.status;
    if (patch.end_time != null) task.endedAt = now();
  } else if (subtype === 'task_notification') {
    if (typeof raw.status === 'string') task.status = raw.status;
    if (typeof raw.summary === 'string') task.summary = raw.summary;
    task.endedAt ??= now();
  }
}

/** The Agent tool call it belongs to was seen first; the task adds its id and whether it runs in the background. */
function startAgentTask(chat: ClaudeBranches, taskId: string, raw: Record<string, unknown>): void {
  const toolUseId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '';
  const background = raw.is_backgrounded === true;
  const known = chat.subagents.get(toolUseId);
  if (known) {
    Object.assign(known, { agentId: taskId, background });
    if (typeof raw.subagent_type === 'string') known.subagentType = raw.subagent_type;
    // Its launch result may have closed it already; a background agent is only done when it says so
    if (background && known.status !== 'running') Object.assign(known, { status: 'running', endedAt: null });
    return;
  }
  // Spawned by a subagent rather than the main agent: no tool call of its own reached the stream
  chat.subagents.set(toolUseId || taskId, {
    toolUseId,
    subagentType: String(raw.subagent_type ?? 'general-purpose'),
    description: String(raw.description ?? '').slice(0, 200),
    status: 'running',
    startedAt: now(),
    endedAt: null,
    agentId: taskId,
    background,
  });
}

function updateAgentTask(agent: SubagentInfo, subtype: string, raw: Record<string, unknown>): void {
  const patch = (raw.patch ?? {}) as Record<string, unknown>;
  const status = subtype === 'task_notification' ? raw.status : subtype === 'task_updated' ? patch.status : undefined;
  if (status === 'completed') Object.assign(agent, { status: 'completed', endedAt: agent.endedAt ?? now() });
  else if (status === 'failed' || status === 'killed') Object.assign(agent, { status: status === 'killed' ? 'stopped' : 'failed', endedAt: agent.endedAt ?? now() });
}

function updateWorkflow(workflow: WorkflowRun, subtype: string, raw: Record<string, unknown>): void {
  const usage = (raw.usage ?? {}) as Record<string, unknown>;
  if (typeof usage.total_tokens === 'number') workflow.totalTokens = usage.total_tokens;
  if (subtype === 'task_progress') {
    // Some progress events only carry usage; the agent list comes with the others
    if (Array.isArray(raw.workflow_progress)) Object.assign(workflow, readProgress(raw.workflow_progress));
    return;
  }
  const patch = (raw.patch ?? {}) as Record<string, unknown>;
  const status = subtype === 'task_notification' ? raw.status : patch.status;
  if (typeof status === 'string') workflow.status = workflowStatus(status);
  if (workflow.status !== 'running') workflow.endedAt ??= now();
  if (subtype === 'task_notification' && typeof raw.summary === 'string') workflow.summary = raw.summary;
}
