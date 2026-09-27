import type { AssistantProposal, AssistantRun, AssistantSource, AssistantWorkItemProposal } from '@agentry/shared';

/** `?suggest=1` opens Suggest tasks over the board of the selected project. */
export const SUGGEST_PARAM = 'suggest';

/** The work item proposals of a run, in the order it proposed them; superseded ones are gone from view. */
export function workItemProposals(proposals: readonly AssistantProposal[] | undefined): AssistantWorkItemProposal[] {
  return (proposals ?? [])
    .filter((p): p is AssistantWorkItemProposal => p.kind === 'work-item' && p.status !== 'superseded')
    .sort((a, b) => a.position - b.position);
}

/**
 * What starts selected: every pending proposal except one that looks like an item the project
 * already has, which the person has to pick on purpose (design system, `.suggestion-like`).
 */
export function initialSelection(proposals: readonly AssistantWorkItemProposal[]): Set<string> {
  return new Set(proposals.filter((p) => p.status === 'pending' && !p.workItem.similarTo).map((p) => p.id));
}

/** Only pending proposals can be created; a selection outlives a proposal decided elsewhere, so it is narrowed. */
export function selectedPending(proposals: readonly AssistantWorkItemProposal[], selected: ReadonlySet<string>): AssistantWorkItemProposal[] {
  return proposals.filter((p) => p.status === 'pending' && selected.has(p.id));
}

/** A phrase for each source a finished run names in its one line ("from the board, docs/plans/ and the last 20 commits"). */
export type SourcePhrase =
  | { key: 'board' | 'milestones' | 'journal' | 'memory' | 'team' | 'resources' | 'chats' }
  | { key: 'commits'; count: number }
  | { key: 'path'; path: string };

const NAMED: Partial<Record<AssistantSource['kind'], SourcePhrase['key']>> = {
  'work-items': 'board',
  milestones: 'milestones',
  journal: 'journal',
  memory: 'memory',
  team: 'team',
  resources: 'resources',
  chats: 'chats',
};

/**
 * The sources a finished run actually read, the project's own files and history first (what the
 * person cannot see Agentry handing it), then Agentry's, at most `max`.
 */
export function readPhrases(sources: readonly AssistantSource[], max = 3): SourcePhrase[] {
  const read = sources.filter((s) => s.state === 'read' || s.state === 'partial');
  const own: SourcePhrase[] = [];
  const handed: SourcePhrase[] = [];
  for (const source of read) {
    if (source.kind === 'work-items') handed.unshift({ key: 'board' });
    else if ((source.kind === 'dir' || source.kind === 'file' || source.kind === 'instructions') && source.path) own.push({ key: 'path', path: source.path });
    else if (source.kind === 'git') own.push({ key: 'commits', count: source.count ?? source.total ?? 0 });
    else {
      const key = NAMED[source.kind];
      if (key && key !== 'board') handed.push({ key } as SourcePhrase);
    }
  }
  // The board first, as the reference words it: it is what a suggestion of tasks reads against
  const board = handed.filter((p) => p.key === 'board');
  return [...board, ...own, ...handed.filter((p) => p.key !== 'board')].slice(0, max);
}

/** Whether the run still works: the only state in which the dialog moves. */
export const isRunning = (run: Pick<AssistantRun, 'status'> | null | undefined): boolean => run?.status === 'running';
