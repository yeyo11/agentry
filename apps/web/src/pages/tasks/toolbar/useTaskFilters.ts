import type { WorkItem, WorkItemFilter } from '@agentry/shared';
import { useCallback, useMemo } from 'react';
import { useListParams } from '../../../lib/list-params';
import { ALL_PROJECTS, useProjectScope } from '../../../lib/project-scope';
import { apiFilter, FILTER_PARAMS, filtersFromSearch, filtersToSearch, hasFilters, inProjects, type TaskFilters } from '../../../lib/work-items';
import { NO_MILESTONE } from '../board/model';

export interface TaskFilterState {
  filters: TaskFilters;
  /** What the API is asked for: the All projects' project pick and "no milestone" are applied after */
  query: Omit<WorkItemFilter, 'projectId'>;
  active: boolean;
  /** How many facets narrow the view, the search left out: the phone's filter button shows it */
  facets: number;
  set: (patch: Partial<TaskFilters>) => void;
  clear: () => void;
  /** What the client narrows on top of the API's answer */
  narrow: <T extends Pick<WorkItem, 'projectId' | 'milestoneId'>>(items: readonly T[]) => T[];
}

/** The parameters the toolbar owns; the view, the scope and `?new=1` are not filters and are not kept */
const OWNED: readonly string[] = Object.values(FILTER_PARAMS);

/**
 * The toolbar's filters, kept in the address so a filtered board can be linked and survives a
 * reload, and kept per project until they are reset, as every list does (`useListParams`). Every
 * other parameter (the view, the scope, `?new=1`) is left as it was.
 */
export function useTaskFilters(): TaskFilterState {
  const { projectId, settled } = useProjectScope();
  // Each project, and All projects, keeps its own; until the scope is known there is no telling whose
  const { params, patch, reset } = useListParams('tasks', OWNED, settled ? (projectId ?? ALL_PROJECTS) : null);
  const search = params.toString();
  const filters = useMemo(() => filtersFromSearch(new URLSearchParams(search)), [search]);
  const noMilestone = filters.milestoneId === NO_MILESTONE;

  const set = useCallback(
    (change: Partial<TaskFilters>) => {
      const next = filtersToSearch({ ...filters, ...change });
      patch(Object.fromEntries(OWNED.map((name) => [name, next.get(name)])));
    },
    [filters, patch],
  );
  const clear = reset;

  const query = useMemo(() => {
    const { milestoneId, ...rest } = apiFilter(filters);
    return noMilestone || !milestoneId ? rest : { ...rest, milestoneId };
  }, [filters, noMilestone]);

  const narrow = useCallback(
    <T extends Pick<WorkItem, 'projectId' | 'milestoneId'>>(items: readonly T[]): T[] => {
      const picked = inProjects(items, filters.projects);
      return noMilestone ? picked.filter((item) => item.milestoneId === null) : picked;
    },
    [filters.projects, noMilestone],
  );

  const facets = (Object.keys(filters) as Array<keyof TaskFilters>).filter((field) => field !== 'q').length;
  return { filters, query, active: hasFilters(filters), facets, set, clear, narrow };
}
