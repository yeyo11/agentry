import type { WorkItem } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useWorkItem } from '../api';
import { taskPath } from '../lib/work-items';

/**
 * The work item an orchestration node works on. A node only names its item by id, so the item is
 * read under the key its own page uses: the graph and the item's page share one request, and a
 * changed prefix reaches both through the event feed.
 */
export function useLinkedWorkItem(itemId: string | undefined): WorkItem | undefined {
  return useWorkItem(itemId ?? null).data;
}

/** The item's key, boxed and in mono, as the way to its page. */
export function WorkItemKeyLink({ item, className = '' }: { item: Pick<WorkItem, 'key' | 'title'>; className?: string }) {
  const { t } = useTranslation('orchestration');
  return (
    <Link to={taskPath(item.key)} className={`workitem-key boxed workitem-key-link ${className}`.trim()} aria-label={t('workItem.open', { key: item.key })} title={item.title}>
      {item.key}
    </Link>
  );
}
