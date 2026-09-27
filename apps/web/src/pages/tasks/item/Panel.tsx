import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useWorkItem, useWorkItemByKey } from '../../../api';
import { Dialog } from '../../../components/Dialog';
import { WorkItemKey } from '../../../components/icons';
import { Empty, ErrorBox, Skeleton } from '../../../components/ui';
import { NARROW, useMediaQuery } from '../../../lib/media';
import { normalizeKey, taskPath } from '../../../lib/work-items';
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

/** An item's body, read by key: the loading, missing and failed states of the page and the panel alike. */
export function ItemByKey({ itemKey, variant }: { itemKey: string; variant: 'page' | 'panel' }) {
  const { t } = useTranslation('workItem');
  const byKey = useWorkItemByKey(itemKey);
  const detail = useWorkItem(byKey.data?.id ?? null);
  if (byKey.isLoading || (byKey.data && detail.isLoading)) return <Skeleton rows={6} height={18} />;
  if (byKey.error) return <ErrorBox error={byKey.error} />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!byKey.data || !detail.data) {
    return (
      <Empty illustration={variant === 'page' ? 'not-found' : undefined} size="md" title={t('page.notFound', { key: normalizeKey(itemKey) ?? itemKey })}>
        {t('page.notFoundBody')}
      </Empty>
    );
  }
  return <WorkItemView item={detail.data} variant={variant} />;
}

/**
 * The panel of `?item=`, a drawer on a desktop. A phone has no room beside the board, so there the
 * item opens as its page instead.
 */
export function WorkItemPanelHost() {
  const [params, setParams] = useSearchParams();
  const narrow = useMediaQuery(NARROW);
  const key = params.get(ITEM_PANEL_PARAM);
  // The dialog takes focus again whenever its `onClose` changes, and `setParams` changes with the address
  const latest = useRef(setParams);
  latest.current = setParams;
  const close = useCallback(
    () =>
      latest.current(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete(ITEM_PANEL_PARAM);
          return next;
        },
        { replace: true },
      ),
    [],
  );
  if (!key) return null;
  if (narrow) return <Navigate to={taskPath(key)} replace />;
  return (
    <Dialog variant="drawer" width={760} title={<WorkItemKey value={normalizeKey(key) ?? key} boxed />} onClose={close}>
      <ItemByKey itemKey={key} variant="panel" />
    </Dialog>
  );
}
