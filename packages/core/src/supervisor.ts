import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HealthSignal, SupervisorConfig, SupervisorProposal, ToolPreset, TranscriptEntry } from '@agentry/shared';
import { DEFAULT_TOOL_PRESETS } from './chat-tools.ts';
import type { ChatRuntime } from './chats.ts';
import { writeAtomic } from './config/files.ts';
import type { Db } from './db.ts';
import { runRef } from './event-sources.ts';
import type { AgentryEventInput } from './events.ts';
import type { TaskContext } from './health-service.ts';
import type { CoreConfig } from './paths.ts';

// The optional supervisor of docs/plans/agent-observability.md §3. When a worker's health turns
// bad, a small model reads the signal and the worker's last steps and drafts a hint of a line or
// two. It is a housekeeping chat of the CLI like the planner, never a call of its own to a model,
// and a person sends what it proposes unless they chose to let it send on its own.

export const DEFAULT_SUPERVISOR: Readonly<SupervisorConfig> = { enabled: false, model: 'haiku', autoSend: false, maxCostUsd: 0.05 };

/** The shipped `read-only` preset, for an install whose person deleted theirs: the supervisor reads, never writes. */
export const DEFAULT_SUPERVISOR_PRESET: ToolPreset = DEFAULT_TOOL_PRESETS.find((p) => p.id === 'read-only') ?? {
  id: 'read-only',
  name: 'Read only',
  allowedTools: ['Read', 'Glob', 'Grep'],
  disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
};

/** A ceiling well past what reading a screenful costs, so a typo cannot hand a watcher a worker's budget. */
const MAX_COST_USD = 5;
/** What `--model` takes: an alias or a full id, `[1m]` variants included; nothing a shell or a flag could misread. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

/** Validates a whole document, since `PUT` replaces it: a missing field is an error, not a default. */
export function parseSupervisorConfig(input: unknown): SupervisorConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('the supervisor settings must be a JSON object');
  const body = input as Record<string, unknown>;
  if (typeof body.enabled !== 'boolean') throw new Error('enabled must be true or false');
  if (typeof body.autoSend !== 'boolean') throw new Error('autoSend must be true or false');
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!MODEL_RE.test(model)) throw new Error('model must be a model alias or id, such as haiku');
  const cost = body.maxCostUsd;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0 || cost > MAX_COST_USD) {
    throw new Error(`maxCostUsd must be a number above 0 and at most ${String(MAX_COST_USD)}`);
  }
  return { enabled: body.enabled, model, autoSend: body.autoSend, maxCostUsd: cost };
}

/** `supervisor.json` in the data directory; absent until the first save, which reads as the defaults. */
export class SupervisorSettings {
  private readonly file: string;

  constructor(config: CoreConfig) {
    this.file = join(config.dataDir, 'supervisor.json');
    mkdirSync(config.dataDir, { recursive: true });
  }

  get(): SupervisorConfig {
    if (!existsSync(this.file)) return { ...DEFAULT_SUPERVISOR };
    try {
      // A field that went bad by hand falls back on its own, so one typo does not switch the supervisor on or off
      const stored = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Record<keyof SupervisorConfig, unknown>>;
      const merged = { ...DEFAULT_SUPERVISOR };
      for (const key of Object.keys(DEFAULT_SUPERVISOR) as Array<keyof SupervisorConfig>) {
        try {
          Object.assign(merged, { [key]: parseSupervisorConfig({ ...DEFAULT_SUPERVISOR, [key]: stored[key] })[key] });
        } catch {
          // keep the default for this field
        }
      }
      return merged;
    } catch {
      return { ...DEFAULT_SUPERVISOR };
    }
  }

  async set(input: unknown): Promise<SupervisorConfig> {
    const config = parseSupervisorConfig(input);
    await writeAtomic(this.file, `${JSON.stringify(config, null, 2)}\n`);
    return config;
  }
}

/** What the housekeeping chat is asked, and where. */
export interface SupervisorQuestion {
  prompt: string;
  /** The worker's own directory, so a look at a file it names is a look at the right one */
  cwd: string;
  model: string;
  maxCostUsd: number;
}

/** What it answered, and what the CLI said it cost. */
export interface SupervisorAnswer {
  text: string;
  costUsd: number;
  isError: boolean;
}

export interface SupervisorDeps {
  settings: SupervisorSettings;
  db: Db;
  /** Runs the housekeeping chat to its result; a test puts a fake here, never a real model */
  ask: (question: SupervisorQuestion) => Promise<SupervisorAnswer>;
  /** The newest entries of the worker's transcript, oldest first */
  steps: (chatId: string) => Promise<TranscriptEntry[]>;
  /** Delivers a proposal's hint to its worker through the hint route of the chat or the task */
  hint: (proposal: SupervisorProposal) => Promise<void>;
  emit: (event: AgentryEventInput) => void;
  /** Adds what the supervisor spent on a task's worker to its graph */
  charge: (orchestrationId: string, costUsd: number) => void;
}

/** Where a proposal is acted on from: the chat, or the task of the graph whose worker it is. */
export type ProposalOwner = { chatId: string } | { orchestrationId: string; taskId: string };

export class SupervisorConflictError extends Error {
  readonly statusCode = 409;
}

/** How much of the worker's recent history the supervisor reads. */
const STEPS = { calls: 12, inputChars: 300, resultLines: 6, resultChars: 600, messageChars: 1200 } as const;
/** A hint is a line or two; what comes back past that is cut rather than sent to the worker. */
const HINT_MAX_CHARS = 400;

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function resultLines(text: string): string {
  const lines = text.trim().split('\n');
  const kept = lines.length > STEPS.resultLines ? [...lines.slice(0, STEPS.resultLines), `… (${String(lines.length - STEPS.resultLines)} more lines)`] : lines;
  return cut(kept.join('\n'), STEPS.resultChars);
}

/**
 * The worker's last steps as the supervisor reads them: its latest tool calls, each with its input
 * and the start of its result, and the last thing it said. Subagents are left out: the signal is
 * about the worker.
 */
export function lastSteps(entries: readonly TranscriptEntry[]): string {
  const calls: Array<{ id: string; name: string; input: string; result: string | null; isError: boolean }> = [];
  const byId = new Map<string, (typeof calls)[number]>();
  let message = '';
  for (const entry of entries) {
    if (entry.isSidechain) continue;
    for (const block of entry.blocks) {
      if (block.type === 'tool_use') {
        const call = { id: block.id, name: block.name, input: cut(JSON.stringify(block.input ?? {}), STEPS.inputChars), result: null, isError: false };
        calls.push(call);
        byId.set(block.id, call);
      } else if (block.type === 'tool_result') {
        const call = byId.get(block.toolUseId);
        if (call) Object.assign(call, { result: resultLines(block.content), isError: block.isError });
      } else if (block.type === 'text' && entry.role === 'assistant' && block.text.trim()) {
        message = block.text.trim();
      }
    }
  }
  const out: string[] = [];
  for (const call of calls.slice(-STEPS.calls)) {
    out.push(`- ${call.name} ${call.input}`);
    out.push(call.result === null ? '  (still running)' : `  ${call.isError ? 'failed: ' : ''}${call.result.replace(/\n/g, '\n  ')}`);
  }
  if (message) out.push('', 'Its last message:', cut(message, STEPS.messageChars));
  return out.join('\n') || '(nothing recorded yet)';
}

export function supervisorPrompt(signal: HealthSignal, steps: string, task: TaskContext | null): string {
  return [
    `You are watching an AI coding agent${task ? ` working on the task "${task.taskName}"` : ''}. Agentry's health checks flagged it:`,
    '',
    `${signal.kind}: ${signal.reason}`,
    ...(signal.detail ? [`Detail: ${signal.detail}`] : []),
    ...(signal.hint ? [`Agentry's generic suggestion: ${signal.hint}`] : []),
    '',
    'Its last steps:',
    steps,
    '',
    'Write the hint a person following it would send it: one or two short lines addressed to the agent, specific to what it is doing, ' +
      'saying what to check or do differently. Reply with the hint only, no preamble. Do not change anything yourself.',
  ].join('\n');
}

/** The answer made fit to send: the first two lines that say something, and no more than a hint needs. */
export function hintFrom(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2);
  return cut(lines.join('\n'), HINT_MAX_CHARS);
}

/**
 * Wakes on a worker's bad health, once per signal per chat, and keeps what it proposed as a row.
 * The rule lives in the store (a unique key on chat and signal), so neither a monitor tick nor a
 * restart asks twice about the same thing.
 */
export class Supervisor {
  /** Chat and signal being asked about right now: the monitor can announce again before the answer is in */
  private readonly asking = new Set<string>();
  /** Chat and signal whose question failed: asking again on every change of the badge would spend without end */
  private readonly failed = new Set<string>();

  constructor(private readonly deps: SupervisorDeps) {}

  get config(): SupervisorConfig {
    return this.deps.settings.get();
  }

  /** Replaces the settings; a proposal already made keeps the cost and status it has. */
  configure(input: unknown): Promise<SupervisorConfig> {
    return this.deps.settings.set(input);
  }

  /**
   * Asks about the worst bad signal it has not asked about yet for this chat, and records the answer.
   * Resolves with the proposal, or null when there was nothing to ask or no usable answer.
   */
  async wake(chat: ChatRuntime, task: TaskContext | null, signals: readonly HealthSignal[]): Promise<SupervisorProposal | null> {
    const config = this.config;
    // Housekeeping is not supervised: that would be the supervisor watching itself
    if (!config.enabled || chat.origin === 'internal') return null;
    const answered = new Set(this.deps.db.proposalsOf(chat.id).map((p) => p.signal));
    const signal = signals.find((s) => {
      const key = `${chat.id}:${s.kind}`;
      return s.level === 'bad' && !answered.has(s.kind) && !this.asking.has(key) && !this.failed.has(key);
    });
    if (!signal) return null;
    const key = `${chat.id}:${signal.kind}`;
    this.asking.add(key);
    try {
      const steps = lastSteps(await this.deps.steps(chat.id).catch(() => []));
      const answer = await this.deps.ask({ prompt: supervisorPrompt(signal, steps, task), cwd: chat.workingDir, model: config.model, maxCostUsd: config.maxCostUsd });
      const costUsd = Number.isFinite(answer.costUsd) && answer.costUsd > 0 ? answer.costUsd : 0;
      // Spent whether or not the answer is usable, so it counts either way
      if (task && costUsd > 0) this.deps.charge(task.orchestrationId, costUsd);
      const hint = answer.isError ? '' : hintFrom(answer.text);
      if (!hint) {
        this.failed.add(key);
        return null;
      }
      const proposal: SupervisorProposal = {
        id: randomUUID(),
        chatId: chat.id,
        ...(task ? { taskId: task.taskId, orchestrationId: task.orchestrationId } : {}),
        signal: signal.kind,
        hint,
        costUsd,
        at: new Date().toISOString(),
        status: 'proposed',
      };
      if (!this.deps.db.saveProposal(proposal)) return null;
      const who = task?.taskName ?? chat.name;
      this.deps.emit({
        type: 'supervisor.proposed',
        title: `${who}: the supervisor proposes a hint`,
        ...runRef(chat),
        taskId: task?.taskId ?? null,
        taskName: task?.taskName ?? null,
        proposal,
      });
      if (!config.autoSend) return proposal;
      try {
        return await this.send(proposal.id, { chatId: chat.id });
      } catch {
        // The worker moved on before the answer came: the proposal stays for a person to judge
        return proposal;
      }
    } catch {
      this.failed.add(key);
      return null;
    } finally {
      this.asking.delete(key);
    }
  }

  private owned(id: string, owner: ProposalOwner): SupervisorProposal {
    const proposal = this.deps.db.proposal(id);
    const matches =
      proposal &&
      ('chatId' in owner ? proposal.chatId === owner.chatId : proposal.orchestrationId === owner.orchestrationId && proposal.taskId === owner.taskId);
    if (!proposal || !matches) throw new Error('proposal not found');
    if (proposal.status !== 'proposed') throw new SupervisorConflictError(`the proposal was already ${proposal.status}`);
    return proposal;
  }

  /** Sends the hint to the worker, then marks it sent: a hint that did not arrive stays proposed. */
  async send(id: string, owner: ProposalOwner): Promise<SupervisorProposal> {
    const proposal = this.owned(id, owner);
    await this.deps.hint(proposal);
    if (!this.deps.db.settleProposal(id, 'sent')) throw new SupervisorConflictError('the proposal was settled in the meantime');
    return { ...proposal, status: 'sent' };
  }

  dismiss(id: string, owner: ProposalOwner): SupervisorProposal {
    const proposal = this.owned(id, owner);
    if (!this.deps.db.settleProposal(id, 'dismissed')) throw new SupervisorConflictError('the proposal was settled in the meantime');
    return { ...proposal, status: 'dismissed' };
  }
}
