import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PriorityMark, WorkItemStatusIcon } from '../../../components/work-item-icons';
import { columnMeta, priorityMeta } from '../../../lib/work-items';
import {
  AssigneeMark,
  EpicDot,
  NONE,
  assigneeOf,
  assigneeValue,
  useAssigneeName,
  useAssigneeOptions,
  useEpicOptions,
  useMilestoneOptions,
  usePriorityOptions,
  useStatusOptions,
} from '../item/fields';
import { Picker } from '../item/Picker';
import type { Draft, SetDraft } from './model';

export type PickerTrigger = (label: string, value: ReactNode) => ReactElement;

/** The form's column, priority, assignee, epic and milestone pickers, built for a trigger. */
export function useNewTaskPickers(draft: Draft, set: SetDraft, person: string, projectId: string | null) {
  const { t } = useTranslation('workItem');
  const { t: tt } = useTranslation('tasks');
  const statuses = useStatusOptions();
  const priorities = usePriorityOptions();
  const assignees = useAssigneeOptions(person, draft.assignee, projectId);
  const epics = useEpicOptions(projectId);
  const milestones = useMilestoneOptions(projectId, draft.milestoneId);
  const epic = epics.epics.find((e) => e.id === draft.epicId) ?? null;
  const milestone = milestones.milestones.find((m) => m.id === draft.milestoneId) ?? null;
  const assigneeName = useAssigneeName(person)(draft.assignee);

  // The same pickers in both forms; only their trigger differs
  return (trigger: PickerTrigger) => ({
    status: (
      <Picker
        label={t('newTask.column')}
        value={draft.status}
        options={statuses}
        onPick={(v) => set('status', v)}
        trigger={trigger(
          t('newTask.column'),
          <>
            <WorkItemStatusIcon status={draft.status} decorative />
            {tt(columnMeta(draft.status).label)}
          </>,
        )}
      />
    ),
    priority: (
      <Picker
        label={t('fields.priority')}
        value={draft.priority}
        options={priorities}
        onPick={(v) => set('priority', v)}
        trigger={trigger(
          t('fields.priority'),
          <>
            <PriorityMark priority={draft.priority} />
            {tt(priorityMeta(draft.priority).label)}
          </>,
        )}
      />
    ),
    assignee: (
      <Picker
        label={t('fields.assignee')}
        value={assigneeValue(draft.assignee)}
        options={assignees}
        onPick={(v) => set('assignee', assigneeOf(v))}
        trigger={trigger(
          t('fields.assignee'),
          <>
            <AssigneeMark assignee={draft.assignee} person={person} />
            <span className={draft.assignee ? '' : 'muted'}>{assigneeName}</span>
          </>,
        )}
      />
    ),
    epic:
      draft.type === 'epic' ? null : (
        <Picker
          label={t('fields.epic')}
          value={draft.epicId ?? NONE}
          options={epics.options}
          onPick={(v) => set('epicId', v === NONE ? null : v)}
          trigger={trigger(
            t('fields.epic'),
            epic ? (
              <>
                <EpicDot epic={epic} />
                {epic.title}
              </>
            ) : (
              <span className="muted">{t('fields.noEpic')}</span>
            ),
          )}
        />
      ),
    milestone: (
      <Picker
        label={t('fields.milestone')}
        value={draft.milestoneId ?? NONE}
        options={milestones.options}
        onPick={(v) => set('milestoneId', v === NONE ? null : v)}
        trigger={trigger(t('fields.milestone'), milestone ? <span className="milestone-name">{milestone.name}</span> : <span className="muted">{t('fields.noMilestone')}</span>)}
      />
    ),
  });
}
