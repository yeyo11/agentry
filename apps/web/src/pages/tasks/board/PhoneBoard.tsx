import type { BoardColumn, WorkItem, WorkItemStatus } from '@agentry/shared';
import { WORK_ITEM_STATUSES } from '@agentry/shared';
import { ArrowDown, ArrowUp, Check, CornerDownRight, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { MoreActions } from '@agentry/ui/components/controls/MoreActions';
import type { MenuEntry } from '@agentry/ui/components/controls/Menu';
import { nameHue } from '@agentry/ui/components/icons';
import { PriorityMark, WorkItemKey, WorkItemStatusIcon, WorkItemTypeIcon } from '../../../components/work-item-icons';
import { Segmented } from '@agentry/ui/components/ui';
import { columnMeta, stripNamesAssignee, taskPath, workItemLiveState, workItemStrip } from '../../../lib/work-items';
import { DonePageSkeleton, MoreButton, type BoardSelection } from './BoardColumns';
import type { LiveSources } from './LiveLine';
import { foldColumn, neighbourStatus } from './model';
import { ColumnRole, useStripRuns } from './team';
import { useMoveWorkItem } from './useMoveWorkItem';
import { Assignee, CardContext, CardFacts, EpicProgress, hasFacts } from './WorkItemCard';
import { WorkItemStrip } from './WorkItemStrip';

/**
 * The board on a phone: no columns side by side, but one list with a section per column, and the
 * column jump above it (each column's glyph and count, the chosen one with its name) to scroll to a
 * section. A card moves through its "⋯", a sheet with the columns and a step up or down; in
 * selection mode the whole row is a pressed button that says "Chosen" in words, never a checkbox.
 */
export function PhoneBoard({
  columns,
  projectNames,
  epics,
  live,
  selection,
  doneShown,
  doneLoading = false,
  onMoreDone,
}: {
  columns: BoardColumn[];
  projectNames?: ReadonlyMap<string, string> | undefined;
  epics: ReadonlyMap<string, { done: number; total: number }>;
  live: LiveSources;
  selection: BoardSelection | null;
  /** How many Done rows are drawn; "and N more" asks for the next page of them */
  doneShown: number;
  doneLoading?: boolean;
  onMoreDone: () => void;
}) {
  const { t } = useTranslation('tasks');
  const runs = useStripRuns();
  const move = useMoveWorkItem();
  const byStatus = new Map(columns.map((column) => [column.status, column]));
  // The first column with work in it: an empty Backlog is not where a phone should open
  const first = WORK_ITEM_STATUSES.find((status) => (byStatus.get(status)?.items.length ?? 0) > 0) ?? 'backlog';
  const [jumped, setJumped] = useState<WorkItemStatus>(first);
  const sections = useRef(new Map<WorkItemStatus, HTMLElement>());
  const label = (status: WorkItemStatus) => t(columnMeta(status).label);
  const allProjects = Boolean(projectNames);

  // The jump follows the scroll: the section at the top of the screen is the one it names
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const status = top?.target.getAttribute('data-status') as WorkItemStatus | null;
        if (status) setJumped(status);
      },
      { rootMargin: '-120px 0px -55% 0px' },
    );
    for (const el of sections.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [columns.length]);

  const jump = (status: WorkItemStatus) => {
    setJumped(status);
    sections.current.get(status)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const moveEntries = (item: WorkItem, column: BoardColumn): MenuEntry[] => {
    const at = column.items.findIndex((entry) => entry.id === item.id);
    const to = (status: WorkItemStatus, index: number, list: readonly WorkItem[]) => move.mutate({ item, drop: { status, index }, column: list });
    const entries: MenuEntry[] = [];
    // Done is in closing order: no place in it to move a card to
    const ranked = column.status !== 'done';
    if (ranked && at > 0) entries.push({ id: 'up', label: t('move.up'), icon: ArrowUp, onSelect: () => to(column.status, at - 1, column.items) });
    if (ranked && at >= 0 && at < column.items.length - 1) entries.push({ id: 'down', label: t('move.down'), icon: ArrowDown, onSelect: () => to(column.status, at + 1, column.items) });
    for (const status of WORK_ITEM_STATUSES) {
      if (status === column.status) continue;
      const list = byStatus.get(status)?.items ?? [];
      // Into the neighbouring columns at the top, where a card goes next; elsewhere at the end
      const index = status === 'done' || status === neighbourStatus(column.status, 1) || status === neighbourStatus(column.status, -1) ? 0 : list.length;
      entries.push({ id: status, label: t('move.to', { column: label(status) }), icon: CornerDownRight, onSelect: () => to(status, index, list) });
    }
    return entries;
  };

  return (
    <div className="workitem-phone-board">
      <div className="workitem-jump">
        <Segmented
          value={jumped}
          label={t('jump.label')}
          onChange={jump}
          options={WORK_ITEM_STATUSES.map((status) => {
            const column = byStatus.get(status);
            const count = column?.count ?? 0;
            const over = !allProjects && Boolean(column?.overLimit);
            return {
              value: status,
              title: t('jump.option', { column: label(status), count }),
              label: (
                <span className={`workitem-jump-option ${over ? 'is-over' : ''}`.trim()}>
                  <WorkItemStatusIcon status={status} decorative />
                  {status === jumped && <span className="workitem-jump-name">{label(status)}</span>}
                  <span className="workitem-jump-count">{count}</span>
                  <span className="sr-only">{status === jumped ? '' : label(status)}</span>
                </span>
              ),
            };
          })}
        />
      </div>

      {WORK_ITEM_STATUSES.map((status) => {
        const column = byStatus.get(status) ?? { status, limit: null, count: 0, overLimit: false, items: [] };
        const over = !allProjects && column.overLimit;
        const { shown, hidden } = foldColumn(column, doneShown);
        const projects = new Set(column.items.map((item) => item.projectId)).size;
        return (
          <section
            key={status}
            className="workitem-msection"
            aria-label={label(status)}
            data-status={status}
            ref={(el) => {
              if (el) sections.current.set(status, el);
              else sections.current.delete(status);
            }}
          >
            <div className="workitem-msection-head">
              <WorkItemStatusIcon status={status} decorative />
              <span className="workitem-col-name">{label(status)}</span>
              <span className={`workitem-col-count ${over ? 'is-over' : ''}`.trim()}>
                <b>{column.count}</b>
                {!allProjects && column.limit !== null && `/${column.limit}`}
              </span>
              {allProjects && projects > 1 && <span className="workitem-msection-note">{t('header.inProjectsShort', { count: projects })}</span>}
              {!allProjects && (
                <>
                  <span className="grow" />
                  <ColumnRole status={status} />
                </>
              )}
              {over && column.limit !== null && (
                <span className="workitem-msection-over">
                  <TriangleAlert size={13} strokeWidth={1.75} aria-hidden />
                  {t('column.over', { count: column.count, limit: column.limit })}
                </span>
              )}
            </div>
            {shown.length > 0 ? (
              <div className={`card workitem-mcard ${over ? 'is-over' : ''}`.trim()}>
                {shown.map((item) =>
                  selection ? (
                    <SelectRow key={item.id} item={item} selection={selection} project={projectNames?.get(item.projectId)} />
                  ) : (
                    <PhoneRow key={item.id} item={item} project={projectNames?.get(item.projectId)} epic={epics.get(item.id)} live={live} strip={workItemStrip(item, runs)} more={moveEntries(item, column)} />
                  ),
                )}
                {status === 'done' && doneLoading && hidden > 0 ? (
                  <DonePageSkeleton />
                ) : (
                  hidden > 0 && <MoreButton count={hidden} onClick={onMoreDone} className="workitem-mrow-more-link" />
                )}
              </div>
            ) : (
              <div className="workitem-col-slot">{t('column.empty')}</div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * A card as a phone row, in the card's five rows (MobileTablero): what it is with its "⋯" to move it,
 * the title, where it goes, its facts, and the strip.
 */
function PhoneRow({
  item,
  project,
  epic,
  live,
  strip,
  more,
}: {
  item: WorkItem;
  project?: string | undefined;
  epic?: { done: number; total: number } | undefined;
  live: LiveSources;
  strip: ReturnType<typeof workItemStrip>;
  more: MenuEntry[];
}) {
  const { t } = useTranslation('tasks');
  const done = item.status === 'done';
  const working = !done && strip?.kind !== 'run-waiting' && (workItemLiveState(item) === 'working' || strip?.kind === 'run');
  const assignee = item.assignee && !stripNamesAssignee(item.assignee, strip) ? <Assignee item={item} /> : null;
  const facts = item.type !== 'epic' && hasFacts(item);
  return (
    <div className={`workitem-mrow ${working ? 'live-rail' : ''}`.trim()} data-item-id={item.id}>
      <div className="workitem-mrow-top">
        <WorkItemTypeIcon type={item.type} />
        <WorkItemKey value={item.key} />
        <span className="grow" />
        {!done && <PriorityMark priority={item.priority} />}
        <MoreActions entries={more} label={t('card.actions', { key: item.key })} title={t('move.title', { key: item.key })} className="workitem-mrow-more" />
      </div>
      <Link to={taskPath(item.key)} className="workitem-mrow-title">
        {item.title}
      </Link>
      {!done && (
        <>
          <CardContext item={item} project={project} trailing={!facts && item.type !== 'epic' ? assignee : null} phone />
          {item.type === 'epic' && <EpicProgress progress={epic} />}
          {facts && (
            <div className="workitem-card-foot">
              <CardFacts item={item} short />
              {assignee}
            </div>
          )}
          <WorkItemStrip item={item} strip={strip} sources={live} />
        </>
      )}
    </div>
  );
}

/** A row in selection mode: the whole row is the pressed button, and it says what it is in words. */
function SelectRow({ item, selection, project }: { item: WorkItem; selection: BoardSelection; project?: string | undefined }) {
  const { t } = useTranslation('tasks');
  const chosen = selection.selected.has(item.id);
  const blocked = selection.blockedReason(item);
  return (
    <button
      type="button"
      className={`workitem-mrow is-select ${chosen ? 'is-selected' : ''} ${blocked ? 'is-unselectable' : ''}`.replace(/\s+/g, ' ').trim()}
      aria-pressed={chosen}
      aria-disabled={blocked ? true : undefined}
      data-item-id={item.id}
      onClick={() => {
        if (!blocked) selection.toggle(item);
      }}
    >
      <span className="workitem-mrow-top">
        <WorkItemTypeIcon type={item.type} />
        <WorkItemKey value={item.key} />
        {!blocked && <PriorityMark priority={item.priority} />}
        <span className="grow" />
        {blocked ? (
          <span className="workitem-mrow-why">{t(`select.why.${blocked}`)}</span>
        ) : chosen ? (
          <span className="workitem-mrow-chosen">
            <Check size={14} strokeWidth={2} aria-hidden />
            {t('select.chosen')}
          </span>
        ) : (
          <span className="workitem-mrow-why">{t('select.tap')}</span>
        )}
      </span>
      <span className="workitem-mrow-title">{item.title}</span>
      {(project || item.epic) && (
        <span className="workitem-context">
          {project && <span className="workitem-project">{project}</span>}
          {item.epic && (
            <span className="workitem-epic is-bare" style={{ '--hue': nameHue(item.epic.id) } as CSSProperties}>
              {item.epic.title}
            </span>
          )}
        </span>
      )}
      {item.relations.some((r) => r.type === 'blocked_by' && r.item.status !== 'done') && (
        <span className="workitem-mrow-meta">
          <CardFacts item={{ acceptanceCriteria: [], relations: item.relations }} short />
        </span>
      )}
    </button>
  );
}
