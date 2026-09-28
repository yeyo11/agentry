import type { FlowRun, FlowRunCause, FlowStage, FlowStep, ProjectFlowSettings, ProjectSettings, PutTeamMemberRequest, TeamMember, WorkItemStatus, WorkItemType } from '@agentry/shared';
import { DEFAULT_FLOW_MAX_PARALLEL, flowStepOf, MAX_FLOW_COST_USD, MAX_FLOW_PARALLEL, MAX_TEAM_COMMANDS, teamCommandProblem, WORK_ITEM_STATUSES, type TeamCommandProblem } from '@agentry/shared';
import { daysAgo } from '../../lib/format';

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
 * The flow a project has: the saved one, or, for a project that never saved one, the template's
 * proposal (off, so nothing acts on it). The board reads this; the Team screens tell the two apart
 * with `savedFlow` and `proposedFlow`, since a proposal answers for no column until it is saved.
 */
export function flowOf(settings: Pick<ProjectSettings, 'flow'> | undefined, members: readonly Pick<TeamMember, 'role'>[]): ProjectFlowSettings {
  return settings?.flow ? savedFlow(settings) : proposedFlow(members);
}

/** No flow at all: what a project that never saved one has, whatever its template would propose. */
export const NO_FLOW: ProjectFlowSettings = { enabled: false, columns: {}, maxBounces: DEFAULT_MAX_BOUNCES };

/** The flow as saved, or none: the columns a member really answers for, as the server reads them. */
export function savedFlow(settings: Pick<ProjectSettings, 'flow'> | undefined): ProjectFlowSettings {
  const flow = settings?.flow ?? NO_FLOW;
  return { ...flow, columns: { ...flow.columns } };
}

/** Each column given to the template role that answers for it, when the team has that role; off. */
export function proposedFlow(members: readonly Pick<TeamMember, 'role'>[]): ProjectFlowSettings {
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
    (a.maxCostUsd ?? null) === (b.maxCostUsd ?? null) &&
    FLOW_COLUMNS.every((status) => (a.columns[status] ?? '') === (b.columns[status] ?? ''))
  );
}

/**
 * Runs of the project at once, as the Flow screen's stepper sets it: whole, between 1 and
 * `MAX_FLOW_PARALLEL`. The default drops the key, so a project that never chose keeps following it.
 */
export function setMaxParallel(flow: ProjectFlowSettings, value: number | undefined): ProjectFlowSettings {
  const next = { ...flow };
  const parallel = value === undefined ? DEFAULT_FLOW_MAX_PARALLEL : Math.min(MAX_FLOW_PARALLEL, Math.max(1, Math.round(value)));
  if (parallel === DEFAULT_FLOW_MAX_PARALLEL) delete next.maxParallel;
  else next.maxParallel = parallel;
  return next;
}

/**
 * What one run may spend, in USD. Unlimited is the owner's default, so an empty field, or zero,
 * drops the key rather than saving a limit nobody chose; the rest is rounded to cents and capped.
 */
export function setMaxCost(flow: ProjectFlowSettings, value: number | undefined): ProjectFlowSettings {
  const next = { ...flow };
  const cost = value === undefined || !Number.isFinite(value) ? 0 : Math.min(MAX_FLOW_COST_USD, Math.round(value * 100) / 100);
  if (cost <= 0) delete next.maxCostUsd;
  else next.maxCostUsd = cost;
  return next;
}

/** The flow as it is saved: the limits as typed rounded, capped, or dropped back to their default. */
export const settledFlow = (flow: ProjectFlowSettings): ProjectFlowSettings => setMaxCost(setMaxParallel(flow, flow.maxParallel), flow.maxCostUsd);

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

/** What creating cards in Backlog sets off: the runs the flow queues at once, whose role, and how many go at a time. */
export interface BacklogRuns {
  count: number;
  role: string;
  parallel: number;
}

/**
 * The flow runs that creating items of these types in Backlog queues, as core decides it (`flow.ts`,
 * `trigger` on `workitem.created`): one refine run per item that is not an epic, while the flow is
 * on, both the Board and Team modules are, and Backlog's role is a member. Null when none would be.
 */
export function backlogRunsFor(
  settings: Pick<ProjectSettings, 'flow' | 'modules' | 'team'> | undefined,
  types: readonly WorkItemType[],
): BacklogRuns | null {
  if (!settings) return null;
  const flow = settings.flow;
  if (!flow?.enabled || !settings.modules.includes('team') || !settings.modules.includes('board')) return null;
  const role = flow.columns.backlog;
  if (!role || !settings.team?.members.some((member) => member.role === role)) return null;
  const count = types.filter((type) => type !== 'epic').length;
  return count > 0 ? { count, role, parallel: flow.maxParallel ?? DEFAULT_FLOW_MAX_PARALLEL } : null;
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
 * A member's "now and before": the runs going now, then the ones that ended, newest first, queued
 * ones left to the line that counts them; and how many tasks those runs worked on. `page` is the
 * member's page of the team's activity; without it the team's snapshot (what runs now, and the last
 * run) stands in.
 */
export function memberRuns(member: Pick<TeamMember, 'running' | 'lastRun'>, page?: readonly FlowRun[]): { runs: FlowRun[]; tasks: number } {
  const all = page ?? [...member.running, ...(member.lastRun ? [member.lastRun] : [])];
  const running = all.filter((run) => run.state === 'running');
  const ended = all.filter((run) => run.state === 'ended');
  return { runs: [...running, ...ended], tasks: new Set(all.map((run) => run.itemId)).size };
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

/**
 * The Team tab's own address: `?view=team&section=flow`, `&section=activity` for the team's whole
 * activity, `&member=<agent>` for one member.
 */
export type TeamSection = 'members' | 'flow' | 'activity';

export function teamSection(value: string | null): TeamSection {
  return value === 'flow' || value === 'activity' ? value : 'members';
}

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
 * The body that saves a member with only `patch` changed. `writes` and `commands` stay absent when
 * they were: sending `[]` in place of `writes` would take a member that may write anywhere down to
 * the documents folder, and leaving `commands` out would lift the member's shell list, since the
 * route reads an absent list as unrestricted.
 */
export function memberBody(
  member: Pick<TeamMember, 'role' | 'model' | 'responsibility' | 'writes' | 'commands'>,
  patch: Partial<Pick<TeamMember, 'model' | 'responsibility'>> & { writes?: string[] | null; commands?: string[] | null } = {},
): PutTeamMemberRequest {
  const writes = patch.writes === undefined ? member.writes : (patch.writes ?? undefined);
  const commands = patch.commands === undefined ? member.commands : (patch.commands ?? undefined);
  return {
    role: member.role,
    model: patch.model ?? member.model,
    responsibility: patch.responsibility ?? member.responsibility,
    ...(writes ? { writes: [...writes] } : {}),
    ...(commands ? { commands: [...commands] } : {}),
  };
}

/**
 * The shell a member has in the flow's work stage, as `commands` says it (`stageRules` in
 * packages/core/src/flow.ts): absent is `Bash` unrestricted, `[]` is no shell at all, and a list is
 * only those commands. Refine and verify keep their own tool sets whatever it says.
 */
export type CommandScope = 'any' | 'none' | 'listed';

export function commandScope(commands: readonly string[] | undefined): CommandScope {
  if (!commands) return 'any';
  return commands.length > 0 ? 'listed' : 'none';
}

/** `commands` as the team route takes it for a scope: null for any, so the absence is what is saved. */
export function commandsFor(scope: CommandScope, patterns: readonly string[]): string[] | null {
  if (scope === 'any') return null;
  return scope === 'none' ? [] : cleanWrites(patterns);
}

/** Why a command pattern cannot be saved, or null: the rule the route and the flow hold it to. */
export function commandProblem(pattern: string): TeamCommandProblem | null {
  return teamCommandProblem(pattern);
}

/** The first problem of a list of patterns, the count included: what keeps the member's Save off. */
export function commandsProblem(patterns: readonly string[]): TeamCommandProblem | 'tooMany' | null {
  if (patterns.length > MAX_TEAM_COMMANDS) return 'tooMany';
  for (const pattern of patterns) {
    const problem = commandProblem(pattern);
    if (problem) return problem;
  }
  return null;
}

/** Two `commands` alike: absent (any command) is not the same as empty (none). */
export const sameCommands = sameWrites;

/**
 * The responsibility each role of the built-in templates starts with, as core writes it into the
 * metadata and the agent file (`packages/core/src/project-templates.ts`), in English because Claude
 * reads it. The web shows one still as the template wrote it in the person's language, by role; an
 * edited one is shown as written.
 */
export const TEMPLATE_RESPONSIBILITIES: Readonly<Record<KnownRole, string>> = {
  'product-owner': 'Refines the backlog and writes acceptance criteria',
  architect: 'Decides the design and reviews it against the codebase',
  developer: 'Implements work items in their own worktree',
  qa: 'Verifies each item against its acceptance criteria',
  researcher: 'Reads the sources and sets out what is known',
  writer: 'Turns findings into documents',
  reviewer: 'Checks documents for accuracy and clarity',
};

/** The role whose template responsibility this still is, word for word, or null once someone edited it. */
export function templateResponsibilityRole(member: Pick<TeamMember, 'role' | 'responsibility'>): KnownRole | null {
  return isKnownRole(member.role) && member.responsibility.trim() === TEMPLATE_RESPONSIBILITIES[member.role] ? member.role : null;
}

/** When a run last did something: it ended, it started, or it was queued. */
export const runTimeOf = (run: Pick<FlowRun, 'endedAt' | 'startedAt' | 'queuedAt'>): string => run.endedAt ?? run.startedAt ?? run.queuedAt;

/**
 * How long an ended run took, from its start to its end; null for one that never started (queued,
 * then cancelled) or has not ended. Said in words ("3 min 40 s"), never as a clock.
 */
export function runDuration(run: Pick<FlowRun, 'startedAt' | 'endedAt'>): number | null {
  if (!run.startedAt || !run.endedAt) return null;
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * A group of Team activity: what runs or waits now, then the ended runs by the day they ended.
 * `days` is 0 for today and 1 for yesterday, which the heads say as "Hoy" and "Ayer · domingo 27".
 */
export type RunGroup = { kind: 'now'; runs: FlowRun[] } | { kind: 'day'; days: number; at: string; runs: FlowRun[] };

/** The activity's list as it is read: "Now" first (running, then queued), then one group per day, newest first. */
export function groupRuns(runs: readonly FlowRun[], now: number = Date.now()): RunGroup[] {
  const live = [...runs.filter((run) => run.state === 'running'), ...runs.filter((run) => run.state === 'queued')];
  const groups: RunGroup[] = live.length > 0 ? [{ kind: 'now', runs: live }] : [];
  for (const run of runs) {
    if (run.state !== 'ended') continue;
    const at = runTimeOf(run);
    const days = daysAgo(at, now) ?? 0;
    const last = groups[groups.length - 1];
    if (last?.kind === 'day' && last.days === days) last.runs.push(run);
    else groups.push({ kind: 'day', days, at, runs: [run] });
  }
  return groups;
}

/** A member's day, as "By member · today" counts it. */
export interface MemberDay {
  runs: number;
  failed: number;
}

/** Today's figures: the activity's summary line and its "By member" card. */
export interface RunDay {
  runs: number;
  running: number;
  queued: number;
  failed: number;
  byAgent: Record<string, MemberDay>;
}

/**
 * What the team did today, from the runs at hand: a run counts while it runs or waits, or when it
 * ended today. The activity holds the newest runs, so today's are all in it unless the team ran
 * more than a page of them in one day.
 */
export function runDay(runs: readonly FlowRun[], now: number = Date.now()): RunDay {
  const day: RunDay = { runs: 0, running: 0, queued: 0, failed: 0, byAgent: {} };
  for (const run of runs) {
    if (run.state === 'ended' && daysAgo(runTimeOf(run), now) !== 0) continue;
    day.runs += 1;
    if (run.state === 'running') day.running += 1;
    if (run.state === 'queued') day.queued += 1;
    const failed = run.outcome === 'failed';
    if (failed) day.failed += 1;
    const member = (day.byAgent[run.agent] ??= { runs: 0, failed: 0 });
    member.runs += 1;
    if (failed) member.failed += 1;
  }
  return day;
}

/** The step of a run as the person reads it, by its column: a `refine` in Por hacer is a check. */
export const runStep = (run: Pick<FlowRun, 'stage' | 'column'> & { step?: FlowStep | null }): FlowStep => run.step ?? flowStepOf(run.stage, run.column);

/**
 * What a run's reason is told from: its cause, or `unknown` for a failed or cancelled run stored
 * before causes were kept (its raw error still shows under the words). Null for any other run.
 */
export function runReason(run: Pick<FlowRun, 'outcome' | 'cause'>): FlowRunCause | 'unknown' | null {
  if (run.outcome !== 'failed' && run.outcome !== 'cancelled') return null;
  return run.cause ?? 'unknown';
}
