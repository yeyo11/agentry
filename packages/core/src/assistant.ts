import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ASSISTANT_PROPOSAL_KINDS,
  ASSISTANT_PROPOSAL_KINDS_OF_RUN,
  ASSISTANT_RESOURCE_KINDS,
  ASSISTANT_RUN_KINDS,
  DEFAULT_ASSISTANT_MODEL,
  assistantResourcePath,
  type AcceptAssistantProposalRequest,
  type AgentryEvent,
  type AssistantFinding,
  type AssistantProposal,
  type AssistantProposalAction,
  type AssistantProposalCount,
  type AssistantProposalKind,
  type AssistantProposalStatus,
  type AssistantResourceKind,
  type AssistantRun,
  type AssistantRunAction,
  type AssistantRunDetail,
  type AssistantRunKind,
  type AssistantRunStatus,
  type AssistantSource,
  type ChatActivity,
  type ConfigScopeKind,
  type Localized,
  type PermissionMode,
  type ProjectSettings,
  type ProjectTeamMember,
  type ProjectTemplateId,
  type ProposedResource,
  type ProposedTeamMember,
  type StartAssistantRunRequest,
  type WorkItem,
  type WorkItemActor,
  type WorkItemPriority,
  type WorkItemRef,
  type WorkItemType,
} from '@agentry/shared';
import {
  assistantLanguage,
  assistantPrompt,
  assistantSchema,
  CONTENT_MAX,
  DESCRIPTION_MAX as MEMBER_DESCRIPTION_MAX,
  parseAnswer,
  RESOURCE_NAME,
  RESUME_PROMPT,
  type AssistantAnswer,
  type AssistantBrief,
  type AssistantGit,
  type AssistantLanguage,
} from './assistant-answer.ts';
import { resourceDraft } from './assistant-draft.ts';
import type { DecisionEngine } from './decisions/engine.ts';
import { addReads, initialSources, NO_READS, projectIsEmpty, projectPath, sameReads, sourcesOf, topFiles, type AssistantFacts, type AssistantReads, type ReadingNow } from './assistant-sources.ts';
import type { Db } from './db.ts';
import type { AgentryEventInput } from './events.ts';
import { projectTemplate } from './project-templates.ts';
import { agentFileContent, MAX_SHORT as MEMBER_SHORT_MAX, MAX_TEXT as MEMBER_TEXT_MAX, MAX_WRITES as MEMBER_WRITES_MAX, roleTitle, templateTeam } from './team.ts';
import type { WorkItemService } from './work-items.ts';
import { MAX_TOKENS_ERROR, stoppedOnMaxTokens } from './open-items.ts';
import { pasted, PASTED_NOTE } from './prompt-rules.ts';

/**
 * The project assistant (decisions 35 to 37 of docs/plans/project-ecosystem.md, orchestration 4).
 * A run is a chat through the CLI in the project's directory that may only read, and answers with a
 * structured result (`--json-schema`); its proposals are rows, each accepted or discarded on its own.
 *
 * What it will not do matters as much as what it does:
 *
 * - A run writes nothing. Its chat has three tools at all (`Read`, `Grep`, `Glob`), confined to the
 *   project's directory, with no shell, no MCP server, no settings file of the person's (whose rules
 *   would add to its own) and no uploads directory, in `dontAsk`, which denies whatever is not
 *   allowed. Secrets are denied even inside the project. What it would have run git for, Agentry
 *   reads and hands it in the prompt. Everything it proposes is written by Agentry, through the
 *   service that owns it, when the person accepts that one proposal.
 * - It runs on demand only, never on a schedule, and one run at a time per project and kind.
 * - A new run leaves the previous one's pending proposals alone unless the person asks to suggest
 *   again, and then they are set aside (`superseded`), never deleted.
 * - A project with nothing to read starts no chat: it is offered its template's team, and asked for
 *   a description before anything is proposed from nothing.
 * - A run a restart cut off is continued once, in its own chat; one that cannot be ends as failed.
 */

export class AssistantError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/** A project as the assistant reads it. */
export interface AssistantProject {
  id: string;
  name: string;
  path: string;
  settings: ProjectSettings;
}

/** What Agentry hands a run beside the directory: counted for "what it read", listed in its prompt. */
export interface AssistantKnown {
  facts: AssistantFacts;
  /** The journal as a flow run is handed it, for `--append-system-prompt` */
  journal: string;
  /** Titles of the latest CLI chats in the directory */
  chats: string[];
  /** The project's own resources, by kind */
  resources: Record<AssistantResourceKind, string[]>;
  /** The project's CLAUDE.md, which a chat loading no settings source may not be handed by the CLI */
  instructions: string | null;
  /** What the run would have asked git; null outside a repository */
  git: AssistantGit | null;
}

/** Everything a run's chat is started with. */
export interface AssistantLaunch {
  run: AssistantRun;
  cwd: string;
  model: string;
  prompt: string;
  appendSystemPrompt: string;
  jsonSchema: Record<string, unknown>;
  permissionMode: PermissionMode;
  /** The only tools the chat has (`--tools`); it loads no settings source and no uploads directory */
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  /** A run cut off by a restart continues in its own chat */
  resumeChatId: string | null;
}

export interface AssistantDeps {
  db: Db;
  items: WorkItemService;
  /** Throws when the project is not imported */
  project(projectId: string): Promise<AssistantProject>;
  known(project: AssistantProject): Promise<AssistantKnown>;
  /** Starts (or continues) the run's chat; `onStart` hears of it in the tick its process is spawned */
  launch(launch: AssistantLaunch, onStart: (chatId: string) => void): Promise<void>;
  chatBusy(chatId: string): boolean;
  stop(chatId: string): void;
  activity?(chatId: string): ChatActivity | null;
  /** What the chat has cost so far; null when unknown */
  cost?(chatId: string): number | null;
  /**
   * Adds the member through the team service. `content` is the agent file to write where there is
   * none, when the run wrote instructions of its own; null lets the team write its starting one.
   */
  addMember(project: AssistantProject, member: ProjectTeamMember, content: string | null): Promise<void>;
  resourceExists(project: AssistantProject, scope: ConfigScopeKind, kind: AssistantResourceKind, name: string): Promise<boolean>;
  saveResource(project: AssistantProject, scope: ConfigScopeKind, kind: AssistantResourceKind, name: string, content: string): Promise<void>;
  emit(event: AgentryEventInput): void;
  /** The decision engine, for `assistant.sources` and `assistant.rerank`; without it both are today's behaviour */
  decisions?: Pick<DecisionEngine, 'ask' | 'effective'>;
}

/** The order an assistant proposal is shown in within its kind, by the value the engine scored it */
const RERANK_RANK: Record<string, number> = { key: 3, useful: 2, minor: 1, covered: 0 };
const SUMMARY_MAX = 300;

/** What a run's chat ended with, as the runtime reports it. */
export interface AssistantChatResult {
  isError: boolean;
  result: string;
  structuredOutput: unknown;
  costUsd?: number;
  cause?: 'budget' | 'rate-limit' | 'stopped';
  /** The main agent's last `stop_reason`, from the CLI's stream-json */
  stopReason?: string;
}

/**
 * The tools a run has, and may use: reading. No shell, since no allow rule for one can be told apart
 * from a write (`git log --output=<file>` writes); git's answers are handed in the prompt instead.
 */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
/**
 * What a run may not read even inside the project: secrets, keys and credentials, and git's own
 * directory, whose config may hold a remote's token. Read rules rule on `Grep` and `Glob` as well.
 */
export const DENIED_READS = [
  'Read(./**/.env)',
  'Read(./**/.env.*)',
  'Read(./**/*.env)',
  'Read(./**/.envrc)',
  'Read(./**/*.pem)',
  'Read(./**/*.key)',
  'Read(./**/*.p12)',
  'Read(./**/*.pfx)',
  'Read(./**/*.jks)',
  'Read(./**/*.keystore)',
  'Read(./**/id_rsa*)',
  'Read(./**/id_ecdsa*)',
  'Read(./**/id_ed25519*)',
  'Read(./**/.ssh/**)',
  'Read(./**/.aws/**)',
  'Read(./**/.npmrc)',
  'Read(./**/.pypirc)',
  'Read(./**/.netrc)',
  'Read(./**/.git-credentials)',
  'Read(./**/credentials*)',
  'Read(./**/secrets/**)',
  'Read(./**/settings.local.json)',
  'Read(./.git/**)',
];
/** Denied outright as well, so a CLI that let another tool through still could not run, write or delegate. */
export const DENIED_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent', 'WebFetch', 'WebSearch', ...DENIED_READS];

const RUNS_LISTED = 50;
const DESCRIPTION_MAX = 4000;
const MODEL = /^[A-Za-z0-9][\w.:[\]-]{0,99}$/;
/** How often a running run announces what it read, at most */
export const READ_EVENT_MS = 3000;
/** How often a running "Create with AI" announces the file it is writing, at most: often enough to watch it fill in */
export const DRAFT_EVENT_MS = 750;
const WORK_ITEMS_LISTED = 150;
const CHATS_LISTED = 30;

/** Stable codes of a run's errors; a client translates them. */
export const ASSISTANT_ERRORS = {
  start: 'assistant.error.start',
  chat: 'assistant.error.chat',
  unreadable: 'assistant.error.unreadable',
  ended: 'assistant.error.ended',
  restart: 'assistant.error.restart',
  maxTokens: 'assistant.error.max-tokens',
} as const;

/** What each role of a template may write when it is offered as it is, as the references draw them. */
const TEMPLATE_WRITES: Record<string, string[]> = {
  'product-owner': [],
  architect: ['docs/'],
  developer: ['src/', 'tests/'],
  qa: ['tests/'],
  researcher: ['docs/'],
  writer: ['docs/'],
  reviewer: [],
};

interface RunRow {
  seq: number;
  id: string;
  project_id: string;
  kind: string;
  status: string;
  model: string;
  description: string | null;
  focus: string | null;
  language: string | null;
  resource_kind: string | null;
  chat_id: string | null;
  empty: number;
  template: string | null;
  proposes: string;
  base_sources: string;
  reads: string;
  findings: string;
  summary: string | null;
  cost_usd: number | null;
  error: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  restarts: number;
  started_at: string;
  ended_at: string | null;
}

interface ProposalRow {
  seq: number;
  id: string;
  run_id: string;
  project_id: string;
  kind: string;
  status: string;
  position: number;
  reason: string;
  payload: string;
  outcome: string | null;
  decided_by_kind: string | null;
  decided_by_role: string | null;
  decided_at: string | null;
  created_at: string;
}

/** A proposed work item as it is stored: the refs are filled in when read. */
interface StoredWorkItem {
  type: WorkItemType;
  title: string;
  description: string;
  priority: WorkItemPriority;
  labels: string[];
  acceptanceCriteria: Array<{ text: string }>;
  epicId: string | null;
  similarToId: string | null;
}

interface Outcome {
  acceptedAgent?: string;
  saved?: { scope: ConfigScopeKind; name: string; path: string };
  createdId?: string;
}

const PERSON: WorkItemActor = { kind: 'person', role: null };

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const localized = (code: string, text: string): Localized => ({ code, text: text.slice(0, 2000) });
const normalTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export class AssistantService {
  private readonly sql: DatabaseSync;
  /** Per running run, when it last announced what it read and the announcement waiting to go */
  private readonly readEvents = new Map<string, { at: number; timer: NodeJS.Timeout | null }>();
  /** Launches under way, so a test or a shutdown can wait for them */
  private pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: AssistantDeps) {
    this.sql = deps.db.connection;
  }

  // ---------- reading ----------

  /** `GET /projects/:id/assistant/runs`: latest first. */
  runs(projectId: string, kind?: unknown): AssistantRun[] {
    const filter = kind === undefined || kind === null || kind === '' ? null : this.kindOf(kind);
    const rows = (
      filter
        ? this.sql.prepare('SELECT * FROM assistant_runs WHERE project_id = ? AND kind = ? ORDER BY seq DESC LIMIT ?').all(projectId, filter, RUNS_LISTED)
        : this.sql.prepare('SELECT * FROM assistant_runs WHERE project_id = ? ORDER BY seq DESC LIMIT ?').all(projectId, RUNS_LISTED)
    ) as unknown as RunRow[];
    const counts = this.counts(rows.map((r) => r.id));
    return rows.map((r) => this.runOf(r, counts.get(r.id)));
  }

  /** `GET /assistant/runs/:runId`: the run with every proposal it made. */
  run(runId: string): AssistantRunDetail {
    const row = this.row(runId);
    if (!row) throw new AssistantError('assistant run not found', 404);
    return this.detailOf(row);
  }

  proposal(proposalId: string): AssistantProposal {
    const row = this.proposalRow(proposalId);
    if (!row) throw new AssistantError('assistant proposal not found', 404);
    return this.proposalOf(row);
  }

  // ---------- starting ----------

  /** `POST /projects/:id/assistant/runs`. `language` is the person's, which the chat's title is written in. */
  async start(projectId: string, input: unknown, language: AssistantLanguage = 'en'): Promise<AssistantRunDetail> {
    const request = this.parseStart(input);
    const project = await this.deps.project(projectId);
    const modules = project.settings.modules;
    if (request.kind === 'work-items' && !modules.includes('board')) {
      throw new AssistantError("the Board module is off in this project: switch it on in the project's settings to have tasks suggested", 409);
    }
    const proposes = ASSISTANT_PROPOSAL_KINDS_OF_RUN[request.kind].filter(
      (k) => (k !== 'team-member' || modules.includes('team')) && (k !== 'work-item' || modules.includes('board')),
    );
    const known = await this.deps.known(project);
    const empty = projectIsEmpty(project.path, known.facts);
    const base = initialSources(project.path, known.facts, empty, empty ? null : await this.unneededFiles(projectId, project.path, request));
    const offered = templateOffered(project.settings);
    // With nothing to read and nothing described there is nothing to ask a model: the template's team
    // is offered as it is, and a description is asked for before anything else is proposed
    const chatless = empty && !request.description && !request.focus;
    const id = randomUUID();
    const now = new Date().toISOString();
    let superseded: string | null = null;
    this.write(() => {
      if (this.sql.prepare("SELECT 1 FROM assistant_runs WHERE project_id = ? AND kind = ? AND status = 'running'").get(projectId, request.kind)) {
        throw new AssistantError(`a ${request.kind} run is already running in this project: stop it or wait for it to end`, 409);
      }
      if (request.supersede) {
        // The latest run that proposed anything: one that failed or was stopped since proposed nothing,
        // and suggesting again after it still means setting the last proposals aside
        const previous = this.sql
          .prepare("SELECT id FROM assistant_runs WHERE project_id = ? AND kind = ? AND status = 'completed' ORDER BY seq DESC LIMIT 1")
          .get(projectId, request.kind) as { id: string } | undefined;
        if (previous) {
          superseded = previous.id;
          this.sql.prepare("UPDATE assistant_proposals SET status = 'superseded' WHERE run_id = ? AND status = 'pending'").run(previous.id);
          this.sql.prepare('UPDATE assistant_runs SET superseded_by = ? WHERE id = ?').run(id, previous.id);
        }
      }
      this.sql
        .prepare(
          `INSERT INTO assistant_runs (id, project_id, kind, status, model, description, focus, language, resource_kind, empty, template, proposes, base_sources, reads, supersedes, started_at)
           VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          projectId,
          request.kind,
          request.model,
          request.description,
          request.focus,
          language,
          request.resourceKind,
          empty ? 1 : 0,
          JSON.stringify(proposes),
          JSON.stringify(base),
          JSON.stringify(NO_READS),
          superseded,
          now,
        );
      if (chatless) {
        const members = request.kind === 'project' && proposes.includes('team-member') ? this.templateMembers(project.settings, offered.team) : [];
        members.forEach((m, i) => this.insertProposal(id, projectId, 'team-member', i, m.reason, m.member, now));
        this.sql
          .prepare("UPDATE assistant_runs SET status = 'completed', template = ?, ended_at = ? WHERE id = ?")
          .run(members.length ? offered.template : null, now, id);
      }
    });
    // Its event names the run it superseded, which a client reads again
    this.announce(id, 'started');
    if (chatless) {
      this.announce(id, 'ended');
      return this.run(id);
    }
    const brief = this.brief(project, known, request, proposes, empty, offered, language);
    this.remember(id, project, known);
    await this.track(this.launch(this.mustRow(id), project, brief, known, null));
    return this.run(id);
  }

  private parseStart(input: unknown): {
    kind: AssistantRunKind;
    model: string;
    description: string | null;
    focus: string | null;
    resourceKind: AssistantResourceKind | null;
    supersede: boolean;
  } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AssistantError('the request must be a JSON object', 400);
    const body = input as Partial<Record<keyof StartAssistantRunRequest, unknown>>;
    const kind = this.kindOf(body.kind);
    let model = DEFAULT_ASSISTANT_MODEL;
    if (body.model !== undefined && body.model !== null) {
      if (typeof body.model !== 'string' || !MODEL.test(body.model.trim())) throw new AssistantError('model must be a model alias or id', 400);
      model = body.model.trim();
    }
    let description: string | null = null;
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string') throw new AssistantError('description must be a string', 400);
      if (body.description.length > DESCRIPTION_MAX) throw new AssistantError(`description is longer than ${String(DESCRIPTION_MAX)} characters`, 400);
      description = body.description.trim() || null;
    }
    let focus: string | null = null;
    if (body.focus !== undefined && body.focus !== null) {
      if (typeof body.focus !== 'string') throw new AssistantError('focus must be a string', 400);
      if (body.focus.length > DESCRIPTION_MAX) throw new AssistantError(`focus is longer than ${String(DESCRIPTION_MAX)} characters`, 400);
      // A focus narrows what tasks are suggested; the other runs propose from the project as a whole
      if (kind !== 'work-items') throw new AssistantError('focus goes with a work-items run only', 400);
      focus = body.focus.trim() || null;
    }
    let resourceKind: AssistantResourceKind | null = null;
    if (body.resourceKind !== undefined && body.resourceKind !== null) {
      const found = ASSISTANT_RESOURCE_KINDS.find((k) => k === body.resourceKind);
      if (!found) throw new AssistantError(`resourceKind must be one of ${ASSISTANT_RESOURCE_KINDS.join(', ')}`, 400);
      if (kind !== 'resources') throw new AssistantError('resourceKind goes with a resources run only', 400);
      resourceKind = found;
    }
    if (kind === 'resources' && description && !resourceKind) throw new AssistantError('a resource built from a description needs its resourceKind', 400);
    if (resourceKind && !description) throw new AssistantError('resourceKind needs the description of the resource to build', 400);
    if (body.supersede !== undefined && typeof body.supersede !== 'boolean') throw new AssistantError('supersede must be a boolean', 400);
    return { kind, model, description, focus, resourceKind, supersede: body.supersede === true };
  }

  private kindOf(value: unknown): AssistantRunKind {
    const kind = ASSISTANT_RUN_KINDS.find((k) => k === value);
    if (!kind) throw new AssistantError(`kind must be one of ${ASSISTANT_RUN_KINDS.join(', ')}`, 400);
    return kind;
  }

  private brief(
    project: AssistantProject,
    known: AssistantKnown,
    request: { kind: AssistantRunKind; description: string | null; focus: string | null; resourceKind: AssistantResourceKind | null },
    proposes: AssistantProposalKind[],
    empty: boolean,
    offered: { template: ProjectTemplateId; team: ProjectTemplateTeam },
    language: AssistantLanguage,
  ): AssistantBrief {
    const items = this.deps.items.list({ projectId: project.id });
    const listed = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, WORK_ITEMS_LISTED);
    return {
      kind: request.kind,
      projectName: project.name,
      description: request.description,
      focus: request.focus,
      resourceKind: request.resourceKind,
      empty,
      proposes,
      templateName: projectTemplate(offered.template).name,
      templateTeam: offered.team,
      team: (project.settings.team?.members ?? []).map((m) => ({ agent: m.agent, role: m.role, model: m.model, responsibility: m.responsibility })),
      resources: known.resources,
      workItems: listed.map((i) => ({ key: i.key, type: i.type, status: i.status, title: i.title })),
      moreWorkItems: items.length - listed.length,
      milestones: known.facts.milestones,
      chats: known.chats.slice(0, CHATS_LISTED),
      git: known.git,
      language,
    };
  }

  /** Starts the run's chat; a run whose chat could not start has failed. */
  private async launch(row: RunRow, project: AssistantProject, brief: AssistantBrief, known: Pick<AssistantKnown, 'journal' | 'instructions'>, resumeChatId: string | null): Promise<void> {
    const launch: AssistantLaunch = {
      run: this.runOf(row),
      cwd: project.path,
      model: row.model,
      prompt: resumeChatId ? RESUME_PROMPT : assistantPrompt(brief, row.model),
      appendSystemPrompt: systemPrompt(known.journal, known.instructions),
      jsonSchema: assistantSchema(brief),
      permissionMode: 'dontAsk',
      tools: [...READ_ONLY_TOOLS],
      allowedTools: [...READ_ONLY_TOOLS],
      disallowedTools: [...DENIED_TOOLS],
      resumeChatId,
    };
    let started = false;
    try {
      await this.deps.launch(launch, (chatId) => {
        started = true;
        this.sql.prepare("UPDATE assistant_runs SET chat_id = ? WHERE id = ? AND status = 'running'").run(chatId, row.id);
        if (row.kind === 'resources' && row.description && row.resource_kind) this.drafting.set(chatId, row.id);
        this.announce(row.id, 'read');
      });
      if (!started) throw new Error('the chat did not start');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = resumeChatId !== null || row.restarts > 0 ? ASSISTANT_ERRORS.restart : ASSISTANT_ERRORS.start;
      this.end(row.id, 'failed', localized(code, `The assistant's chat could not start: ${message}`));
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }

  /** Waits for every launch under way; for tests and for shutting down cleanly. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** The template's roles as proposals, for a project with nothing to read. */
  private templateMembers(settings: ProjectSettings, team: ProjectTemplateTeam): Array<{ member: ProposedTeamMember; reason: string }> {
    const taken = new Set((settings.team?.members ?? []).map((m) => m.role));
    const agents = new Set((settings.team?.members ?? []).map((m) => m.agent));
    return team
      .filter((r) => !taken.has(r.role))
      .map((r) => {
        let agent = r.role;
        for (let n = 2; agents.has(agent); n++) agent = `${r.role}-${String(n)}`;
        agents.add(agent);
        return {
          member: { ...r, agent, writes: TEMPLATE_WRITES[r.role] ?? [], fromTemplate: true, description: r.responsibility, instructions: '' },
          reason: `One of the template's roles: ${r.responsibility}.`,
        };
      });
  }

  // ---------- stopping ----------

  /** `POST /assistant/runs/:runId/stop`. What it proposed so far is nothing: a stopped run proposes nothing. */
  stop(runId: string): AssistantRunDetail {
    const row = this.row(runId);
    if (!row) throw new AssistantError('assistant run not found', 404);
    if (row.status !== 'running') throw new AssistantError(`the run is ${row.status}, not running`, 409);
    if (this.end(runId, 'stopped', null) && row.chat_id) {
      try {
        this.deps.stop(row.chat_id);
      } catch {
        // already gone
      }
    }
    return this.run(runId);
  }

  // ---------- what its chat does ----------

  /** Everything on the feed goes through here; failures are swallowed, as they run inside someone else's event. */
  observe(event: AgentryEvent): void {
    try {
      switch (event.type) {
        case 'chat.activity':
          if (event.activity) this.noteActivity(event.runId, event.activity);
          break;
        case 'run.ended':
          this.chatEnded(event.runId, event.error);
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

  /** A read the chat is making becomes part of what it read. */
  private noteActivity(chatId: string, activity: ChatActivity): void {
    if (activity.kind !== 'tool' || !activity.tool) return;
    const row = this.sql.prepare("SELECT * FROM assistant_runs WHERE chat_id = ? AND status = 'running'").get(chatId) as RunRow | undefined;
    if (!row) return;
    const added = this.readOf(row, activity);
    if (!added) return;
    const reads = parseJson<AssistantReads>(row.reads, NO_READS);
    const next = addReads(reads, added);
    if (sameReads(reads, next)) return;
    this.sql.prepare("UPDATE assistant_runs SET reads = ? WHERE id = ? AND status = 'running'").run(JSON.stringify(next), row.id);
    this.readSoon(row.id);
  }

  private readOf(row: RunRow, activity: ChatActivity): Partial<AssistantReads> | null {
    const target = activity.target ?? '';
    const project = this.projectDir(row);
    const path = project ? projectPath(project, target) : null;
    if (!path) return null;
    if (activity.tool === 'Read') return { files: [path] };
    if (activity.tool === 'LS') return { dirs: [path.endsWith('/') ? path : `${path}/`] };
    return null;
  }

  /** The directory a run reads in: the one its launch named, remembered with its base sources' paths being relative to it. */
  private readonly dirs = new Map<string, string>();

  private projectDir(row: RunRow): string | null {
    return this.dirs.get(row.id) ?? null;
  }

  /** The running "Create with AI" runs by their chat, and what each one's chat has streamed of its result */
  private readonly drafting = new Map<string, string>();
  private readonly drafts = new Map<string, string>();

  /**
   * The structured result a chat is streaming, as far as it has got. A running "Create with AI" keeps
   * it, so its editor can show the file as it is written; nothing of it is saved or proposed.
   */
  chatStructured(chatId: string, raw: string): void {
    const runId = this.drafting.get(chatId);
    if (!runId) return;
    this.drafts.set(runId, raw);
    this.readSoon(runId, DRAFT_EVENT_MS);
  }

  /** Announces what a running run has read, or has written of its draft, at most every few seconds. */
  private readSoon(runId: string, every = READ_EVENT_MS): void {
    const now = Date.now();
    const state = this.readEvents.get(runId) ?? { at: 0, timer: null };
    this.readEvents.set(runId, state);
    if (state.timer) return;
    const wait = state.at + every - now;
    if (wait <= 0) {
      state.at = now;
      this.announce(runId, 'read');
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      state.at = Date.now();
      if (this.row(runId)?.status === 'running') this.announce(runId, 'read');
    }, wait);
    state.timer.unref();
  }

  /** A result of a chat. Only a running run's chat counts, and only its first result. */
  chatResult(chatId: string, result: AssistantChatResult): void {
    try {
      const row = this.sql.prepare("SELECT * FROM assistant_runs WHERE chat_id = ? AND status = 'running'").get(chatId) as RunRow | undefined;
      if (!row) return;
      this.finish(row, result);
    } catch {
      // Heard from the runtime's own event: a closed database (shutting down) must not become its error
    }
  }

  /** The chat's process ended; a run still going got no result, and failed. */
  chatEnded(chatId: string, error: string | null): void {
    const row = this.sql.prepare("SELECT * FROM assistant_runs WHERE chat_id = ? AND status = 'running'").get(chatId) as RunRow | undefined;
    if (!row) return;
    this.end(row.id, 'failed', localized(ASSISTANT_ERRORS.ended, error ? `The assistant's chat ended without an answer: ${error}` : "The assistant's chat ended without an answer."));
  }

  private finish(row: RunRow, result: AssistantChatResult): void {
    const cost = typeof result.costUsd === 'number' ? result.costUsd : null;
    if (result.isError) {
      if (result.cause === 'stopped') this.end(row.id, 'stopped', null, cost);
      else this.end(row.id, 'failed', localized(ASSISTANT_ERRORS.chat, result.result || "The assistant's chat failed."), cost);
      return;
    }
    // An answer cut by the token limit can parse and still be missing what it was writing
    if (stoppedOnMaxTokens(result)) {
      this.end(row.id, 'failed', localized(ASSISTANT_ERRORS.maxTokens, `The assistant's answer was not used: ${MAX_TOKENS_ERROR}.`), cost);
      return;
    }
    const proposes = parseJson<AssistantProposalKind[]>(row.proposes, []);
    const kind = row.kind as AssistantRunKind;
    const project = this.projectSettingsOf(row);
    const brief = {
      kind,
      proposes,
      resourceKind: (row.resource_kind as AssistantResourceKind | null) ?? null,
      description: row.description,
      templateTeam: project ? templateOffered(project).team : [],
    };
    const answer = parseAnswer(result.structuredOutput, brief);
    if (!answer) {
      this.end(row.id, 'failed', localized(ASSISTANT_ERRORS.unreadable, 'The assistant ended without a readable answer.'), cost);
      return;
    }
    const now = new Date().toISOString();
    let completed = false;
    this.write(() => {
      const reads = addReads(parseJson<AssistantReads>(row.reads, NO_READS), {
        files: answer.read.filter((r) => r.kind === 'file' && r.path).map((r) => r.path as string),
        dirs: answer.read.filter((r) => r.kind === 'dir' && r.path).map((r) => r.path as string),
        git: answer.read.some((r) => r.kind === 'git'),
      });
      const done = this.sql
        .prepare(
          "UPDATE assistant_runs SET status = 'completed', summary = ?, findings = ?, reads = ?, cost_usd = COALESCE(?, cost_usd), ended_at = ? WHERE id = ? AND status = 'running'",
        )
        .run(answer.summary, JSON.stringify(answer.findings), JSON.stringify(reads), cost, now, row.id);
      if (done.changes !== 1) return;
      completed = true;
      this.insertAnswer(row, answer, project, now);
    });
    // Read before `ended` forgets it: what the project already has is what a proposal can be covered by
    const covered = { known: this.knownResources.get(row.id), settings: project };
    if (completed) {
      this.ended(row.id);
      this.rerank(row.id, row.project_id, covered.known, covered.settings);
    }
  }

  /**
   * `assistant.sources`: the top-level files the run will not need to read, which leave the list it
   * is shown. One question per file, on names and sizes only. Nothing is dropped unless the engine
   * acts (active, every answer above the threshold); the run keeps its own tools either way.
   */
  private async unneededFiles(projectId: string, path: string, request: { description: string | null; focus: string | null; kind: string }): Promise<ReadonlySet<string> | null> {
    const engine = this.deps.decisions;
    if (!engine || engine.effective('assistant.sources', projectId).mode === 'off') return null;
    try {
      const files = topFiles(path);
      if (files.length < 2) return null;
      const outcome = await engine.ask(
        'assistant.sources',
        {
          kind: 'assistant_run',
          id: null,
          data: { brief: (request.description ?? request.focus ?? request.kind).slice(0, SUMMARY_MAX * 2), files: files.map((f) => ({ id: f.name, name: f.name, bytes: f.bytes })) },
        },
        { projectId },
      );
      if (!outcome.act || !outcome.answers) return null;
      const answers = outcome.answers;
      const dropped = files.filter((f) => {
        const a = answers[f.name];
        return a?.kind === 'noul' && !a.value;
      });
      return dropped.length ? new Set(dropped.map((f) => f.name)) : null;
    } catch {
      return null;
    }
  }

  /**
   * `assistant.rerank`: asks how valuable each proposal of a finished run is, and when the engine
   * acts, moves the better ones up inside their kind. Only the order changes: every proposal stays,
   * still pending, for the person to accept or discard. Never awaited and never a failure of the run.
   */
  private rerank(runId: string, projectId: string, known: Record<AssistantResourceKind, string[]> | undefined, settings: ProjectSettings | null): void {
    const engine = this.deps.decisions;
    if (!engine || engine.effective('assistant.rerank', projectId).mode === 'off') return;
    void (async () => {
      const rows = this.sql.prepare("SELECT * FROM assistant_proposals WHERE run_id = ? AND status = 'pending' ORDER BY seq").all(runId) as unknown as ProposalRow[];
      if (rows.length < 2) return;
      const proposals = rows.map((r) => this.proposalOf(r)).map((p) => ({
        id: p.id,
        kind: p.kind,
        title: p.kind === 'team-member' ? roleTitle(p.member.role) : p.kind === 'resource' ? p.resource.name : p.workItem.title,
        summary: p.reason.slice(0, SUMMARY_MAX),
      }));
      const outcome = await engine.ask(
        'assistant.rerank',
        {
          kind: 'assistant_run',
          id: runId,
          data: {
            proposals,
            agents: known?.agents ?? [],
            skills: known?.skills ?? [],
            commands: known?.commands ?? [],
            members: (settings?.team?.members ?? []).map((m) => m.role),
          },
        },
        { projectId },
      );
      if (!outcome.act || !outcome.answers) return;
      const answers = outcome.answers;
      const rank = (id: string): number => {
        const a = answers[id];
        return a?.kind === 'score' ? (RERANK_RANK[a.value] ?? 1) : 1;
      };
      this.write(() => {
        for (const kind of ASSISTANT_PROPOSAL_KINDS) {
          const ofKind = rows.filter((r) => r.kind === kind).sort((a, b) => rank(b.id) - rank(a.id) || a.position - b.position);
          ofKind.forEach((r, i) => this.sql.prepare('UPDATE assistant_proposals SET position = ? WHERE id = ?').run(i, r.id));
        }
      });
      this.announce(runId, 'ended');
    })().catch(() => undefined);
  }

  /** The proposals of an answer, leaving out what the project already has. */
  private insertAnswer(row: RunRow, answer: AssistantAnswer, settings: ProjectSettings | null, now: string): void {
    const members = settings?.team?.members ?? [];
    let position = 0;
    for (const m of answer.members) {
      if (members.some((x) => x.role === m.role || x.agent === m.agent)) continue;
      const { reason, ...member } = m;
      this.insertProposal(row.id, row.project_id, 'team-member', position++, reason, member, now);
    }
    const known = this.knownResources.get(row.id);
    const single = row.kind === 'resources' && !!row.description;
    position = 0;
    for (const r of answer.resources) {
      // A suggestion of something the project already has is noise; a resource built from a
      // description is what the person asked for, and its editor lets them rename it
      if (!single && known?.[r.kind].includes(r.name)) continue;
      const { reason, ...resource } = r;
      this.insertProposal(row.id, row.project_id, 'resource', position++, reason, resource, now);
    }
    const items = this.deps.items.list({ projectId: row.project_id });
    const byTitle = new Map(items.map((i) => [normalTitle(i.title), i] as const));
    const byKey = (key: string | null): WorkItem | null => (key ? this.deps.items.findByKey(row.project_id, key.toUpperCase()) : null);
    position = 0;
    for (const w of answer.workItems) {
      const epic = w.type === 'epic' ? null : byKey(w.epicKey);
      const similar = byKey(w.similarToKey) ?? byTitle.get(normalTitle(w.title)) ?? null;
      const stored: StoredWorkItem = {
        type: w.type,
        title: w.title,
        description: w.description,
        priority: w.priority,
        labels: w.labels,
        acceptanceCriteria: w.acceptanceCriteria,
        epicId: epic?.type === 'epic' ? epic.id : null,
        similarToId: similar?.id ?? null,
      };
      this.insertProposal(row.id, row.project_id, 'work-item', position++, w.reason, stored, now);
    }
  }

  /** What resources each running run was told of, so its answer does not propose them again */
  private readonly knownResources = new Map<string, Record<AssistantResourceKind, string[]>>();
  private readonly settingsOfRun = new Map<string, ProjectSettings>();

  private projectSettingsOf(row: RunRow): ProjectSettings | null {
    return this.settingsOfRun.get(row.id) ?? null;
  }

  // ---------- a restart ----------

  /**
   * Once the runtime has restored its chats: a run cut off by the restart continues once, in its own
   * chat (or in a new one when it never got one), and one that cannot, or was already continued
   * once, ends as failed. Before this a run still going would look like one that ended.
   */
  async recover(): Promise<void> {
    const running = this.sql.prepare("SELECT * FROM assistant_runs WHERE status = 'running' ORDER BY seq").all() as unknown as RunRow[];
    for (const row of running) {
      if (row.chat_id && this.deps.chatBusy(row.chat_id)) continue;
      if (row.restarts > 0) {
        this.end(row.id, 'failed', localized(ASSISTANT_ERRORS.restart, 'Agentry restarted twice while the assistant worked; start it again.'));
        continue;
      }
      this.sql.prepare('UPDATE assistant_runs SET restarts = restarts + 1 WHERE id = ?').run(row.id);
      try {
        const project = await this.deps.project(row.project_id);
        const known = await this.deps.known(project);
        const proposes = parseJson<AssistantProposalKind[]>(row.proposes, []);
        const brief = this.brief(
          project,
          known,
          { kind: row.kind as AssistantRunKind, description: row.description, focus: row.focus, resourceKind: row.resource_kind as AssistantResourceKind | null },
          proposes,
          row.empty === 1,
          templateOffered(project.settings),
          // A run that never got a chat is asked again from its start, titled as it was the first time
          assistantLanguage(row.language),
        );
        this.remember(row.id, project, known);
        await this.track(this.launch(this.mustRow(row.id), project, brief, known, row.chat_id));
      } catch (err) {
        this.end(row.id, 'failed', localized(ASSISTANT_ERRORS.restart, `The assistant could not go on after a restart: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  // ---------- deciding ----------

  /**
   * `POST /assistant/proposals/:id/accept`, with what the person changed. The proposal is claimed
   * first, so two accepts cannot both write; if writing fails it is handed back, still pending.
   */
  async accept(proposalId: string, input: unknown = {}, actor: WorkItemActor = PERSON): Promise<AssistantProposal> {
    const edits = parseEdits(input);
    const row = this.proposalRow(proposalId);
    if (!row) throw new AssistantError('assistant proposal not found', 404);
    if (row.status !== 'pending') throw new AssistantError(`the proposal is ${row.status}, not pending`, 409);
    const project = await this.deps.project(row.project_id);
    const proposal = this.proposalOf(row);
    // Checked before claiming, so a refusal leaves nothing to hand back
    this.requireModule(project, proposal.kind);
    if (!this.claim(row.id, 'pending', 'accepted', actor)) throw new AssistantError('the proposal was decided meanwhile', 409);
    let outcome: Outcome;
    try {
      outcome = await this.perform(project, proposal, edits, actor);
    } catch (err) {
      this.sql.prepare("UPDATE assistant_proposals SET status = 'pending', decided_by_kind = NULL, decided_by_role = NULL, decided_at = NULL WHERE id = ? AND status = 'accepted'").run(row.id);
      throw err;
    }
    this.sql.prepare('UPDATE assistant_proposals SET outcome = ? WHERE id = ?').run(JSON.stringify(outcome), row.id);
    const accepted = this.proposal(row.id);
    this.announceProposal(accepted, 'accepted');
    return accepted;
  }

  /** `POST /assistant/proposals/:id/discard`. */
  discard(proposalId: string, actor: WorkItemActor = PERSON): AssistantProposal {
    const row = this.proposalRow(proposalId);
    if (!row) throw new AssistantError('assistant proposal not found', 404);
    if (row.status !== 'pending' || !this.claim(row.id, 'pending', 'discarded', actor)) throw new AssistantError(`the proposal is ${row.status}, not pending`, 409);
    const discarded = this.proposal(row.id);
    this.announceProposal(discarded, 'discarded');
    return discarded;
  }

  /** `POST /assistant/proposals/:id/restore`: a discarded proposal waits for the person again. */
  restore(proposalId: string): AssistantProposal {
    const row = this.proposalRow(proposalId);
    if (!row) throw new AssistantError('assistant proposal not found', 404);
    const r = this.sql
      .prepare("UPDATE assistant_proposals SET status = 'pending', decided_by_kind = NULL, decided_by_role = NULL, decided_at = NULL WHERE id = ? AND status = 'discarded'")
      .run(row.id);
    if (r.changes !== 1) throw new AssistantError(`only a discarded proposal can be restored; this one is ${row.status}`, 409);
    const restored = this.proposal(row.id);
    this.announceProposal(restored, 'restored');
    return restored;
  }

  private claim(proposalId: string, from: AssistantProposalStatus, to: AssistantProposalStatus, actor: WorkItemActor): boolean {
    const r = this.sql
      .prepare('UPDATE assistant_proposals SET status = ?, decided_by_kind = ?, decided_by_role = ?, decided_at = ? WHERE id = ? AND status = ?')
      .run(to, actor.kind, actor.role ?? null, new Date().toISOString(), proposalId, from);
    return r.changes === 1;
  }

  private requireModule(project: AssistantProject, kind: AssistantProposalKind): void {
    const modules = project.settings.modules;
    if (kind === 'team-member' && !modules.includes('team')) {
      throw new AssistantError("the Team module is off in this project: switch it on in the project's settings to add this member", 409);
    }
    if (kind === 'work-item' && !modules.includes('board')) {
      throw new AssistantError("the Board module is off in this project: switch it on in the project's settings to create this task", 409);
    }
  }

  private async perform(project: AssistantProject, proposal: AssistantProposal, edits: Edits, actor: WorkItemActor): Promise<Outcome> {
    if (proposal.kind === 'team-member') {
      const m = { ...proposal.member, ...edits.member };
      const members = project.settings.team?.members ?? [];
      if (members.some((x) => x.agent === m.agent)) throw new AssistantError(`${m.agent} is already on the team`, 409);
      const member: ProjectTeamMember = { agent: m.agent, role: m.role, model: m.model, responsibility: m.responsibility, writes: m.writes };
      const instructions = m.instructions.trim();
      await this.deps.addMember(project, member, instructions ? memberFile(member, instructions, m.description) : null);
      return { acceptedAgent: m.agent };
    }
    if (proposal.kind === 'resource') {
      const r = proposal.resource;
      const name = edits.resource.name ?? r.name;
      const content = edits.resource.content ?? r.content;
      const scope = edits.resource.scope ?? r.scope;
      if (!RESOURCE_NAME.test(name)) throw new AssistantError('the name may only have letters, digits, _ . - (64 at most)', 400);
      if (!content.trim()) throw new AssistantError('the content is empty', 400);
      if (await this.deps.resourceExists(project, scope, r.kind, name)) {
        throw new AssistantError(`a ${r.kind.slice(0, -1)} named ${name} already exists there: rename it before saving`, 409);
      }
      await this.deps.saveResource(project, scope, r.kind, name, content);
      return { saved: { scope, name, path: assistantResourcePath(r.kind, name, scope) } };
    }
    const w = { ...proposal.workItem, ...edits.workItem };
    const epicId = w.type === 'epic' ? null : w.epicId && this.deps.items.find(w.epicId)?.type === 'epic' ? w.epicId : null;
    const run = this.row(proposal.runId);
    const source = run?.chat_id ? { kind: 'chat' as const, chatId: run.chat_id, orchestrationId: null, taskId: null } : null;
    const item = this.deps.items.create(
      project.id,
      {
        type: w.type,
        title: w.title,
        description: w.description,
        status: 'backlog',
        priority: w.priority,
        labels: w.labels,
        epicId,
        acceptanceCriteria: w.acceptanceCriteria,
      },
      { actor, cause: source ? { ...source, event: 'assistant.accepted' } : null },
    );
    if (proposal.reason.trim()) {
      try {
        this.deps.items.comment(item.id, { body: proposal.reason }, { actor: { kind: 'agent', role: null }, source, cause: source ? { ...source, event: 'assistant.reason' } : null });
      } catch {
        // The item exists, which is what the person accepted; its first comment is the lesser loss
      }
    }
    return { createdId: item.id };
  }

  // ---------- rows ----------

  /** Ends a run that has not ended yet; false when it already had, so a late result changes nothing. */
  private end(runId: string, status: Exclude<AssistantRunStatus, 'running' | 'completed'>, error: Localized | null, cost: number | null = null): boolean {
    const row = this.row(runId);
    const live = row?.chat_id && this.deps.cost ? this.deps.cost(row.chat_id) : null;
    let changed = false;
    this.write(() => {
      const r = this.sql
        .prepare("UPDATE assistant_runs SET status = ?, error = ?, cost_usd = COALESCE(?, ?, cost_usd), ended_at = ? WHERE id = ? AND status = 'running'")
        .run(status, error ? JSON.stringify(error) : null, cost, live, new Date().toISOString(), runId);
      changed = r.changes === 1;
      // A run that ends with nothing to propose replaces nothing: what it set aside waits for the
      // person again, as it did before they asked to suggest again
      if (changed && row?.supersedes) {
        const back = this.sql.prepare('UPDATE assistant_runs SET superseded_by = NULL WHERE id = ? AND superseded_by = ?').run(row.supersedes, runId);
        if (back.changes === 1) this.sql.prepare("UPDATE assistant_proposals SET status = 'pending' WHERE run_id = ? AND status = 'superseded'").run(row.supersedes);
      }
    });
    if (!changed) return false;
    this.ended(runId);
    return true;
  }

  private ended(runId: string): void {
    const pending = this.readEvents.get(runId);
    if (pending?.timer) clearTimeout(pending.timer);
    this.readEvents.delete(runId);
    this.drafts.delete(runId);
    for (const [chatId, id] of this.drafting) if (id === runId) this.drafting.delete(chatId);
    this.dirs.delete(runId);
    this.knownResources.delete(runId);
    this.settingsOfRun.delete(runId);
    const status = this.row(runId)?.status;
    this.announce(runId, status === 'failed' ? 'failed' : 'ended');
  }

  /** What a run is told of its project, kept while it runs so its answer is read against it. */
  private remember(runId: string, project: AssistantProject, known: AssistantKnown): void {
    this.dirs.set(runId, project.path);
    this.knownResources.set(runId, known.resources);
    this.settingsOfRun.set(runId, project.settings);
  }

  private insertProposal(runId: string, projectId: string, kind: AssistantProposalKind, position: number, reason: string, payload: unknown, now: string): void {
    this.sql
      .prepare(
        `INSERT INTO assistant_proposals (id, run_id, project_id, kind, status, position, reason, payload, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(randomUUID(), runId, projectId, kind, position, reason, JSON.stringify(payload), now);
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
    return (this.sql.prepare('SELECT * FROM assistant_runs WHERE id = ?').get(runId) as RunRow | undefined) ?? null;
  }

  private mustRow(runId: string): RunRow {
    const row = this.row(runId);
    if (!row) throw new AssistantError('assistant run not found', 404);
    return row;
  }

  private proposalRow(proposalId: string): ProposalRow | null {
    return (this.sql.prepare('SELECT * FROM assistant_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined) ?? null;
  }

  private counts(runIds: string[]): Map<string, Record<AssistantProposalKind, AssistantProposalCount>> {
    const out = new Map<string, Record<AssistantProposalKind, AssistantProposalCount>>();
    if (!runIds.length) return out;
    const rows = this.sql
      .prepare(`SELECT run_id, kind, status, COUNT(*) AS n FROM assistant_proposals WHERE run_id IN (${runIds.map(() => '?').join(',')}) GROUP BY run_id, kind, status`)
      .all(...runIds) as Array<{ run_id: string; kind: string; status: string; n: number }>;
    for (const r of rows) {
      const counts = out.get(r.run_id) ?? emptyCounts();
      out.set(r.run_id, counts);
      const kind = ASSISTANT_PROPOSAL_KINDS.find((k) => k === r.kind);
      if (!kind) continue;
      const c = counts[kind];
      c.total += r.n;
      if (r.status === 'pending' || r.status === 'accepted' || r.status === 'discarded' || r.status === 'superseded') c[r.status] += r.n;
    }
    return out;
  }

  private runOf(row: RunRow, counts?: Record<AssistantProposalKind, AssistantProposalCount>): AssistantRun {
    const status = row.status as AssistantRunStatus;
    const running = status === 'running';
    const activity = running && row.chat_id && this.deps.activity ? this.deps.activity(row.chat_id) : null;
    const dir = this.dirs.get(row.id);
    let now: ReadingNow | null = null;
    if (activity?.kind === 'tool' && activity.target && dir) now = { path: projectPath(dir, activity.target), git: false };
    const sources: AssistantSource[] = sourcesOf(parseJson<AssistantSource[]>(row.base_sources, []), parseJson<AssistantReads>(row.reads, NO_READS), !running, now);
    const liveCost = running && row.chat_id && this.deps.cost ? this.deps.cost(row.chat_id) : null;
    return {
      id: row.id,
      projectId: row.project_id,
      kind: row.kind as AssistantRunKind,
      status,
      model: row.model,
      description: row.description,
      ...(row.kind === 'work-items' ? { focus: row.focus } : {}),
      ...(row.language ? { language: assistantLanguage(row.language) } : {}),
      resourceKind: (row.resource_kind as AssistantResourceKind | null) ?? null,
      chatId: row.chat_id,
      ...(running && row.chat_id ? { activity } : {}),
      empty: row.empty === 1,
      template: (row.template as ProjectTemplateId | null) ?? null,
      sources,
      findings: parseJson<AssistantFinding[]>(row.findings, []),
      counts: counts ?? this.counts([row.id]).get(row.id) ?? emptyCounts(),
      costUsd: liveCost ?? row.cost_usd,
      durationMs: row.ended_at ? Math.max(0, Date.parse(row.ended_at) - Date.parse(row.started_at)) : null,
      error: parseJson<Localized | null>(row.error, null),
      supersedes: row.supersedes,
      supersededBy: row.superseded_by,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }

  private detailOf(row: RunRow): AssistantRunDetail {
    const rows = this.sql.prepare('SELECT * FROM assistant_proposals WHERE run_id = ? ORDER BY seq').all(row.id) as unknown as ProposalRow[];
    const order = (k: string) => ASSISTANT_PROPOSAL_KINDS.findIndex((x) => x === k);
    const proposals = rows.sort((a, b) => order(a.kind) - order(b.kind) || a.position - b.position).map((p) => this.proposalOf(p));
    const raw = row.status === 'running' ? this.drafts.get(row.id) : undefined;
    const kind = ASSISTANT_RESOURCE_KINDS.find((k) => k === row.resource_kind);
    const draft = raw !== undefined && kind ? resourceDraft(raw, kind) : null;
    return { ...this.runOf(row), proposals, ...(draft ? { draft } : {}) };
  }

  private ref(itemId: string | null | undefined): WorkItemRef | null {
    if (!itemId) return null;
    const item = this.deps.items.find(itemId);
    return item ? { id: item.id, key: item.key, title: item.title, type: item.type, status: item.status } : null;
  }

  private proposalOf(row: ProposalRow): AssistantProposal {
    const outcome = parseJson<Outcome>(row.outcome, {});
    const base = {
      id: row.id,
      runId: row.run_id,
      projectId: row.project_id,
      status: row.status as AssistantProposalStatus,
      reason: row.reason,
      position: row.position,
      decidedBy: row.decided_by_kind ? { kind: row.decided_by_kind as WorkItemActor['kind'], role: row.decided_by_role } : null,
      decidedAt: row.decided_at,
      createdAt: row.created_at,
    };
    if (row.kind === 'team-member') {
      return { ...base, kind: 'team-member', member: parseJson<ProposedTeamMember>(row.payload, emptyMember()), acceptedAgent: outcome.acceptedAgent ?? null };
    }
    if (row.kind === 'resource') {
      return { ...base, kind: 'resource', resource: parseJson<ProposedResource>(row.payload, emptyResource()), saved: outcome.saved ?? null };
    }
    const stored = parseJson<StoredWorkItem>(row.payload, { type: 'task', title: '', description: '', priority: 'medium', labels: [], acceptanceCriteria: [], epicId: null, similarToId: null });
    const epic = this.ref(stored.epicId);
    return {
      ...base,
      kind: 'work-item',
      workItem: {
        type: stored.type,
        title: stored.title,
        description: stored.description,
        priority: stored.priority,
        labels: stored.labels,
        acceptanceCriteria: stored.acceptanceCriteria,
        epicId: stored.epicId,
        epic: epic?.type === 'epic' ? epic : null,
        similarTo: this.ref(stored.similarToId),
      },
      created: this.ref(outcome.createdId),
    };
  }

  private announce(runId: string, action: AssistantRunAction): void {
    const row = this.row(runId);
    if (!row) return;
    const what = row.kind === 'project' ? 'Project assistant' : row.kind === 'work-items' ? 'Suggest tasks' : 'Suggest resources';
    const title =
      action === 'started' ? `${what} started` : action === 'read' ? `${what} is reading` : action === 'failed' ? `${what} failed` : `${what} ${row.status}`;
    try {
      this.deps.emit({
        type: 'assistant.run',
        title,
        projectId: row.project_id,
        runId: row.id,
        kind: row.kind as AssistantRunKind,
        action,
        status: row.status as AssistantRunStatus,
        chatId: row.chat_id,
        supersedes: row.supersedes,
      });
    } catch {
      // the row is written; a broken listener must not undo the run
    }
  }

  private announceProposal(proposal: AssistantProposal, action: AssistantProposalAction): void {
    const label = proposal.kind === 'team-member' ? roleTitle(proposal.member.role) : proposal.kind === 'resource' ? proposal.resource.name : proposal.workItem.title;
    const saved = proposal.kind === 'resource' ? proposal.saved : null;
    try {
      this.deps.emit({
        type: 'assistant.proposal',
        title: `${label} ${action}`,
        projectId: proposal.projectId,
        runId: proposal.runId,
        proposalId: proposal.id,
        proposalKind: proposal.kind,
        action,
        itemId: proposal.kind === 'work-item' ? (proposal.created?.id ?? null) : null,
        agent: proposal.kind === 'team-member' ? proposal.acceptedAgent : null,
        resource: proposal.kind === 'resource' && saved ? { kind: proposal.resource.kind, name: saved.name, scope: saved.scope } : null,
      });
    } catch {
      // the decision is written
    }
  }

}

type ProjectTemplateTeam = ReturnType<typeof templateTeam>;

/** The template whose team a project is offered, and that team: its own, or the software one. */
function templateOffered(settings: ProjectSettings): { template: ProjectTemplateId; team: ProjectTemplateTeam } {
  const own = settings.template ? projectTemplate(settings.template).team : [];
  return { template: own.length && settings.template ? settings.template : 'software', team: templateTeam(settings) };
}

/** CLAUDE.md past this is cut, and the run told to read the rest */
const INSTRUCTIONS_MAX = 40_000;

/** What a run's chat has appended to its system prompt: the journal, and the project's CLAUDE.md. */
function systemPrompt(journal: string, instructions: string | null): string {
  const parts = journal.trim() ? [journal] : [];
  if (instructions?.trim()) {
    const cut = instructions.length > INSTRUCTIONS_MAX;
    parts.push(
      [
        "# The project's CLAUDE.md",
        '',
        pasted(cut ? instructions.slice(0, INSTRUCTIONS_MAX) : instructions),
        ...(cut ? ['', `[cut at ${String(INSTRUCTIONS_MAX)} characters: read CLAUDE.md for the rest]`] : []),
        '',
        PASTED_NOTE,
      ].join('\n'),
    );
  }
  return parts.join('\n\n');
}

function emptyCounts(): Record<AssistantProposalKind, AssistantProposalCount> {
  const zero = (): AssistantProposalCount => ({ total: 0, pending: 0, accepted: 0, discarded: 0, superseded: 0 });
  return { 'team-member': zero(), resource: zero(), 'work-item': zero() };
}

function emptyMember(): ProposedTeamMember {
  return { role: '', agent: '', model: DEFAULT_ASSISTANT_MODEL, responsibility: '', writes: [], fromTemplate: false, description: '', instructions: '' };
}

function emptyResource(): ProposedResource {
  return { kind: 'agents', name: '', description: '', content: '', scope: 'project', path: '' };
}

/**
 * The agent file of a member the run wrote instructions for: the team's starting file, whose
 * frontmatter the team compares against the metadata, with the run's instructions as a section of
 * its own before the rules every member keeps.
 */
export function memberFile(member: ProjectTeamMember, instructions: string, description: string): string {
  const starting = agentFileContent(member);
  const marker = '## What you may write';
  const extra = [
    '## In this project',
    '',
    ...(description && description !== member.responsibility ? [`When to use it: ${description}`, ''] : []),
    instructions.trim(),
    '',
    '',
  ].join('\n');
  const at = starting.indexOf(marker);
  return at < 0 ? `${starting}\n${extra}` : `${starting.slice(0, at)}${extra}${starting.slice(at)}`;
}

interface Edits {
  member: Partial<Omit<ProposedTeamMember, 'fromTemplate'>>;
  resource: { name?: string; content?: string; scope?: ConfigScopeKind };
  workItem: Partial<Omit<StoredWorkItem, 'similarToId'>>;
}

/**
 * What the person changed before accepting, checked for shape; the services it goes to check the
 * rest (a role's clash, a label's length, an epic of another project).
 */
function parseEdits(input: unknown): Edits {
  const edits: Edits = { member: {}, resource: {}, workItem: {} };
  if (input === undefined || input === null) return edits;
  if (typeof input !== 'object' || Array.isArray(input)) throw new AssistantError('the request must be a JSON object', 400);
  const body = input as Partial<Record<keyof AcceptAssistantProposalRequest, unknown>>;
  const obj = (v: unknown, field: string): Record<string, unknown> | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) throw new AssistantError(`${field} must be an object`, 400);
    return v as Record<string, unknown>;
  };
  const text = (v: unknown, field: string, max = Infinity): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string') throw new AssistantError(`${field} must be a string`, 400);
    if (v.length > max) throw new AssistantError(`${field} is longer than ${String(max)} characters`, 400);
    return v;
  };
  const texts = (v: unknown, field: string, max = Infinity, each = Infinity): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new AssistantError(`${field} must be an array of strings`, 400);
    if (v.length > max) throw new AssistantError(`${field} lists more than ${String(max)}`, 400);
    if (v.some((x: string) => x.length > each)) throw new AssistantError(`an entry of ${field} is longer than ${String(each)} characters`, 400);
    return v as string[];
  };
  const member = obj(body.member, 'member');
  if (member) {
    const set = <K extends keyof Edits['member']>(key: K, value: Edits['member'][K] | undefined) => {
      if (value !== undefined) edits.member[key] = value;
    };
    // The team's limits, checked before the agent file is written rather than by the team after it
    set('role', text(member.role, 'member.role', MEMBER_SHORT_MAX));
    set('agent', text(member.agent, 'member.agent', 64));
    set('model', text(member.model, 'member.model', MEMBER_SHORT_MAX));
    set('responsibility', text(member.responsibility, 'member.responsibility', MEMBER_TEXT_MAX));
    set('description', text(member.description, 'member.description', MEMBER_DESCRIPTION_MAX));
    set('instructions', text(member.instructions, 'member.instructions', CONTENT_MAX));
    set('writes', texts(member.writes, 'member.writes', MEMBER_WRITES_MAX, MEMBER_TEXT_MAX));
  }
  const resource = obj(body.resource, 'resource');
  if (resource) {
    const name = text(resource.name, 'resource.name');
    const content = text(resource.content, 'resource.content', CONTENT_MAX);
    if (name !== undefined) edits.resource.name = name.trim();
    if (content !== undefined) edits.resource.content = content;
    if (resource.scope !== undefined) {
      if (resource.scope !== 'project' && resource.scope !== 'user') throw new AssistantError('resource.scope must be project or user', 400);
      edits.resource.scope = resource.scope;
    }
  }
  const workItem = obj(body.workItem, 'workItem');
  if (workItem) {
    const w = edits.workItem;
    const title = text(workItem.title, 'workItem.title');
    const description = text(workItem.description, 'workItem.description');
    const labels = texts(workItem.labels, 'workItem.labels');
    if (title !== undefined) w.title = title;
    if (description !== undefined) w.description = description;
    if (labels !== undefined) w.labels = labels;
    // The store refuses a type or a priority it does not know, with its own message
    if (workItem.type !== undefined) w.type = workItem.type as WorkItemType;
    if (workItem.priority !== undefined) w.priority = workItem.priority as WorkItemPriority;
    if (workItem.epicId !== undefined) {
      if (workItem.epicId !== null && typeof workItem.epicId !== 'string') throw new AssistantError('workItem.epicId must be a string or null', 400);
      w.epicId = workItem.epicId;
    }
    if (workItem.acceptanceCriteria !== undefined) {
      const list = workItem.acceptanceCriteria;
      if (!Array.isArray(list) || list.some((c) => !c || typeof c !== 'object' || typeof (c as { text?: unknown }).text !== 'string')) {
        throw new AssistantError('workItem.acceptanceCriteria must be an array of { text }', 400);
      }
      w.acceptanceCriteria = (list as Array<{ text: string }>).map((c) => ({ text: c.text }));
    }
  }
  return edits;
}
