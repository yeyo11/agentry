import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_FLOW_MAX_PARALLEL,
  DOCUMENT_KINDS,
  FLOW_RUN_STATUSES,
  FLOW_RUNS_PAGE,
  FLOW_RUNS_PAGE_MAX,
  FLOW_STAGE_OF_COLUMN,
  isTeamCommandPattern,
  MAX_FLOW_RESTARTS,
  type AgentryEvent,
  type ChatActivity,
  type DocumentKind,
  type FlowCriterionResult,
  type FlowMemoryProposal,
  type FlowRun,
  type FlowRunAction,
  type FlowRunDocument,
  type FlowRunOutcome,
  type FlowRunPage,
  type FlowRunQuery,
  type FlowRunState,
  type FlowRunStatus,
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
  type WorkItemChange,
  type WorkItemRef,
  type WorkItemSource,
  type WorkItemStatus,
} from '@agentry/shared';
import type { RunResult } from './chats.ts';
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
 *   what is running, and so does removing the item.
 * - Each stage gets only the tools it needs (`stageRules`), and `git push` is always denied. A
 *   project that sets `flow.maxCostUsd` has every run held to it by the CLI (`--max-budget-usd`).
 * - A member works in chats of its own. It never takes over a person's chat, and a run cut off by
 *   a restart goes on only in its own chat, at most `MAX_FLOW_RESTARTS` times; otherwise it fails,
 *   and says so on the item, as every failed run does.
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
  failed: 'flow.failed',
} as const;

/** Runs of a project listed with its team, ended ones included, newest last. */
const TEAM_RUNS = 200;
const SUMMARY_MAX = 20_000;
const PROPOSALS_MAX = 20;
const DOCUMENTS_MAX = 20;
const CRITERIA_MAX = 30;
const CRITERION_MAX = 500;
const DESCRIPTION_MAX = 50_000;

/** Tools every stage may use; the rest is added per stage (`stageRules`) */
const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
/** Only the work stage reaches the network: refining and verifying read the project */
const WEB_TOOLS = ['WebFetch', 'WebSearch'];
/** Denied to every run, whatever its stage allows: a member's work stays on the item's branch until a person takes it further */
const DENIED_TOOLS = ['Bash(git push)', 'Bash(git push *)'];
/** What verifying may ask git: reading the changes, never writing */
const GIT_READS = ['status', 'diff', 'log', 'show'].flatMap((c) => [`Bash(git ${c})`, `Bash(git ${c} *)`]);
/** `--output` makes those same commands write a file anywhere, so it is denied beside them */
const GIT_OUTPUT_DENIED = ['diff', 'log', 'show'].map((c) => `Bash(git ${c} *--output*)`);

/** A request the flow refuses, with the status the API answers it with. */
export class FlowError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404,
  ) {
    super(message);
  }
}

/**
 * The query of `GET /projects/:id/flow/runs` as the query string carries it (lists comma separated),
 * checked: an unknown status, a limit out of range or a cursor this service did not write is refused.
 */
export function parseFlowRunQuery(raw: Record<string, unknown> | undefined): FlowRunQuery {
  const query: FlowRunQuery = {};
  const list = (value: unknown, field: string): string[] | undefined => {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' && !Array.isArray(value)) throw new FlowError(`${field} must be a comma separated list`, 400);
    const values = (Array.isArray(value) ? value : [value]).flatMap((v) => (typeof v === 'string' ? v.split(',') : [])).map((v) => v.trim()).filter(Boolean);
    return values.length ? [...new Set(values)] : undefined;
  };
  const agents = list(raw?.agent, 'agent');
  if (agents) query.agent = agents;
  const statuses = list(raw?.status, 'status');
  if (statuses) {
    const unknown = statuses.filter((v) => !(FLOW_RUN_STATUSES as readonly string[]).includes(v));
    if (unknown.length) throw new FlowError(`unknown status ${unknown.join(', ')}; a run is ${FLOW_RUN_STATUSES.join(', ')}`, 400);
    query.status = statuses as FlowRunStatus[];
  }
  if (typeof raw?.itemId === 'string' && raw.itemId) query.itemId = raw.itemId;
  if (raw?.limit !== undefined && raw.limit !== '') {
    const limit = Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > FLOW_RUNS_PAGE_MAX) throw new FlowError(`limit must be a whole number from 1 to ${FLOW_RUNS_PAGE_MAX}`, 400);
    query.limit = limit;
  }
  if (typeof raw?.cursor === 'string' && raw.cursor) {
    cursorSeq(raw.cursor);
    query.cursor = raw.cursor;
  }
  return query;
}

/** A page's cursor is the position of its last run, so the next page starts after it whatever was added since. */
function cursorOf(seq: number): string {
  return Buffer.from(JSON.stringify({ seq }), 'utf8').toString('base64url');
}

function cursorSeq(cursor: string): number {
  try {
    const seq = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { seq?: unknown }).seq;
    if (typeof seq === 'number' && Number.isInteger(seq) && seq > 0) return seq;
  } catch {
    // refused below
  }
  throw new FlowError('cursor is not one this list gave out', 400);
}

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
  disallowedTools: string[];
  /** `--max-budget-usd`: `flow.maxCostUsd`, or null when the project sets none */
  maxBudgetUsd: number | null;
  /** The chat to continue: the Developer's own chat from an earlier run, or this run's own chat cut off by a restart */
  resumeChatId: string | null;
  /**
   * This run's own chat, cut off by a restart: it goes on there or not at all. A new chat would
   * start with none of the item's context, so a chat that cannot be continued fails the run.
   */
  continuing: boolean;
  /**
   * Whether the run works in the item's worktree. Refining changes no code, and its specification
   * belongs where the Documents module reads, so it works in the project's own checkout and makes
   * no worktree for every card it refines.
   */
  inWorktree: boolean;
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
  /**
   * The chat's turn hit its account's rate limit and the account rotation is on its way for it: the
   * run waits to go on in the same chat on the next account (`rotated`) rather than fail. False when
   * the rotation is off or has nothing left to try.
   */
  rotating?: (chatId: string) => boolean;
  stop: (chatId: string) => void;
  activity?: (chatId: string) => ChatActivity | null;
  emit: (event: AgentryEventInput) => void;
}

/** What a run's chat ended with, as the runtime reports it. */
export type FlowChatResult = Pick<RunResult, 'isError' | 'result' | 'structuredOutput' | 'cause'>;

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
  restarts: number;
}

/** The structured result, read defensively: the CLI checks it against the schema, but a result can still be anything. */
interface ParsedResult {
  summary: string;
  verdict: FlowVerdict | null;
  /** Verifying only: each criterion judged on its own */
  criteria: FlowCriterionResult[];
  memoryProposals: FlowMemoryProposal[];
  documents: FlowRunDocument[];
  /** Refining only: the item's new description */
  description: string | null;
  /** Refining only: criteria to add */
  acceptanceCriteria: string[];
}

const TARGET_KINDS: readonly MemoryProposalTargetKind[] = ['instructions', 'memory', 'journal'];

/** History entries that say where an item is or what worked on it, not what it asks: they give a refine nothing new to check */
const UNCHANGING: ReadonlySet<WorkItemChange> = new Set<WorkItemChange>(['status', 'link', 'waiting']);

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
    properties.criteria = {
      type: 'array',
      description: 'Every acceptance criterion listed in the prompt, by its id, each judged on its own',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          met: { type: 'boolean' },
          note: { type: 'string', description: 'What you checked, or what is missing' },
        },
        required: ['id', 'met', 'note'],
      },
    };
    required.push('verdict', 'criteria');
  }
  if (stage === 'refine') {
    properties.description = { type: 'string', description: "The item's complete new description in Markdown; leave it out to keep the current one" };
    properties.acceptanceCriteria = { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria to add to the item' };
  }
  return { type: 'object', properties, required };
}

/** What a run may do: its permission mode and its rules, as the CLI's flags take them. */
export interface FlowRules {
  permissionMode: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
}

/**
 * The edit rules for paths relative to the project. A comma splits the flag's list and a
 * parenthesis closes the rule, so a path either cannot carry is left out, as is one that climbs out
 * of the project: leaving it out allows less, never more.
 */
function editRules(paths: readonly string[]): string[] {
  const rules: string[] = [];
  for (const raw of paths) {
    const path = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!path || /[,()\s]/.test(path) || path.startsWith('/') || path.split('/').includes('..')) continue;
    const patterns = /[*?[]/.test(path) ? [path] : [path, `${path}/**`];
    for (const p of patterns) for (const tool of WRITE_TOOLS) rules.push(`${tool}(${p})`);
  }
  return [...new Set(rules)];
}

/**
 * What each stage may do (orchestration 5 of docs/plans/project-ecosystem.md):
 *
 * - **refine** reads, and writes only under the documents folder, where its specification goes;
 * - **work** has the shell and the web, and writes the member's `writes` plus the documents folder.
 *   With no `writes`, edits are accepted anywhere in the place it works. With them the session runs
 *   in `dontAsk`, which denies whatever is not allowed outright: the CLI's rules cannot say "every
 *   path but these", so the paths are allowed rather than the rest denied. The shell is `Bash`
 *   whole unless the member lists `commands`: then only `Bash(<pattern>)` for each, in `dontAsk`
 *   too, and none at all for an empty list. A shell command can still write files; `writes` bounds
 *   the edit tools, as the member's screen says, and `commands` is what bounds the shell;
 * - **verify** reads, asks git what changed, runs the test commands the project declares
 *   (`testCommandRules`), and writes only under the documents folder, where its report goes.
 *
 * Refining and verifying run in `dontAsk` whatever `writes` says, and `git push` is denied to all.
 */
export function stageRules(
  stage: FlowStage,
  writes: readonly string[] | undefined,
  extra: { documentsPath: string; testCommands: readonly string[]; commands?: readonly string[] | undefined },
): FlowRules {
  const documents = editRules([extra.documentsPath]);
  if (stage === 'refine') return { permissionMode: 'dontAsk', allowedTools: [...READ_TOOLS, ...documents], disallowedTools: [...DENIED_TOOLS] };
  if (stage === 'verify') {
    return {
      permissionMode: 'dontAsk',
      allowedTools: [...READ_TOOLS, ...GIT_READS, ...extra.testCommands, ...documents],
      disallowedTools: [...DENIED_TOOLS, ...GIT_OUTPUT_DENIED],
    };
  }
  const commands = extra.commands;
  const tools = [...READ_TOOLS, ...(commands ? commandRules(commands) : ['Bash']), ...WEB_TOOLS];
  if (!writes && !commands) return { permissionMode: 'acceptEdits', allowedTools: [...tools, ...WRITE_TOOLS], disallowedTools: [...DENIED_TOOLS] };
  const edits = writes ? editRules([...writes, extra.documentsPath]) : WRITE_TOOLS;
  return { permissionMode: 'dontAsk', allowedTools: [...tools, ...edits], disallowedTools: [...DENIED_TOOLS] };
}

/**
 * A member's shell commands as the CLI's rules: `Bash(<pattern>)` each. A pattern the rule could not
 * carry (a comma splits the flag's list, a parenthesis closes the rule, a newline starts another) is
 * left out, which allows less, never more.
 */
function commandRules(commands: readonly string[]): string[] {
  return [...new Set(commands.filter((c) => isTeamCommandPattern(c) && !c.includes(',')).map((c) => `Bash(${c})`))];
}

const SCRIPT_NAME = /^[A-Za-z0-9][\w:.-]{0,63}$/;
/** Scripts that check rather than build, deploy or publish: what verifying may run */
const CHECK_SCRIPT = /^(test|tests|typecheck|type-check|lint|check)(:[\w.-]+)?$/;

/**
 * The test commands a project declares, as rules verifying may run: the check scripts of its
 * `package.json` (with the package manager its lockfile names), `make test` when its Makefile has
 * that target, and the test runner of a Cargo, Go or Python project. Nothing else, so QA cannot run
 * a deploy or a publish script by calling it a test.
 */
export function testCommandRules(dir: string): string[] {
  const rules: string[] = [];
  const read = (name: string): string | null => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return null;
    }
  };
  const pkg = read('package.json');
  if (pkg !== null) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(pkg) as { scripts?: unknown };
      if (parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)) scripts = parsed.scripts as Record<string, unknown>;
    } catch {
      // not JSON: it declares nothing
    }
    const manager = existsSync(join(dir, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(dir, 'yarn.lock'))
        ? 'yarn'
        : existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))
          ? 'bun'
          : 'npm';
    for (const name of Object.keys(scripts)) {
      if (!SCRIPT_NAME.test(name) || !CHECK_SCRIPT.test(name)) continue;
      rules.push(`Bash(${manager} run ${name})`, `Bash(${manager} run ${name} *)`);
      if (name === 'test') rules.push(`Bash(${manager} test)`, `Bash(${manager} test *)`);
    }
  }
  if (/^test\s*:/m.test(read('Makefile') ?? '')) rules.push('Bash(make test)');
  if (existsSync(join(dir, 'Cargo.toml'))) rules.push('Bash(cargo test)', 'Bash(cargo test *)');
  if (existsSync(join(dir, 'go.mod'))) rules.push('Bash(go test *)');
  if (['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini'].some((f) => existsSync(join(dir, f)))) {
    rules.push('Bash(pytest)', 'Bash(pytest *)', 'Bash(python -m pytest *)');
  }
  return [...new Set(rules)];
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
      'Verify it against each acceptance criterion, on this worktree and its branch: read the changes (`git diff`, `git log`), run the tests the project declares.',
    );
    if (item.acceptanceCriteria.length) {
      lines.push('', 'Judge each of these criteria on its own, and return every one in `criteria` by its id, with `met` and a `note`:', '');
      for (const c of item.acceptanceCriteria) lines.push(`- \`${c.id}\`: ${c.text}`);
      lines.push('');
    } else {
      lines.push('The item has no acceptance criteria: return `criteria` empty, and judge it by its description.');
    }
    lines.push(
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
  /**
   * Chats of running runs whose turn hit the rate limit, waiting for the rotation to say whether they
   * go on. In memory: a restart meanwhile continues the run in its chat anyway (`recover`).
   */
  private readonly awaitingRotation = new Set<string>();

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

  /**
   * `GET /work-items/:itemId/runs`: every run of an item, newest first, whatever its state. The Team
   * screen holds each member's latest run only, so an older failed run read as a normal one there.
   */
  itemRuns(itemId: string): FlowRun[] {
    const rows = this.sql.prepare('SELECT * FROM flow_runs WHERE item_id = ? ORDER BY queued_at DESC, seq DESC').all(itemId) as unknown as RunRow[];
    return rows.map((r) => this.runOf(r));
  }

  /**
   * `GET /projects/:id/flow/runs`: the team's activity, every run of the project newest first, a page
   * at a time. Newest first is the order they were queued in, `seq`, which the cursor carries, so a
   * run queued while someone pages never shifts the pages after it.
   */
  page(projectId: string, query: FlowRunQuery = {}): FlowRunPage {
    const where = ['project_id = ?'];
    const params: Array<string | number> = [projectId];
    if (query.agent?.length) {
      where.push('agent IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(query.agent));
    }
    if (query.itemId) {
      where.push('item_id = ?');
      params.push(query.itemId);
    }
    if (query.status?.length) {
      const states = query.status.filter((v): v is 'queued' | 'running' => v === 'queued' || v === 'running');
      const outcomes = query.status.filter((v) => v !== 'queued' && v !== 'running');
      const any: string[] = [];
      if (states.length) {
        any.push('state IN (SELECT value FROM json_each(?))');
        params.push(JSON.stringify(states));
      }
      if (outcomes.length) {
        // An ended run with no outcome, which the store never writes, reads as failed (`flowRunStatus`)
        any.push(`(state = 'ended' AND (outcome IN (SELECT value FROM json_each(?))${outcomes.includes('failed') ? ' OR outcome IS NULL' : ''}))`);
        params.push(JSON.stringify(outcomes));
      }
      where.push(`(${any.join(' OR ')})`);
    }
    const filter = where.join(' AND ');
    const total = (this.sql.prepare(`SELECT COUNT(*) AS n FROM flow_runs WHERE ${filter}`).get(...params) as { n: number }).n;
    const limit = Math.min(Math.max(1, query.limit ?? FLOW_RUNS_PAGE), FLOW_RUNS_PAGE_MAX);
    const after = query.cursor ? cursorSeq(query.cursor) : null;
    const rows = this.sql
      .prepare(`SELECT * FROM flow_runs WHERE ${filter}${after !== null ? ' AND seq < ?' : ''} ORDER BY seq DESC LIMIT ?`)
      .all(...params, ...(after !== null ? [after] : []), limit + 1) as unknown as RunRow[];
    const more = rows.length > limit;
    const runs = rows.slice(0, limit);
    const last = runs[runs.length - 1];
    return { runs: runs.map((r) => this.runOf(r)), total, nextCursor: more && last ? cursorOf(last.seq) : null };
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
          // A run on an item nobody can see any more would spend for nothing
          this.cancelQueued(event.itemId, 'the item was removed');
          this.stopRunning(event.itemId, 'the item was removed');
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
    // The Product Owner refined it already and nothing has changed since: checking it again in todo
    // would be a second paid run to say the same
    if (this.refinedAlready(item, column, member.role)) {
      this.cancelQueued(itemId, 'it was refined and has not changed since');
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

  private stopRunning(itemId: string, why: string): void {
    const rows = this.sql.prepare("SELECT id, chat_id FROM flow_runs WHERE item_id = ? AND state = 'running'").all(itemId) as Array<{ id: string; chat_id: string | null }>;
    for (const row of rows) {
      this.end(row.id, 'cancelled', null, why);
      if (!row.chat_id) continue;
      try {
        this.deps.stop(row.chat_id);
      } catch {
        // already gone
      }
    }
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
    // Queued while the refine it would repeat was still running: that one has spoken for it
    if (!row.chat_id && this.refinedAlready(item, item.status, row.role)) {
      this.end(row.id, 'cancelled', null, 'it was refined and has not changed since');
      return null;
    }
    // The count and the claim in one transaction: two processes on one database could otherwise
    // both see the last free place and both take it
    const now = new Date().toISOString();
    let claimed = false;
    this.write(() => {
      const running = this.sql.prepare("SELECT item_id FROM flow_runs WHERE project_id = ? AND state = 'running'").all(row.project_id) as Array<{ item_id: string }>;
      if (running.length >= maxParallel(project.settings)) return;
      // One run at a time on an item: the next waits for the one working on it
      if (running.some((r) => r.item_id === row.item_id)) return;
      // A run a restart cut off keeps when it first started: a person's move since then still counts
      claimed =
        this.sql
          .prepare("UPDATE flow_runs SET state = 'running', started_at = COALESCE(started_at, ?), agent = ?, model = ? WHERE id = ? AND state = 'queued'")
          .run(now, member.agent, member.model, row.id).changes === 1;
    });
    if (!claimed) return null;
    return { row: { ...row, state: 'running', started_at: row.started_at ?? now, agent: member.agent, model: member.model }, item, member, project };
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
    // Only a run's own chat is continued: this run's, cut off by a restart, or the Developer's from
    // an earlier round. A person's chat on the item is theirs, and a member never takes it over
    const continuing = row.chat_id !== null;
    const resumeChatId = row.chat_id ?? (stage === 'work' ? this.workChat(item.id) : null);
    const documentsPath = project.settings.documents?.path ?? 'docs';
    const rules = stageRules(stage, member.writes, { documentsPath, testCommands: stage === 'verify' ? testCommandRules(project.path) : [], commands: member.commands });
    const launch: FlowLaunch = {
      run: this.runOf(row),
      item,
      member,
      prompt: continuing
        ? 'Agentry restarted while you were on this run. Carry on from where you were, and end with the structured result.'
        : flowPrompt(stage, row.column_name as WorkItemStatus, item, member, {
            documentsPath,
            rejection: stage === 'work' && (item.bounces ?? 0) > 0 ? this.rejection(item.id, project.settings) : null,
          }),
      appendSystemPrompt: this.deps.handoff(item.projectId),
      jsonSchema: flowResultSchema(stage),
      permissionMode: rules.permissionMode,
      allowedTools: rules.allowedTools,
      disallowedTools: rules.disallowedTools,
      maxBudgetUsd: maxCostUsd(project.settings),
      resumeChatId,
      continuing,
      inWorktree: stage !== 'refine',
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
      if (/concurrent run limit/i.test(message)) {
        // The runtime is full: back in the queue, in its place, until a chat ends. A chat it was
        // about to continue told it of itself first, so the row gets back the chat it had
        this.sql
          .prepare("UPDATE flow_runs SET state = 'queued', chat_id = ?, started_at = CASE WHEN ? IS NULL THEN NULL ELSE started_at END WHERE id = ? AND state = 'running'")
          .run(row.chat_id, row.chat_id, row.id);
        return;
      }
      this.end(row.id, 'failed', null, continuing ? `its chat could not be continued after a restart: ${message}` : message);
    }
  }

  /**
   * The chat of the item's latest work run, which the Developer continues after a bounce: the
   * flow's own, never a chat a person started with "Work on it", which the item links the same way.
   */
  private workChat(itemId: string): string | null {
    const row = this.sql
      .prepare("SELECT chat_id FROM flow_runs WHERE item_id = ? AND stage = 'work' AND chat_id IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .get(itemId) as { chat_id: string } | undefined;
    return row?.chat_id ?? null;
  }

  /** A chat a run of the flow worked in, now or before. */
  ranChat(chatId: string): boolean {
    return !!this.sql.prepare('SELECT 1 FROM flow_runs WHERE chat_id = ? LIMIT 1').get(chatId);
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

  /** The chat's process ended; a run still going got no result, and failed, unless it waits for the rotation. */
  chatEnded(chatId: string, error: string | null): void {
    const row = this.sql.prepare("SELECT * FROM flow_runs WHERE chat_id = ? AND state = 'running'").get(chatId) as RunRow | undefined;
    if (!row) return;
    // The process the limit took down: the run goes on in this chat once the rotation replays it
    if (this.awaitingRotation.has(chatId)) return;
    if (this.deps.rotating?.(chatId)) {
      this.awaitingRotation.add(chatId);
      return;
    }
    this.end(row.id, 'failed', null, error ?? 'the chat ended without a result');
    this.dispatch();
  }

  /** A run's chat is waiting for the account rotation, which may replay its turn: the core's to do. */
  awaitsRotation(chatId: string): boolean {
    return this.awaitingRotation.has(chatId);
  }

  /**
   * What the rotation came to for a chat that hit the rate limit. Resumed, its turn was replayed on
   * the next account in the same chat, and the run goes on there; otherwise no account was left to
   * take it over, and the run fails and says so on its item.
   */
  rotated(chatId: string, outcome: { resumed: boolean; reason?: string | null }): void {
    try {
      if (!this.awaitingRotation.delete(chatId) || outcome.resumed) return;
      const row = this.sql.prepare("SELECT * FROM flow_runs WHERE chat_id = ? AND state = 'running'").get(chatId) as RunRow | undefined;
      if (!row) return;
      this.end(row.id, 'failed', null, `the account hit its rate limit and no other account could take the run over${outcome.reason ? ` (${outcome.reason})` : ''}`);
      this.dispatch();
    } catch {
      // heard from the core's rotation: a closed database (shutting down) must not become its error
    }
  }

  private async finish(row: RunRow, result: FlowChatResult): Promise<void> {
    // A turn the rate limit cut goes on in the same chat on the next account, as a person's chat does
    if (result.isError && result.cause === 'rate-limit' && row.chat_id && (this.awaitingRotation.has(row.chat_id) || this.deps.rotating?.(row.chat_id))) {
      this.awaitingRotation.add(row.chat_id);
      return;
    }
    const parsed = result.isError ? null : parseResult(result.structuredOutput, row.stage as FlowStage);
    const failure = result.isError ? chatFailure(result, this.deps.project(row.project_id)?.settings) : parsed ? null : 'the run ended without a readable structured result';
    const verdictMissing = !!parsed && row.stage === 'verify' && !parsed.verdict;
    const item = this.deps.items.find(row.item_id);
    // QA passes an item only when every one of its criteria is met, whatever its verdict says
    const unmet = parsed && item && row.stage === 'verify' ? item.acceptanceCriteria.filter((c) => !parsed.criteria.some((r) => r.id === c.id && r.met)) : [];
    const outcome: FlowRunOutcome = failure || verdictMissing ? 'failed' : parsed?.verdict === 'fail' || unmet.length ? 'rejected' : 'passed';
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

    // Tied before the comment, so a document the run reported but that cannot be tied is named there
    // rather than dropped without a word
    const untied: string[] = [];
    if (board && settings.modules.includes('documents')) {
      const roots = [project.path, item.worktree ?? ''].filter(Boolean);
      for (const document of result.documents) {
        const path = documentPathOf(document.path, roots);
        await this.deps
          .tie(item.id, { ...document, path }, { role: row.stage as FlowStage, teamRole: row.role, chatId: row.chat_id, actor, cause: cause(`flow.${row.stage}`) })
          .catch((err: unknown) => untied.push(`\`${document.path}\`: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    if (board && (result.summary || untied.length)) {
      const body = untied.length ? [commentOf(item, result), '', 'Documents not tied to the item:', ...untied.map((u) => `- ${u}`)].join('\n').trim() : commentOf(item, result);
      this.deps.items.comment(item.id, { body }, { actor, source, cause: cause(`flow.${row.stage}`) });
    }
    if (board && row.stage === 'verify') this.checkCriteria(item, result.criteria, actor, cause(`flow.${row.stage}`));
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

  /** Every criterion QA found met is checked on the item, as QA; one it found unmet is left as it is. */
  private checkCriteria(item: WorkItem, criteria: readonly FlowCriterionResult[], actor: WorkItemActor, cause: WorkItemCause): void {
    for (const criterion of item.acceptanceCriteria) {
      if (criterion.checked || !criteria.some((c) => c.id === criterion.id && c.met)) continue;
      try {
        this.deps.items.checkCriterion(item.id, criterion.id, { checked: true }, { actor, cause });
      } catch {
        // removed meanwhile: the others still go
      }
    }
  }

  /**
   * Whether the todo check of an item would repeat a refine: the role's latest refine of the item
   * passed, and nothing has changed on the item since it started but what that run wrote itself (its
   * description, criteria, comment, documents and its move to todo). An edit, a comment or a relation
   * from anyone else is something to check again; so is a refine that failed or was cancelled. Moves
   * and links are not: they say where the item is, not what it asks. Only todo: a card a person puts
   * back in backlog asks for a new refine.
   */
  private refinedAlready(item: WorkItem, column: WorkItemStatus, role: string): boolean {
    if (column !== 'todo') return false;
    const last = this.sql
      .prepare("SELECT * FROM flow_runs WHERE item_id = ? AND stage = 'refine' AND role = ? AND state = 'ended' ORDER BY seq DESC LIMIT 1")
      .get(item.id, role) as RunRow | undefined;
    if (!last || last.outcome !== 'passed') return false;
    const since = last.started_at ?? last.queued_at;
    const own = (actor: WorkItemActor, chatId: string | null | undefined): boolean => actor.kind === 'agent' && actor.role === last.role && !!last.chat_id && chatId === last.chat_id;
    const changed = this.deps.items
      .history(item.id)
      .some((e) => e.createdAt >= since && !UNCHANGING.has(e.change) && !own(e.actor, e.cause?.chatId));
    if (changed) return false;
    return !this.deps.items.comments(item.id).some((c) => c.createdAt >= since && !own(c.author, c.source?.chatId));
  }

  private personMovedSince(itemId: string, since: string): boolean {
    return this.deps.items.history(itemId).some((e) => e.change === 'status' && e.actor.kind === 'person' && e.createdAt >= since);
  }

  // ---------- a restart ----------

  /**
   * Once the runtime has restored its chats: a run cut off by the restart goes back to the queue,
   * keeping its chat so it continues there, and the queue starts moving. Before this nothing
   * starts, since a chat still being restored would look like one that ended. A run cut off more
   * than `MAX_FLOW_RESTARTS` times fails instead: whatever keeps taking the wrapper down with it
   * would keep spending.
   */
  recover(): void {
    const running = this.sql.prepare("SELECT * FROM flow_runs WHERE state = 'running' ORDER BY seq").all() as unknown as RunRow[];
    for (const row of running) {
      if (row.chat_id && this.deps.chatBusy(row.chat_id)) continue;
      if (row.restarts >= MAX_FLOW_RESTARTS) {
        this.end(row.id, 'failed', null, `Agentry restarted ${row.restarts + 1} times while this run worked; move the item again to start it over`);
        continue;
      }
      let requeued = false;
      this.write(() => {
        const queued = this.sql.prepare("SELECT 1 FROM flow_runs WHERE item_id = ? AND state = 'queued'").get(row.item_id);
        if (queued) return;
        // It keeps when it started, and the chat it continues in: a run with no chat yet starts afresh
        this.sql
          .prepare("UPDATE flow_runs SET state = 'queued', restarts = restarts + 1, started_at = CASE WHEN chat_id IS NULL THEN NULL ELSE started_at END WHERE id = ?")
          .run(row.id);
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
    if (!ended) return false;
    // A run stopped while it waited for the rotation is not replayed once the rotation comes back
    const chatId = this.row(runId)?.chat_id;
    if (chatId) this.awaitingRotation.delete(chatId);
    this.announce(runId, 'ended');
    if (outcome === 'failed') this.reportFailure(runId);
    return true;
  }

  /**
   * A failed run says so on its item, as its member: without it the item only showed a chat that
   * ended and moved nothing, and the reason was on the Team screen alone.
   */
  private reportFailure(runId: string): void {
    try {
      const row = this.row(runId);
      const item = row ? this.deps.items.find(row.item_id) : null;
      const project = row ? this.deps.project(row.project_id) : null;
      if (!row || !item || !project?.settings.modules.includes('board')) return;
      const source: WorkItemSource | null = row.chat_id ? { kind: 'chat', chatId: row.chat_id, orchestrationId: null, taskId: null } : null;
      this.deps.items.comment(
        item.id,
        { body: `This ${stageNoun(row.stage as FlowStage)} run failed and moved nothing: ${row.error ?? 'no reason was given'}.` },
        { actor: { kind: 'agent', role: row.role }, source, cause: source ? { ...source, event: FLOW_CAUSE.failed } : null },
      );
    } catch {
      // the run has ended; a comment that cannot be written must not undo that
    }
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
      error: row.error,
      restarts: row.restarts ?? 0,
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

/** None unless the person sets one: the owner decided on 2026-09-28 that runs have no default cap */
function maxCostUsd(settings: ProjectSettings): number | null {
  return settings.flow?.maxCostUsd ?? null;
}

function stageNoun(stage: FlowStage): string {
  return stage === 'refine' ? 'refining' : stage === 'work' ? 'work' : 'verification';
}

/** Why a chat that ended in error failed its run, in words a person reading the item can act on. */
function chatFailure(result: FlowChatResult, settings: ProjectSettings | undefined): string {
  if (result.cause === 'budget') {
    const budget = settings ? maxCostUsd(settings) : null;
    return budget === null ? 'it reached its budget' : `it reached its budget of ${budget} USD (flow.maxCostUsd)`;
  }
  if (result.cause === 'rate-limit') return 'the account hit its rate limit';
  if (result.cause === 'stopped') return 'its chat was stopped';
  return result.result || 'the chat failed';
}

/** A run's comment: its summary, and for a verification, each criterion as QA found it. */
function commentOf(item: WorkItem, result: ParsedResult): string {
  if (!result.criteria.length || !item.acceptanceCriteria.length) return result.summary;
  const lines = [result.summary, ''];
  for (const criterion of item.acceptanceCriteria) {
    const judged = result.criteria.find((c) => c.id === criterion.id);
    const mark = judged?.met ? 'x' : ' ';
    const note = judged?.note ? ` — ${judged.note}` : judged ? '' : ' — not judged';
    lines.push(`- [${mark}] ${criterion.text}${note}`);
  }
  return lines.join('\n');
}

/**
 * A document's path as a run reported it, relative to the project. Agents write `./docs/x.md`, or
 * the absolute path of the checkout or worktree they work in, and the documents service refuses a
 * path that needs cleaning rather than guess at it; the flow knows where its run worked, so it can.
 */
function documentPathOf(path: string, roots: readonly string[]): string {
  let rel = path.trim();
  // The longest first: an item's worktree lives inside the project's checkout
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    const prefix = `${root.replace(/\/+$/, '')}/`;
    if (rel.startsWith(prefix)) {
      rel = rel.slice(prefix.length);
      break;
    }
  }
  while (rel.startsWith('./')) rel = rel.slice(2);
  return rel;
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
  const verdict = stage === 'verify' && (value.verdict === 'pass' || value.verdict === 'fail') ? value.verdict : null;
  const criteria: FlowCriterionResult[] = [];
  for (const c of stage === 'verify' && Array.isArray(value.criteria) ? value.criteria.slice(0, CRITERIA_MAX) : []) {
    if (!isObject(c) || typeof c.id !== 'string' || typeof c.met !== 'boolean') continue;
    criteria.push({ id: c.id, met: c.met, note: typeof c.note === 'string' ? c.note.trim().slice(0, CRITERION_MAX) : '' });
  }
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
  return { summary, verdict, criteria, memoryProposals, documents, description, acceptanceCriteria };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
