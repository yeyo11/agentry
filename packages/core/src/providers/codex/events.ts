import { randomUUID } from 'node:crypto';
import type { ContentBlock, RateLimitInfo, RunTaskChange, TranscriptEntry } from '@agentry/shared';
import { now } from '../../live-chat.ts';
import type { DriverEvent, ModelUsage } from '../driver.ts';
import type { FileUpdateChange, RateLimitSnapshot, RateLimitWindow, ThreadItem, ThreadTokenUsage, TurnError, TurnView } from './protocol/types.ts';

/** `codexErrorInfo` values that mean the account's window is spent. */
const LIMIT_ERRORS = new Set(['usageLimitExceeded', 'rateLimitExceeded']);

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The name of a window by its length, as the rest of Agentry names them (`5h`, `7d`). */
function windowName(mins: number | null, fallback: string): string {
  if (!mins || mins <= 0) return fallback;
  return mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
}

/** `account/rateLimits/updated` as the neutral window info. */
export function rateLimitInfo(snapshot: RateLimitSnapshot): RateLimitInfo {
  const windows: RateLimitInfo['windows'] = {};
  let worst: { used: number; resetsAt: number | undefined; name: string } | null = null;
  const take = (window: RateLimitWindow | null | undefined, fallback: string) => {
    if (!window) return;
    const name = windowName(window.windowDurationMins, fallback);
    windows[name] = { utilization: window.usedPercent / 100, resetsAt: window.resetsAt ?? 0 };
    if (!worst || window.usedPercent > worst.used) worst = { used: window.usedPercent, resetsAt: window.resetsAt ?? undefined, name };
  };
  take(snapshot.primary, 'primary');
  take(snapshot.secondary, 'secondary');
  const top = worst as { used: number; resetsAt: number | undefined; name: string } | null;
  return {
    status: top && top.used >= 100 ? 'rejected' : top && top.used >= 80 ? 'allowed_warning' : 'allowed',
    ...(top ? { rateLimitType: top.name } : {}),
    ...(top?.resetsAt ? { resetsAt: top.resetsAt } : {}),
    windows,
    observedAt: now(),
  };
}

/**
 * Reads the notifications of one `codex app-server` process and says what they mean as driver
 * events. It keeps what a turn needs to end: the last answer (the structured result when a schema
 * was asked for), the usage, and the files an approval is about.
 */
export class CodexEvents {
  /** The files a `fileChange` item will touch, by item: its approval request names none */
  readonly changes = new Map<string, FileUpdateChange[]>();
  private schema = false;
  private lastText = '';
  private usage: ThreadTokenUsage | null = null;
  private streaming: 'text' | 'thinking' | null = null;

  constructor(
    private readonly sink: (event: DriverEvent) => void,
    private readonly model: () => string | null,
  ) {}

  /** A turn is about to start: what the last one left is not this one's. */
  startTurn(schema: boolean): void {
    this.schema = schema;
    this.lastText = '';
    this.usage = null;
    this.streaming = null;
  }

  private entry(role: TranscriptEntry['role'], blocks: ContentBlock[]): TranscriptEntry {
    return { uuid: randomUUID(), role, timestamp: now(), model: role === 'assistant' ? this.model() : null, isSidechain: false, parentToolUseId: null, blocks };
  }

  private message(role: TranscriptEntry['role'], blocks: ContentBlock[]): void {
    const entry = this.entry(role, blocks);
    this.sink({ kind: 'message', entry, mainAgent: role === 'assistant', run: { kind: 'message', entry } });
  }

  private task(change: RunTaskChange): void {
    this.sink({ kind: 'task', run: { kind: 'task', task: change } });
  }

  notification(method: string, params: Record<string, unknown>): void {
    const { sink } = this;
    switch (method) {
      case 'item/started':
        this.started(record(params.item) as unknown as ThreadItem);
        return;
      case 'item/completed':
        this.completed(record(params.item) as unknown as ThreadItem);
        return;
      case 'item/agentMessage/delta': {
        const delta = str(params.delta);
        if (!delta) return;
        if (this.schema) sink({ kind: 'structured-delta', json: delta });
        else sink({ kind: 'delta', block: 'text', text: delta });
        return;
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const delta = str(params.delta);
        if (delta && this.streaming === 'thinking') sink({ kind: 'delta', block: 'thinking', text: delta });
        return;
      }
      case 'thread/tokenUsage/updated':
        this.usage = record(params.tokenUsage) as unknown as ThreadTokenUsage;
        return;
      case 'account/rateLimits/updated':
        if (params.rateLimits) sink({ kind: 'rate-limit', info: rateLimitInfo(record(params.rateLimits) as unknown as RateLimitSnapshot) });
        return;
      case 'error': {
        // The server is trying again: Agentry says so and the turn goes on. A final error comes
        // again as the turn's own `error`, so it is read from there.
        if (params.willRetry === true) sink({ kind: 'notice', text: 'Codex hit a transient error and is retrying.' });
        return;
      }
      default:
      // thread/status/changed, turn/started, turn/diff/updated and the rest say nothing a chat shows
    }
  }

  private started(item: ThreadItem): void {
    const { sink } = this;
    switch (item.type) {
      case 'agentMessage':
        this.streaming = this.schema ? null : 'text';
        sink({ kind: 'block-started', block: { type: 'text', id: item.id }, streams: this.schema ? 'other' : 'text', structured: this.schema });
        return;
      case 'reasoning':
        this.streaming = 'thinking';
        sink({ kind: 'block-started', block: { type: 'thinking', id: item.id }, streams: 'thinking', structured: false });
        return;
      case 'commandExecution': {
        const call = item as Extract<ThreadItem, { type: 'commandExecution' }>;
        this.message('assistant', [{ type: 'tool_use', id: call.id, name: 'Bash', input: { command: call.command } }]);
        sink({ kind: 'command-started', toolUseId: call.id, command: call.command });
        return;
      }
      case 'fileChange':
        this.changes.set(item.id, (item as Extract<ThreadItem, { type: 'fileChange' }>).changes ?? []);
        return;
      case 'collabAgentToolCall': {
        const call = item as Extract<ThreadItem, { type: 'collabAgentToolCall' }>;
        this.task({ taskId: call.id, change: 'started', taskKind: 'agent', status: 'running', ...(call.prompt ? { description: call.prompt.slice(0, 200) } : {}) });
        return;
      }
      default:
    }
  }

  private completed(item: ThreadItem): void {
    const { sink } = this;
    switch (item.type) {
      case 'agentMessage': {
        const { text } = item as Extract<ThreadItem, { type: 'agentMessage' }>;
        this.streaming = null;
        sink({ kind: 'block-stopped' });
        if (!text) return;
        this.lastText = text;
        this.message('assistant', [{ type: 'text', text }]);
        return;
      }
      case 'reasoning': {
        const reasoning = item as Extract<ThreadItem, { type: 'reasoning' }>;
        this.streaming = null;
        sink({ kind: 'block-stopped' });
        const text = [...(reasoning.summary ?? []), ...(reasoning.content ?? [])].join('\n\n');
        if (text) this.message('assistant', [{ type: 'thinking', text }]);
        return;
      }
      case 'plan': {
        const { text } = item as Extract<ThreadItem, { type: 'plan' }>;
        if (text) this.message('assistant', [{ type: 'text', text }]);
        return;
      }
      case 'commandExecution': {
        const call = item as Extract<ThreadItem, { type: 'commandExecution' }>;
        const isError = call.status !== 'completed' || (call.exitCode !== null && call.exitCode !== 0);
        this.message('user', [{ type: 'tool_result', toolUseId: call.id, content: call.aggregatedOutput ?? (call.status === 'declined' ? 'declined' : ''), isError }]);
        sink({ kind: 'command-ended', toolUseId: call.id, isError });
        return;
      }
      case 'fileChange': {
        const call = item as Extract<ThreadItem, { type: 'fileChange' }>;
        this.changes.delete(call.id);
        const changes = call.changes ?? [];
        const ids = changes.map((_, index) => (changes.length === 1 ? call.id : `${call.id}#${index}`));
        const isError = call.status !== 'completed';
        this.message(
          'assistant',
          changes.map((change, index): ContentBlock => ({ type: 'tool_use', id: ids[index] ?? call.id, name: 'Edit', input: { file_path: change.path, change: change.kind.type, diff: change.diff } })),
        );
        this.message(
          'user',
          ids.map((id): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: isError ? call.status : 'applied', isError })),
        );
        return;
      }
      case 'mcpToolCall': {
        const call = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
        const isError = call.status === 'failed' || call.error !== null && call.error !== undefined;
        this.message('assistant', [{ type: 'tool_use', id: call.id, name: `mcp__${call.server}__${call.tool}`, input: call.arguments ?? {} }]);
        this.message('user', [{ type: 'tool_result', toolUseId: call.id, content: JSON.stringify(call.error ?? call.result ?? null), isError }]);
        return;
      }
      case 'dynamicToolCall': {
        const call = item as Extract<ThreadItem, { type: 'dynamicToolCall' }>;
        this.message('assistant', [{ type: 'tool_use', id: call.id, name: call.tool, input: call.arguments ?? {} }]);
        this.message('user', [{ type: 'tool_result', toolUseId: call.id, content: JSON.stringify(call.contentItems ?? null), isError: call.success === false }]);
        return;
      }
      case 'collabAgentToolCall': {
        const call = item as Extract<ThreadItem, { type: 'collabAgentToolCall' }>;
        this.task({ taskId: call.id, change: 'ended', taskKind: 'agent', status: call.status === 'completed' ? 'completed' : 'failed' });
        return;
      }
      default:
    }
  }

  /** `turn/completed`: the one result of the turn. */
  completedTurn(turn: TurnView): void {
    const error: TurnError | null = turn.error ?? null;
    const interrupted = turn.status === 'interrupted';
    const isError = turn.status === 'failed' || interrupted;
    const info = error?.codexErrorInfo;
    const kind = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined;
    const rateLimited = turn.status === 'failed' && kind !== undefined && LIMIT_ERRORS.has(kind);
    const text = turn.status === 'failed' ? (error?.message ?? 'The turn failed') : this.lastText;
    let structuredOutput: unknown;
    if (this.schema && turn.status === 'completed') {
      try {
        structuredOutput = JSON.parse(this.lastText);
      } catch {
        // the answer was not the JSON that was asked for: the result carries none
      }
    }
    const model = this.model();
    const modelUsage: ModelUsage[] = model && this.usage?.modelContextWindow ? [{ model, contextWindow: this.usage.modelContextWindow }] : [];
    const durationMs = typeof turn.durationMs === 'number' ? turn.durationMs : 0;
    this.sink({
      kind: 'result',
      isError,
      text,
      failure: interrupted ? 'interrupted' : text || 'error',
      turns: 1,
      modelUsage,
      structuredOutput,
      budget: false,
      rateLimited,
      run: {
        kind: 'result',
        text,
        outcome: {
          isError,
          turns: 1,
          durationMs,
          // Codex reports tokens and no cost
          costUsd: 0,
          ...(structuredOutput !== undefined ? { structuredOutput } : {}),
          permissionDenials: [],
        },
      },
    });
  }
}
