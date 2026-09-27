import {
  ASSISTANT_RESOURCE_KINDS,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_TYPES,
  assistantResourcePath,
  type AssistantFinding,
  type AssistantProposalKind,
  type AssistantResourceKind,
  type AssistantRunKind,
  type ProjectTeamRole,
  type ProposedResource,
  type ProposedTeamMember,
  type WorkItemPriority,
  type WorkItemType,
} from '@agentry/shared';
import { roleTitle } from './team.ts';

/**
 * What an assistant run is asked and how its answer is read: the prompt, the JSON Schema its result
 * is held to (`--json-schema`), and a defensive reading of that result. Kept apart from the service
 * so the words a paid run is given can be read, and tested, on their own.
 */

/** A run's proposals per kind at most; more are cut, not refused */
export const PROPOSALS_MAX = 12;
const CONTENT_MAX = 100_000;
const TEXT_MAX = 20_000;
const SHORT_MAX = 200;
const LABELS_MAX = 10;
const CRITERIA_MAX = 30;
const CRITERION_MAX = 500;
const WRITES_MAX = 20;
const FINDINGS_MAX = 16;
const READ_MAX = 200;

/** A file or directory name the resources and the team accept */
export const RESOURCE_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** What Agentry hands a run beside the directory itself, and what it offers when a project is new. */
export interface AssistantBrief {
  kind: AssistantRunKind;
  projectName: string;
  /** What the person described: the one resource to build, or what an empty project is for */
  description: string | null;
  resourceKind: AssistantResourceKind | null;
  /** The directory had nothing to read: the run works from the description alone */
  empty: boolean;
  /** Which kinds this run proposes; a kind whose module is off is left out */
  proposes: AssistantProposalKind[];
  templateName: string | null;
  templateTeam: ProjectTeamRole[];
  team: Array<{ agent: string; role: string; model: string; responsibility: string }>;
  resources: Record<AssistantResourceKind, string[]>;
  workItems: Array<{ key: string; type: WorkItemType; status: string; title: string }>;
  /** Items beyond the ones listed, which the prompt says exist */
  moreWorkItems: number;
  milestones: string[];
  chats: string[];
}

/** One entry of the answer's `read`: what the run says it looked at. */
export interface AnsweredRead {
  kind: 'file' | 'dir' | 'git';
  path: string | null;
}

export interface AnsweredMember extends ProposedTeamMember {
  reason: string;
}

export interface AnsweredResource extends ProposedResource {
  reason: string;
}

export interface AnsweredWorkItem {
  type: WorkItemType;
  title: string;
  description: string;
  priority: WorkItemPriority;
  labels: string[];
  acceptanceCriteria: Array<{ text: string }>;
  /** Keys as the run wrote them; the service resolves them to ids */
  epicKey: string | null;
  similarToKey: string | null;
  reason: string;
}

export interface AssistantAnswer {
  summary: string;
  findings: AssistantFinding[];
  read: AnsweredRead[];
  members: AnsweredMember[];
  resources: AnsweredResource[];
  workItems: AnsweredWorkItem[];
}

const FRONTMATTER: Record<AssistantResourceKind, string> = {
  agents: '`name` (the file name) and `description` (when to use it), optionally `tools` and `model`',
  skills: '`name` (the directory name) and `description` (when it applies)',
  commands: '`description`, optionally `argument-hint`',
};

const nullableString = (description: string) => ({ type: ['string', 'null'], description });
const strings = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

function memberSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      role: { type: 'string', description: 'A short role id in kebab case, such as developer or qa' },
      agent: { type: 'string', description: 'The agent file name under .claude/agents/, without .md; usually the role' },
      model: { type: 'string', description: 'opus for roles that decide (product owner, architect), sonnet for the others' },
      responsibility: { type: 'string', description: 'One line on what it answers for' },
      writes: strings('Paths relative to the project it may write, such as src/ or docs/; empty means it only works on work items'),
      description: { type: 'string', description: "The agent file's description: when the CLI should pick it" },
      instructions: { type: 'string', description: "The agent file's body in Markdown, specific to this project; empty lets Agentry write its standard one" },
      reason: { type: 'string', description: 'Why this project needs it, in one or two sentences' },
    },
    required: ['role', 'agent', 'model', 'responsibility', 'writes', 'description', 'instructions', 'reason'],
  };
}

function resourceSchema(kinds: readonly AssistantResourceKind[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...kinds] },
      name: { type: 'string', description: 'File or directory name without extension: letters, digits, _ . -' },
      description: { type: 'string', description: 'One line, as its frontmatter says it' },
      content: { type: 'string', description: 'The whole file, frontmatter included (for a skill, its SKILL.md)' },
      reason: { type: 'string', description: 'What in this project makes it worth having, in one or two sentences' },
    },
    required: ['kind', 'name', 'description', 'content', 'reason'],
  };
}

function workItemSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...WORK_ITEM_TYPES] },
      title: { type: 'string' },
      description: { type: 'string', description: 'Markdown: what and why, with the files it concerns' },
      priority: { type: 'string', enum: [...WORK_ITEM_PRIORITIES] },
      labels: strings('A few short labels'),
      acceptanceCriteria: strings('Each one checkable on its own'),
      epic: nullableString('The key of an existing epic it belongs to, such as AGN-12; null for none'),
      similarTo: nullableString('The key of an existing work item it resembles; null when none does'),
      reason: { type: 'string', description: 'Why it is needed, in one or two sentences; it becomes its first comment' },
    },
    required: ['type', 'title', 'description', 'priority', 'labels', 'acceptanceCriteria', 'epic', 'similarTo', 'reason'],
  };
}

/** The JSON Schema a run's result is held to. Only the lists the run proposes are asked for. */
export function assistantSchema(brief: Pick<AssistantBrief, 'kind' | 'proposes' | 'resourceKind' | 'description'>): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    summary: { type: 'string', description: 'What you found, in two or three sentences' },
    read: {
      type: 'array',
      description: 'What you read: files and directories relative to the project, and git for its history',
      items: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['file', 'dir', 'git'] }, path: nullableString('Relative path; a directory ends in /; null for git') },
        required: ['kind', 'path'],
      },
    },
  };
  const required = ['summary', 'read'];
  if (brief.kind === 'project') {
    properties.findings = {
      type: 'array',
      description: 'Tags: stack for what the project uses (TypeScript, Fastify), gap for what it lacks (no CI)',
      items: { type: 'object', properties: { kind: { type: 'string', enum: ['stack', 'gap'] }, label: { type: 'string' } }, required: ['kind', 'label'] },
    };
    required.push('findings');
  }
  if (brief.proposes.includes('team-member')) {
    properties.teamMembers = { type: 'array', items: memberSchema() };
    required.push('teamMembers');
  }
  if (brief.proposes.includes('resource')) {
    const single = brief.kind === 'resources' && !!brief.description && !!brief.resourceKind;
    properties.resources = {
      type: 'array',
      items: resourceSchema(single && brief.resourceKind ? [brief.resourceKind] : ASSISTANT_RESOURCE_KINDS),
      ...(single ? { minItems: 1, maxItems: 1 } : {}),
    };
    required.push('resources');
  }
  if (brief.proposes.includes('work-item')) {
    properties.workItems = { type: 'array', items: workItemSchema() };
    required.push('workItems');
  }
  return { type: 'object', properties, required };
}

const list = (values: readonly string[], none = 'none') => (values.length ? values.join(', ') : none);

/** The prompt of a run: who it is, that it writes nothing, what Agentry already knows, what to propose. */
export function assistantPrompt(brief: AssistantBrief): string {
  const lines: string[] = [
    `You are Agentry's project assistant for the project "${brief.projectName}", in this directory.`,
    '',
    'You are read-only. Read with Read, Grep and Glob, and use Bash only for `git log`, `git status` and `ls`. Do not try to create, edit or delete any file: nothing is written until the person accepts each of your proposals, one by one, and Agentry writes it then.',
    '',
  ];
  if (brief.empty) {
    lines.push('The directory has nothing to read yet: no files, no chats, no git history. Work from what the person described.', '');
  } else {
    lines.push(
      'Read the project first: its README and manifests, its CLAUDE.md if there is one, its documents, the layout of its source, and its recent history with `git log`. Read enough to be specific; you do not need to read every file.',
      '',
    );
  }

  lines.push('## What Agentry already knows', '');
  lines.push(`### Team (${String(brief.team.length)})`);
  if (brief.team.length) for (const m of brief.team) lines.push(`- ${roleTitle(m.role)} (${m.role}, agent ${m.agent}, ${m.model}): ${m.responsibility}`);
  else lines.push('- nobody yet');
  lines.push('', "### Resources in the project's .claude/");
  for (const kind of ASSISTANT_RESOURCE_KINDS) lines.push(`- ${kind}: ${list(brief.resources[kind])}`);
  lines.push('', `### Work items (${String(brief.workItems.length + brief.moreWorkItems)}): do not propose these again`);
  if (brief.workItems.length) for (const w of brief.workItems) lines.push(`- ${w.key} [${w.type}, ${w.status}] ${w.title}`);
  else lines.push('- none yet');
  if (brief.moreWorkItems) lines.push(`- and ${String(brief.moreWorkItems)} more, older`);
  lines.push('', `### Open milestones: ${list(brief.milestones)}`);
  if (brief.chats.length) {
    lines.push('', '### What recent Claude Code chats in this directory were about');
    for (const c of brief.chats) lines.push(`- ${c}`);
  }
  lines.push('', "The project's journal, if it has entries, is in your system prompt.", '');

  if (brief.description && brief.kind !== 'resources') lines.push('## What the person says the project is for', '', brief.description, '');

  lines.push('## What to propose', '');
  if (brief.kind === 'resources' && brief.description && brief.resourceKind) {
    lines.push(
      `Build exactly one ${singular(brief.resourceKind)} from this description, fitted to this project:`,
      '',
      brief.description,
      '',
      `Return it in \`resources\` with its whole content. Its frontmatter carries ${FRONTMATTER[brief.resourceKind]}.`,
    );
  } else {
    if (brief.proposes.includes('team-member')) {
      const template = brief.templateTeam.map((r) => `${r.role} (${r.model}): ${r.responsibility}`);
      lines.push(
        '- `teamMembers`: the roles this project needs. A member is a CLI agent file in `.claude/agents/`.',
        template.length
          ? `  Start from the roles of the ${brief.templateName ?? 'project'} template, adapted to the project: ${template.join('; ')}. Add a role beyond them only where the project clearly needs it, and leave out a role the team already has.`
          : '  Leave out a role the team already has.',
        '  Give each one what it may write (`writes`), keeping the roles that decide or verify to documents and tests.',
      );
    }
    if (brief.proposes.includes('resource')) {
      lines.push(
        "- `resources`: agents, skills and commands that would help in this repository, each with its whole file content, for the project's `.claude/`. Propose only what the project's own rules or repeated work justify, and nothing it already has.",
        ...ASSISTANT_RESOURCE_KINDS.map((k) => `  A ${singular(k)}'s frontmatter carries ${FRONTMATTER[k]}.`),
      );
    }
    if (brief.proposes.includes('work-item')) {
      lines.push(
        brief.kind === 'project'
          ? '- `workItems`: the first work items: what is missing or broken, most useful first, at most eight.'
          : '- `workItems`: the next work items: what is missing or broken, most useful first, at most eight.',
        '  Each is created in the backlog if the person accepts it. Name an existing epic by its key when it belongs to one, and an existing item it resembles in `similarTo`.',
      );
    }
    lines.push('', 'Give each proposal its reason, specific to what you read. Propose fewer, better things rather than many.');
  }
  lines.push('', 'End with the structured result, and list in `read` what you read.');
  return lines.join('\n');
}

/** Told to a run's chat continued after Agentry restarted in the middle of it. */
export const RESUME_PROMPT = 'Agentry restarted while you were working on this. Carry on from where you were, still read-only, and end with the structured result.';

function singular(kind: AssistantResourceKind): string {
  return kind === 'agents' ? 'agent' : kind === 'skills' ? 'skill' : 'command';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = SHORT_MAX): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const body = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arrayOf = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

function stringList(v: unknown, max: number, each: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arrayOf(v, max * 2)) {
    const s = str(raw, each);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function relPath(v: unknown): string | null {
  const s = str(v, 500);
  if (!s) return null;
  const clean = s.replace(/\\/g, '/').replace(/^\.\//, '');
  if (clean.startsWith('/') || clean.split('/').includes('..')) return null;
  return clean;
}

/** A role id as the team keeps it: lower case, words joined by `-`. */
function roleId(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const id = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || null;
}

/**
 * Reads a run's structured result; null when it is not one. Lists the run was not asked for are
 * ignored, entries that cannot be used are dropped, and oversized lists are cut, never refused: a
 * run is paid for, and one bad proposal should not throw away the good ones.
 */
export function parseAnswer(raw: unknown, brief: Pick<AssistantBrief, 'kind' | 'proposes' | 'resourceKind' | 'description' | 'templateTeam'>): AssistantAnswer | null {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!isObject(value)) return null;
  const summary = typeof value.summary === 'string' ? value.summary.trim().slice(0, TEXT_MAX) : null;
  if (summary === null) return null;

  const findings: AssistantFinding[] = [];
  if (brief.kind === 'project') {
    const seen = new Set<string>();
    for (const f of arrayOf(value.findings, FINDINGS_MAX * 2)) {
      if (!isObject(f)) continue;
      const label = str(f.label, 60);
      const kind = f.kind === 'gap' ? 'gap' : f.kind === 'stack' ? 'stack' : null;
      if (!label || !kind || seen.has(`${kind}:${label.toLowerCase()}`)) continue;
      seen.add(`${kind}:${label.toLowerCase()}`);
      findings.push({ kind, label });
      if (findings.length >= FINDINGS_MAX) break;
    }
  }

  const read: AnsweredRead[] = [];
  for (const r of arrayOf(value.read, READ_MAX)) {
    if (!isObject(r)) continue;
    if (r.kind === 'git') read.push({ kind: 'git', path: null });
    else if (r.kind === 'file' || r.kind === 'dir') {
      const path = relPath(r.path);
      if (path) read.push({ kind: r.kind, path: r.kind === 'dir' && !path.endsWith('/') ? `${path}/` : path });
    }
  }

  const members: AnsweredMember[] = [];
  if (brief.proposes.includes('team-member')) {
    const templateRoles = new Set(brief.templateTeam.map((r) => r.role));
    const roles = new Set<string>();
    const agents = new Set<string>();
    for (const m of arrayOf(value.teamMembers, PROPOSALS_MAX * 2)) {
      if (!isObject(m)) continue;
      const role = roleId(m.role);
      const responsibility = str(m.responsibility, 2000);
      if (!role || !responsibility || roles.has(role)) continue;
      const named = str(m.agent, 64);
      const agent = named && RESOURCE_NAME.test(named) && !agents.has(named) ? named : role;
      if (!RESOURCE_NAME.test(agent) || agents.has(agent)) continue;
      roles.add(role);
      agents.add(agent);
      members.push({
        role,
        agent,
        model: str(m.model, 100) ?? 'sonnet',
        responsibility,
        writes: stringList(m.writes, WRITES_MAX, 500).filter((w) => relPath(w) !== null),
        fromTemplate: templateRoles.has(role),
        description: str(m.description, 2000) ?? responsibility,
        instructions: body(m.instructions, CONTENT_MAX),
        reason: body(m.reason, 2000),
      });
      if (members.length >= PROPOSALS_MAX) break;
    }
  }

  const resources: AnsweredResource[] = [];
  if (brief.proposes.includes('resource')) {
    const single = brief.kind === 'resources' && !!brief.description && brief.resourceKind ? brief.resourceKind : null;
    const names = new Set<string>();
    for (const r of arrayOf(value.resources, PROPOSALS_MAX * 2)) {
      if (!isObject(r)) continue;
      const kind = ASSISTANT_RESOURCE_KINDS.find((k) => k === r.kind);
      const rawName = str(r.name, 64)?.replace(/^\//, '').replace(/\.md$/i, '') ?? null;
      const content = body(r.content, CONTENT_MAX);
      if (!kind || (single && kind !== single) || !rawName || !RESOURCE_NAME.test(rawName) || !content) continue;
      if (names.has(`${kind}/${rawName}`)) continue;
      names.add(`${kind}/${rawName}`);
      resources.push({
        kind,
        name: rawName,
        description: str(r.description, 2000) ?? '',
        content: content.endsWith('\n') ? content : `${content}\n`,
        scope: 'project',
        path: assistantResourcePath(kind, rawName, 'project'),
        reason: body(r.reason, 2000),
      });
      if (resources.length >= (single ? 1 : PROPOSALS_MAX)) break;
    }
  }

  const workItems: AnsweredWorkItem[] = [];
  if (brief.proposes.includes('work-item')) {
    const titles = new Set<string>();
    for (const w of arrayOf(value.workItems, PROPOSALS_MAX * 2)) {
      if (!isObject(w)) continue;
      const title = str(w.title, 300);
      if (!title || titles.has(title.toLowerCase())) continue;
      titles.add(title.toLowerCase());
      workItems.push({
        type: WORK_ITEM_TYPES.find((t) => t === w.type) ?? 'task',
        title,
        description: body(w.description, 50_000),
        priority: WORK_ITEM_PRIORITIES.find((p) => p === w.priority) ?? 'medium',
        labels: stringList(w.labels, LABELS_MAX, 50),
        acceptanceCriteria: stringList(w.acceptanceCriteria, CRITERIA_MAX, CRITERION_MAX).map((text) => ({ text })),
        epicKey: str(w.epic, 40),
        similarToKey: str(w.similarTo, 40),
        reason: body(w.reason, 2000),
      });
      if (workItems.length >= PROPOSALS_MAX) break;
    }
  }

  return { summary, findings, read, members, resources, workItems };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
