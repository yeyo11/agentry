import type {
  AgentryLanguage,
  DocumentChangeAction,
  DocumentKind,
  FlowRunAction,
  FlowRunCause,
  FlowRunOutcome,
  FlowRunState,
  FlowRunStatus,
  FlowRun,
  FlowStage,
  FlowStep,
  FlowVerdict,
  JournalChangeAction,
  JournalEntryKind,
  MemoryProposalAction,
  MemoryProposalStatus,
  MemoryProposalTargetKind,
  MilestoneState,
  ProjectChange,
  ProjectModule,
  ProjectTemplateId,
  WorkItemActorKind,
  WorkItemLinkKind,
  WorkItemLinkRole,
  WorkItemPriority,
  WorkItemRelationType,
  WorkItemSourceKind,
  WorkItemStatus,
  WorkItemType,
  TeamAgentDriftField,
  TeamAgentFileState,
  TeamChangeAction,
  WorkItemWaitReason,
} from './types.ts';

// The fixed orders and value lists of the project ecosystem, in one place so the core, the API's
// validation and the web never disagree on which columns exist or in which order they are drawn.

/**
 * A list of every member of `Union`, checked both ways: a value the union lacks does not compile,
 * and neither does a list that leaves a member out. `satisfies readonly Union[]` alone only catches
 * the first, which let a member added to a union go missing from every screen and validator that
 * reads the list.
 */
export function valuesOf<Union>() {
  return <const List extends readonly Union[]>(
    list: List & ([Exclude<Union, List[number]>] extends [never] ? unknown : { missing: Exclude<Union, List[number]> }),
  ): List => list;
}

export const PROJECT_MODULES = valuesOf<ProjectModule>()(['board', 'team', 'documents', 'memory']);

export const PROJECT_TEMPLATE_IDS = valuesOf<ProjectTemplateId>()(['simple', 'software', 'library', 'research', 'custom']);

export const PROJECT_CHANGES = valuesOf<ProjectChange>()(['name', 'key', 'modules', 'settings']);

/** The board's columns, left to right */
export const WORK_ITEM_STATUSES = valuesOf<WorkItemStatus>()(['backlog', 'todo', 'in_progress', 'in_review', 'done']);

export const WORK_ITEM_TYPES = valuesOf<WorkItemType>()(['epic', 'story', 'task', 'bug']);

/** Lowest first */
export const WORK_ITEM_PRIORITIES = valuesOf<WorkItemPriority>()(['low', 'medium', 'high', 'urgent']);

export const WORK_ITEM_ACTOR_KINDS = valuesOf<WorkItemActorKind>()(['person', 'agent', 'system']);

export const WORK_ITEM_SOURCE_KINDS = valuesOf<WorkItemSourceKind>()(['chat', 'orchestration']);

export const WORK_ITEM_LINK_KINDS = valuesOf<WorkItemLinkKind>()(['chat', 'orchestration', 'document']);

/** In the order of an item's life: where it came from, then the columns it goes through */
export const WORK_ITEM_LINK_ROLES = valuesOf<WorkItemLinkRole>()(['origin', 'refine', 'work', 'verify', 'reference']);

export const WORK_ITEM_RELATION_TYPES = valuesOf<WorkItemRelationType>()(['blocks', 'blocked_by']);

export const WORK_ITEM_WAIT_REASONS = valuesOf<WorkItemWaitReason>()(['approval', 'bounces', 'merge']);

export const MILESTONE_STATES = valuesOf<MilestoneState>()(['open', 'closed']);

// ---- team, flow, journal, memory proposals and documents (orchestration 3)

export const TEAM_AGENT_FILE_STATES = valuesOf<TeamAgentFileState>()(['ok', 'missing', 'drifted']);

export const TEAM_AGENT_DRIFT_FIELDS = valuesOf<TeamAgentDriftField>()(['name', 'description', 'model']);

export const TEAM_CHANGE_ACTIONS = valuesOf<TeamChangeAction>()(['created', 'updated', 'removed', 'template', 'file']);

/** In the order of an item's life on the board */
export const FLOW_STAGES = valuesOf<FlowStage>()(['refine', 'work', 'verify']);

/** The stage a column's responsible role acts in; `done` has none, since only a person moves an item there. */
export const FLOW_STAGE_OF_COLUMN = {
  backlog: 'refine',
  todo: 'refine',
  in_progress: 'work',
  in_review: 'verify',
  done: null,
} as const satisfies Record<WorkItemStatus, FlowStage | null>;

/** The stage as the person reads it in each column: the Product Owner refines in backlog and checks in todo. */
export const FLOW_STEP_OF_COLUMN = {
  backlog: 'refine',
  todo: 'check',
  in_progress: 'work',
  in_review: 'verify',
  done: null,
} as const satisfies Record<WorkItemStatus, FlowStep | null>;

export const FLOW_STEPS = valuesOf<FlowStep>()(['refine', 'check', 'work', 'verify']);

/**
 * A run's step: its column's, or its stage's own name for a column that has none (a run stored with
 * a column that does not match its stage, which the flow never writes).
 */
export function flowStepOf(stage: FlowStage, column: WorkItemStatus): FlowStep {
  const step = FLOW_STEP_OF_COLUMN[column];
  return step && FLOW_STAGE_OF_COLUMN[column] === stage ? step : stage;
}

export const FLOW_RUN_CAUSES = valuesOf<FlowRunCause>()([
  'budget',
  'no-account',
  'no-provider',
  'limit-wait-expired',
  'rate-limit',
  'stopped',
  'restarts',
  'unreadable',
  'no-verdict',
  'max-tokens',
  'not-started',
  'not-continued',
  'chat-ended',
  'chat-failed',
  'item-moved',
  'item-removed',
  'item-done',
  'replaced',
  'flow-off',
  'no-member',
  'refined',
  'chat-busy',
  'conflict-unresolved',
]);

export const FLOW_RUN_STATES = valuesOf<FlowRunState>()(['queued', 'running', 'ended']);

export const FLOW_RUN_OUTCOMES = valuesOf<FlowRunOutcome>()(['passed', 'rejected', 'failed', 'cancelled']);

/** Queued and running first, then the outcomes in {@link FLOW_RUN_OUTCOMES} order: how the activity lists them */
export const FLOW_RUN_STATUSES = valuesOf<FlowRunStatus>()(['queued', 'running', 'passed', 'rejected', 'failed', 'cancelled']);

/** A run's state and outcome in one word; an ended run without an outcome, which the store never writes, reads as failed. */
export function flowRunStatus(run: Pick<FlowRun, 'state' | 'outcome'>): FlowRunStatus {
  return run.state === 'ended' ? (run.outcome ?? 'failed') : run.state;
}

/** Runs of the team's activity a page holds when the request does not say */
export const FLOW_RUNS_PAGE = 50;

/** The most runs one page of the team's activity may ask for */
export const FLOW_RUNS_PAGE_MAX = 200;

export const FLOW_RUN_ACTIONS = valuesOf<FlowRunAction>()(['queued', 'started', 'ended']);

export const FLOW_VERDICTS = valuesOf<FlowVerdict>()(['pass', 'fail']);

/** Flow runs of a project at once when its settings leave `flow.maxParallel` out */
export const DEFAULT_FLOW_MAX_PARALLEL = 2;

/** Fixes of failing checks the decision may start for one head when `flow.checksFixAttempts` is absent */
export const DEFAULT_CHECKS_FIX_ATTEMPTS = 2;

/** The highest `flow.checksFixAttempts` a project may set */
export const MAX_CHECKS_FIX_ATTEMPTS = 5;

/** The highest `flow.maxParallel` a project may set: the Flow screen's stepper stops there */
export const MAX_FLOW_PARALLEL = 10;

/** The highest `flow.maxCostUsd` a project may set */
export const MAX_FLOW_COST_USD = 100;

/** Times a flow run cut off by a restart is continued in its chat before it fails */
export const MAX_FLOW_RESTARTS = 2;

/**
 * Times an unattended run (a flow run, an orchestration worker) is sent back to its chat when its turn
 * ended with work still owed. Past it, the run's result is judged as it is.
 */
export const MAX_CONTINUATIONS = 3;

/** The most shell command patterns a member may list in `commands` */
export const MAX_TEAM_COMMANDS = 50;

/** The longest shell command pattern */
export const TEAM_COMMAND_MAX = 200;

/** Why a shell command pattern cannot be a member's: `comma` apart, since it has a message of its own */
export type TeamCommandProblem = 'invalid' | 'comma';

/**
 * Why a shell command pattern cannot be a member's (`npm test`, `pnpm *`, `cargo test *`), or null
 * when it can. The one rule for the team route, the settings document, the flow and the member's
 * screen. A pattern becomes the rule `Bash(<pattern>)`, and the flow hands its rules to the CLI as
 * one comma-joined `--allowedTools=` list (`chats.ts`), so:
 *
 * - a comma would cut the rule in two, and the CLI would read two rules neither of which was meant;
 * - a parenthesis would end the rule early, and a control character (a newline) start another;
 * - only a wildcard would mean any command, which is what leaving `commands` out already says.
 *
 * It must be one line of printable text, no longer than {@link TEAM_COMMAND_MAX}, with nothing
 * around it to trim.
 */
export function teamCommandProblem(value: unknown): TeamCommandProblem | null {
  if (typeof value !== 'string') return 'invalid';
  if (value.includes(',')) return 'comma';
  const pattern = value.trim();
  if (!pattern || pattern.length > TEAM_COMMAND_MAX || pattern !== value) return 'invalid';
  if (/[\u0000-\u001f\u007f()]/.test(pattern)) return 'invalid';
  return /^[*\s:]+$/.test(pattern) ? 'invalid' : null;
}

/** A shell command pattern a member may carry: one {@link teamCommandProblem} finds nothing wrong with. */
export function isTeamCommandPattern(value: unknown): value is string {
  return teamCommandProblem(value) === null;
}

export const JOURNAL_ENTRY_KINDS = valuesOf<JournalEntryKind>()(['closed', 'decision', 'memory', 'note']);

export const JOURNAL_CHANGE_ACTIONS = valuesOf<JournalChangeAction>()(['added', 'removed']);

export const MEMORY_PROPOSAL_TARGET_KINDS = valuesOf<MemoryProposalTargetKind>()(['instructions', 'memory', 'journal']);

export const MEMORY_PROPOSAL_STATUSES = valuesOf<MemoryProposalStatus>()(['pending', 'approved', 'rejected']);

export const MEMORY_PROPOSAL_ACTIONS = valuesOf<MemoryProposalAction>()(['created', 'approved', 'rejected']);

export const DOCUMENT_KINDS = valuesOf<DocumentKind>()(['spec', 'adr', 'report', 'doc']);

export const DOCUMENT_CHANGE_ACTIONS = valuesOf<DocumentChangeAction>()(['written', 'removed', 'tied', 'untied']);

/** Work items a list page holds when the request does not say (`WorkItemPageQuery.limit`) */
export const WORK_ITEMS_PAGE = 100;

/** The most work items one page, or a board's Done column, may ask for */
export const WORK_ITEMS_PAGE_MAX = 500;

/** Items of the Done column a board holds when the request does not say, and each "and N more" adds */
export const BOARD_DONE_PAGE = 20;

export const AGENTRY_LANGUAGES = valuesOf<AgentryLanguage>()(['en', 'es']);

/**
 * The language of an `Accept-Language` header, or of a stored choice: the first of Agentry's
 * languages it names, English when it names none. Weights are not read: browsers list the
 * preferred language first.
 */
export function agentryLanguage(value: unknown): AgentryLanguage {
  if (typeof value !== 'string') return 'en';
  for (const tag of value.split(',')) {
    const code = tag.trim().toLowerCase().split(/[-_;.@]/)[0];
    const known = AGENTRY_LANGUAGES.find((language) => language === code);
    if (known) return known;
  }
  return 'en';
}

/**
 * A key prefix: upper case letters and digits, starting with a letter, two to ten characters. The
 * derived ones are two to five letters, plus a digit on a clash; the rest of the room is for a
 * person who edits it.
 */
export const WORK_ITEM_KEY_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

/** `AGN-12`. Composed on every read, since only the number is stored. */
export function workItemKey(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}

/** Splits a key back into its prefix and number; null for anything that is not one. */
export function parseWorkItemKey(key: string): { prefix: string; number: number } | null {
  const match = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]*)$/.exec(key.toUpperCase());
  if (!match?.[1] || !match[2]) return null;
  return { prefix: match[1], number: Number(match[2]) };
}

/** The branch an item is worked on: `task/agn-12`. Lower case, as git refs usually are. */
export function workItemBranch(key: string): string {
  return `task/${key.toLowerCase()}`;
}

/**
 * The history causes a work item's pull request writes (docs/plans/work-item-pull-requests.md): the
 * PR opened, the update conflicted and the item went back to work, GitHub merged it (the move to
 * Done), or it was closed without merging. A client words them.
 */
export const WORK_ITEM_PR_CAUSE = {
  opened: 'pr.opened',
  conflict: 'pr.conflict',
  merged: 'pr.merged',
  closed: 'pr.closed',
} as const;

/** The Conventional Commits types a label can give a pull request's title. */
export const CONVENTIONAL_TYPES = ['feat', 'fix', 'docs', 'chore', 'refactor', 'perf', 'test', 'build', 'ci'] as const;
