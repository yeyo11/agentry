import type { WorkItem, WorkItemFilter } from '@agentry/shared';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiFilter, filtersFromSearch, filtersToSearch, hasFilters, inProjects, type TaskFilters } from '../../../lib/work-items';
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

/**
 * The toolbar's filters, kept in the address so a filtered board can be linked and survives a
 * reload. Every other parameter (the view, the scope, `?new=1`) is left as it was.
 */
export function useTaskFilters(): TaskFilterState {
  const [params, setParams] = useSearchParams();
  const search = params.toString();
  const filters = useMemo(() => filtersFromSearch(new URLSearchParams(search)), [search]);
  const noMilestone = filters.milestoneId === NO_MILESTONE;

  const set = useCallback(
    (patch: Partial<TaskFilters>) =>
      setParams((previous) => filtersToSearch({ ...filtersFromSearch(previous), ...patch }, previous), { replace: true }),
    [setParams],
  );
  const clear = useCallback(() => setParams((previous) => filtersToSearch({}, previous), { replace: true }), [setParams]);

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
