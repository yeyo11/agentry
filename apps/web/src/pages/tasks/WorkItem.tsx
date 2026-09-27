import { useParams } from 'react-router-dom';
import { PageHeader } from '../../components/ui';
import { normalizeKey } from '../../lib/work-items';

/**
 * `/tasks/:key`: one work item, by its key (`useWorkItemByKey` resolves it). A stub until web-item
 * replaces this file whole.
 */
export function WorkItemPage() {
  const { key = '' } = useParams();
  return <PageHeader title={normalizeKey(key) ?? key} />;
}
