import type { FlowRun, FlowStage, ProjectFlowSettings, ProjectSettings, PutTeamMemberRequest, TeamMember, WorkItemStatus } from '@agentry/shared';
import { WORK_ITEM_STATUSES } from '@agentry/shared';

/**
 * The Team tab's pure model: role names and initials, the flow as the screens edit it, and what the
 * members did last. docs/plans/project-ecosystem.md, orchestration 3.
 */

/** Roles the built-in templates bring; their names are translated, any other role is shown as written. */
export const KNOWN_ROLES = ['product-owner', 'architect', 'developer', 'qa', 'researcher', 'writer', 'reviewer'] as const;
export type KnownRole = (typeof KNOWN_ROLES)[number];

export const isKnownRole = (role: string): role is KnownRole => (KNOWN_ROLES as readonly string[]).includes(role);

/** The same in both languages: a team says PO, DEV and QA whatever it speaks. */
const INITIALS: Record<KnownRole, string> = {
  'product-owner': 'PO',
  architect: 'AR',
  developer: 'DEV',
  qa: 'QA',
  researcher: 'RES',
  writer: 'DOC',
  reviewer: 'REV',
};

/** What a role avatar says: the template's acronym, or the initials of a role someone named. */
export function roleInitials(role: string): string {
  if (isKnownRole(role)) return INITIALS[role];
  const words = role.split(/[-_\s.]+/).filter(Boolean);
  if (words.length > 1)
    return words
      .slice(0, 3)
      .map((word) => word.charAt(0))
      .join('')
      .toUpperCase();
  return (words[0] ?? role).slice(0, 3).toUpperCase() || '?';
}

/** A role nobody translated, readable: `tech-writer` reads "Tech writer", in sentence case as the glossary asks. */
export function roleFallbackName(role: string): string {
  const text = role.split(/[-_\s]+/).filter(Boolean).join(' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : role;
}

/** What a member does when a card enters a column, as the flow names its run. Done has none. */
export function stageOf(status: WorkItemStatus): FlowStage | null {
  if (status === 'backlog' || status === 'todo') return 'refine';
  if (status === 'in_progress') return 'work';
  if (status === 'in_review') return 'verify';
  return null;
}

/** The columns a role can answer for: every one but Done, which is the person's. */
export const FLOW_COLUMNS = WORK_ITEM_STATUSES.filter((status) => status !== 'done');

export const DEFAULT_MAX_BOUNCES = 3;
export const MAX_BOUNCES = 20;

/**
 * The flow as the Flow screen starts editing it: the saved one, or, for a project that never saved
 * one, off, with each column given to the template role that answers for it when the team has it.
 */
export function flowOf(settings: Pick<ProjectSettings, 'flow'> | undefined, members: readonly Pick<TeamMember, 'role'>[]): ProjectFlowSettings {
  if (settings?.flow) return { ...settings.flow, columns: { ...settings.flow.columns } };
  const has = (role: string) => members.some((member) => member.role === role);
  const columns: ProjectFlowSettings['columns'] = {};
  if (has('product-owner')) {
    columns.backlog = 'product-owner';
    columns.todo = 'product-owner';
  }
  if (has('developer')) columns.in_progress = 'developer';
  if (has('qa')) columns.in_review = 'qa';
  return { enabled: false, columns, maxBounces: DEFAULT_MAX_BOUNCES };
}

export function sameFlow(a: ProjectFlowSettings, b: ProjectFlowSettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.maxBounces === b.maxBounces &&
    (a.maxParallel ?? null) === (b.maxParallel ?? null) &&
    FLOW_COLUMNS.every((status) => (a.columns[status] ?? '') === (b.columns[status] ?? ''))
  );
}

/** A column given to nobody drops its key, so the document the API gets has no empty roles. */
export function setColumnRole(flow: ProjectFlowSettings, status: WorkItemStatus, role: string): ProjectFlowSettings {
  const columns = { ...flow.columns };
  if (role && status !== 'done') columns[status] = role;
  else delete columns[status];
  return { ...flow, columns };
}

/** The columns a role answers for, in board order: what a member card says under "Answers for". */
export function columnsOf(flow: Pick<ProjectFlowSettings, 'columns'>, role: string): WorkItemStatus[] {
  return FLOW_COLUMNS.filter((status) => flow.columns[status] === role);
}

/** Members at work now: the phone's "2 working now". */
export const workingCount = (members: readonly Pick<TeamMember, 'running'>[]): number => members.filter((member) => member.running.length > 0).length;

/**
 * The team's latest work, newest first: each member's run that is going now, else its last one that
 * ended. What the Team screen's activity card lists, without asking the server for more.
 */
export function teamActivity(members: readonly TeamMember[], limit = 6): FlowRun[] {
  const runs = members.flatMap((member) => (member.running.length > 0 ? member.running : member.lastRun ? [member.lastRun] : []));
  const at = (run: FlowRun) => run.endedAt ?? run.startedAt ?? run.queuedAt;
  return runs.sort((a, b) => at(b).localeCompare(at(a))).slice(0, limit);
}

/**
 * What a run that ended has to say beside its outcome: why it failed, or the summary it wrote. A
 * failed run moved nothing, so its reason is the one thing that explains the item where it is.
 */
export function runNote(run: Pick<FlowRun, 'state' | 'outcome' | 'error' | 'summary'>): string | null {
  if (run.state !== 'ended') return null;
  if (run.outcome === 'failed' || run.outcome === 'cancelled') return run.error?.trim() || null;
  return run.summary?.trim() || null;
}

/** Two members may not share a role (the flow hands a column to one), and an agent file name is the CLI's. */
export const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** A new member's agent file name from its role: `Tech writer` becomes `tech-writer`. */
export function agentNameFor(role: string): string {
  return role
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[-_.]+|-+$/g, '')
    .slice(0, 64);
}

/** A role id as the settings keep it: lower case words joined by hyphens. */
export const roleIdFor = agentNameFor;

/** `writes` as saved: trimmed, no empties, no repeats. */
export function cleanWrites(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

/** Two `writes` alike: absent (anywhere) is not the same as empty (only the documents folder). */
export function sameWrites(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return a === undefined || b === undefined ? a === b : sameList(a, b);
}

export function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((value, i) => value === y[i]);
}

/** The Team tab's own address: `?view=team&section=flow`, `&member=<agent>` for one member. */
export type TeamSection = 'members' | 'flow';

export function teamSearch(params: URLSearchParams, next: { section?: TeamSection; member?: string | null }): string {
  const query = new URLSearchParams(params);
  query.set('view', 'team');
  if (next.section) {
    if (next.section === 'members') query.delete('section');
    else query.set('section', next.section);
  }
  if (next.member !== undefined) {
    if (next.member) query.set('member', next.member);
    else query.delete('member');
  }
  return `?${query.toString()}`;
}

/**
 * Where a member may write, as its `writes` says it and the flow enforces it (`stageRules` in
 * packages/core/src/flow.ts): absent is no limit of Agentry's own, `[]` is nothing of the project
 * but the documents folder, and a list is those paths plus the documents folder.
 */
export type WriteScope = 'anywhere' | 'documents' | 'paths';

export function writeScope(writes: readonly string[] | undefined): WriteScope {
  if (!writes) return 'anywhere';
  return writes.length > 0 ? 'paths' : 'documents';
}

/** `writes` as the team route takes it for a scope: absent for anywhere, so the absence is what is saved. */
export function writesFor(scope: WriteScope, paths: readonly string[]): string[] | undefined {
  if (scope === 'anywhere') return undefined;
  return scope === 'documents' ? [] : cleanWrites(paths);
}

/**
 * The body that saves a member with only `patch` changed. `writes` stays absent when it was: sending
 * `[]` in its place would take a member that may write anywhere down to the documents folder.
 */
export function memberBody(
  member: Pick<TeamMember, 'role' | 'model' | 'responsibility' | 'writes'>,
  patch: Partial<Pick<TeamMember, 'model' | 'responsibility'>> & { writes?: string[] | null } = {},
): PutTeamMemberRequest {
  const writes = patch.writes === undefined ? member.writes : (patch.writes ?? undefined);
  return {
    role: member.role,
    model: patch.model ?? member.model,
    responsibility: patch.responsibility ?? member.responsibility,
    ...(writes ? { writes: [...writes] } : {}),
  };
}
