import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useWorkItemByKey } from '../../api';
import { usePageTitle } from '../../components/ui';
import { DirtyScope } from '../../lib/dirty';
import { normalizeKey, taskPath } from '../../lib/work-items';
import { ItemByKey } from './item/Panel';

/**
 * `/tasks/:key`: one work item, by its key. The top bar reads "Tasks / AGN-12"; the page is the
 * item's content and, on a desktop, its properties in a column of their own beside it.
 */
export function WorkItemPage() {
  const { key = '' } = useParams();
  const item = useWorkItemByKey(key);
  const navigate = useNavigate();
  const location = useLocation();
  const shown = normalizeKey(key) ?? key;
  usePageTitle(item.data ? `${item.data.key} · ${item.data.title}` : shown);
  return (
    <DirtyScope>
      {/* A new prefix renames the item: the address follows it, and keeps where Back goes */}
      <ItemByKey itemKey={key} variant="page" onRenamed={(next) => navigate(taskPath(next), { replace: true, state: location.state as unknown })} />
    </DirtyScope>
  );
}
