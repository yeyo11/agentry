import type { BoardColumn, WorkItem, WorkItemStatus } from '@agentry/shared';
import { WORK_ITEM_STATUSES } from '@agentry/shared';
import { Plus, TriangleAlert } from 'lucide-react';
import { Fragment, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON_SM, WorkItemStatusIcon } from '../../../components/icons';
import { columnMeta } from '../../../lib/work-items';
import type { LiveSources } from './LiveLine';
import { DONE_SHOWN, isSamePlace, keyboardDrop, type Drop, type NotSelectable } from './model';
import { useMoveWorkItem } from './useMoveWorkItem';
import { WorkItemCard } from './WorkItemCard';

/** What the board needs to know about selection mode, which the page owns. */
export interface BoardSelection {
  selected: ReadonlySet<string>;
  blockedReason: (item: WorkItem) => NotSelectable | null;
  toggle: (item: WorkItem) => void;
}

interface Grab {
  id: string;
  key: string;
  origin: Drop;
  at: Drop;
}

const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const DRAG_TYPE = 'application/x-agentry-work-item';

/**
 * The five columns of a board, side by side. A card moves by pointer (drag it between or inside
 * columns) or by keyboard (Space picks it up, the arrows carry it, Space drops it, Escape puts it
 * back), and either way the API is told which card it now follows. A column over its limit says so
 * in words and in the warn colour, and still takes the card.
 */
export function BoardColumns({
  columns,
  projectNames,
  epics,
  live,
  selection,
  moving = true,
  moreTo,
  onOpen,
  onNewTask,
}: {
  columns: BoardColumn[];
  /** Set on the All projects board: each card names its project, and no column has a limit or a "+" */
  projectNames?: ReadonlyMap<string, string> | undefined;
  epics: ReadonlyMap<string, { done: number; total: number }>;
  live: LiveSources;
  selection: BoardSelection | null;
  /** Off while a filter hides cards: a drop between visible cards is still honest, so it stays on */
  moving?: boolean;
  /** Where "and N more" in Done leads: the list of what is done */
  moreTo: string;
  onOpen: (item: WorkItem) => void;
  onNewTask?: ((status: WorkItemStatus) => void) | undefined;
}) {
  const { t } = useTranslation('tasks');
  const move = useMoveWorkItem();
  const [dragId, setDragId] = useState<string | null>(null);
  const [target, setTarget] = useState<Drop | null>(null);
  const [grab, setGrab] = useState<Grab | null>(null);
  const [said, setSaid] = useState('');
  const refocus = useRef<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const byStatus = new Map(columns.map((column) => [column.status, column]));
  const label = (status: WorkItemStatus) => t(columnMeta(status).label);
  const itemById = (id: string) => columns.flatMap((column) => column.items).find((item) => item.id === id);

  // A card carried by keyboard is drawn where it is going; the others close up behind it
  const drawn = (column: BoardColumn): WorkItem[] => {
    if (!grab) return column.items;
    const others = column.items.filter((item) => item.id !== grab.id);
    if (column.status !== grab.at.status) return others;
    const card = itemById(grab.id);
    if (!card) return others;
    return [...others.slice(0, grab.at.index), card, ...others.slice(grab.at.index)];
  };

  // The card keeps the focus as it moves from one column to another, which re-mounts it
  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    boardRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)?.focus();
  });

  const counts = (without: string): Record<WorkItemStatus, number> =>
    Object.fromEntries(WORK_ITEM_STATUSES.map((status) => [status, (byStatus.get(status)?.items ?? []).filter((item) => item.id !== without).length])) as Record<
      WorkItemStatus,
      number
    >;

  const commit = (item: Pick<WorkItem, 'id' | 'key'>, drop: Drop) => {
    const board = { columns };
    if (isSamePlace(board, item.id, drop)) return;
    const column = byStatus.get(drop.status)?.items ?? [];
    move.mutate({ item, drop, column });
  };

  const say = (text: string) => setSaid(text);
  const where = (drop: Drop, total: number) => t('drag.moved', { column: label(drop.status), position: drop.index + 1, total });

  const cardKeys = (item: WorkItem) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (selection) {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (!selection.blockedReason(item)) selection.toggle(item);
      } else if (ARROWS.has(event.key)) {
        event.preventDefault();
        focusNeighbour(event.currentTarget, event.key);
      }
      return;
    }
    if (grab && grab.id === item.id) {
      if (ARROWS.has(event.key)) {
        event.preventDefault();
        const next = keyboardDrop(grab.at, event.key as 'ArrowUp', counts(item.id));
        if (!next) return;
        refocus.current = item.id;
        setGrab({ ...grab, at: next });
        say(where(next, counts(item.id)[next.status] + 1));
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        refocus.current = item.id;
        setGrab(null);
        commit(item, grab.at);
        say(t('drag.dropped', { key: item.key, column: label(grab.at.status), position: grab.at.index + 1 }));
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        refocus.current = event.key === 'Escape' ? item.id : null;
        setGrab(null);
        say(t('drag.cancelled', { key: item.key, column: label(grab.origin.status) }));
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onOpen(item);
    } else if (event.key === ' ' && moving) {
      event.preventDefault();
      const column = byStatus.get(item.status)?.items ?? [];
      const origin = { status: item.status, index: column.findIndex((entry) => entry.id === item.id) };
      setGrab({ id: item.id, key: item.key, origin, at: origin });
      say(t('drag.picked', { key: item.key, column: label(item.status), position: origin.index + 1, total: column.length }));
    } else if (ARROWS.has(event.key)) {
      event.preventDefault();
      focusNeighbour(event.currentTarget, event.key);
    }
  };

  // ---- a pointer drag, with the browser's own drag and drop ----
  const dropIndex = (event: DragEvent<HTMLElement>): number => {
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-item-id]')].filter((el) => el.dataset.itemId !== dragId);
    const at = cards.findIndex((el) => {
      const box = el.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    return at < 0 ? cards.length : at;
  };

  const columnDrag = (status: WorkItemStatus) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!dragId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const index = dropIndex(event);
      if (target?.status !== status || target.index !== index) setTarget({ status, index });
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!dragId) return;
      event.preventDefault();
      const item = itemById(dragId);
      const drop = { status, index: dropIndex(event) };
      setDragId(null);
      setTarget(null);
      if (item) commit(item, drop);
    },
  });

  return (
    <div className={`workitem-board ${dragId ? 'is-dragging' : ''}`.trim()} ref={boardRef}>
      {WORK_ITEM_STATUSES.map((status) => {
        const column = byStatus.get(status) ?? { status, limit: null, count: 0, overLimit: false, items: [] };
        const all = drawn(column);
        const done = status === 'done';
        const shown = done ? all.slice(0, Math.max(DONE_SHOWN, grab?.at.status === 'done' ? grab.at.index + 1 : 0)) : all;
        const hidden = all.length - shown.length;
        const limit = projectNames ? null : column.limit;
        const over = !projectNames && column.overLimit;
        const others = dragId ? shown.filter((item) => item.id !== dragId) : shown;
        const indicatorAt = dragId && target?.status === status && !isSamePlace({ columns }, dragId, target) ? target.index : -1;
        const indicator = <div className="workitem-drop" aria-hidden />;
        return (
          <section key={status} className={`workitem-col ${over ? 'is-over' : ''}`.trim()} aria-label={label(status)} data-status={status} {...columnDrag(status)}>
            <div className="workitem-col-head">
              <WorkItemStatusIcon status={status} decorative />
              <span className="workitem-col-name">{label(status)}</span>
              <span className="workitem-col-count">
                <span aria-hidden>
                  <b>{column.count}</b>
                  {limit !== null && `/${limit}`}
                </span>
                <span className="sr-only">{limit !== null ? t('column.countLimit', { count: column.count, limit }) : t('column.count', { count: column.count })}</span>
              </span>
              <span className="grow" />
              {onNewTask && (
                <button type="button" className="icon-btn workitem-col-add" aria-label={t('actions.newTaskIn', { column: label(status) })} onClick={() => onNewTask(status)}>
                  <Plus {...ICON_SM} />
                </button>
              )}
            </div>
            {over && limit !== null && (
              <div className="workitem-col-limit" role="status">
                <TriangleAlert size={13} strokeWidth={1.75} aria-hidden />
                {t('column.over', { count: column.count, limit })}
              </div>
            )}
            <div className="workitem-col-body">
              {shown.map((item) => (
                <Fragment key={item.id}>
                  {indicatorAt >= 0 && others[indicatorAt]?.id === item.id && indicator}
                  <WorkItemCard
                    item={item}
                    project={projectNames?.get(item.projectId)}
                    epic={epics.get(item.id)}
                    live={live}
                    selection={
                      selection
                        ? { selected: selection.selected.has(item.id), blocked: selection.blockedReason(item), onToggle: () => selection.toggle(item) }
                        : undefined
                    }
                    grabbed={grab?.id === item.id}
                    dragging={dragId === item.id}
                    draggable={moving && !selection && !grab}
                    onOpen={() => onOpen(item)}
                    onKeyDown={cardKeys(item)}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData(DRAG_TYPE, item.id);
                      event.dataTransfer.setData('text/plain', item.key);
                      setDragId(item.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setTarget(null);
                    }}
                  />
                </Fragment>
              ))}
              {indicatorAt >= 0 && indicatorAt >= others.length && indicator}
              {shown.length === 0 && indicatorAt < 0 && <div className="workitem-col-slot">{dragId ? t('column.drop') : t('column.empty')}</div>}
              {hidden > 0 && (
                <Link to={moreTo} className="workitem-col-slot is-more">
                  {t('column.more', { count: hidden })}
                </Link>
              )}
            </div>
          </section>
        );
      })}
      <div className="sr-only workitem-announce" role="status" aria-live="assertive">
        {said}
      </div>
    </div>
  );
}

/** Arrow keys walk the board: up and down a column, left and right to the neighbouring column's card. */
function focusNeighbour(card: HTMLElement, key: string) {
  const column = card.closest<HTMLElement>('.workitem-col');
  const board = card.closest<HTMLElement>('.workitem-board');
  if (!column || !board) return;
  const cards = [...column.querySelectorAll<HTMLElement>('[data-item-id]')];
  const at = cards.indexOf(card);
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    cards[at + (key === 'ArrowDown' ? 1 : -1)]?.focus();
    return;
  }
  const cols = [...board.querySelectorAll<HTMLElement>('.workitem-col')];
  const step = key === 'ArrowRight' ? 1 : -1;
  for (let i = cols.indexOf(column) + step; i >= 0 && i < cols.length; i += step) {
    const next = [...(cols[i]?.querySelectorAll<HTMLElement>('[data-item-id]') ?? [])];
    if (next.length) {
      (next[Math.min(at, next.length - 1)] ?? next[0])?.focus();
      return;
    }
  }
}
