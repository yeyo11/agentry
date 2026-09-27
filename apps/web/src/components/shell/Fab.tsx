import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fabFor } from '../../lib/shell-live';

/**
 * The phone's floating "start something" button, in the brand gradient above the tab bar. What it
 * starts and whether it has room for its words depend on the page (`fabFor`); where there is
 * nothing to start from here, it is not there.
 */
export function Fab({
  pathname,
  search,
  onNewChat,
  onNewOrchestration,
  onNewTask,
}: {
  pathname: string;
  search: string;
  onNewChat: () => void;
  onNewOrchestration: () => void;
  onNewTask: () => void;
}) {
  const { t } = useTranslation(['components', 'shell']);
  const plan = fabFor(pathname, search);
  if (!plan) return null;
  const { label, onClick } = {
    chat: { label: t('components:shell.newChat'), onClick: onNewChat },
    orchestration: { label: t('shell:topbar.newOrchestration'), onClick: onNewOrchestration },
    task: { label: t('shell:tasks.newTask'), onClick: onNewTask },
  }[plan.action];
  return (
    <button
      type="button"
      className={`fab ${plan.labelled ? 'fab-labelled' : ''}`.trim()}
      // The words are the name when they show; the icon alone needs them said
      aria-label={plan.labelled ? undefined : label}
      onClick={onClick}
    >
      <Plus size={22} strokeWidth={2.2} aria-hidden />
      {plan.labelled && <span>{label}</span>}
    </button>
  );
}
