import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentryLanguage,
  FlowRun,
  ProjectFlowSettings,
  ProjectSettings,
  ProjectTeamMember,
  ProjectTeamRole,
  PutTeamMemberRequest,
  Team,
  TeamAgentDriftField,
  TeamAgentFile,
  TeamChangeAction,
  TeamFromTemplateRequest,
  TeamMember,
  WorkItemStatus,
} from '@agentry/shared';
import { MAX_TEAM_COMMANDS, teamCommandProblem, WORK_ITEM_STATUSES } from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import type { AgentryEventInput } from './events.ts';
import { projectTemplate } from './project-templates.ts';

/*
 * The Team module (decision 26 of docs/plans/project-ecosystem.md). A member is two things: a CLI
 * agent file in the project's `.claude/agents/<agent>.md`, which is what `claude --agent` reads and
 * so also works from a terminal, and the metadata in `settings.team` (role, model, responsibility,
 * what it may write), which is Agentry's.
 *
 * The agent file belongs to the person as soon as they touch it. Agentry writes a starting file only
 * where there is none (`wx`, so not even a race overwrites one), and rewrites a file later only while
 * it is byte for byte what Agentry wrote: the hash of each file it wrote is kept in
 * `team-files/<projectId>.json` in the data directory. A file edited by hand, or one that was already
 * there, is never written again; where its frontmatter disagrees with the metadata the member is
 * served as `drifted`, and a deleted one as `missing`, for the person to decide.
 */

/** The agent file names the CLI and the settings accept. */
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MAX_SHORT = 100;
export const MAX_TEXT = 500;
export const MAX_WRITES = 50;
/** What a flow the template creates starts with; the person changes it on the Flow screen. */
const DEFAULT_MAX_BOUNCES = 3;
const ID = /^[A-Za-z0-9-]+$/;

/**
 * The columns a template's role answers for when the template creates the flow (decision 28): the
 * one who refines takes `backlog` and `todo`, the one who does the work `in_progress`, the one who
 * checks it `in_review`. The Architect is consulted, not handed cards.
 */
const DEFAULT_COLUMNS: Readonly<Record<string, readonly WorkItemStatus[]>> = {
  'product-owner': ['backlog', 'todo'],
  developer: ['in_progress'],
  qa: ['in_review'],
  researcher: ['backlog', 'todo'],
  writer: ['in_progress'],
  reviewer: ['in_review'],
};

/** How a role reads in the agent file; unknown roles are title-cased from their slug. */
const ROLE_TITLES: Readonly<Record<string, string>> = {
  'product-owner': 'Product Owner',
  qa: 'QA',
};

/** What each template role does when the flow hands it a card, written into its starting agent file. */
const ROLE_GUIDANCE: Readonly<Record<string, string>> = {
  'product-owner':
    'When a work item enters `backlog` or `todo`, refine it: complete its description, write acceptance criteria that can each be checked on their own, and, when the item needs one, write its specification in the documents folder.',
  architect:
    'You are consulted on the design. Read the codebase before deciding, record each decision that others will have to follow as an architecture decision in the documents folder, and review designs against what the code really does.',
  developer:
    "When a work item enters `in_progress`, implement it in the item's own worktree and branch, against its acceptance criteria. When QA sends it back, read QA's comment and fix what it names before anything else.",
  qa: 'When a work item enters `in_review`, verify it against each acceptance criterion in turn, running what can be run. Give a verdict: `pass` when every criterion holds, `fail` otherwise, naming what is missing so the Developer can fix it.',
  researcher:
    'When a work item enters `backlog` or `todo`, read the sources it needs and set out what is known, what is not, and where each claim comes from, so the question it asks can be answered.',
  writer: 'When a work item enters `in_progress`, turn the findings it points to into a document in the documents folder, clear and accurate.',
  reviewer:
    'When a work item enters `in_review`, check its documents for accuracy and clarity against their sources. Give a verdict: `pass` when they hold, `fail` otherwise, naming what to fix.',
};

export class TeamError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/** A project as the team reads it. */
export interface TeamProject {
  id: string;
  name: string;
  path: string;
  settings: ProjectSettings;
}

export interface TeamDeps {
  dataDir: string;
  /** The project and its settings; throws when the project is not imported */
  project(projectId: string): Promise<TeamProject>;
  /** Replaces the project's settings document, validated, emitting `project.updated` */
  saveSettings(projectId: string, settings: ProjectSettings): Promise<ProjectSettings>;
  emit(event: AgentryEventInput): void;
}

/**
 * Every flow run of a project, queued, running and ended, as the flow keeps them. The flow plugs it
 * in once it exists (`TeamService.runs`); without it every member reads as idle.
 */
export type TeamRunSource = (projectId: string) => readonly FlowRun[];

const sha = (content: string) => createHash('sha256').update(content).digest('hex');

export function roleTitle(role: string): string {
  return (
    ROLE_TITLES[role] ??
    role
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

/** The built-in roles in Spanish, as the interface names them (apps/web/src/i18n/GLOSSARY.md) */
const ROLE_TITLES_ES: Readonly<Record<string, string>> = {
  'product-owner': 'Product Owner',
  architect: 'Arquitecto',
  developer: 'Desarrollador',
  qa: 'QA',
  researcher: 'Investigador',
  writer: 'Redactor técnico',
  reviewer: 'Revisor',
};

/**
 * A role as the person reads it, for the first line of a chat Agentry starts for a member: a
 * built-in role in their language, a role of their own as they wrote it.
 */
export function roleTitleIn(role: string, language: AgentryLanguage): string {
  return (language === 'es' ? ROLE_TITLES_ES[role] : undefined) ?? roleTitle(role);
}

/** A YAML scalar that reads back as `value`: plain where that is safe, JSON-quoted (valid YAML) otherwise. */
function yamlScalar(value: string): string {
  const plain = /^[A-Za-z0-9][^:#\n"'`{}[\],&*!|>%@]*$/.test(value) && value.trim() === value;
  return plain ? value : JSON.stringify(value);
}

/** The fields of a Markdown file's frontmatter that the team compares: `key: value` lines, quotes undone. */
export function readFrontmatter(content: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  const fields: Record<string, string> = {};
  if (!block) return fields;
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    let value = (match[2] ?? '').trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    fields[match[1]] = value;
  }
  return fields;
}

/**
 * A list field of an agent file's frontmatter, in any of the forms the CLI reads: `tools: Read, Grep`,
 * a flow list `tools: [Read, Grep]`, or a block list of `- Read` lines under `tools:`. Null when the
 * field is absent.
 */
export function readFrontmatterList(content: string, field: string): string[] | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if (!block) return null;
  const lines = block.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^${field}:`).test(l));
  if (at < 0) return null;
  const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  const inline = (lines[at] ?? '').slice(field.length + 1).trim();
  if (inline) return inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (!item) break;
    const value = unquote(item[1] ?? '');
    if (value) items.push(value);
  }
  return items;
}

/**
 * The starting agent file of a member: frontmatter the CLI reads (`name`, `description`, `model`),
 * then a body stating the role, its responsibility, what it may write and how a flow run ends.
 */
export function agentFileContent(member: ProjectTeamMember): string {
  const title = roleTitle(member.role);
  const guidance = ROLE_GUIDANCE[member.role];
  // `writes: []` is "nothing of the project", not "no limit": the flow allows no edit outside the
  // documents folder then, and the file has to say the same
  const writes = !member.writes
    ? ['Agentry sets no limit of its own on what you write; keep to what your responsibility needs.']
    : member.writes.length
      ? [
          'You may write only these paths, relative to the project, and the documents folder:',
          '',
          ...member.writes.map((w) => `- \`${w}\``),
          '',
          "Agentry enforces this on the chats it starts for you; from a terminal, keep to it yourself. Read anything you need.",
        ]
      : [
          "You write none of the project's files: only documents in the documents folder. Read anything you need.",
          '',
          'Agentry enforces this on the chats it starts for you; from a terminal, keep to it yourself.',
        ];
  // Only said when the member has a list: a file written before the list existed reads the same
  const commands = !member.commands
    ? []
    : [
        '## What you may run',
        '',
        ...(member.commands.length
          ? [
              'When you work on an item, the shell runs only these commands (`*` stands for any arguments):',
              '',
              ...member.commands.map((c) => `- \`${c}\``),
            ]
          : ['When you work on an item, you have no shell: read, edit and write files only.']),
        '',
        'Agentry enforces this on the chats it starts for you; from a terminal, keep to it yourself.',
        '',
      ];
  return [
    '---',
    `name: ${yamlScalar(member.agent)}`,
    `description: ${yamlScalar(member.responsibility)}`,
    `model: ${yamlScalar(member.model)}`,
    '---',
    '',
    `You are the ${title} of this project's team.`,
    '',
    `Your responsibility: ${member.responsibility}`,
    '',
    ...(guidance ? [guidance, ''] : []),
    '## What you may write',
    '',
    ...writes,
    '',
    ...commands,
    '## How a flow run ends',
    '',
    "Agentry's flow starts you on a work item when its card enters a column you answer for. End every such run with the structured result it asks for:",
    '',
    '- `summary`: what you did, which becomes your comment on the item;',
    '- `verdict`: `pass` or `fail`, only when you verify the item;',
    '- `criteria`: when you verify the item, each acceptance criterion by its id, `met` or not, with a note. The item passes only when every one is met;',
    '- `memoryProposals`: what the team should remember, each with its target, its text and why. Nothing is written until a person approves it;',
    '- `documents`: every document you wrote in the documents folder, with its kind (`spec`, `adr`, `report` or `doc`).',
    '',
    'Never move a work item to `done`: a person approves that.',
    '',
  ].join('\n');
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new TeamError(`${field} must be a non-empty string`, 400);
  if (value.length > max) throw new TeamError(`${field} is longer than ${max} characters`, 400);
  return value.trim();
}

function agentName(value: string): string {
  if (!AGENT_NAME.test(value)) throw new TeamError('agent must be an agent file name without .md (letters, digits, _ . -)', 400);
  return value;
}

/** Validates a member's metadata as `PUT` receives it. Paths are checked again, whole, by the settings. */
export function parseMemberRequest(agent: string, input: unknown): { member: ProjectTeamMember; createFile: boolean } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TeamError('the member must be a JSON object', 400);
  const body = input as Partial<Record<keyof PutTeamMemberRequest, unknown>>;
  const member: ProjectTeamMember = {
    agent: agentName(agent),
    role: text(body.role, 'role', MAX_SHORT),
    model: text(body.model, 'model', MAX_SHORT),
    responsibility: text(body.responsibility, 'responsibility', MAX_TEXT),
  };
  if (body.writes !== undefined && body.writes !== null) {
    if (!Array.isArray(body.writes)) throw new TeamError('writes must be an array of paths', 400);
    if (body.writes.length > MAX_WRITES) throw new TeamError(`writes lists more than ${MAX_WRITES} paths`, 400);
    member.writes = [...new Set(body.writes.map((w) => text(w, 'writes', MAX_TEXT)))];
  }
  // null, like leaving it out, is an unrestricted shell; [] is no shell at all
  if (body.commands !== undefined && body.commands !== null) {
    if (!Array.isArray(body.commands)) throw new TeamError('commands must be an array of command patterns', 400);
    if (body.commands.length > MAX_TEAM_COMMANDS) throw new TeamError(`commands lists more than ${MAX_TEAM_COMMANDS} patterns`, 400);
    for (const command of body.commands as unknown[]) {
      const problem = teamCommandProblem(command);
      if (problem === 'comma') throw new TeamError(`a command pattern cannot contain a comma: ${JSON.stringify(command)}`, 400);
      if (problem) throw new TeamError(`not a command pattern: ${JSON.stringify(command)} (one line, no parentheses, not only a wildcard)`, 400);
    }
    member.commands = [...new Set(body.commands as string[])];
  }
  if (body.createFile !== undefined && typeof body.createFile !== 'boolean') throw new TeamError('createFile must be a boolean', 400);
  return { member, createFile: body.createFile === true };
}

/**
 * The roles "from template" offers: the project's template's team, or the most complete one when
 * the project has no template (imported before modules existed) or its template has no team
 * (Simple), since switching the Team module on means wanting one.
 */
export function templateTeam(settings: ProjectSettings): ProjectTeamRole[] {
  const own = settings.template ? projectTemplate(settings.template).team : [];
  return own.length ? own : projectTemplate('custom').team;
}

/** Keeps, per project, the hash of each agent file Agentry wrote, so it knows which ones are still its own. */
class WrittenFiles {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'team-files');
  }

  private file(projectId: string): string {
    if (!ID.test(projectId)) throw new TeamError('invalid project id', 400);
    return join(this.dir, `${projectId}.json`);
  }

  read(projectId: string): Record<string, string> {
    try {
      const raw = JSON.parse(readFileSync(this.file(projectId), 'utf8')) as { files?: unknown };
      if (!raw.files || typeof raw.files !== 'object' || Array.isArray(raw.files)) return {};
      return Object.fromEntries(Object.entries(raw.files).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch {
      return {};
    }
  }

  async record(projectId: string, agent: string, content: string): Promise<void> {
    const files = { ...this.read(projectId), [agent]: sha(content) };
    await writeAtomic(this.file(projectId), `${JSON.stringify({ projectId, files }, null, 2)}\n`);
  }
}

/** What writing a member's file came to: `written`, a new file; `rewritten`, Agentry's own followed the metadata; `kept`, left as it was. */
type FileWrite = 'written' | 'rewritten' | 'kept';

export class TeamService {
  /** The flow's runs, plugged in by the flow; null leaves every member idle. */
  runs: TeamRunSource | null = null;
  private readonly written: WrittenFiles;
  /** Changes run one at a time: each reads the settings, edits the team and writes them back whole. */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TeamDeps) {
    this.written = new WrittenFiles(deps.dataDir);
  }

  private agentsDir(project: TeamProject): string {
    return join(project.path, '.claude', 'agents');
  }

  private agentPath(project: TeamProject, agent: string): string {
    return join(this.agentsDir(project), `${agentName(agent)}.md`);
  }

  /** The team as `GET /projects/:id/team` serves it, readable with the module off. */
  async team(projectId: string): Promise<Team> {
    return this.view(await this.deps.project(projectId));
  }

  private view(project: TeamProject): Team {
    const members = project.settings.team?.members ?? [];
    const runs = this.runs?.(project.id) ?? [];
    const used = new Set(members.map((m) => m.agent));
    return {
      projectId: project.id,
      enabled: project.settings.modules.includes('team'),
      members: members.map((m) => this.memberView(project, m, runs)),
      unassignedAgents: this.agentFiles(project).filter((a) => !used.has(a)),
    };
  }

  private agentFiles(project: TeamProject): string[] {
    const dir = this.agentsDir(project);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name.slice(0, -'.md'.length))
      .filter((name) => AGENT_NAME.test(name))
      .sort((a, b) => a.localeCompare(b));
  }

  private memberView(project: TeamProject, member: ProjectTeamMember, runs: readonly FlowRun[]): TeamMember {
    const own = runs.filter((r) => r.agent === member.agent);
    const running = own.filter((r) => r.state === 'running').sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
    const ended = own.filter((r) => r.state === 'ended').sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
    const columns = project.settings.flow?.columns ?? {};
    return {
      ...member,
      file: this.fileState(project, member),
      columns: WORK_ITEM_STATUSES.filter((s) => columns[s] === member.role),
      running,
      queued: own.filter((r) => r.state === 'queued').length,
      lastRun: ended[0] ?? null,
    };
  }

  private fileState(project: TeamProject, member: ProjectTeamMember): TeamAgentFile {
    const path = `.claude/agents/${member.agent}.md`;
    const full = this.agentPath(project, member.agent);
    let content: string;
    let updatedAt: string;
    try {
      content = readFileSync(full, 'utf8');
      updatedAt = statSync(full).mtime.toISOString();
    } catch {
      return { path, state: 'missing', drift: [], description: null, model: null, updatedAt: null };
    }
    const fm = readFrontmatter(content);
    const drift: TeamAgentDriftField[] = [];
    // The CLI needs a name and a description to offer the agent, so leaving them out is a drift too;
    // a file without a model inherits one, and the flow passes the member's with `--model` anyway
    if (fm.name !== member.agent) drift.push('name');
    if (fm.description !== member.responsibility) drift.push('description');
    if (fm.model !== undefined && fm.model !== member.model) drift.push('model');
    return {
      path,
      state: drift.length ? 'drifted' : 'ok',
      drift,
      description: fm.description ?? null,
      model: fm.model ?? null,
      updatedAt,
    };
  }

  /**
   * Writes the member's starting file where there is none; rewrites it to follow the metadata only
   * while it is still exactly what Agentry last wrote. Anything else on disk is the person's.
   */
  private async writeFile(project: TeamProject, member: ProjectTeamMember, create: boolean): Promise<FileWrite> {
    const full = this.agentPath(project, member.agent);
    const content = agentFileContent(member);
    let current: string | null = null;
    try {
      current = readFileSync(full, 'utf8');
    } catch {
      current = null;
    }
    if (current === null) {
      if (!create) return 'kept';
      try {
        await mkdir(this.agentsDir(project), { recursive: true });
        await writeFile(full, content, { flag: 'wx' });
      } catch (err) {
        // Someone wrote it between the read and now: theirs wins
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'kept';
        throw err;
      }
      await this.written.record(project.id, member.agent, content);
      return 'written';
    }
    const ours = this.written.read(project.id)[member.agent];
    if (ours === undefined || ours !== sha(current) || current === content) return 'kept';
    await writeAtomic(full, content);
    await this.written.record(project.id, member.agent, content);
    return 'rewritten';
  }

  private requireEnabled(project: TeamProject): void {
    if (!project.settings.modules.includes('team')) {
      throw new TeamError("the Team module is off in this project: switch it on in the project's settings to change its team", 409);
    }
    if (!existsSync(project.path)) throw new TeamError('project directory is missing on disk', 409);
  }

  private emit(project: TeamProject, action: TeamChangeAction, agents: string[], title: string): void {
    this.deps.emit({ type: 'team.changed', title, projectId: project.id, action, agents });
  }

  /**
   * Adds the template's roles the person accepted, each with its agent file (an existing file is
   * kept as it is) and, for the roles the flow knows, the columns nobody answers for yet. A role
   * already on the team is left alone. The flow is created switched off: turning it on is the
   * person's choice.
   */
  async fromTemplate(projectId: string, input: unknown): Promise<Team> {
    return (await this.addFromTemplate(projectId, input)).team;
  }

  /**
   * `fromTemplate`, and the members it added: `POST /projects/:id/team/from-template` answers 201
   * when it added any and 200 when every role was already on the team, like the other creating routes.
   */
  async addFromTemplate(projectId: string, input: unknown): Promise<{ team: Team; added: string[] }> {
    return this.serialized(async () => {
      const project = await this.deps.project(projectId);
      this.requireEnabled(project);
      const offered = templateTeam(project.settings);
      const body = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Partial<Record<keyof TeamFromTemplateRequest, unknown>>;
      let roles = offered.map((r) => r.role);
      if (body.roles !== undefined && body.roles !== null) {
        if (!Array.isArray(body.roles) || body.roles.some((r) => typeof r !== 'string')) throw new TeamError('roles must be an array of role names', 400);
        const unknown = (body.roles as string[]).filter((r) => !roles.includes(r));
        if (unknown.length) throw new TeamError(`the template offers no role ${unknown.join(', ')}; it offers ${roles.join(', ')}`, 400);
        roles = roles.filter((r) => (body.roles as string[]).includes(r));
      }
      const members = [...(project.settings.team?.members ?? [])];
      const added: ProjectTeamMember[] = [];
      for (const role of offered.filter((r) => roles.includes(r.role))) {
        if (members.some((m) => m.role === role.role)) continue;
        let agent = role.role;
        for (let n = 2; members.some((m) => m.agent === agent); n++) agent = `${role.role}-${n}`;
        const member: ProjectTeamMember = { agent, ...role };
        members.push(member);
        added.push(member);
      }
      if (!added.length) return { team: this.view(project), added: [] };

      const flow: ProjectFlowSettings = project.settings.flow ?? { enabled: false, columns: {}, maxBounces: DEFAULT_MAX_BOUNCES };
      const columns = { ...flow.columns };
      for (const member of added) for (const column of DEFAULT_COLUMNS[member.role] ?? []) columns[column] ??= member.role;
      const settings = await this.deps.saveSettings(project.id, { ...project.settings, team: { members }, flow: { ...flow, columns } });
      const saved = { ...project, settings };
      for (const member of added) await this.writeFile(saved, member, true);
      this.emit(saved, 'template', added.map((m) => m.agent), `${project.name}: ${added.length} team members from the template`);
      return { team: this.view(saved), added: added.map((m) => m.agent) };
    });
  }

  /**
   * Creates or replaces a member's metadata. Its agent file follows only where Agentry still owns it
   * (see `writeFile`); `createFile` writes a starting one where there is none, a new member's or a
   * deleted one's. Two members may not share a role: the flow hands a column to a role, and needs to
   * know whose it is.
   */
  async putMember(projectId: string, agent: string, input: unknown): Promise<TeamMember> {
    const { member, createFile } = parseMemberRequest(agent, input);
    return this.serialized(async () => {
      const project = await this.deps.project(projectId);
      this.requireEnabled(project);
      const members = [...(project.settings.team?.members ?? [])];
      const rival = members.find((m) => m.role === member.role && m.agent !== member.agent);
      if (rival) throw new TeamError(`the role ${member.role} is already ${rival.agent}'s`, 409);
      const index = members.findIndex((m) => m.agent === member.agent);
      const action: TeamChangeAction = index < 0 ? 'created' : 'updated';
      if (index < 0) members.push(member);
      else members[index] = member;
      const settings = await this.deps.saveSettings(project.id, { ...project.settings, team: { members } });
      const saved = { ...project, settings };
      await this.writeFile(saved, member, createFile);
      this.emit(saved, action, [member.agent], `${project.name}: ${roleTitle(member.role)} ${action === 'created' ? 'joined the team' : 'updated'}`);
      return this.memberView(saved, member, this.runs?.(project.id) ?? []);
    });
  }

  /**
   * Takes a member off the team. Its agent file stays where it is, still usable from a terminal and
   * offered again by "add a member"; the flow's columns keep naming the role, and answer to nobody
   * until a member takes it again.
   */
  async removeMember(projectId: string, agent: string): Promise<void> {
    agentName(agent);
    await this.serialized(async () => {
      const project = await this.deps.project(projectId);
      this.requireEnabled(project);
      const members = project.settings.team?.members ?? [];
      const member = members.find((m) => m.agent === agent);
      if (!member) throw new TeamError('team member not found', 404);
      await this.deps.saveSettings(project.id, { ...project.settings, team: { members: members.filter((m) => m !== member) } });
      this.emit(project, 'removed', [agent], `${project.name}: ${roleTitle(member.role)} left the team`);
    });
  }

  /**
   * An agent file of the project saved or deleted outside the team's own routes (the resources
   * editor, the assistant): announced as `file` when it is a member's, whose file state and drift
   * change with it, or while the Team module is on, whose unassigned agents it is. Never throws.
   */
  async agentFileChanged(projectId: string, agent: string, action: 'saved' | 'removed'): Promise<void> {
    try {
      const project = await this.deps.project(projectId);
      const member = project.settings.team?.members.find((m) => m.agent === agent);
      if (!member && !project.settings.modules.includes('team')) return;
      const what = member ? `${roleTitle(member.role)}'s agent file` : `agent file ${agent}`;
      this.emit(project, 'file', [agent], `${project.name}: ${what} ${action === 'saved' ? 'saved' : 'deleted'}`);
    } catch {
      // the project went away meanwhile: nobody is left to tell
    }
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }
}
