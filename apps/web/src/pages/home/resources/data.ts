import type { AssistantResourceKind, AssistantResourceProposal, ConfigResource, Project } from '@agentry/shared';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys, useAssistantRuns, useTeam, type Scope } from '../../../api';
import { useToast } from '../../../components/Toast';
import { AI_KINDS, byDecision, proposalRuns, resourceProposals, sectionKinds, type ResourceSection } from './model';

/**
 * How many agents, skills and commands the project's `.claude/` holds: the Recursos tab's figure.
 * The same queries as the tab's lists, so opening the tab reads them from the cache.
 */
export function useProjectResourceCount(project: Project): number | undefined {
  const scope: Scope = { projectId: project.id };
  const lists = useQueries({
    queries: AI_KINDS.map((kind) => ({ queryKey: keys.resources(scope, kind), queryFn: () => api.resources(scope, kind) })),
  });
  if (lists.some((q) => !q.data)) return undefined;
  return lists.reduce((sum, q) => sum + (q.data?.length ?? 0), 0);
}

/**
 * What the Resources tab reads and does: the project's agents, skills and commands, the assistant's
 * runs and their proposals, and the actions on them. The page keeps only the URL and the editor.
 */
export function useResourcesData(project: Project, scope: Scope, section: ResourceSection, proposalId: string | null) {
  const { t } = useTranslation(['config', 'projects']);
  const toast = useToast();
  const queryClient = useQueryClient();

  // ---- the project's agents, skills and commands ----
  const lists = useQueries({
    queries: AI_KINDS.map((kind) => ({ queryKey: keys.resources(scope, kind), queryFn: () => api.resources(scope, kind) })),
  });
  const resources: Partial<Record<AssistantResourceKind, ConfigResource[]>> = {};
  AI_KINDS.forEach((kind, i) => {
    const data = lists[i]?.data;
    if (data) resources[kind] = data;
  });
  const listsLoading = lists.some((q) => q.isLoading);
  const listsError = lists.find((q) => q.error)?.error;
  const count = (kind: AssistantResourceKind) => resources[kind]?.length ?? 0;

  // ---- the assistant's runs and their proposals ----
  const resourceRuns = useAssistantRuns(project.id, 'resources');
  const projectRuns = useAssistantRuns(proposalId ? project.id : null, 'project');
  const { suggest, ids } = proposalRuns(resourceRuns.data ?? [], projectRuns.data ?? [], proposalId !== null);
  const details = useQueries({
    queries: ids.map((id) => ({ queryKey: keys.assistantRun(id), queryFn: ({ signal }: { signal: AbortSignal }) => api.assistantRun(id, { signal }) })),
  });
  const runsById = new Map(details.flatMap((q) => (q.data ? [[q.data.id, q.data] as const] : [])));
  const proposals = resourceProposals(details.flatMap((q) => q.data?.proposals ?? []));
  const kinds = sectionKinds(section);
  // The card: every proposal of the latest "Suggest", and what other runs left pending
  const cardProposals = byDecision(proposals.filter((p) => kinds.includes(p.resource.kind) && (p.runId === suggest?.id || p.status === 'pending')));
  const pendingProposals = cardProposals.filter((p) => p.status === 'pending');
  const openProposal = proposalId ? (proposals.find((p) => p.id === proposalId) ?? null) : null;
  const detailsLoading = details.some((q) => q.isLoading) || resourceRuns.isLoading || projectRuns.isLoading;

  const team = useTeam(project.modules.includes('team') ? project.id : null);
  const teamMembers = team.data?.enabled ? team.data.members.length : 0;

  const refreshRun = (runId: string) => {
    void queryClient.invalidateQueries({ queryKey: keys.assistantRun(runId) });
    void queryClient.invalidateQueries({ queryKey: keys.assistantRunsOf(project.id) });
  };
  const suggestRun = useMutation({
    mutationFn: () => api.startAssistantRun(project.id, { kind: 'resources', ...(suggest && suggest.status !== 'running' ? { supersede: true } : {}) }),
    onSuccess: (started) => {
      queryClient.setQueryData(keys.assistantRun(started.id), started);
      refreshRun(started.id);
    },
    onError: (err) => toast.error(t('resourcesAi.startFailed'), err),
  });
  const stopRun = useMutation({
    mutationFn: (runId: string) => api.stopAssistantRun(runId),
    onSuccess: (stopped) => refreshRun(stopped.id),
    onError: (err) => toast.error(t('resourcesAi.stopFailed'), err),
  });
  const decide = useMutation({
    mutationFn: ({ proposal, action }: { proposal: AssistantResourceProposal; action: 'discard' | 'restore' }) =>
      action === 'discard' ? api.discardAssistantProposal(proposal.id) : api.restoreAssistantProposal(proposal.id),
    onSuccess: (_answer, { proposal }) => refreshRun(proposal.runId),
    onError: (err) => toast.error(t('resourcesAi.decideFailed'), err),
  });
  // Each discarded on its own, as every decision on a proposal is (decision 36)
  const discardAll = useMutation({
    mutationFn: async (all: AssistantResourceProposal[]) => {
      for (const proposal of all) await api.discardAssistantProposal(proposal.id);
    },
    onSettled: (_answer, _error, all) => new Set(all.map((p) => p.runId)).forEach(refreshRun),
    onError: (err) => toast.error(t('resourcesAi.decideFailed'), err),
  });

  return {
    resources,
    listsLoading,
    listsError,
    count,
    suggest,
    runsById,
    kinds,
    cardProposals,
    pendingProposals,
    openProposal,
    detailsLoading,
    teamMembers,
    suggestRun,
    stopRun,
    decide,
    discardAll,
  };
}
