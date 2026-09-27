import type { AssistantProposal, AssistantResourceKind, AssistantResourceProposal, AssistantRun, ConfigScopeKind, ResourceKind } from '@agentry/shared';

/** The kinds the assistant proposes and builds, which the tab shows together under "All". */
export const AI_KINDS: readonly AssistantResourceKind[] = ['agents', 'skills', 'commands'];

/** The other resources a project's `.claude/` holds, each still edited on its own. */
export const OTHER_KINDS: readonly ResourceKind[] = ['output-styles', 'rules', 'workflows'];

/** `?section=`: every AI kind together, or one kind. */
export type ResourceSection = 'all' | ResourceKind;

export const isAiKind = (kind: string | null | undefined): kind is AssistantResourceKind => (AI_KINDS as readonly string[]).includes(kind ?? '');

export function sectionFrom(value: string | null): ResourceSection {
  if (value === null || value === 'all') return 'all';
  return isAiKind(value) || (OTHER_KINDS as readonly string[]).includes(value) ? (value as ResourceKind) : 'all';
}

/** The kinds a section shows: all three, one of them, or none for a kind the assistant does not handle. */
export function sectionKinds(section: ResourceSection): AssistantResourceKind[] {
  if (section === 'all') return [...AI_KINDS];
  return isAiKind(section) ? [section] : [];
}

/** A command is typed with its slash, so it is shown with it; the others by their name. */
export const shownName = (kind: ResourceKind, name: string): string => (kind === 'commands' ? `/${name}` : name);

/**
 * The runs whose proposals the tab shows: the latest "Suggest" (a `resources` run without a
 * description), the latest few "Create with AI", and, while a link names a proposal the tab has not
 * found, the latest `project` runs, since the assistant's page sends its resources here to be reviewed.
 */
export function proposalRuns(resourceRuns: readonly AssistantRun[], projectRuns: readonly AssistantRun[], lookingForOne: boolean): { suggest: AssistantRun | null; ids: string[] } {
  const suggest = resourceRuns.find((run) => run.description === null) ?? null;
  const created = resourceRuns.filter((run) => run.description !== null && run.status !== 'failed').slice(0, 3);
  const project = lookingForOne ? projectRuns.filter((run) => run.status === 'completed').slice(0, 3) : [];
  const ids = [suggest, ...created, ...project].filter((run): run is AssistantRun => run !== null).map((run) => run.id);
  return { suggest, ids: [...new Set(ids)] };
}

/** A run's resource proposals the person has not set aside, by run then in the order it proposed them. */
export function resourceProposals(proposals: readonly AssistantProposal[]): AssistantResourceProposal[] {
  const seen = new Set<string>();
  const out: AssistantResourceProposal[] = [];
  for (const proposal of proposals) {
    if (proposal.kind !== 'resource' || proposal.status === 'superseded' || seen.has(proposal.id)) continue;
    seen.add(proposal.id);
    out.push(proposal);
  }
  return out;
}

/** Pending ones first, as they wait for the person, then what was saved, then what was discarded. */
export function byDecision(proposals: readonly AssistantResourceProposal[]): AssistantResourceProposal[] {
  const rank = { pending: 0, accepted: 1, discarded: 2, superseded: 3 } as const;
  return [...proposals].sort((a, b) => rank[a.status] - rank[b.status]);
}

/**
 * Where a resource is written, relative to its scope's root as the API serves paths: the project's
 * `.claude/`, or the Claude config directory for the user. A skill is a directory with its SKILL.md.
 */
export function savePath(kind: AssistantResourceKind, name: string, scope: ConfigScopeKind): string {
  const base = scope === 'project' ? '.claude/' : '';
  return kind === 'skills' ? `${base}skills/${name}/` : `${base}${kind}/${name}.md`;
}
