import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useWorkItem, useWorkItemByKey } from '../../../api';
import { Dialog } from '../../../components/Dialog';
import { WorkItemKey } from '../../../components/icons';
import { Empty, ErrorBox, Skeleton } from '../../../components/ui';
import { useLeaveGuard } from '../../../lib/dirty';
import { NARROW, useMediaQuery } from '../../../lib/media';
import { queryView } from '../../../lib/query-view';
import { normalizeKey, renamedKey, returnState, taskPath } from '../../../lib/work-items';
import { WorkItemView } from './View';

/**
 * `?item=AGN-12` on Tasks opens that item in a panel beside the board, so reading one card does not
 * leave the board. The board sets it when a card is opened (`itemPanelSearch`) and mounts
 * `WorkItemPanelHost` once; the panel's "Open as a page" leads to `/tasks/AGN-12`.
 */
export const ITEM_PANEL_PARAM = 'item';

/** The address with the panel open on `key`, every other parameter kept (the view, the filters). */
export function itemPanelSearch(key: string, base: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(base);
  next.set(ITEM_PANEL_PARAM, key);
  return next;
}

/**
 * An item's body, read by key: the loading, missing and failed states of the page and the panel
 * alike. Once found, the item is followed by its id, so a new project prefix does not turn an open
 * item into "not found": `onRenamed` gets the key it goes by now, for the address.
 */
export function ItemByKey({ itemKey, variant, onRenamed }: { itemKey: string; variant: 'page' | 'panel'; onRenamed: (key: string) => void }) {
  const { t } = useTranslation('workItem');
  const byKey = useWorkItemByKey(itemKey);
  const found = useRef<{ key: string; id: string } | null>(null);
  if (found.current?.key !== itemKey) found.current = null;
  if (byKey.data) found.current = { key: itemKey, id: byKey.data.id };
  const detail = useWorkItem(found.current?.id ?? null);
  const renamed = renamedKey(itemKey, detail.data?.key);
  const latest = useRef(onRenamed);
  latest.current = onRenamed;
  useEffect(() => {
    if (renamed) latest.current(renamed);
  }, [renamed]);

  // What was shown stays while a refetch fails: an editor open on it keeps what is being typed
  if (queryView(detail) === 'shown' && detail.data) return <WorkItemView item={detail.data} variant={variant} />;
  const key = queryView(byKey);
  if (key === 'loading' || (key === 'shown' && detail.isLoading)) return <Skeleton rows={6} height={18} />;
  if (key === 'failed') return <ErrorBox error={byKey.error} />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  return (
    <Empty illustration={variant === 'page' ? 'not-found' : undefined} size="md" title={t('page.notFound', { key: normalizeKey(itemKey) ?? itemKey })}>
      {t('page.notFoundBody')}
    </Empty>
  );
}

/**
 * The panel of `?item=`, a drawer on a desktop. A phone has no room beside the board, so there the
 * item opens as its page instead, which goes back to the board it came from.
 */
export function WorkItemPanelHost() {
  const [params, setParams] = useSearchParams();
  const narrow = useMediaQuery(NARROW);
  const location = useLocation();
  const guard = useLeaveGuard();
  const key = params.get(ITEM_PANEL_PARAM);
  const setItem = useCallback(
    (next: string | null) =>
      setParams(
        (previous) => {
          const query = new URLSearchParams(previous);
          if (next) query.set(ITEM_PANEL_PARAM, next);
          else query.delete(ITEM_PANEL_PARAM);
          return query;
        },
        { replace: true },
      ),
    [setParams],
  );
  // A description being edited in the panel is not lost to Escape, the backdrop or the close button
  const close = () => void guard().then((ok) => ok && setItem(null));
  if (!key) return null;
  if (narrow) {
    const board = new URLSearchParams(location.search);
    board.delete(ITEM_PANEL_PARAM);
    const query = board.toString();
    return <Navigate to={taskPath(key)} replace state={returnState(`${location.pathname}${query ? `?${query}` : ''}`)} />;
  }
  return (
    <Dialog variant="drawer" width={760} title={<WorkItemKey value={normalizeKey(key) ?? key} boxed />} onClose={close}>
      <ItemByKey itemKey={key} variant="panel" onRenamed={setItem} />
    </Dialog>
  );
}
