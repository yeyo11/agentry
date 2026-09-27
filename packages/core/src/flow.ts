import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_FLOW_MAX_PARALLEL,
  DOCUMENT_KINDS,
  FLOW_STAGE_OF_COLUMN,
  WORK_ITEM_STATUSES,
  type AgentryEvent,
  type ChatActivity,
  type DocumentKind,
  type FlowMemoryProposal,
  type FlowRun,
  type FlowRunAction,
  type FlowRunDocument,
  type FlowRunOutcome,
  type FlowRunState,
  type FlowStage,
  type FlowVerdict,
  type MemoryProposalTargetKind,
  type PermissionMode,
  type ProjectFlow,
  type ProjectSettings,
  type ProjectTeamMember,
  type WorkItem,
  type WorkItemActor,
  type WorkItemCause,
  type WorkItemRef,
  type WorkItemSource,
  type WorkItemStatus,
} from '@agentry/shared';
import type { Db } from './db.ts';
import type { AgentryEventInput } from './events.ts';
import { roleTitle } from './team.ts';
import { workItemPrompt } from './work-links.ts';
import type { WorkItemService } from './work-items.ts';

/**
 * The flow by column (decisions 28 to 30 of docs/plans/project-ecosystem.md): a card entering a
 * column that a team role answers for starts that role's run on the item, as its CLI agent, and the
 * run's structured result becomes a comment, memory proposals, document ties and, sometimes, a move.
 *
 * It starts paid agent runs on its own, so what it will not do matters as much as what it does:
 *
 * - Only a person's move, a new card, or the flow's own move starts a run. An item
 *   moved by a chat or an orchestration linked to it (the work-links automation) is already being
 *   worked on, and a run there would compete with it.
 * - At most `flow.maxParallel` runs of a project at once, one at a time per item, and one queued per
 *   item: a second trigger replaces the queued one rather than adding to it.
 * - A queued run whose item has left its column since (a person moved it) is cancelled, never
 *   started; a run that ends after a person moved the item writes its comment and moves nothing.
 * - The flow only moves forward (`backlog` to `todo`, `in_progress` to `in_review`), never to `done`,
 *   and backwards only on QA's failing verdict, at most `maxBounces` times in a round. Past that the
 *   item waits for the person, so no pair of roles can bounce an item between them for ever.
 * - Switching the flow, the Team module or the Board module off cancels what is queued and stops
 *   what is running.
 *
 * Driven by the event feed and the runtime's results, never by polling. Runs are rows, so a queue
 * and the runs a restart cut off are picked up again once the runtime is back (`recover`).
 */

/** The stable codes of the causes the flow writes into an item's history; a client translates them. */
export const FLOW_CAUSE = {
  refined: 'flow.refined',
  worked: 'flow.worked',
  rejected: 'flow.rejected',
  passed: 'flow.passed',
  exhausted: 'flow.bounces',
} as const;

/** Runs of a project listed with its team, ended ones included, newest last. */
const TEAM_RUNS = 200;
const SUMMARY_MAX = 20_000;
const PROPOSALS_MAX = 20;
const DOCUMENTS_MAX = 20;
const CRITERIA_MAX = 30;
const CRITERION_MAX = 500;
const DESCRIPTION_MAX = 50_000;

/** Tools every member may use; writing is added on top, by `writes` */
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/** What the flow knows of a project, read without waiting: its directory and its settings. */
export interface FlowProject {
  path: string;
  settings: ProjectSettings;
}

/** Everything a run's chat is started with. */
export interface FlowLaunch {
  run: FlowRun;
  item: WorkItem;
  member: ProjectTeamMember;
  prompt: string;
  appendSystemPrompt: string;
  jsonSchema: Record<string, unknown>;
  permissionMode: PermissionMode;
  allowedTools: string[];
  /** The chat to continue: the item's work chat, or this run's own chat cut off by a restart */
  resumeChatId: string | null;
}

export interface FlowDeps {
  db: Db;
  items: WorkItemService;
  /** Null when the project is not imported: its items keep their rows, but nothing runs there */
  project: (projectId: string) => FlowProject | null;
  /** The journal as it is handed to a run, for `--append-system-prompt` */
  handoff: (projectId: string) => string;
  propose: (projectId: string, proposal: FlowMemoryProposal, origin: { proposedBy: WorkItemActor; source: WorkItemSource; flowRunId: string; itemId: string }) => void;
  tie: (itemId: string, document: FlowRunDocument, options: { role: FlowStage; teamRole: string; chatId: string; actor: WorkItemActor; cause: WorkItemCause }) => Promise<void>;
  /**
   * Starts or continues the run's chat in the item's place. `onStart` hears of the chat in the tick
   * its process is spawned, before any of its output can arrive.
   */
  launch: (launch: FlowLaunch, onStart: (chatId: string) => void) => Promise<void>;
  /** A chat has a live execution now (a person may be working in it) */
  chatBusy: (chatId: string) => boolean;
  stop: (chatId: string) => void;
  activity?: (chatId: string) => ChatActivity | null;
  emit: (event: AgentryEventInput) => void;
}

/** What a run's chat ended with, as the runtime reports it. */
export interface FlowChatResult {
  isError: boolean;
  result: string;
  structuredOutput: unknown;
}

interface RunRow {
  seq: number;
  id: string;
  project_id: string;
  item_id: string;
  role: string;
  agent: string;
  model: string;
  stage: string;
  column_name: string;
  state: string;
  chat_id: string | null;
  outcome: string | null;
  summary: string | null;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  ended_at: string | null;
}

/** The structured result, read defensively: the CLI checks it against the schema, but a result can still be anything. */
interface ParsedResult {
  summary: string;
  verdict: FlowVerdict | null;
  memoryProposals: FlowMemoryProposal[];
  documents: FlowRunDocument[];
  /** Refining only: the item's new description */
  description: string | null;
  /** Refining only: criteria to add */
  acceptanceCriteria: string[];
}

const TARGET_KINDS: readonly MemoryProposalTargetKind[] = ['instructions', 'memory', 'journal'];

/** The JSON Schema a run's result is held to (`--json-schema`); refining may also rewrite the item. */
export function flowResultSchema(stage: FlowStage): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    summary: { type: 'string', description: 'What you did and found; it becomes your comment on the work item' },
    memoryProposals: {
      type: 'array',
      description: 'What the team should remember; a person approves each one before it is written',
      items: {
        type: 'object',
        properties: {
          target: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: [...TARGET_KINDS] },
              file: { type: ['string', 'null'], description: 'For memory: the memory file name, such as testing.md' },
              section: { type: ['string', 'null'], description: 'For instructions: the CLAUDE.md heading it goes under' },
            },
            required: ['kind'],
          },
          text: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['target', 'text', 'reason'],
      },
    },
    documents: {
      type: 'array',
      description: 'Every document you wrote in the documents folder, relative to the project',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, kind: { type: 'string', enum: [...DOCUMENT_KINDS] } },
        required: ['path', 'kind'],
      },
    },
  };
  const required = ['summary', 'memoryProposals', 'documents'];
  if (stage === 'verify') {
    properties.verdict = { type: 'string', enum: ['pass', 'fail'], description: 'pass only when every acceptance criterion is met' };
    required.push('verdict');
  }
  if (stage === 'refine') {
    properties.description = { type: 'string', description: "The item's complete new description in Markdown; leave it out to keep the current one" };
    properties.acceptanceCriteria = { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria to add to the item' };
  }
  return { type: 'object', properties, required };
}

/**
 * The permission rules a member's `writes` becomes. With no `writes`, edits are accepted anywhere in
 * the place it works. With them, the session runs in `dontAsk`, which denies whatever is not allowed
 * outright, and only edits under those paths are allowed: the CLI's rules cannot say "every path but
 * these", so the paths are allowed rather than the rest denied. A shell command can still write
 * files; `writes` bounds the edit tools, as the member's screen says.
 */
export function writeRules(writes: readonly string[] | undefined): { permissionMode: PermissionMode; allowedTools: string[] } {
  if (!writes) return { permissionMode: 'acceptEdits', allowedTools: [...READ_TOOLS, ...WRITE_TOOLS] };
  const rules: string[] = [];
  for (const raw of writes) {
    const path = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    // A comma splits the flag's list and a parenthesis closes the rule: such a path cannot be said
    // safely, and leaving it out allows less, never more
    if (!path || /[,()\s]/.test(path) || path.startsWith('/') || path.split('/').includes('..')) continue;
    const patterns = /[*?[]/.test(path) ? [path] : [path, `${path}/**`];
    for (const p of patterns) for (const tool of WRITE_TOOLS) rules.push(`${tool}(${p})`);
  }
  return { permissionMode: 'dontAsk', allowedTools: [...READ_TOOLS, ...new Set(rules)] };
}

/** The stage's instructions, then the item as "Work on it" gives it. */
export function flowPrompt(stage: FlowStage, column: WorkItemStatus, item: WorkItem, member: ProjectTeamMember, extra: { documentsPath: string; rejection: string | null }): string {
  const who = `You are the ${roleTitle(member.role)} of this project's team, started by Agentry's flow by column because ${item.key} entered ${column}.`;
  const lines = [workItemPrompt(item), '', '---', '', who, ''];
  if (stage === 'refine' && column === 'backlog') {
    lines.push(
      'Refine it so a developer can start without asking: complete its description and its acceptance criteria.',
      'Return the whole new description in `description` (leave it out to keep the current one) and the criteria to add in `acceptanceCriteria`.',
      `When a specification helps, write it as Markdown under \`${extra.documentsPath}/\` and report it in \`documents\` with kind \`spec\`.`,
      'Do not change the code. Agentry moves the item to todo once your run ends well.',
    );
  } else if (stage === 'refine') {
    lines.push(
      'Check that it is ready to be worked on: its acceptance criteria are complete and testable, and nothing blocks it.',
      'Return anything missing in `description` or `acceptanceCriteria`, and say in `summary` whether it is ready. It stays in todo until a person moves it on.',
    );
  } else if (stage === 'work') {
    lines.push('Implement it here, in its worktree, and commit your work on its branch.');
    if (extra.rejection) lines.push('', 'Verification sent it back with this comment; address every point:', '', extra.rejection);
    lines.push(
      '',
      `An architecture decision worth keeping goes under \`${extra.documentsPath}/\`, reported in \`documents\` with kind \`adr\`.`,
      'Agentry moves the item to in_review once your run ends well.',
    );
  } else {
    lines.push(
      'Verify it against each acceptance criterion, on this worktree and its branch: read the changes, run the tests.',
      'Give `verdict: pass` only when every criterion is met; otherwise `fail`, and say in `summary` what is missing so the developer can fix it.',
      `A verification report, when useful, goes under \`${extra.documentsPath}/\` with kind \`report\`. Do not change the code.`,
    );
  }
  lines.push('', 'End with the structured result. Never move the item to done: a person approves that.');
  return lines.join('\n');
}

export class FlowService {
  private readonly sql: DatabaseSync;
  /** One dispatch at a time: claiming reads the counts, and two at once could both see a free place */
  private dispatching: Promise<void> = Promise.resolve();
  private recovered = false;

  constructor(private readonly deps: FlowDeps) {
    this.sql = deps.db.connection;
  }

  // ---------- reading ----------

  /** `GET /projects/:id/flow`. */
  projectFlow(projectId: string): ProjectFlow {
    const project = this.deps.project(projectId);
    const rows = this.sql.prepare("SELECT * FROM flow_runs WHERE project_id = ? AND state != 'ended' ORDER BY seq").all(projectId) as unknown as RunRow[];
    const runs = rows.map((r) => this.runOf(r));
    return {
      projectId,
      enabled: !!project && active(project.settings),
      maxParallel: project ? maxParallel(project.settings) : DEFAULT_FLOW_MAX_PARALLEL,
      running: runs.filter((r) => r.state === 'running'),
      queued: runs.filter((r) => r.state === 'queued'),
    };
  }

  /** Every run of a project still going, and its latest ended ones: what the Team screen reads. */
  runs(projectId: string): FlowRun[] {
    const live = this.sql.prepare("SELECT * FROM flow_runs WHERE project_id = ? AND state != 'ended' ORDER BY seq").all(projectId) as unknown as RunRow[];
    const ended = this.sql
      .prepare("SELECT * FROM flow_runs WHERE project_id = ? AND state = 'ended' ORDER BY seq DESC LIMIT ?")
      .all(projectId, TEAM_RUNS) as unknown as RunRow[];
    return [...ended.reverse(), ...live].map((r) => this.runOf(r));
  }

  run(runId: string): FlowRun | null {
    const row = this.row(runId);
    return row ? this.runOf(row) : null;
  }

  /** A run's chat is the flow's while the run goes on: the work-links automation leaves it alone. */
  ownsChat(chatId: string): boolean {
    return !!this.sql.prepare("SELECT 1 FROM flow_runs WHERE chat_id = ? AND state = 'running' LIMIT 1").get(chatId);
  }

  // ---------- what starts it ----------

  /** Everything on the feed goes through here; handlers swallow their failures, as they run inside someone else's event. */
  observe(event: AgentryEvent): void {
    try {
      switch (event.type) {
        case 'workitem.moved':
          if (event.status === event.previousStatus) break;
          if (event.status === 'done') {
            this.cancelQueued(event.itemId, 'the item was done');
            break;
          }
          if (this.startsRuns(event.actor, event.cause)) this.trigger(event.itemId, event.status);
          else this.cancelQueued(event.itemId, 'the item moved');
          break;
        case 'workitem.created':
          // Every path that makes a card is a person's doing (the board, "create a task from this
          // message"); an orchestration never makes one (decision 23)
          this.trigger(event.itemId, event.status);
          break;
        case 'workitem.removed':
          this.cancelQueued(event.itemId, 'the item was removed');
          break;
        case 'project.updated':
          if (event.changes.includes('modules') || event.changes.includes('settings')) this.settingsChanged(event.projectId);
          break;
        case 'run.ended':
          this.chatEnded(event.runId, event.error);
          // A place in the runtime came free: a run held back by its limit may start
          this.dispatch();
          break;
        case 'run.removed':
          this.chatEnded(event.runId, 'the chat was removed');
          break;
        default:
          break;
      }
    } catch {
      // see the method comment
    }
  }

  /**
   * A person's move, and the flow's own. A move made by a chat or an orchestration following its
   * own work (`system`), or by an agent outside the flow, starts nothing.
   */
  private startsRuns(actor: WorkItemActor, cause: WorkItemCause | null): boolean {
    if (actor.kind === 'person') return true;
    return actor.kind === 'agent' && !!cause?.event.startsWith('flow.');
  }

  /** A card entered a column: queue the run of the role that answers for it, replacing any run still queued for the item. */
  private trigger(itemId: string, column: WorkItemStatus): void {
    const item = this.deps.items.find(itemId);
    if (!item) return;
    const project = this.deps.project(item.projectId);
    const stage = FLOW_STAGE_OF_COLUMN[column];
    const role = project?.settings.flow?.columns[column];
    const member = role && project ? memberOf(project.settings, role) : null;
    if (!project || !active(project.settings) || !stage || !member || item.type === 'epic' || item.status !== column) {
      this.cancelQueued(itemId, 'the item moved');
      return;
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    let replaced: RunRow | undefined;
    this.write(() => {
      replaced = this.sql.prepare("SELECT * FROM flow_runs WHERE item_id = ? AND state = 'queued'").get(itemId) as RunRow | undefined;
      if (replaced) this.endRow(replaced.id, 'cancelled', null, 'the item moved again before it started', now);
      this.sql
        .prepare(
          `INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, queued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(id, item.projectId, itemId, member.role, member.agent, member.model, stage, column, now);
    });
    if (replaced) this.announce(replaced.id, 'ended');
    this.announce(id, 'queued');
    this.dispatch();
  }

  private cancelQueued(itemId: string, why: string): void {
    const rows = this.sql.prepare("SELECT id FROM flow_runs WHERE item_id = ? AND state = 'queued'").all(itemId) as Array<{ id: string }>;
    for (const { id } of rows) this.end(id, 'cancelled', null, why);
  }

  /**
   * The flow or one of the modules it needs went off: nothing queued starts, and what runs is
   * stopped, so switching it off is how a person stops it spending. Otherwise the limit may have
   * risen, and the queue gets another look.
   */
  settingsChanged(projectId: string): void {
    const project = this.deps.project(projectId);
    if (project && active(project.settings)) {
      this.dispatch();
      return;
    }
    const rows = this.sql.prepare("SELECT * FROM flow_runs WHERE project_id = ? AND state != 'ended' ORDER BY seq").all(projectId) as unknown as RunRow[];
    for (const row of rows) {
      this.end(row.id, 'cancelled', null, 'the flow was switched off');
      if (row.state === 'running' && row.chat_id) {
        try {
          this.deps.stop(row.chat_id);
        } catch {
          // already gone
        }
      }
    }
  }

  // ---------- starting ----------

  /**
   * Starts what the limits allow, oldest first. Serialised, and each row is claimed with a guarded
   * update, so neither two dispatches nor two processes on one database start the same run.
   */
  dispatch(): void {
    if (!this.recovered) return;
    this.dispatching = this.dispatching.then(() => this.dispatchNow()).catch(() => undefined);
  }

  /** Waits for every dispatch asked for so far; for tests and for shutting down cleanly. */
  settled(): Promise<void> {
    return this.dispatching;
  }

  private async dispatchNow(): Promise<void> {
    const queued = this.sql.prepare("SELECT * FROM flow_runs WHERE state = 'queued' ORDER BY seq").all() as unknown as RunRow[];
    const launches: Array<Promise<void>> = [];
    for (const row of queued) {
      const claimed = this.claim(row);
      if (claimed) launches.push(this.start(claimed.row, claimed.item, claimed.member, claimed.project));
    }
    await Promise.all(launches);
  }

  /** Decides whether a queued run starts now, stays queued, or is moot; claims it when it starts. */
  private claim(row: RunRow): { row: RunRow; item: WorkItem; member: ProjectTeamMember; project: FlowProject } | null {
    const project = this.deps.project(row.project_id);
    if (!project || !active(project.settings)) {
      this.end(row.id, 'cancelled', null, 'the flow was switched off');
      return null;
    }
    const item = this.deps.items.find(row.item_id);
    // The item left the column that started the run: a person's move wins over a queued run
    if (!item || item.status !== row.column_name) {
      this.end(row.id, 'cancelled', null, item ? 'the item left the column before the run started' : 'the item was removed');
      return null;
    }
    const member = memberOf(project.settings, row.role);
    if (!member || project.settings.flow?.columns[item.status] !== row.role) {
      this.end(row.id, 'cancelled', null, 'nobody on the team answers for the column now');
      return null;
    }
    const running = this.sql.prepare("SELECT item_id FROM flow_runs WHERE project_id = ? AND state = 'running'").all(row.project_id) as Array<{ item_id: string }>;
    if (running.length >= maxParallel(project.settings)) return null;
    // One run at a time on an item: the next waits for the one working on it
    if (running.some((r) => r.item_id === row.item_id)) return null;
    const now = new Date().toISOString();
    const claimed = this.sql
      .prepare("UPDATE flow_runs SET state = 'running', started_at = ?, agent = ?, model = ? WHERE id = ? AND state = 'queued'")
      .run(now, member.agent, member.model, row.id);
    if (claimed.changes !== 1) return null;
    return { row: { ...row, state: 'running', started_at: now, agent: member.agent, model: member.model }, item, member, project };
  }

  private async start(row: RunRow, item: WorkItem, member: ProjectTeamMember, project: FlowProject): Promise<void> {
    const stage = row.stage as FlowStage;
    // A person working in the item's chat now is working on it: the run is moot. The flow's own chats
    // do not count: one whose run just ended is still closing its process as the next role starts
    const own = new Set((this.sql.prepare('SELECT chat_id FROM flow_runs WHERE item_id = ? AND chat_id IS NOT NULL').all(item.id) as Array<{ chat_id: string }>).map((r) => r.chat_id));
    const busy = this.deps.items.links(item.id).find((l) => l.kind === 'chat' && l.chatId && !own.has(l.chatId) && this.deps.chatBusy(l.chatId));
    if (busy) {
      this.end(row.id, 'cancelled', null, 'a chat is already working on the item');
      return;
    }
    const resumeChatId = row.chat_id ?? (stage === 'work' ? this.workChat(item.id) : null);
    const rules = writeRules(member.writes);
    const launch: FlowLaunch = {
      run: this.runOf(row),
      item,
      member,
      prompt: row.chat_id
        ? 'Agentry restarted while you were on this run. Carry on from where you were, and end with the structured result.'
        : flowPrompt(stage, row.column_name as WorkItemStatus, item, member, {
            documentsPath: project.settings.documents?.path ?? 'docs',
            rejection: stage === 'work' && (item.bounces ?? 0) > 0 ? this.rejection(item.id, project.settings) : null,
          }),
      appendSystemPrompt: this.deps.handoff(item.projectId),
      jsonSchema: flowResultSchema(stage),
      permissionMode: rules.permissionMode,
      allowedTools: rules.allowedTools,
      resumeChatId,
    };
    let started = false;
    try {
      await this.deps.launch(launch, (chatId) => {
        started = true;
        this.sql.prepare('UPDATE flow_runs SET chat_id = ? WHERE id = ?').run(chatId, row.id);
        this.announce(row.id, 'started');
      });
      if (!started) throw new Error('the chat did not start');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!started && /concurrent run limit/i.test(message)) {
        // The runtime is full: back in the queue, in its place, until a chat ends
        this.sql.prepare("UPDATE flow_runs SET state = 'queued', started_at = NULL WHERE id = ? AND state = 'running'").run(row.id);
        return;
      }
      this.end(row.id, 'failed', null, message);
    }
  }

  /** The item's latest work chat, which a Developer's run continues. */
  private workChat(itemId: string): string | null {
    const links = this.deps.items.links(itemId).filter((l) => l.kind === 'chat' && l.role === 'work' && l.chatId);
    return links[links.length - 1]?.chatId ?? null;
  }

  /** The newest comment of the role that verifies: what sent the item back. */
  private rejection(itemId: string, settings: ProjectSettings): string | null {
    const verifier = settings.flow?.columns.in_review;
    const comments = this.deps.items.comments(itemId).filter((c) => c.author.kind === 'agent' && (!verifier || c.author.role === verifier));
    return comments[comments.length - 1]?.body ?? null;
  }

  // ---------- ending ----------

  /** A result of a chat. Only a running run's chat counts; a chat continued by hand afterwards is not the flow's. */
  chatResult(chatId: string, result: FlowChatResult): Promise<void> {
    try {
      const row = this.sql.prepare("SELECT * FROM flow_runs WHERE chat_id = ? AND state = 'running'").get(chatId) as RunRow | undefined;
      if (!row) return Promise.resolve();
      return this.finish(row, result).catch(() => undefined);
    } catch {
      // Heard from the runtime's own event: a closed database (shutting down) must not become its error
      return Promise.resolve();
    }
  }

  /** The chat's process ended; a run still going got no result, and failed. */
  chatEnded(chatId: string, error: string | null): void {
    const row = this.sql.prepare("SELECT * FROM flow_runs WHERE chat_id = ? AND state = 'running'").get(chatId) as RunRow | undefined;
    if (!row) return;
    this.end(row.id, 'failed', null, error ?? 'the chat ended without a result');
    this.dispatch();
  }

  private async finish(row: RunRow, result: FlowChatResult): Promise<void> {
    const parsed = result.isError ? null : parseResult(result.structuredOutput, row.stage as FlowStage);
    const failure = result.isError ? result.result || 'the chat failed' : parsed ? null : 'the run ended without a readable structured result';
    const verdictMissing = !!parsed && row.stage === 'verify' && !parsed.verdict;
    const outcome: FlowRunOutcome = failure || verdictMissing ? 'failed' : parsed?.verdict === 'fail' ? 'rejected' : 'passed';
    // Ended first, so the move below finds no run on the item and the next role can start
    if (!this.end(row.id, outcome, parsed?.summary ?? null, failure ?? (verdictMissing ? 'verification ended without a verdict' : null))) return;
    try {
      if (parsed) await this.apply(row, parsed, outcome);
    } finally {
      this.dispatch();
    }
  }

  /** Writes what a run produced, then makes the move it earned when nothing has overtaken it. */
  private async apply(row: RunRow, result: ParsedResult, outcome: FlowRunOutcome): Promise<void> {
    const item = this.deps.items.find(row.item_id);
    const project = this.deps.project(row.project_id);
    if (!item || !project || !row.chat_id) return;
    const settings = project.settings;
    const board = settings.modules.includes('board');
    const actor: WorkItemActor = { kind: 'agent', role: row.role };
    const source: WorkItemSource = { kind: 'chat', chatId: row.chat_id, orchestrationId: null, taskId: null };
    const cause = (event: string): WorkItemCause => ({ ...source, event });
    const personSince = this.personMovedSince(item.id, row.started_at ?? row.queued_at);

    if (board && result.summary) this.deps.items.comment(item.id, { body: result.summary }, { actor, source, cause: cause(`flow.${row.stage}`) });
    if (board && row.stage === 'refine') this.refineItem(item, result, actor, cause(FLOW_CAUSE.refined), row.started_at ?? row.queued_at);
    if (settings.modules.includes('memory')) {
      for (const proposal of result.memoryProposals) {
        try {
          this.deps.propose(item.projectId, proposal, { proposedBy: actor, source, flowRunId: row.id, itemId: item.id });
        } catch {
          // a target that could never be written: the others still go
        }
      }
    }
    if (board && settings.modules.includes('documents')) {
      for (const document of result.documents) {
        await this.deps.tie(item.id, document, { role: row.stage as FlowStage, teamRole: row.role, chatId: row.chat_id, actor, cause: cause(`flow.${row.stage}`) }).catch(() => undefined);
      }
    }

    // A move needs the flow still on, the item still where the run found it, and no person since
    const current = this.deps.items.find(item.id);
    if (!current || !board || !active(settings) || current.status !== row.column_name || personSince) return;
    if (row.stage === 'refine' && row.column_name === 'backlog' && outcome === 'passed') {
      this.deps.items.move(item.id, { status: 'todo' }, { actor, cause: cause(FLOW_CAUSE.refined) });
    } else if (row.stage === 'work' && outcome === 'passed') {
      this.deps.items.move(item.id, { status: 'in_review' }, { actor, cause: cause(FLOW_CAUSE.worked) });
    } else if (row.stage === 'verify' && outcome === 'passed') {
      this.deps.items.setFlowState(item.id, { waiting: 'approval' }, { actor, cause: cause(FLOW_CAUSE.passed) });
    } else if (row.stage === 'verify' && outcome === 'rejected') {
      const bounces = current.bounces ?? 0;
      const max = settings.flow?.maxBounces ?? 0;
      if (bounces >= max) {
        this.deps.items.setFlowState(item.id, { waiting: 'bounces' }, { actor, cause: cause(FLOW_CAUSE.exhausted) });
      } else {
        this.deps.items.setFlowState(item.id, { bounces: bounces + 1, waiting: null }, { actor, cause: cause(FLOW_CAUSE.rejected) });
        this.deps.items.move(item.id, { status: 'in_progress' }, { actor, cause: cause(FLOW_CAUSE.rejected) });
      }
    }
  }

  /** The Product Owner's description and criteria, unless a person edited them while it worked. */
  private refineItem(item: WorkItem, result: ParsedResult, actor: WorkItemActor, cause: WorkItemCause, since: string): void {
    const history = this.deps.items.history(item.id).filter((e) => e.actor.kind === 'person' && e.createdAt >= since);
    const changes: { description?: string; acceptanceCriteria?: Array<{ id?: string; text: string }> } = {};
    if (result.description !== null && !history.some((e) => e.change === 'description')) changes.description = result.description;
    if (result.acceptanceCriteria.length && !history.some((e) => e.change === 'criterion')) {
      const have = new Set(item.acceptanceCriteria.map((c) => c.text.trim().toLowerCase()));
      const added = result.acceptanceCriteria.filter((t) => {
        const key = t.trim().toLowerCase();
        if (have.has(key)) return false;
        have.add(key);
        return true;
      });
      if (added.length) changes.acceptanceCriteria = [...item.acceptanceCriteria.map((c) => ({ id: c.id, text: c.text })), ...added.map((text) => ({ text }))];
    }
    if (changes.description === undefined && changes.acceptanceCriteria === undefined) return;
    try {
      this.deps.items.update(item.id, changes, { actor, cause });
    } catch {
      // too many criteria, or a text the store refuses: the comment still says what was proposed
    }
  }

  private personMovedSince(itemId: string, since: string): boolean {
    return this.deps.items.history(itemId).some((e) => e.change === 'status' && e.actor.kind === 'person' && e.createdAt >= since);
  }

  // ---------- a restart ----------

  /**
   * Once the runtime has restored its chats: a run cut off by the restart goes back to the queue,
   * keeping its chat so it continues there, and the queue starts moving. Before this nothing
   * starts, since a chat still being restored would look like one that ended.
   */
  recover(): void {
    const running = this.sql.prepare("SELECT * FROM flow_runs WHERE state = 'running' ORDER BY seq").all() as unknown as RunRow[];
    for (const row of running) {
      if (row.chat_id && this.deps.chatBusy(row.chat_id)) continue;
      let requeued = false;
      this.write(() => {
        const queued = this.sql.prepare("SELECT 1 FROM flow_runs WHERE item_id = ? AND state = 'queued'").get(row.item_id);
        if (queued) return;
        this.sql.prepare("UPDATE flow_runs SET state = 'queued', started_at = NULL WHERE id = ?").run(row.id);
        requeued = true;
      });
      // A newer trigger for the item already waits, and replaces the run that was cut off
      if (!requeued) this.end(row.id, 'cancelled', null, 'cut off by a restart, and the item moved since');
    }
    this.recovered = true;
    this.dispatch();
  }

  // ---------- rows ----------

  /** Ends a run that has not ended yet; false when it already had, so a late result changes nothing. */
  private end(runId: string, outcome: FlowRunOutcome, summary: string | null, error: string | null): boolean {
    const ended = this.endRow(runId, outcome, summary, error, new Date().toISOString());
    if (ended) this.announce(runId, 'ended');
    return ended;
  }

  private endRow(runId: string, outcome: FlowRunOutcome, summary: string | null, error: string | null, at: string): boolean {
    const r = this.sql
      .prepare("UPDATE flow_runs SET state = 'ended', outcome = ?, summary = ?, error = ?, ended_at = ? WHERE id = ? AND state != 'ended'")
      .run(outcome, summary === null ? null : summary.slice(0, SUMMARY_MAX), error === null ? null : error.slice(0, 2000), at, runId);
    return r.changes === 1;
  }

  private write(fn: () => void): void {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.sql.exec('COMMIT');
    } catch (err) {
      try {
        this.sql.exec('ROLLBACK');
      } catch {
        // already ended by SQLite
      }
      throw err;
    }
  }

  private row(runId: string): RunRow | null {
    return (this.sql.prepare('SELECT * FROM flow_runs WHERE id = ?').get(runId) as RunRow | undefined) ?? null;
  }

  private runOf(row: RunRow): FlowRun {
    const item = this.deps.items.find(row.item_id);
    const ref: WorkItemRef | null = item ? { id: item.id, key: item.key, title: item.title, type: item.type, status: item.status } : null;
    const state = row.state as FlowRunState;
    return {
      id: row.id,
      projectId: row.project_id,
      itemId: row.item_id,
      item: ref,
      role: row.role,
      agent: row.agent,
      model: row.model,
      stage: row.stage as FlowStage,
      column: row.column_name as WorkItemStatus,
      state,
      chatId: row.chat_id,
      ...(state === 'running' && row.chat_id && this.deps.activity ? { activity: this.deps.activity(row.chat_id) } : {}),
      outcome: (row.outcome as FlowRunOutcome | null) ?? null,
      summary: row.summary,
      queuedAt: row.queued_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }

  private announce(runId: string, action: FlowRunAction): void {
    const run = this.run(runId);
    if (!run) return;
    const key = run.item?.key ?? run.itemId;
    const title =
      action === 'queued'
        ? `${roleTitle(run.role)} queued on ${key}`
        : action === 'started'
          ? `${roleTitle(run.role)} started on ${key}`
          : `${roleTitle(run.role)} ${run.outcome ?? 'ended'} on ${key}`;
    try {
      this.deps.emit({
        type: 'flow.run',
        title,
        projectId: run.projectId,
        itemId: run.itemId,
        key,
        runId: run.id,
        action,
        role: run.role,
        agent: run.agent,
        stage: run.stage,
        chatId: run.chatId,
        outcome: run.outcome,
      });
    } catch {
      // the row is written; a broken listener must not undo the run
    }
  }
}

/** The flow runs only while it is on, and the Team and Board modules with it. */
function active(settings: ProjectSettings): boolean {
  return !!settings.flow?.enabled && settings.modules.includes('team') && settings.modules.includes('board');
}

function maxParallel(settings: ProjectSettings): number {
  return settings.flow?.maxParallel ?? DEFAULT_FLOW_MAX_PARALLEL;
}

function memberOf(settings: ProjectSettings, role: string): ProjectTeamMember | null {
  return settings.team?.members.find((m) => m.role === role) ?? null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Reads a run's structured result; null when it is not one. Oversized lists are cut, not refused. */
export function parseResult(raw: unknown, stage: FlowStage): ParsedResult | null {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!isObject(value)) return null;
  const summary = typeof value.summary === 'string' ? value.summary.trim().slice(0, SUMMARY_MAX) : null;
  if (summary === null) return null;
  const verdict = value.verdict === 'pass' || value.verdict === 'fail' ? value.verdict : null;
  const memoryProposals: FlowMemoryProposal[] = [];
  for (const p of Array.isArray(value.memoryProposals) ? value.memoryProposals.slice(0, PROPOSALS_MAX) : []) {
    if (!isObject(p) || !isObject(p.target)) continue;
    const kind = TARGET_KINDS.find((k) => k === (p.target as Record<string, unknown>).kind);
    const text = str(p.text);
    if (!kind || !text) continue;
    memoryProposals.push({ target: { kind, file: str(p.target.file), section: str(p.target.section) }, text, reason: str(p.reason) ?? '' });
  }
  const documents: FlowRunDocument[] = [];
  for (const d of Array.isArray(value.documents) ? value.documents.slice(0, DOCUMENTS_MAX) : []) {
    if (!isObject(d)) continue;
    const path = str(d.path);
    const kind: DocumentKind = DOCUMENT_KINDS.find((k) => k === d.kind) ?? 'doc';
    if (path) documents.push({ path, kind });
  }
  const refining = stage === 'refine';
  const description = refining && typeof value.description === 'string' && value.description.trim() ? value.description.trim().slice(0, DESCRIPTION_MAX) : null;
  const acceptanceCriteria = refining && Array.isArray(value.acceptanceCriteria)
    ? value.acceptanceCriteria
        .map(str)
        .filter((t): t is string => t !== null)
        .map((t) => t.slice(0, CRITERION_MAX))
        .slice(0, CRITERIA_MAX)
    : [];
  return { summary, verdict, memoryProposals, documents, description, acceptanceCriteria };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Columns in board order, for a client or a test that walks them. */
export const FLOW_COLUMNS: readonly WorkItemStatus[] = WORK_ITEM_STATUSES.filter((s) => FLOW_STAGE_OF_COLUMN[s] !== null);
