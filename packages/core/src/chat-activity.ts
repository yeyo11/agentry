import { relative } from 'node:path';
import type { ChatActivity } from '@agentry/shared';
import { oneLine } from './health-strings.ts';

/*
 * What a live execution is doing right now, read from the stream-json events it is already
 * producing. Nothing here asks the CLI anything: a tool call without its result yet, a text or
 * thinking block being streamed, and a permission prompt nobody has answered are everything the
 * stream says about the present, and they are what the kinds of {@link ChatActivity} name.
 */

/** As long a label as a one-line ticker can show without the ellipsis doing all the work. */
const TARGET_MAX = 80;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Where a file tool puts its bytes; each of them names the key differently. */
const pathOf = (input: Record<string, unknown>): string => text(input.file_path) || text(input.notebook_path) || text(input.path);

/**
 * A path as the person reading it thinks of it: relative to the directory the chat works in. An
 * absolute path elsewhere on the machine stays absolute — `../../..` says less than where it is.
 */
export function shortPath(path: string, cwd: string): string {
  if (!cwd || !path.startsWith('/')) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

/** `https://docs.anthropic.com/en/api` → `docs.anthropic.com`: the host is what is recognised at a glance. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Tools that name a file, whatever they do to it. */
const FILE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);
/** Tools that search: the pattern is the label, not the directory it runs in. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob']);
/** Tools that delegate: what the subagent was asked to do. */
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/**
 * Keys a tool nobody here knows about (an MCP server's, a new one of the CLI's) may carry a label
 * in, most telling first. A tool with none gets no target, and the ticker shows its name alone.
 */
const GENERIC_KEYS = ['description', 'query', 'pattern', 'prompt', 'command', 'name', 'subject'] as const;

/**
 * A short human label for what a tool call is working on. Pure: same call, same label, whatever the
 * chat is doing around it. Empty labels come back as `undefined`, which is what leaves the field out.
 */
export function activityTarget(tool: string, input: Record<string, unknown>, cwd: string): string | undefined {
  const label = (value: string): string | undefined => oneLine(value, TARGET_MAX) || undefined;

  if (FILE_TOOLS.has(tool)) {
    const path = pathOf(input);
    return path ? label(shortPath(path, cwd)) : undefined;
  }
  if (SEARCH_TOOLS.has(tool)) return label(text(input.pattern));
  if (AGENT_TOOLS.has(tool)) return label(text(input.description) || text(input.subagent_type) || text(input.prompt));
  if (tool === 'Bash' || tool === 'BashOutput' || tool === 'KillShell') {
    return label(text(input.description) || text(input.command) || text(input.shell_id) || text(input.bash_id));
  }
  if (tool === 'WebFetch') {
    const url = text(input.url);
    return url ? label(hostOf(url)) : undefined;
  }
  if (tool === 'WebSearch') return label(text(input.query));
  if (tool === 'TodoWrite') return undefined;

  for (const key of GENERIC_KEYS) {
    const value = text(input[key]);
    if (value) return label(value);
  }
  return undefined;
}

/** A tool call the CLI has started and has had no result for. */
interface OpenCall {
  tool: string;
  target: string | undefined;
  since: string;
}

/**
 * Folds one execution's stream into the one line that says what it is doing. It is fed the events
 * as they arrive and asked for {@link current} whenever somebody wants to know; it keeps no clock
 * of its own, so every `since` is the timestamp of the event that started the activity.
 *
 * What wins when several are true at once: a prompt waiting for a person beats everything (nothing
 * moves until it is answered), then the most recent tool call still without a result, then the
 * block being streamed. Blocks are told apart from calls because the CLI announces a tool call
 * twice — once as a partial block, with its name but not its input, and again in the assistant
 * message that carries the whole call — and the first of the two is what the ticker reacts to.
 */
export class ChatActivityTracker {
  /** By tool call id, in the order the calls started: the last one is the newest */
  private readonly open = new Map<string, OpenCall>();
  private streaming: { kind: 'writing' | 'thinking'; since: string } | null = null;
  private waitingSince: string | null = null;

  constructor(private cwd: string) {}

  /** The CLI reports the directory it really works in with its `init`; a worktree is not `cwd`. */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /**
   * A `content_block_start` of the main agent. A tool block is registered at once, without its
   * input: the arguments stream in afterwards, and waiting for them would leave the ticker blank
   * for as long as a large edit takes to serialise.
   */
  blockStarted(block: { type?: unknown; id?: unknown; name?: unknown }, at: string): void {
    const type = text(block.type);
    if (type === 'text' || type === 'thinking') {
      this.streaming = { kind: type === 'text' ? 'writing' : 'thinking', since: at };
      return;
    }
    this.streaming = null;
    const id = text(block.id);
    const name = text(block.name);
    if (type === 'tool_use' && id && name) this.open.set(id, { tool: name, target: undefined, since: at });
  }

  /** A `content_block_stop`: whatever was streaming is finished. */
  blockStopped(): void {
    this.streaming = null;
  }

  /** The whole tool call, from the assistant message. Keeps the time the partial block gave it. */
  called(id: string, tool: string, input: Record<string, unknown>, at: string): void {
    const started = this.open.get(id)?.since ?? at;
    this.open.set(id, { tool, target: activityTarget(tool, input, this.cwd), since: started });
  }

  /** Its result arrived: the call is no longer what the chat is doing. */
  answered(id: string): void {
    this.open.delete(id);
  }

  /** How many prompts are waiting for a person, as the chat counts them. */
  setPendingPrompts(count: number, at: string): void {
    if (count > 0) this.waitingSince ??= at;
    else this.waitingSince = null;
  }

  /** The turn ended: a call the CLI never answered (an interrupt) is not still running. */
  turnEnded(): void {
    this.open.clear();
    this.streaming = null;
  }

  /** The process is gone, so nothing is being done at all. */
  clear(): void {
    this.turnEnded();
    this.waitingSince = null;
  }

  current(): ChatActivity | null {
    if (this.waitingSince) return { kind: 'waiting', since: this.waitingSince };
    const calls = [...this.open.values()];
    const call = calls[calls.length - 1];
    if (call) return { kind: 'tool', tool: call.tool, ...(call.target ? { target: call.target } : {}), since: call.since };
    if (this.streaming) return { kind: this.streaming.kind, since: this.streaming.since };
    return null;
  }
}

/** What makes two activities the same news, so an unchanged one is never announced twice. */
export const activityKey = (activity: ChatActivity | null): string =>
  activity ? `${activity.kind}|${activity.tool ?? ''}|${activity.target ?? ''}|${activity.since}` : '';
