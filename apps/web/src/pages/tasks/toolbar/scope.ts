import type { Milestone, Project } from '@agentry/shared';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, keys } from '../../../api';
import { useFallbackInterval } from '../../../lib/feed';
import { useProjectScope } from '../../../lib/project-scope';

export interface TasksScope {
  /** The selected project; null with All projects */
  project: Project | null;
  projectId: string | null;
  allProjects: boolean;
  /** The projects whose Board module is on: the ones Tasks shows with All projects */
  boardProjects: Project[];
  /** Each project's name by id, for the cards of the All projects view */
  projectNames: ReadonlyMap<string, string>;
  /** The selected project has its Board module off: its items are kept, and not shown */
  boardOff: boolean;
  settled: boolean;
}

/** What Tasks is about: the top bar's project, or every project with a board. */
export function useTasksScope(): TasksScope {
  const { project, projectId, projects, settled } = useProjectScope();
  return useMemo(() => {
    const boardProjects = projects.filter((p) => p.modules.includes('board'));
    return {
      project,
      projectId,
      allProjects: projectId === null,
      boardProjects,
      projectNames: new Map(projects.map((p) => [p.id, p.name])),
      boardOff: project !== null && !project.modules.includes('board'),
      settled,
    };
  }, [project, projectId, projects, settled]);
}

/**
 * The milestones of every project in `projectIds`, each read with the project's own query key, so
 * the milestones page and the toolbar share them and `milestone.changed` refreshes them.
 */
export function useScopeMilestones(projectIds: readonly string[]): { milestones: Milestone[]; loading: boolean; error: unknown } {
  const fallback = useFallbackInterval();
  const results = useQueries({
    queries: projectIds.map((id) => ({
      queryKey: keys.milestones(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.milestones(id, { signal }),
      refetchInterval: fallback,
    })),
  });
  const milestones = results.flatMap((result) => result.data ?? []);
  return { milestones, loading: results.some((result) => result.isPending), error: results.find((result) => result.error)?.error ?? null };
}
