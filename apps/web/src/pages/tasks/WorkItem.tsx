import { useParams } from 'react-router-dom';
import { useWorkItemByKey } from '../../api';
import { usePageTitle } from '../../components/ui';
import { normalizeKey } from '../../lib/work-items';
import { ItemByKey } from './item/Panel';

/**
 * `/tasks/:key`: one work item, by its key. The top bar reads "Tasks / AGN-12"; the page is the
 * item's content and, on a desktop, its properties in a column of their own beside it.
 */
export function WorkItemPage() {
  const { key = '' } = useParams();
  const item = useWorkItemByKey(key);
  const shown = normalizeKey(key) ?? key;
  usePageTitle(item.data ? `${item.data.key} · ${item.data.title}` : shown);
  return <ItemByKey itemKey={key} variant="page" />;
}
