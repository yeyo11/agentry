import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useWorkItemByKey } from '../../api';
import { usePageTitle } from '@agentry/ui/components/ui';
import { DirtyScope, useDirtyKeys } from '../../lib/dirty';
import { normalizeKey, taskPath } from '../../lib/work-items';
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
  return (
    <DirtyScope>
      <FollowedItem itemKey={key} />
    </DirtyScope>
  );
}

/**
 * A new prefix renames the item: the address follows it and keeps where Back goes. A new path
 * mounts the page again, so while a title or a description is being edited the address waits for
 * the edit to be saved or cancelled: the item is followed by its id meanwhile, and nothing is lost.
 */
function FollowedItem({ itemKey }: { itemKey: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const editing = useDirtyKeys().size > 0;
  const [renamed, setRenamed] = useState<string | null>(null);
  useEffect(() => {
    if (!renamed || editing) return;
    // A tick later: effects run child first, and the router's leave guard learns that nothing is
    // being edited any more in its provider's effect, above this one
    const timer = window.setTimeout(() => navigate(taskPath(renamed), { replace: true, state: location.state as unknown }), 0);
    return () => window.clearTimeout(timer);
  }, [renamed, editing, navigate, location.state]);
  return <ItemByKey itemKey={itemKey} variant="page" onRenamed={setRenamed} />;
}
