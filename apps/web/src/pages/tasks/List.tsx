import type { BoardColumn, WorkItem } from '@agentry/shared';
import { Check, ChevronDown, ListOrdered, TriangleAlert, User } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { PriorityMark, WorkItemKey, WorkItemStatusIcon, WorkItemTypeIcon } from '../../components/icons';
import { Spinner } from '../../components/Spinner';
import { timeAgo } from '../../lib/format';
import { columnMeta, priorityMeta, taskPath, workItemLiveState } from '../../lib/work-items';
import type { BoardSelection } from './board/BoardColumns';
import { LiveLine, type LiveSources } from './board/LiveLine';
import { byRank, DONE_SHOWN, openBlockers } from './board/model';
import { Assignee } from './board/WorkItemCard';

/**
 * The list view of Tasks (`/tasks?view=list`): the same items as the board, grouped by column in
 * board order and ordered by their place in it, one row each. J and K walk the rows; Enter opens
 * one. Done shows its first few, and the rest behind a button. On a phone each group is a card of
 * rows whose titles wrap.
 */
export function List({
  columns,
  projectNames,
  live,
  selection,
  phone,
  onOpen,
}: {
  columns: BoardColumn[];
  projectNames?: ReadonlyMap<string, string> | undefined;
  live: LiveSources;
  selection: BoardSelection | null;
  phone: boolean;
  onOpen: (item: WorkItem) => void;
}) {
  const { t } = useTranslation('tasks');
  const [allDone, setAllDone] = useState(false);
  const groups = columns.filter((column) => column.items.length > 0);

  const walk = (event: KeyboardEvent<HTMLElement>) => {
    const key = event.key.toLowerCase();
    if (key !== 'j' && key !== 'k') return;
    if ((event.target as HTMLElement).closest('input, textarea')) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-row]')];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[at < 0 ? 0 : at + (key === 'j' ? 1 : -1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  return (
    <div className={phone ? 'workitem-mlist' : 'workitem-list-wrap'} onKeyDown={walk}>
      <div className={phone ? 'workitem-mlist-groups' : 'card workitem-list'}>
        {/* The column heads are for the eye; each row says everything it shows to a screen reader */}
        {!phone && (
          <div className="workitem-list-cols" aria-hidden>
            <span />
            <span>{t('list.key')}</span>
            <span>{t('list.title')}</span>
            <span>{t('list.now')}</span>
            <span>{t('list.labels')}</span>
            <span title={t('list.criteriaFull')}>
              <span aria-hidden>{t('list.criteria')}</span>
              <span className="sr-only">{t('list.criteriaFull')}</span>
            </span>
            <span>{t('list.priority')}</span>
            <span title={t('list.assignee')}>
              <User size={13} strokeWidth={1.75} aria-hidden />
              <span className="sr-only">{t('list.assignee')}</span>
            </span>
            <span className="is-end">
              {t('list.changed')}
            </span>
          </div>
        )}
        {groups.map((column) => {
          const items = byRank(column.items);
          const done = column.status === 'done';
          const shown = done && !allDone ? items.slice(0, DONE_SHOWN) : items;
          const rest = items.length - shown.length;
          const over = !projectNames && column.overLimit && column.limit !== null;
          const head = (
            <div className="workitem-group">
              <span className="workitem-group-name">
                <WorkItemStatusIcon status={column.status} decorative />
                <span className="workitem-col-name">{t(columnMeta(column.status).label)}</span>
                <span className="workitem-col-count">{items.length}</span>
                {over && (
                  <span className="badge badge-warn">
                    <TriangleAlert size={11} strokeWidth={2} aria-hidden />
                    {phone ? `${column.count}/${column.limit}` : t('list.over', { count: column.count, limit: column.limit })}
                  </span>
                )}
              </span>
            </div>
          );
          const rows = shown.map((item) => <Row key={item.id} item={item} project={projectNames?.get(item.projectId)} live={live} selection={selection} phone={phone} onOpen={onOpen} />);
          const toggle =
            done && (rest > 0 || allDone) && items.length > DONE_SHOWN ? (
              <button type="button" className="workitem-list-more" aria-expanded={allDone} onClick={() => setAllDone((v) => !v)}>
                <ChevronDown size={14} strokeWidth={1.75} aria-hidden className={allDone ? 'is-open' : ''} />
                {allDone ? t('list.hideDone') : t('list.showDone', { count: rest })}
              </button>
            ) : null;
          if (phone)
            return (
              <section key={column.status} className="workitem-msection" aria-label={t(columnMeta(column.status).label)}>
                {head}
                <div className={`card workitem-mcard ${over ? 'is-over' : ''}`.trim()}>
                  {rows}
                  {toggle}
                </div>
              </section>
            );
          return (
            <section key={column.status} className="workitem-list-group" aria-label={t(columnMeta(column.status).label)}>
              {head}
              {rows}
              {toggle}
            </section>
          );
        })}
      </div>
      {!phone && (
        <p className="workitem-list-foot">
          <ListOrdered size={13} strokeWidth={1.75} aria-hidden />
          {t('list.order')} · <kbd className="palette-kbd">J</kbd> <kbd className="palette-kbd">K</kbd> {t('list.keys')}
        </p>
      )}
    </div>
  );
}

function Row({
  item,
  project,
  live,
  selection,
  phone,
  onOpen,
}: {
  item: WorkItem;
  project?: string | undefined;
  live: LiveSources;
  selection: BoardSelection | null;
  phone: boolean;
  onOpen: (item: WorkItem) => void;
}) {
  const { t } = useTranslation('tasks');
  const working = workItemLiveState(item) === 'working';
  const blockers = openBlockers(item);
  const total = item.acceptanceCriteria.length;
  const checked = item.acceptanceCriteria.filter((c) => c.checked).length;
  const classes = ['workitem-row', item.status === 'done' && 'is-done', working && 'live-rail', phone && 'is-phone'].filter(Boolean).join(' ');
  const mark = working ? <Spinner variant="ring" className="workitem-card-spin" /> : <WorkItemTypeIcon type={item.type} />;

  const cells = phone ? (
    <>
      <span className="workitem-row-mark">{mark}</span>
      <WorkItemKey value={item.key} />
      <span className="workitem-row-title">{item.title}</span>
      <PriorityMark priority={item.priority} />
    </>
  ) : (
    <>
      <span className="workitem-row-mark">
        {mark}
      </span>
      <span>
        <WorkItemKey value={item.key} />
      </span>
      <span className="workitem-row-title">
        {item.title}
        {project && <span className="workitem-row-project"> · {project}</span>}
      </span>
      <span className="workitem-row-now">
        {working || item.activeLink ? (
          <LiveLine item={item} sources={live} className="is-inline" />
        ) : blockers.length > 0 ? (
          <span className="workitem-fact">{t('card.blockedByShort', { keys: blockers.map((b) => b.key).join(', ') })}</span>
        ) : null}
      </span>
      <span className="workitem-row-labels">
        {item.labels.map((label) => (
          <span key={label} className="workitem-label">
            {label}
          </span>
        ))}
      </span>
      <span className="workitem-row-num" title={total ? t('card.criteria', { done: checked, total }) : undefined}>
        {total > 0 && `${checked}/${total}`}
      </span>
      <span className="workitem-row-prio">
        <PriorityMark priority={item.priority} />
        <span aria-hidden>{t(priorityMeta(item.priority).label)}</span>
      </span>
      <span className="workitem-row-who">
        {item.assignee ? <Assignee item={item} /> : <span className="workitem-assignee-none" title={t('list.unassigned')} />}
      </span>
      <span className="workitem-row-when">
        {timeAgo(item.updatedAt)}
      </span>
    </>
  );

  if (selection) {
    const chosen = selection.selected.has(item.id);
    const blocked = selection.blockedReason(item);
    return (
      <button
        type="button"
        className={`${classes} is-select ${chosen ? 'is-selected' : ''}`.trim()}
       
        aria-pressed={chosen}
        aria-disabled={blocked ? true : undefined}
        title={blocked ? t(`select.why.${blocked}`) : undefined}
        data-row
        onClick={() => {
          if (!blocked) selection.toggle(item);
        }}
      >
        {cells}
        {chosen && <Check size={14} strokeWidth={2} aria-hidden className="workitem-row-check" />}
      </button>
    );
  }
  return (
    <Link
      to={taskPath(item.key)}
      className={classes}
     
      data-row
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onOpen(item);
      }}
    >
      {cells}
    </Link>
  );
}
