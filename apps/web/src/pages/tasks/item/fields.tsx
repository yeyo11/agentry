import type { Milestone, WorkItemAssignee, WorkItemPriority, WorkItemRef, WorkItemStatus, WorkItemType } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { useMilestones, useProjects, useTeam, useWorkItemList } from '../../../api';
import { Monogram, PriorityMark, WorkItemStatusIcon, WorkItemTypeIcon, nameHue } from '../../../components/icons';
import { WORK_ITEM_COLUMNS, WORK_ITEM_PRIORITY_META, WORK_ITEM_TYPE_META } from '../../../lib/work-items';
import { RoleAvatar, useRoleName } from '../../team/RoleAvatar';
import type { PickerOption } from './Picker';

/**
 * The options of each field a work item is edited through, drawn with the marks the board draws,
 * shared by the item's page and the New task form so both offer the same choices the same way.
 */

/** Stands for "none" in a picker, whose values are strings and never empty */
export const NONE = '__none__';

export function useStatusOptions(): PickerOption<WorkItemStatus>[] {
  const { t } = useTranslation('tasks');
  return WORK_ITEM_COLUMNS.map((column) => ({
    value: column.status,
    label: (
      <span className="workitem-option">
        <WorkItemStatusIcon status={column.status} decorative />
        {t(column.label)}
      </span>
    ),
  }));
}

export function usePriorityOptions(): PickerOption<WorkItemPriority>[] {
  const { t } = useTranslation('tasks');
  return WORK_ITEM_PRIORITY_META.map((meta) => ({
    value: meta.priority,
    label: (
      <span className="workitem-option">
        <PriorityMark priority={meta.priority} />
        {t(meta.label)}
      </span>
    ),
  }));
}

/** `offered` is the project's list of types (its board settings); the current type stays offered even if it left the list. */
export function useTypeOptions(offered?: readonly WorkItemType[], current?: WorkItemType): PickerOption<WorkItemType>[] {
  const { t } = useTranslation('tasks');
  return WORK_ITEM_TYPE_META.filter((meta) => !offered?.length || offered.includes(meta.type) || meta.type === current).map((meta) => ({
    value: meta.type,
    label: (
      <span className="workitem-option">
        <WorkItemTypeIcon type={meta.type} decorative />
        {t(meta.label)}
      </span>
    ),
  }));
}

// ---------- assignee ----------

/** An assignee as a picker value: `none`, `person`, or `role:<role>` (the API's filter spells it the same) */
export const assigneeValue = (assignee: WorkItemAssignee | null): string => (assignee ? (assignee.kind === 'role' ? `role:${assignee.role}` : 'person') : NONE);

export const assigneeOf = (value: string): WorkItemAssignee | null =>
  value === 'person' ? { kind: 'person' } : value.startsWith('role:') ? { kind: 'role', role: value.slice(5) } : null;

/** The person's round monogram, a role's squircle (as the board draws it), or an empty dashed ring for nobody. */
export function AssigneeMark({ assignee, person }: { assignee: WorkItemAssignee | null; person: string }) {
  if (!assignee) return <span className="workitem-assignee-none" aria-hidden />;
  if (assignee.kind === 'role') return <RoleAvatar role={assignee.role} size="sm" />;
  return <Monogram name={person} size={18} />;
}

/** An assignee in words: the person's name, a role's display name, or "no assignee". */
export function useAssigneeName(person: string): (assignee: WorkItemAssignee | null) => string {
  const { t } = useTranslation('workItem');
  const roleName = useRoleName();
  return (assignee) => (!assignee ? t('fields.noAssignee') : assignee.kind === 'person' ? person : roleName(assignee.role));
}

/**
 * Nobody, the person, and each member of the project's team while its Team module is on (decision
 * 13 of the ecosystem plan). A role already set stays pickable after its member left the team.
 */
export function useAssigneeOptions(person: string, current: WorkItemAssignee | null, projectId: string | null): PickerOption<string>[] {
  const { t } = useTranslation('workItem');
  const roleName = useRoleName();
  const project = useProjects(false).data?.find((p) => p.id === projectId);
  const team = useTeam(project?.modules.includes('team') ? project.id : null).data;
  const options: PickerOption<string>[] = [
    {
      value: NONE,
      label: (
        <span className="workitem-option">
          <AssigneeMark assignee={null} person={person} />
          {t('fields.noAssignee')}
        </span>
      ),
    },
    {
      value: 'person',
      label: (
        <span className="workitem-option">
          <AssigneeMark assignee={{ kind: 'person' }} person={person} />
          {person}
        </span>
      ),
    },
  ];
  const roles = (team?.members ?? []).map((member) => member.role);
  if (current?.kind === 'role' && !roles.includes(current.role)) roles.push(current.role);
  for (const role of roles) {
    const assignee: WorkItemAssignee = { kind: 'role', role };
    options.push({
      value: assigneeValue(assignee),
      label: (
        <span className="workitem-option">
          <AssigneeMark assignee={assignee} person={person} />
          {roleName(role)}
        </span>
      ),
    });
  }
  return options;
}

// ---------- epic and milestone ----------

/** The epic's diamond alone, in its own hue, for a field too narrow for the whole label */
export function EpicDot({ epic }: { epic: Pick<WorkItemRef, 'id'> }) {
  return <span className="workitem-epic workitem-epic-dot" style={{ '--hue': nameHue(epic.id) } as React.CSSProperties} aria-hidden />;
}

/** The project's epics to put an item under; never the item itself. */
export function useEpicOptions(projectId: string | null, exclude?: string): { options: PickerOption<string>[]; epics: WorkItemRef[] } {
  const { t } = useTranslation('workItem');
  const list = useWorkItemList(projectId, { type: ['epic'] }, projectId !== null);
  const epics = (list.data ?? []).filter((epic) => epic.id !== exclude);
  return {
    epics,
    options: [
      { value: NONE, label: <span className="workitem-option muted">{t('fields.noEpic')}</span> },
      ...epics.map((epic) => ({
        value: epic.id,
        label: (
          <span className="workitem-option">
            <EpicDot epic={epic} />
            {epic.title}
            <span className="workitem-key">{epic.key}</span>
          </span>
        ),
      })),
    ],
  };
}

/** The open milestones, plus the item's own if it was closed since. */
export function useMilestoneOptions(projectId: string | null, current: string | null): { options: PickerOption<string>[]; milestones: Milestone[] } {
  const { t } = useTranslation('workItem');
  const query = useMilestones(projectId);
  const milestones = query.data ?? [];
  return {
    milestones,
    options: [
      { value: NONE, label: <span className="workitem-option muted">{t('fields.noMilestone')}</span> },
      ...milestones.filter((m) => m.state === 'open' || m.id === current).map((m) => ({ value: m.id, label: <span className="workitem-option milestone-name">{m.name}</span> })),
    ],
  };
}

/** A milestone's bar: done in ok, in flight neutral, the rest as track. No dates. */
export function MilestoneBar({ milestone, width = 64 }: { milestone: Milestone; width?: number }) {
  const { total, done, byStatus } = milestone.progress;
  const doing = byStatus.in_progress + byStatus.in_review;
  const share = (n: number) => (total ? `${(n / total) * 100}%` : '0%');
  return (
    <span className="milestone-bar" style={{ width }} aria-hidden>
      <i className="done" style={{ width: share(done) }} />
      <i className="doing" style={{ width: share(doing) }} />
    </span>
  );
}
