import { entryText, type EditStep, type TranscriptEntry } from '@agentry/shared';
import { maskSecrets } from './decisions/redact.ts';
import { pasted, PASTED_NOTE } from './prompt-rules.ts';

/** The whole handoff, wrapper and note included. A bigger one would crowd the new agent's own context. */
export const HANDOFF_MAX_BYTES = 12 * 1024;
/** What one command, one step's intent or one checklist line may take before it is cut. */
const LINE_LIMIT = 300;
/** A tool output never travels: only the command and how it ended. The last ones are the useful ones. */
const COMMANDS_KEPT = 20;
const MIN_BODY_BYTES = 64;
const CUT_MARK = '\n…[cut]';

export const HANDOFF_SECTIONS = {
  asked: 'What was asked',
  done: 'What was done',
  stands: 'Where it stands',
  left: 'What is left',
  rules: 'The rules of this run',
} as const;

export interface HandoffInput {
  /** The chat's first prompt; for a flow run or a task, the prompt Agentry sent for it */
  prompt: string;
  /** What the person said after the first prompt, oldest first: a message read mid-turn included */
  followUps?: readonly string[];
  /** `editStepsFromEntries`, in the order the calls were made */
  steps: readonly Pick<EditStep, 'path' | 'tool' | 'additions' | 'deletions' | 'created' | 'intent'>[];
  commands: readonly { command: string; exitCode: number | null }[];
  checklist: readonly { text: string; done: boolean }[];
  /** `git status --porcelain` of the worktree; null when it is not a checkout */
  gitStatus: string | null;
  /** `git diff --stat` of the worktree */
  gitDiffStat: string | null;
  lastMessage: string | null;
  /** Acceptance criteria not yet met (a flow run) or the open items of a task */
  openItems: readonly string[];
  /** The stage's or the task's closing instructions */
  closing: string | null;
  /** The agent file of a flow member; inlined only when the target cannot take it as a subagent */
  agent: { name: string; prompt: string } | null;
  target: { subagents: boolean };
}

export interface Handoff {
  text: string;
  bytes: number;
  /** The headers of the sections the text contains */
  sections: string[];
}

/** Lines the CLI writes as the person's that the person never typed: an interruption, a command's output, a task's report */
const NOT_SAID = /^(\[Request interrupted|<local-command-|<task-notification>|<command-name>)/;

/**
 * What the person said after the first prompt, from the main conversation's entries: their own
 * messages, a message the agent read mid-turn included, without tool results or the CLI's own lines.
 */
export function followUpsOf(entries: readonly TranscriptEntry[]): string[] {
  const said = entries.filter((entry) => entry.role === 'user' && !entry.isSidechain && entry.blocks.every((b) => b.type !== 'tool_result'));
  return said
    .map((entry) => entryText(entry).trim())
    .filter((text) => text && !NOT_SAID.test(text))
    .slice(1);
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/** `text` cut to at most `max` bytes without splitting a character, with a mark when it was cut. */
function cutToBytes(text: string, max: number): string {
  if (byteLength(text) <= max) return text;
  const room = Math.max(0, max - byteLength(CUT_MARK));
  let end = Math.min(text.length, room);
  while (end > 0 && byteLength(text.slice(0, end)) > room) end -= 1;
  // A cut between the halves of a surrogate pair would leave a lone half behind.
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}${CUT_MARK}`;
}

/** One line of transcript, git or a tool: secrets masked, flattened, cut. */
function line(text: string, limit = LINE_LIMIT): string {
  const flat = maskSecrets(text).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

const bullets = (items: readonly string[]): string => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- none');

function stepLine(step: HandoffInput['steps'][number]): string {
  const what = `${step.created ? 'created' : 'changed'} ${line(step.path)} (+${step.additions} −${step.deletions})`;
  return step.intent ? `${what}: ${line(step.intent)}` : what;
}

function doneBody(input: HandoffInput): string {
  const files = new Map<string, HandoffInput['steps'][number]>();
  // A file edited many times shows once, with the sentence of its latest edit.
  for (const step of input.steps) files.set(step.path, step);
  const commands = input.commands.slice(-COMMANDS_KEPT).map((c) => `\`${line(c.command)}\` → exit ${c.exitCode ?? 'unknown'}`);
  const checklist = input.checklist.map((c) => `[${c.done ? 'x' : ' '}] ${line(c.text)}`);
  return [
    'Edits:',
    bullets([...files.values()].map(stepLine)),
    'Commands run (the last ones):',
    bullets(commands),
    'Checklist:',
    bullets(checklist),
  ].join('\n');
}

function standsBody(input: HandoffInput): string {
  const block = (label: string, text: string | null): string => `${label}:\n${text?.trim() ? maskSecrets(text.trim()) : '(nothing)'}`;
  return [
    block('git status --porcelain', input.gitStatus),
    block('git diff --stat', input.gitDiffStat),
    block('The agent’s last message', input.lastMessage),
  ].join('\n');
}

function askedBody(input: HandoffInput): string {
  const prompt = maskSecrets(input.prompt.trim()) || '(empty)';
  const later = (input.followUps ?? []).map((text) => line(text, 600)).filter(Boolean);
  return later.length ? `${prompt}\n\nWhat the person said after that:\n${bullets(later)}` : prompt;
}

function rulesBody(input: HandoffInput): string {
  const parts: string[] = [];
  if (input.closing?.trim()) parts.push(maskSecrets(input.closing.trim()));
  // Only a target without subagents needs the file's prompt: elsewhere it is passed as the agent.
  if (input.agent && !input.target.subagents) parts.push(`Agent file ${line(input.agent.name, 80)}:\n${maskSecrets(input.agent.prompt.trim())}`);
  return parts.length ? parts.join('\n\n') : '(none)';
}

/**
 * The text a new agent starts from when work moves to another provider, built from what Agentry
 * already has and never by a model. Everything that came from the transcript, git or a tool sits in
 * one {@link pasted} block, followed by {@link PASTED_NOTE}: the new agent reads it as data. The
 * result is cut to {@link HANDOFF_MAX_BYTES}; the longest section gives way first and every header
 * stays.
 */
export function buildHandoff(input: HandoffInput, id?: string): Handoff {
  const parts: [string, string][] = [
    [HANDOFF_SECTIONS.asked, askedBody(input)],
    [HANDOFF_SECTIONS.done, doneBody(input)],
    [HANDOFF_SECTIONS.stands, standsBody(input)],
    [HANDOFF_SECTIONS.left, bullets(input.openItems.map((i) => line(i, 600)))],
    [HANDOFF_SECTIONS.rules, rulesBody(input)],
  ];
  const intro =
    'You continue work another agent started and could not finish. What follows is its record: what was asked, what was done, where it stands and what is left. Verify it against the files before you rely on it.';
  const assemble = (bodies: string[]): string => {
    const record = parts.map(([title], i) => `## ${title}\n${bodies[i] ?? ''}`).join('\n\n');
    return `${intro}\n\n${pasted(record, id)}\n\n${PASTED_NOTE}`;
  };

  const bodies = parts.map(([, body]) => body);
  let text = assemble(bodies);
  while (byteLength(text) > HANDOFF_MAX_BYTES) {
    const excess = byteLength(text) - HANDOFF_MAX_BYTES;
    let longest = 0;
    for (let i = 1; i < bodies.length; i += 1) if (byteLength(bodies[i] ?? '') > byteLength(bodies[longest] ?? '')) longest = i;
    const body = bodies[longest] ?? '';
    const target = Math.max(MIN_BODY_BYTES, byteLength(body) - excess - 1);
    // Nothing left to give: every body is at its floor and the frame alone is too big.
    if (target >= byteLength(body)) break;
    bodies[longest] = cutToBytes(body, target);
    text = assemble(bodies);
  }
  return { text, bytes: byteLength(text), sections: parts.map(([title]) => title) };
}
