import type { WorkItem, WorkItemStatus } from '@agentry/shared';
import { useTranslation } from 'react-i18next';

export interface NewTaskProps {
  /** The project the task goes into; with All projects, the form asks for one */
  projectId: string | null;
  /** The column it starts in: the "+" of a column passes its own. Default Backlog */
  status?: WorkItemStatus;
  onClose: () => void;
  onCreated?: (item: WorkItem) => void;
}

/**
 * The New task form: a dialog on a desktop, a full screen on a phone. The board opens it from its
 * "Nueva tarea", a column's "+" and `?new=1` (lib/work-items NEW_TASK_PATH). A stub until web-item
 * replaces this file whole, keeping these props.
 */
export function NewTask(_props: NewTaskProps) {
  const { t } = useTranslation('workItem');
  return <h2>{t('newTask.title')}</h2>;
}
