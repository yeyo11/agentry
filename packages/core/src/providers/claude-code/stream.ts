import { normalizeMessage, type PermissionMode, type PermissionUpdate, type RateLimitInfo, type RunOutcome, type RunTaskChange } from '@agentry/shared';
import { now } from '../../live-chat.ts';
import type { BranchTracker, DriverEvent, EnvironmentDetails, ModelUsage } from '../driver.ts';
import type { ControlChannel } from './control.ts';

// High-frequency events that add nothing to the UI
const IGNORED_SUBTYPES = new Set(['thinking_tokens', 'hook_started', 'hook_response', 'commands_changed']);
/** Wording the CLI uses when the subscription window is spent (`result` text and stderr) */
export const RATE_LIMIT_RE = /usage limit|rate limit|session limit|out of (?:usage|quota)|quota exceeded/i;

/** The CLI takes `manual` on the command line but reports that same mode as `default`. */
export const reportedMode = (mode: string): PermissionMode => (mode === 'default' ? 'manual' : (mode as PermissionMode));

/** The CLI's result subtype for a ceiling set with `--max-budget-usd`. */
const BUDGET_SUBTYPE = 'error_max_budget_usd';

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const named = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? { name: x } : ((x ?? {}) as Record<string, unknown>))) : [];

function toEnvironment(raw: Record<string, unknown>): EnvironmentDetails {
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  const memory = raw.memory_paths && typeof raw.memory_paths === 'object' ? (raw.memory_paths as Record<string, unknown>) : {};
  return {
    cliVersion: text(raw.claude_code_version),
    model: text(raw.model),
    permissionMode: text(raw.permissionMode),
    outputStyle: text(raw.output_style),
    tools: strings(raw.tools),
    mcpServers: named(raw.mcp_servers).map((s) => ({ name: String(s.name ?? ''), status: String(s.status ?? ''), source: text(s.source) ?? undefined })),
    // agents/skills are plain names on some versions and objects on others
    agents: named(raw.agents).map((a) => String(a.name ?? a.agentType ?? '')).filter(Boolean),
    skills: named(raw.skills).map((s) => String(s.name ?? '')).filter(Boolean),
    slashCommands: strings(raw.slash_commands),
    plugins: named(raw.plugins).map((p) => ({ name: String(p.name ?? ''), path: text(p.path) ?? undefined, source: text(p.source) ?? undefined })),
    memoryPaths: Object.fromEntries(Object.entries(memory).filter((e): e is [string, string] => typeof e[1] === 'string')),
  };
}

/** The tool the CLI gives a chat started with `--json-schema`, whose input is the structured result. */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';


const taskKindOf = (type: string): RunTaskChange['taskKind'] =>
  type === 'local_bash' ? 'command' : type === 'local_agent' ? 'agent' : type === 'local_workflow' ? 'workflow' : 'other';

function denialsOf(raw: unknown): RunOutcome['permissionDenials'] {
  if (!Array.isArray(raw)) return [];
  return raw.map((d) => {
    const denial = (d ?? {}) as Record<string, unknown>;
    return { toolName: String(denial.tool_name ?? ''), toolUseId: String(denial.tool_use_id ?? '') };
  });
}

/** What the CLI reports per model at the end of a turn, cost and context window, where it says them. */
function modelUsageOf(raw: unknown): ModelUsage[] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).map(([model, entry]) => {
    const { costUSD, contextWindow } = (entry ?? {}) as { costUSD?: unknown; contextWindow?: unknown };
    return {
      model,
      ...(typeof costUSD === 'number' && Number.isFinite(costUSD) ? { costUsd: costUSD } : {}),
      ...(typeof contextWindow === 'number' && Number.isFinite(contextWindow) ? { contextWindow } : {}),
    };
  });
}

/**
 * Reads the stream-json a `claude -p` process writes and says what it means as driver events. The
 * only state it keeps is the block being streamed: whether its deltas are text, thinking, or the
 * structured result a schema asked for.
 */
export class ClaudeStream {
  private streaming: 'text' | 'thinking' | null = null;
  private structured = false;
  private readonly taskKinds = new Map<string, RunTaskChange['taskKind']>();

  constructor(
    private readonly sink: (event: DriverEvent) => void,
    private readonly branches: BranchTracker,
    private readonly control: ControlChannel,
  ) {}

  /** One line of stderr. */
  error(line: string): void {
    if (!line.trim()) return;
    if (RATE_LIMIT_RE.test(line)) this.sink({ kind: 'rate-limited' });
    this.sink({ kind: 'stderr', text: line });
  }

  /** One line of stdout. */
  line(line: string): void {
    const { sink } = this;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (line.trim()) sink({ kind: 'unreadable', text: line });
      return;
    }
    const type = String(raw.type ?? 'unknown');
    const subtype = typeof raw.subtype === 'string' ? raw.subtype : undefined;
    if (subtype && IGNORED_SUBTYPES.has(subtype)) return;

    if (type === 'control_request') {
      if (typeof raw.request_id === 'string') this.controlRequest(raw.request_id, (raw.request ?? {}) as Record<string, unknown>);
      return;
    }
    if (type === 'control_cancel_request') {
      if (typeof raw.request_id === 'string') {
        this.control.forget(raw.request_id);
        sink({ kind: 'permission-withdrawn', id: raw.request_id });
      }
      return;
    }
    if (type === 'control_response') {
      this.control.settle((raw.response ?? {}) as Record<string, unknown>);
      return;
    }

    // The mode changes under the chat's feet: set from the panel, or by the model leaving plan mode
    if (type === 'system' && subtype === 'status' && typeof raw.permissionMode === 'string') {
      sink({ kind: 'mode-changed', mode: reportedMode(raw.permissionMode) });
      return;
    }

    if (type === 'stream_event') {
      this.streamEvent(raw);
      return;
    }

    // The CLI's heartbeat for a command that is still running, every 30 s
    if (type === 'tool_progress') {
      const id = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : typeof raw.parent_tool_use_id === 'string' ? raw.parent_tool_use_id : null;
      sink({ kind: 'heartbeat', toolUseId: id, elapsedSeconds: typeof raw.elapsed_time_seconds === 'number' ? raw.elapsed_time_seconds : null });
      return;
    }

    if (type === 'assistant' || type === 'user') {
      const entry = normalizeMessage(raw);
      if (!entry) return;
      this.branches.message(entry);
      for (const block of entry.blocks) {
        if (block.type === 'tool_use' && block.name === 'Bash') {
          const input = (block.input ?? {}) as Record<string, unknown>;
          if (typeof input.command === 'string' && input.run_in_background !== true) sink({ kind: 'command-started', toolUseId: block.id, command: input.command });
        } else if (block.type === 'tool_result') {
          sink({ kind: 'command-ended', toolUseId: block.toolUseId, isError: block.isError });
        }
      }
      const mainAgent = entry.role === 'assistant' && !entry.isSidechain;
      const reason = mainAgent && raw.parent_tool_use_id == null ? ((raw.message ?? {}) as Record<string, unknown>).stop_reason : undefined;
      sink({ kind: 'message', entry, mainAgent, ...(typeof reason === 'string' ? { stopReason: reason } : {}), run: { kind: 'message', entry } });
      return;
    }

    if (type === 'system' && subtype === 'init') {
      sink({
        kind: 'init',
        sessionId: typeof raw.session_id === 'string' ? raw.session_id : null,
        model: typeof raw.model === 'string' ? raw.model : null,
        permissionMode: typeof raw.permissionMode === 'string' ? reportedMode(raw.permissionMode) : null,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
        environment: toEnvironment(raw),
        run: {
          kind: 'init',
          init: {
            sessionId: typeof raw.session_id === 'string' ? raw.session_id : '',
            model: typeof raw.model === 'string' ? raw.model : '',
            cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
            permissionMode: typeof raw.permissionMode === 'string' ? reportedMode(raw.permissionMode) : '',
            tools: strings(raw.tools),
            mcpServers: named(raw.mcp_servers).map((s) => ({ name: String(s.name ?? ''), status: String(s.status ?? '') })),
          },
        },
      });
      return;
    }

    if (type === 'system' && subtype && (subtype.startsWith('task_') || subtype === 'background_tasks_changed')) {
      this.branches.task(subtype, raw);
      sink({ kind: 'task', run: { kind: 'task', task: this.taskChange(subtype, raw) } });
      return;
    }

    if (type === 'rate_limit_event') {
      const info = raw.rate_limit_info as Record<string, unknown> | undefined;
      if (info) {
        sink({
          kind: 'rate-limit',
          info: {
            status: String(info.status ?? ''),
            rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
            resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
            windows: (info.unifiedWindows as RateLimitInfo['windows'] | undefined) ?? {},
            observedAt: now(),
          },
        });
      }
      return;
    }

    if (type === 'result') {
      const isError = raw.is_error === true;
      const text = typeof raw.result === 'string' ? raw.result : '';
      sink({
        kind: 'result',
        isError,
        text,
        failure: text || String(subtype ?? 'error'),
        turns: typeof raw.num_turns === 'number' ? raw.num_turns : 1,
        ...(typeof raw.total_cost_usd === 'number' ? { costUsd: raw.total_cost_usd } : {}),
        modelUsage: modelUsageOf(raw.modelUsage),
        structuredOutput: raw.structured_output,
        ...(typeof raw.stop_reason === 'string' ? { stopReason: raw.stop_reason } : {}),
        budget: subtype === BUDGET_SUBTYPE,
        rateLimited: isError && (raw.api_error_status === 429 || RATE_LIMIT_RE.test(text)),
        run: {
          kind: 'result',
          text,
          outcome: {
            isError,
            turns: typeof raw.num_turns === 'number' ? raw.num_turns : 1,
            durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : 0,
            costUsd: typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : 0,
            ...(raw.structured_output !== undefined ? { structuredOutput: raw.structured_output } : {}),
            permissionDenials: denialsOf(raw.permission_denials),
          },
        },
      });
      return;
    }

    // Any other protocol event is one Agentry has no use for
  }

  /** What a `task_*` event says, in the neutral words. A task's kind is told once, by its `task_started`. */
  private taskChange(subtype: string, raw: Record<string, unknown>): RunTaskChange {
    const taskId = typeof raw.task_id === 'string' ? raw.task_id : undefined;
    if (!taskId) return { change: 'listed', taskKind: 'other' };
    if (typeof raw.task_type === 'string') this.taskKinds.set(taskId, taskKindOf(raw.task_type));
    const patch = (raw.patch ?? {}) as Record<string, unknown>;
    const status = typeof raw.status === 'string' ? raw.status : typeof patch.status === 'string' ? patch.status : undefined;
    return {
      taskId,
      change: subtype === 'task_started' ? 'started' : subtype === 'task_updated' ? 'updated' : subtype === 'task_progress' ? 'progress' : 'ended',
      taskKind: this.taskKinds.get(taskId) ?? 'other',
      ...(status ? { status } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
    };
  }

  /** The CLI asks the host something: a tool permission, a question, a plan to approve. */
  private controlRequest(requestId: string, request: Record<string, unknown>): void {
    if (request.subtype !== 'can_use_tool') {
      // Hooks and SDK MCP servers are never registered, so nothing else should arrive
      this.control.refuse(requestId, request.subtype);
      return;
    }
    const input = (request.input ?? {}) as Record<string, unknown>;
    this.control.ask(requestId, input);
    this.sink({
      kind: 'permission-request',
      question: {
        id: requestId,
        toolName: String(request.tool_name ?? 'unknown'),
        toolUseId: typeof request.tool_use_id === 'string' ? request.tool_use_id : '',
        input,
        ...(typeof request.description === 'string' ? { description: request.description } : {}),
        ...(Array.isArray(request.permission_suggestions) ? { suggestions: request.permission_suggestions as PermissionUpdate[] } : {}),
        ...(request.requires_user_interaction === true ? { requiresUserInteraction: true } : {}),
      },
    });
  }

  private streamEvent(raw: Record<string, unknown>): void {
    const { sink } = this;
    // Token-level deltas of the main agent; the full block follows as a regular `assistant` event
    if (raw.parent_tool_use_id != null) return;
    const event = (raw.event ?? {}) as Record<string, unknown>;
    if (event.type === 'message_delta') {
      // The assistant events the CLI emits per block carry no stop reason yet: it arrives here
      const reason = ((event.delta ?? {}) as Record<string, unknown>).stop_reason;
      if (typeof reason === 'string') sink({ kind: 'stop-reason', reason });
    } else if (event.type === 'content_block_start') {
      const block = (event.content_block ?? {}) as Record<string, unknown>;
      const blockType = block.type;
      this.streaming = blockType === 'text' || blockType === 'thinking' ? blockType : null;
      // The CLI hands the result a schema asks for as the input of this tool, which streams like any
      // other: whoever waits for the result may show it as it is written
      this.structured = blockType === 'tool_use' && block.name === STRUCTURED_OUTPUT_TOOL;
      sink({ kind: 'block-started', block, streams: this.streaming ?? 'other', structured: this.structured });
    } else if (event.type === 'content_block_delta' && this.structured) {
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json) {
        sink({ kind: 'structured-delta', json: delta.partial_json });
      }
    } else if (event.type === 'content_block_delta' && this.streaming) {
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      const chunk = delta.type === 'text_delta' ? delta.text : delta.type === 'thinking_delta' ? delta.thinking : null;
      if (typeof chunk === 'string' && chunk) sink({ kind: 'delta', block: this.streaming, text: chunk });
    } else if (event.type === 'content_block_stop') {
      this.streaming = null;
      this.structured = false;
      sink({ kind: 'block-stopped' });
    }
  }
}
