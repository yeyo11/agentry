import type { Milestone, Project, WorkItem } from '@agentry/shared';
import { WORK_ITEM_PRIORITIES, WORK_ITEM_TYPES } from '@agentry/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Monogram } from '@agentry/ui/components/icons';
import { PriorityMark, WorkItemTypeIcon } from '../../../components/work-item-icons';
import { labelsInUse, NO_MILESTONE } from '../board/model';
import { ProjectFacetIcon, type Facet } from './Filters';
import { RoleAvatar, useRoleName } from '../../team/RoleAvatar';

/**
 * The toolbar's facets and their options, from what the board holds: the epics and labels in use,
 * the assignees there are, and the milestones of the scope. Types and priorities are fixed, the
 * priorities offered most urgent first, as a person scans them.
 */
export function useFacets({
  allProjects,
  projects,
  items,
  milestones,
}: {
  allProjects: boolean;
  /** The projects with a board, for the All projects view's project facet */
  projects: readonly Pick<Project, 'id' | 'name'>[];
  /** Every item of the scope, unfiltered */
  items: readonly WorkItem[];
  milestones: readonly Milestone[];
}): Facet[] {
  const { t } = useTranslation('tasks');
  const roleName = useRoleName();
  return useMemo(() => {
    const roles = [...new Set(items.flatMap((item) => (item.assignee?.kind === 'role' ? [item.assignee.role] : [])))].sort();
    const epics = items.filter((item) => item.type === 'epic');
    const named = (name: string, projectId: string) => (allProjects ? `${name} · ${projects.find((p) => p.id === projectId)?.name ?? ''}` : name);
    const facets: Facet[] = [
      {
        field: 'type',
        label: t('toolbar.type'),
        options: WORK_ITEM_TYPES.map((type) => ({ value: type, label: t(`type.${type}`), mark: <WorkItemTypeIcon type={type} decorative /> })),
      },
      {
        field: 'priority',
        label: t('toolbar.priority'),
        options: [...WORK_ITEM_PRIORITIES].reverse().map((priority) => ({ value: priority, label: t(`priority.${priority}`), mark: <PriorityMark priority={priority} /> })),
      },
      { field: 'labels', label: t('toolbar.label'), options: labelsInUse(items).map((label) => ({ value: label, label })) },
      {
        field: 'assignee',
        label: t('toolbar.assignee'),
        options: [
          { value: 'person', label: t('toolbar.person'), mark: <Monogram name={t('toolbar.person')} size={18} /> },
          ...roles.map((role) => ({ value: `role:${role}`, label: roleName(role), mark: <RoleAvatar role={role} size="sm" label={roleName(role)} /> })),
          { value: 'none', label: t('toolbar.unassigned') },
        ],
      },
      { field: 'epicId', label: t('toolbar.epic'), single: true, options: epics.map((epic) => ({ value: epic.id, label: named(epic.title, epic.projectId) })) },
      {
        field: 'milestoneId',
        label: t('toolbar.milestone'),
        single: true,
        options: [
          ...milestones.filter((m) => m.state === 'open').map((m) => ({ value: m.id, label: named(m.name, m.projectId) })),
          ...milestones.filter((m) => m.state === 'closed').map((m) => ({ value: m.id, label: named(m.name, m.projectId) })),
          { value: NO_MILESTONE, label: t('toolbar.noMilestone') },
        ],
      },
    ];
    if (allProjects)
      facets.unshift({ field: 'projects', label: t('toolbar.project'), icon: <ProjectFacetIcon />, options: projects.map((project) => ({ value: project.id, label: project.name })) });
    return facets;
  }, [allProjects, items, milestones, projects, roleName, t]);
}
