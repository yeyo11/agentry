import type {
  DocumentChangeAction,
  DocumentKind,
  FlowRunAction,
  FlowRunOutcome,
  FlowRunState,
  FlowStage,
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

export const WORK_ITEM_WAIT_REASONS = valuesOf<WorkItemWaitReason>()(['approval', 'bounces']);

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

export const FLOW_RUN_STATES = valuesOf<FlowRunState>()(['queued', 'running', 'ended']);

export const FLOW_RUN_OUTCOMES = valuesOf<FlowRunOutcome>()(['passed', 'rejected', 'failed', 'cancelled']);

export const FLOW_RUN_ACTIONS = valuesOf<FlowRunAction>()(['queued', 'started', 'ended']);

export const FLOW_VERDICTS = valuesOf<FlowVerdict>()(['pass', 'fail']);

/** Flow runs of a project at once when its settings leave `flow.maxParallel` out */
export const DEFAULT_FLOW_MAX_PARALLEL = 2;

/** The highest `flow.maxCostUsd` a project may set */
export const MAX_FLOW_COST_USD = 100;

/** Times a flow run cut off by a restart is continued in its chat before it fails */
export const MAX_FLOW_RESTARTS = 2;

export const JOURNAL_ENTRY_KINDS = valuesOf<JournalEntryKind>()(['closed', 'decision', 'memory', 'note']);

export const JOURNAL_CHANGE_ACTIONS = valuesOf<JournalChangeAction>()(['added', 'removed']);

export const MEMORY_PROPOSAL_TARGET_KINDS = valuesOf<MemoryProposalTargetKind>()(['instructions', 'memory', 'journal']);

export const MEMORY_PROPOSAL_STATUSES = valuesOf<MemoryProposalStatus>()(['pending', 'approved', 'rejected']);

export const MEMORY_PROPOSAL_ACTIONS = valuesOf<MemoryProposalAction>()(['created', 'approved', 'rejected']);

export const DOCUMENT_KINDS = valuesOf<DocumentKind>()(['spec', 'adr', 'report', 'doc']);

export const DOCUMENT_CHANGE_ACTIONS = valuesOf<DocumentChangeAction>()(['written', 'removed', 'tied', 'untied']);

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
