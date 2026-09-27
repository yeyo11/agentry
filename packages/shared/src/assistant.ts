import type {
  AssistantProposalAction,
  AssistantProposalKind,
  AssistantProposalStatus,
  AssistantResourceKind,
  AssistantRunAction,
  AssistantRunKind,
  AssistantRunStatus,
  AssistantSourceKind,
  AssistantSourceState,
  AssistantSourceUnit,
  ConfigScopeKind,
  ProjectTemplateId,
} from './types.ts';
import { valuesOf } from './work-items.ts';

// The value lists of the project assistant (orchestration 4), so the core, the API's validation and
// the web agree on them, and the few rules both ends apply.

export const ASSISTANT_RUN_KINDS = valuesOf<AssistantRunKind>()(['project', 'work-items', 'resources']);

export const ASSISTANT_RUN_STATUSES = valuesOf<AssistantRunStatus>()(['running', 'completed', 'failed', 'stopped']);

export const ASSISTANT_RUN_ACTIONS = valuesOf<AssistantRunAction>()(['started', 'read', 'ended', 'failed']);

/** In the order a `project` run's page draws them: the team, the resources, the first work items */
export const ASSISTANT_PROPOSAL_KINDS = valuesOf<AssistantProposalKind>()(['team-member', 'resource', 'work-item']);

export const ASSISTANT_PROPOSAL_STATUSES = valuesOf<AssistantProposalStatus>()(['pending', 'accepted', 'discarded', 'superseded']);

export const ASSISTANT_PROPOSAL_ACTIONS = valuesOf<AssistantProposalAction>()(['accepted', 'discarded', 'restored']);

export const ASSISTANT_RESOURCE_KINDS = valuesOf<AssistantResourceKind>()(['agents', 'skills', 'commands']);

export const ASSISTANT_SOURCE_KINDS = valuesOf<AssistantSourceKind>()([
  'file',
  'dir',
  'instructions',
  'memory',
  'journal',
  'work-items',
  'milestones',
  'team',
  'resources',
  'chats',
  'git',
]);

export const ASSISTANT_SOURCE_STATES = valuesOf<AssistantSourceState>()(['pending', 'reading', 'read', 'partial', 'missing']);

export const ASSISTANT_SOURCE_UNITS = valuesOf<AssistantSourceUnit>()([
  'lines',
  'files',
  'documents',
  'chats',
  'commits',
  'items',
  'entries',
  'members',
]);

/** The model an assistant run uses when the request names none: reading and proposing, not building. */
export const DEFAULT_ASSISTANT_MODEL = 'sonnet';

/** The run kinds a proposal of each kind can come from; a `project` run makes all three. */
export const ASSISTANT_PROPOSAL_KINDS_OF_RUN = {
  project: ['team-member', 'resource', 'work-item'],
  'work-items': ['work-item'],
  resources: ['resource'],
} as const satisfies Record<AssistantRunKind, readonly AssistantProposalKind[]>;

/**
 * Whether the wizard's "Propose a team, resources and tasks" starts on for a template: on for every
 * one but Simple, whose projects have no modules to fill.
 */
export function assistantOnCreateByDefault(template: ProjectTemplateId): boolean {
  return template !== 'simple';
}

/**
 * Where a resource is saved, relative to its scope's root: the project's `.claude/` for `project`,
 * the Claude config dir for `user`. A skill is a directory (its `SKILL.md` inside), the others one
 * Markdown file. Matches what `/config/resources` writes.
 */
export function assistantResourcePath(kind: AssistantResourceKind, name: string, scope: ConfigScopeKind): string {
  const base = scope === 'project' ? '.claude/' : '';
  return kind === 'skills' ? `${base}skills/${name}/` : `${base}${kind}/${name}.md`;
}
