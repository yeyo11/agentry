import type { WorkItemDetail } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, ExternalLink, Link2, MessageSquare, Play, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, keys } from '../../../api';
import { MoreActions } from '../../../components/controls';
import { Tooltip } from '../../../components/controls/Tooltip';
import { useConfirm } from '../../../components/Dialog';
import { ICON_SM, WorkItemStatusIcon } from '../../../components/icons';
import { useToast } from '../../../components/Toast';
import { columnMeta, returnPath, returnState, taskPath } from '../../../lib/work-items';
import { useMoveItem, type ItemActions } from './hooks';
import { deleteWarning, workOnBlocker } from './model';
import { ITEM_PANEL_PARAM } from './Panel';
import { WorkOnDialog } from './WorkOn';

/** Where a work item is shown: its own page, or the panel the board opens beside itself. */
export type ItemVariant = 'page' | 'panel';

/** The item's column as a badge with its glyph and word; only Done is coloured, and it is named. */
export function StatusBadge({ item }: { item: Pick<WorkItemDetail, 'status'> }) {
  const { t } = useTranslation('tasks');
  return (
    <span className={`badge workitem-status-badge ${item.status === 'done' ? 'badge-ok' : ''}`.trim()}>
      <WorkItemStatusIcon status={item.status} decorative />
      {t(columnMeta(item.status).label)}
    </span>
  );
}

/**
 * The item's two actions: "Work on it", the primary, which starts a chat through the API, and "Move
 * to Done", the person's approval (decision 29). Where "Work on it" cannot start, it says why in
 * words instead of failing on press: an epic is not worked on, Done is final, and an item a chat is
 * already on offers that chat.
 */
export function useItemButtons(item: WorkItemDetail, actions: ItemActions) {
  const { t } = useTranslation('workItem');
  const [starting, setStarting] = useState(false);
  const blocker = workOnBlocker(item);
  const activeChat = item.activeLink?.chatId;
  const move = useMoveItem(item, actions);
  const done =
    item.status === 'done' ? null : (
      <button type="button" className="btn workitem-done" onClick={() => move('done')} disabled={actions.move.isPending}>
        <Check {...ICON_SM} />
        {t('actions.moveToDone')}
      </button>
    );
  let work: ReactNode = null;
  if (blocker === 'busy' && activeChat) {
    work = (
      <Link to={`/chats/${activeChat}`} className="btn workitem-work">
        <MessageSquare {...ICON_SM} />
        {t('actions.openChat')}
      </Link>
    );
  } else if (blocker === null) {
    work = (
      <button type="button" className="btn btn-primary workitem-work" onClick={() => setStarting(true)}>
        <Play {...ICON_SM} />
        {t('actions.workOn')}
      </button>
    );
  }
  const refusal =
    blocker === 'epic' || blocker === 'done' ? (
      <p className="workitem-refusal" role="note">
        <CircleAlert {...ICON_SM} />
        {t(`workOn.blocked.${blocker}`)}
      </p>
    ) : null;
  const dialog = starting ? <WorkOnDialog item={item} onClose={() => setStarting(false)} /> : null;
  return { done, work, refusal, dialog };
}

/** The `⋯` of the item: copy its link, open it as a page from the panel, delete it after a confirmation. */
export function ItemMenu({ item, variant, withCopy }: { item: WorkItemDetail; variant: ItemVariant; withCopy: boolean }) {
  const { t } = useTranslation('workItem');
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const here = useLocation();
  const [, setParams] = useSearchParams();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteWorkItem(item.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.workItems });
      // Back where it was opened from, with its view, filters and project tab: the panel just closes
      if (variant === 'panel')
        setParams(
          (previous) => {
            const next = new URLSearchParams(previous);
            next.delete(ITEM_PANEL_PARAM);
            return next;
          },
          { replace: true },
        );
      else navigate(returnPath(here.state), { replace: true });
    },
    onError: (error) => toast.error(t('errors.delete'), error),
  });
  const copy = () => void navigator.clipboard?.writeText(`${location.origin}${taskPath(item.key)}`).then(() => toast.success(t('actions.copied')));
  return (
    <MoreActions
      label={t('actions.more')}
      entries={[
        ...(withCopy ? [{ id: 'copy', label: t('actions.copyLink'), icon: Link2, onSelect: copy }] : []),
        ...(variant === 'panel' ? [{ id: 'page', label: t('actions.openPage'), icon: ExternalLink, onSelect: () => navigate(taskPath(item.key), { state: returnState(boardAddress(here)) }) }] : []),
        {
          id: 'delete',
          label: t('actions.delete'),
          icon: Trash2,
          destructive: true,
          onSelect: () =>
            void confirm({
              title: t('delete.title', { key: item.key }),
              body: deleteWarning(item) === 'working' ? `${t('delete.body')} ${t('delete.working')}` : t('delete.body'),
              confirmLabel: t('actions.delete'),
              danger: true,
            }).then(
              (ok) => ok && remove.mutate(),
            ),
        },
      ]}
    />
  );
}

/** The address the panel was opened on, without the panel: what its page goes back to. */
function boardAddress(location: { pathname: string; search: string }): string {
  const query = new URLSearchParams(location.search);
  query.delete(ITEM_PANEL_PARAM);
  const rest = query.toString();
  return `${location.pathname}${rest ? `?${rest}` : ''}`;
}

/** Where the page goes back to: the board or list it was opened from with its filters, or a project's tab. */
export function useBackPath(): string {
  return returnPath(useLocation().state);
}

export function CopyLink({ item }: { item: WorkItemDetail }) {
  const { t } = useTranslation('workItem');
  const toast = useToast();
  return (
    <Tooltip content={t('actions.copyLink')}>
      <button
        type="button"
        className="icon-btn"
        aria-label={t('actions.copyLink')}
        onClick={() => void navigator.clipboard?.writeText(`${location.origin}${taskPath(item.key)}`).then(() => toast.success(t('actions.copied')))}
      >
        <Link2 {...ICON_SM} />
      </button>
    </Tooltip>
  );
}
