import { randomUUID } from 'node:crypto';
import type { ContentBlock, TranscriptEntry } from '@agentry/shared';
import { now } from '../../live-chat.ts';
import type { DriverEvent } from '../driver.ts';

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** The text of an ACP content block; anything that is not text is named, never dropped silently. */
function contentText(raw: unknown): string {
  const content = asRecord(raw);
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  return typeof content.type === 'string' ? `[${content.type}]` : '';
}

interface Diff {
  path: string;
  oldText: string;
  newText: string;
}

/** A change as lines: what was removed with `-`, what was added with `+`, under the path. */
function diffText(diff: Diff): string {
  const lines = (text: string, mark: string): string[] => (text ? text.replace(/\n$/, '').split('\n').map((l) => `${mark}${l}`) : []);
  return [`--- ${diff.path}`, `+++ ${diff.path}`, ...lines(diff.oldText, '-'), ...lines(diff.newText, '+')].join('\n');
}

function diffsOf(content: unknown): Diff[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    const c = asRecord(item);
    return c.type === 'diff' && typeof c.path === 'string' ? [{ path: c.path, oldText: typeof c.oldText === 'string' ? c.oldText : '', newText: typeof c.newText === 'string' ? c.newText : '' }] : [];
  });
}

/** What a tool's result says: its text content and its diffs, else the raw output's text. */
function resultText(update: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      const c = asRecord(item);
      if (c.type === 'content') parts.push(contentText(c.content));
      else if (c.type === 'diff') for (const diff of diffsOf([c])) parts.push(diffText(diff));
    }
  }
  if (parts.length === 0) {
    const out = asRecord(update.rawOutput);
    if (typeof out.content === 'string') parts.push(out.content);
    else if (typeof update.rawOutput === 'string') parts.push(update.rawOutput);
  }
  return parts.join('\n');
}

interface Call {
  title: string;
  kind: string;
  commandStarted: boolean;
  done: boolean;
}

/**
 * Turns `session/update` notifications into driver events. It owns what a stream of chunks needs:
 * the block being written (a message is one block, closed when something else arrives or the turn
 * ends), the tool calls in flight, and the last text of the turn, which is the result's text.
 */
export class UpdateTranslator {
  private open: { type: 'text' | 'thinking'; text: string } | null = null;
  private readonly calls = new Map<string, Call>();
  /** The agent's last full text since the turn began */
  lastText = '';
  /** What the context window holds and holds at most, from the latest `usage_update` */
  context: { used: number; size: number } | null = null;
  /** The agent's slash commands, as it last listed them */
  commands: string[] = [];

  constructor(
    private readonly sink: (event: DriverEvent) => void,
    private readonly model: () => string | null,
    /** `current_mode_update`: the agent's mode id; the session maps it back and reports it */
    private readonly modeChanged: (modeId: string) => void,
    /** `config_option_update` */
    private readonly optionsChanged: (options: unknown[]) => void,
  ) {}

  beginTurn(): void {
    this.lastText = '';
  }

  /** Closes the block being written, as the message it was */
  flush(): void {
    const block = this.open;
    if (!block) return;
    this.open = null;
    this.sink({ kind: 'block-stopped' });
    if (!block.text) return;
    if (block.type === 'text') this.lastText = block.text;
    this.message('assistant', [{ type: block.type, text: block.text }]);
  }

  update(raw: Record<string, unknown>): void {
    switch (raw.sessionUpdate) {
      case 'agent_message_chunk':
        return this.chunk('text', contentText(raw.content));
      case 'agent_thought_chunk':
        return this.chunk('thinking', contentText(raw.content));
      case 'tool_call':
        return this.toolCall(raw);
      case 'tool_call_update':
        return this.toolUpdate(raw);
      case 'plan':
        return this.plan(raw.entries);
      case 'usage_update':
        if (typeof raw.used === 'number' && typeof raw.size === 'number') this.context = { used: raw.used, size: raw.size };
        return;
      case 'current_mode_update':
        if (typeof raw.currentModeId === 'string') this.modeChanged(raw.currentModeId);
        return;
      case 'config_option_update':
        if (Array.isArray(raw.configOptions)) this.optionsChanged(raw.configOptions);
        return;
      case 'available_commands_update':
        if (Array.isArray(raw.availableCommands)) this.commands = raw.availableCommands.flatMap((c) => (typeof asRecord(c).name === 'string' ? [String(asRecord(c).name)] : []));
        return;
      // The history a load replays is dropped before it gets here; the title has no place in the feed
      default:
        return;
    }
  }

  private chunk(type: 'text' | 'thinking', text: string): void {
    if (!text) return;
    if (this.open && this.open.type !== type) this.flush();
    if (!this.open) {
      this.open = { type, text: '' };
      this.sink({ kind: 'block-started', block: { type }, streams: type, structured: false });
    }
    this.open.text += text;
    this.sink({ kind: 'delta', block: type, text });
  }

  private message(role: TranscriptEntry['role'], blocks: ContentBlock[]): void {
    const entry: TranscriptEntry = { uuid: randomUUID(), role, timestamp: now(), model: role === 'assistant' ? this.model() : null, isSidechain: false, parentToolUseId: null, blocks };
    this.sink({ kind: 'message', entry, mainAgent: role === 'assistant', run: { kind: 'message', entry } });
  }

  private toolCall(raw: Record<string, unknown>): void {
    this.flush();
    const id = typeof raw.toolCallId === 'string' ? raw.toolCallId : randomUUID();
    const kind = typeof raw.kind === 'string' ? raw.kind : 'other';
    const title = typeof raw.title === 'string' && raw.title ? raw.title : kind;
    const call: Call = { title, kind, commandStarted: false, done: false };
    this.calls.set(id, call);
    this.sink({ kind: 'block-started', block: { type: 'tool_use', id, name: title }, streams: 'other', structured: false });
    this.sink({ kind: 'block-stopped' });
    const diffs = diffsOf(raw.content);
    const input: Record<string, unknown> = { kind, ...asRecord(raw.rawInput), ...(Array.isArray(raw.locations) ? { locations: raw.locations } : {}), ...(diffs.length > 0 ? { diffs } : {}) };
    this.message('assistant', [{ type: 'tool_use', id, name: title, input }]);
    this.startCommand(id, call, raw.rawInput);
    if (raw.status === 'completed' || raw.status === 'failed') this.finish(id, call, raw);
  }

  private toolUpdate(raw: Record<string, unknown>): void {
    const id = typeof raw.toolCallId === 'string' ? raw.toolCallId : '';
    const call = this.calls.get(id);
    if (!call) return;
    if (raw.rawInput !== undefined) this.startCommand(id, call, raw.rawInput);
    if (raw.status === 'completed' || raw.status === 'failed') this.finish(id, call, raw);
  }

  private startCommand(id: string, call: Call, rawInput: unknown): void {
    if (call.kind !== 'execute' || call.commandStarted) return;
    const command = asRecord(rawInput).command;
    if (typeof command !== 'string') return;
    call.commandStarted = true;
    this.sink({ kind: 'command-started', toolUseId: id, command });
  }

  private finish(id: string, call: Call, raw: Record<string, unknown>): void {
    if (call.done) return;
    call.done = true;
    this.flush();
    const isError = raw.status === 'failed';
    this.message('user', [{ type: 'tool_result', toolUseId: id, content: resultText(raw), isError }]);
    if (call.commandStarted) this.sink({ kind: 'command-ended', toolUseId: id, isError });
  }

  private plan(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    const mark = (status: unknown): string => (status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]');
    const lines = entries.map((e) => `${mark(asRecord(e).status)} ${String(asRecord(e).content ?? '')}`.trim());
    this.sink({ kind: 'task', run: { kind: 'task', task: { change: 'listed', taskKind: 'other', description: lines.join('\n') } } });
  }

  /** Whatever the turn left open ends with it: a tool that never reported is not left running */
  endTurn(): void {
    this.flush();
    for (const [id, call] of this.calls) {
      if (call.commandStarted && !call.done) this.sink({ kind: 'command-ended', toolUseId: id, isError: true });
    }
    this.calls.clear();
  }
}
