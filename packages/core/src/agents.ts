import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { entryText, normalizeMessage, type AgentTokenUsage, type TranscriptEntry } from '@agentry/shared';

// A subagent's conversation is kept beside its session's transcript, one file per agent:
//
//   <session>/subagents/agent-<agentId>.jsonl          the transcript, same line format as the session's
//   <session>/subagents/agent-<agentId>.meta.json      agentType, description, toolUseId, requestShape…
//   <session>/subagents/workflows/<wf_…>/agent-<id>.*  the same for the agents a workflow launched
//
// Ids end up in file paths, so they are checked against these patterns before anything is joined:
// nothing that could climb out of the directory gets through.

/** A subagent's id as the CLI writes it (hex today); anything with a dot or a slash is refused. */
export const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** A workflow run id (`wf_5c79d6c0-b39`). */
export const WORKFLOW_RUN_ID_RE = /^wf_[A-Za-z0-9_-]{1,128}$/;

export interface AgentFileRead {
  /** Every normalised entry, in order */
  entries: TranscriptEntry[];
  usage: AgentTokenUsage;
  toolCalls: number;
  model: string | null;
  cwd: string | null;
  firstAt: string | null;
  lastAt: string | null;
  /** First user message: what the agent was asked */
  prompt: string | null;
  /** Text of the last assistant message that has any: what the agent reported back */
  result: string | null;
}

/** What a transcript that has not been written yet reads as: an agent just launched has a meta and nothing else. */
export function emptyAgentRead(): AgentFileRead {
  return {
    entries: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
    toolCalls: 0,
    model: null,
    cwd: null,
    firstAt: null,
    lastAt: null,
    prompt: null,
    result: null,
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * One agent's transcript in one pass: the normalised conversation plus what is summed or picked
 * out of it. Lines still being written by a live agent are skipped, not fatal.
 */
export async function readAgentFile(file: string): Promise<AgentFileRead> {
  const read = emptyAgentRead();
  // The CLI writes one line per content block of an assistant message, each carrying the whole
  // message's usage: summing lines would count a message once per block. The last line of an id
  // holds its final figures.
  const usageByMessage = new Map<string, Record<string, unknown>>();
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof o.timestamp === 'string') {
      read.firstAt ??= o.timestamp;
      read.lastAt = o.timestamp;
    }
    if (!read.cwd && typeof o.cwd === 'string' && o.cwd) read.cwd = o.cwd;
    const entry = normalizeMessage(o);
    if (!entry) continue;
    read.entries.push(entry);
    if (entry.role === 'user') {
      if (read.prompt === null) read.prompt = entryText(entry) || null;
      continue;
    }
    if (entry.model) read.model = entry.model;
    read.toolCalls += entry.blocks.filter((b) => b.type === 'tool_use').length;
    const text = entryText(entry).trim();
    if (text) read.result = text;
    const message = o.message as { id?: unknown; usage?: unknown } | undefined;
    if (message?.usage && typeof message.usage === 'object') {
      usageByMessage.set(typeof message.id === 'string' ? message.id : entry.uuid, message.usage as Record<string, unknown>);
    }
  }
  for (const u of usageByMessage.values()) {
    read.usage.input += num(u.input_tokens);
    read.usage.output += num(u.output_tokens);
    read.usage.cacheRead += num(u.cache_read_input_tokens);
    read.usage.cacheCreation += num(u.cache_creation_input_tokens);
  }
  const { input, output, cacheRead, cacheCreation } = read.usage;
  read.usage.total = input + output + cacheRead + cacheCreation;
  return read;
}
