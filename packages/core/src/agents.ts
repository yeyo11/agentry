import { entryText, normalizeMessage, type TokenUsage, type TranscriptEntry } from '@agentry/shared';
import type { JsonlFold } from './jsonl-cache.ts';
import { emptyTokenUsage, UsageFold } from './usage.ts';

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
  usage: TokenUsage;
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
    usage: emptyTokenUsage(),
    toolCalls: 0,
    model: null,
    cwd: null,
    firstAt: null,
    lastAt: null,
    prompt: null,
    result: null,
  };
}

/** An agent's transcript folded so far: the read, with the usage still being summed. */
export interface AgentFold {
  read: AgentFileRead;
  spent: UsageFold;
}

/**
 * One agent's transcript, a line at a time: the normalised conversation plus what is summed or
 * picked out of it. Kept per file by a {@link JsonlCache}, so a panel following a live agent reads
 * what it appended and not the whole file again.
 */
export const AGENT_FOLD: JsonlFold<AgentFold> = {
  init: () => ({ read: emptyAgentRead(), spent: new UsageFold() }),
  clone: ({ read, spent }) => ({ read: { ...read, entries: [...read.entries] }, spent: spent.clone() }),
  add: ({ read, spent }, o) => {
    if (typeof o.timestamp === 'string') {
      read.firstAt ??= o.timestamp;
      read.lastAt = o.timestamp;
    }
    if (!read.cwd && typeof o.cwd === 'string' && o.cwd) read.cwd = o.cwd;
    const entry = normalizeMessage(o);
    if (!entry) return;
    read.entries.push(entry);
    if (entry.role === 'user') {
      if (read.prompt === null) read.prompt = entryText(entry) || null;
      return;
    }
    if (entry.model) read.model = entry.model;
    read.toolCalls += entry.blocks.filter((b) => b.type === 'tool_use').length;
    const text = entryText(entry).trim();
    if (text) read.result = text;
    spent.add(o, entry);
  },
};

/** What a fold of an agent's transcript reads as, its usage totalled. */
export function agentRead(fold: AgentFold): AgentFileRead {
  return { ...fold.read, usage: fold.spent.total() };
}
