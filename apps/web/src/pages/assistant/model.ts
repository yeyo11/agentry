import type {
  AssistantProposal,
  AssistantProposalKind,
  AssistantResourceProposal,
  AssistantRun,
  AssistantRunDetail,
  AssistantSource,
  AssistantTeamMemberProposal,
  AssistantWorkItemProposal,
  ProjectTemplateId,
} from '@agentry/shared';

/** The project assistant's page, by project id: the wizard and the empty Team screen hand off to it. */
export const assistantPath = (projectId: string): string => `/projects/${encodeURIComponent(projectId)}/assistant`;

/** The project's own page, which "Go to the project" and "Skip for now" lead to. */
export const projectPath = (projectId: string): string => `/?project=${encodeURIComponent(projectId)}`;

/**
 * Where "Review" opens a proposed resource: the project's Resources tab, which loads it into the
 * editor unsaved; saving it there is the accept (decision 37).
 */
export function resourceReviewHref(projectId: string, proposal: Pick<AssistantResourceProposal, 'id' | 'resource'>): string {
  const query = new URLSearchParams({ project: projectId, view: 'resources', section: proposal.resource.kind, proposal: proposal.id });
  return `/?${query.toString()}`;
}

/** "Propose team, resources and tasks" in the wizard starts on for every template but Simple. */
export const proposesByDefault = (template: ProjectTemplateId): boolean => template !== 'simple';

/** The latest run of a list served latest first; null for none. */
export const latestRun = <R extends AssistantRun>(runs: readonly R[] | undefined): R | null => runs?.[0] ?? null;

/**
 * The run that proposes first tasks for an empty project: an empty `project` run offers only the
 * template's team and asks what the project is for; the `work-items` run started from that
 * description, after it, is what fills the first-tasks card.
 */
export function followingRun(projectRun: AssistantRun | null, workItemRuns: readonly AssistantRun[] | undefined): AssistantRun | null {
  if (!projectRun?.empty) return null;
  const since = Date.parse(projectRun.startedAt);
  return workItemRuns?.find((run) => Date.parse(run.startedAt) >= since) ?? null;
}

type ProposalOf<K extends AssistantProposalKind> = K extends 'team-member'
  ? AssistantTeamMemberProposal
  : K extends 'resource'
    ? AssistantResourceProposal
    : AssistantWorkItemProposal;

/**
 * A run's proposals of one kind, in the order it proposed them. Superseded ones belong to a run
 * the person asked to redo, so they are not offered again.
 */
export function proposalsOf<K extends AssistantProposalKind>(run: AssistantRunDetail | null | undefined, kind: K): ProposalOf<K>[] {
  if (!run) return [];
  return run.proposals
    .filter((p): p is ProposalOf<K> => p.kind === kind && p.status !== 'superseded')
    .sort((a, b) => a.position - b.position);
}

/** "2 of 6 accepted": decided ones out of those still offered. */
export function tally(proposals: readonly AssistantProposal[]): { accepted: number; total: number; pending: number } {
  return {
    accepted: proposals.filter((p) => p.status === 'accepted').length,
    pending: proposals.filter((p) => p.status === 'pending').length,
    total: proposals.length,
  };
}

/** How much a finished run read, for its one line: "after reading 61 files, 23 chats and docs/". */
export function readSummary(sources: readonly AssistantSource[]): { files: number; chats: number; dirs: string[] } {
  let files = 0;
  let chats = 0;
  const dirs: string[] = [];
  for (const source of sources) {
    if (source.state === 'pending' || source.state === 'missing') continue;
    if (source.kind === 'file' || source.kind === 'instructions') files += 1;
    else if (source.kind === 'dir') {
      if (source.unit === 'files' && source.count !== null) files += source.count;
      // A folder of documents reads better by its name than folded into the file count
      if (source.unit === 'documents' && source.path) dirs.push(source.path);
    } else if (source.kind === 'chats' && source.count !== null) chats += source.count;
  }
  return { files, chats, dirs };
}

/** The part of the screen a run's state asks for. */
export type AssistantStage = 'none' | 'running' | 'empty' | 'done' | 'failed' | 'stopped';

export function stageOf(run: AssistantRun | null): AssistantStage {
  if (!run) return 'none';
  if (run.status === 'running') return 'running';
  if (run.status === 'failed') return 'failed';
  if (run.status === 'stopped') return 'stopped';
  return run.empty ? 'empty' : 'done';
}
