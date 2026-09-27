import type { WorkItem } from '@agentry/shared';
import { Ban, Check, Folder, ListChecks } from 'lucide-react';
import type { DragEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { EpicLabel, Monogram, PriorityMark, WorkItemKey, WorkItemTypeIcon } from '../../../components/icons';
import { Spinner } from '../../../components/Spinner';
import { taskPath, workItemLiveState } from '../../../lib/work-items';
import { LiveLine, type LiveSources } from './LiveLine';
import { openBlockers, type NotSelectable } from './model';

const FACT = { size: 12, strokeWidth: 1.75, 'aria-hidden': true } as const;

/** Who an item is assigned to, as a monogram: the person, or a team role once the Team module exists. */
export function Assignee({ item }: { item: Pick<WorkItem, 'assignee'> }) {
  const { t } = useTranslation('tasks');
  const who = item.assignee;
  if (!who) return null;
  const name = who.kind === 'person' ? t('toolbar.person') : who.role;
  const said = who.kind === 'person' ? t('card.assignedToYou') : t('card.assignedTo', { role: who.role });
  return (
    <span className="workitem-assignee" role="img" aria-label={said} title={said}>
      <Monogram name={name} size={20} />
    </span>
  );
}

/** The checklist's progress and what the item waits for: the facts under a card or a row. */
export function CardFacts({ item, short = false }: { item: Pick<WorkItem, 'acceptanceCriteria' | 'relations'>; short?: boolean }) {
  const { t } = useTranslation('tasks');
  const blockers = openBlockers(item);
  const total = item.acceptanceCriteria.length;
  const done = item.acceptanceCriteria.filter((criterion) => criterion.checked).length;
  const keys = blockers.map((blocker) => blocker.key).join(', ');
  return (
    <>
      {blockers.length > 0 && (
        <span className="workitem-fact is-blocked" title={t('card.blockedBy', { keys })}>
          <Ban {...FACT} />
          {short ? t('card.blockedByShort', { keys }) : <span aria-hidden>{keys}</span>}
          {!short && <span className="sr-only">{t('card.blockedBy', { keys })}</span>}
        </span>
      )}
      {total > 0 && (
        <span className="workitem-fact" title={t('card.criteria', { done, total })}>
          <ListChecks {...FACT} />
          <span aria-hidden>
            {done}/{total}
          </span>
          <span className="sr-only">{t('card.criteria', { done, total })}</span>
        </span>
      )}
    </>
  );
}

/** An epic's card counts the items it groups, instead of carrying an epic label of its own. */
export function EpicProgress({ progress, compact = false }: { progress: { done: number; total: number } | undefined; compact?: boolean }) {
  const { t } = useTranslation('tasks');
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const share = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className={`workitem-card-epic ${compact ? 'is-compact' : ''}`.trim()}>
      <span className="workitem-ms-bar" role="img" aria-label={t('card.epicProgressLabel', { done, total })}>
        <i className="done" style={{ width: `${share}%` }} />
      </span>
      <span aria-hidden>{t('card.epicProgress', { done, total })}</span>
    </div>
  );
}

export interface CardSelection {
  selected: boolean;
  /** Why it cannot be picked; null when it can */
  blocked: NotSelectable | null;
  onToggle: () => void;
}

/**
 * One work item on the desktop board. At rest it is still; a card whose chat or node runs carries
 * the live rail, the ring spinner in place of its type and a line that says what it is doing.
 * The card itself is the focus stop: Enter opens the item, Space picks it up to move it with the
 * arrows (the board owns that), and a pointer drags it. In selection mode the whole card is a
 * checkbox instead.
 */
export function WorkItemCard({
  item,
  project,
  epic,
  live,
  selection,
  grabbed = false,
  dragging = false,
  draggable = false,
  onOpen,
  onKeyDown,
  onDragStart,
  onDragEnd,
}: {
  item: WorkItem;
  /** The project's name, on the All projects board */
  project?: string | undefined;
  epic?: { done: number; total: number } | undefined;
  live: LiveSources;
  selection?: CardSelection | undefined;
  grabbed?: boolean;
  dragging?: boolean;
  draggable?: boolean;
  onOpen: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
}) {
  const { t } = useTranslation('tasks');
  const state = workItemLiveState(item);
  const working = state === 'working';
  const facts = <CardFacts item={item} />;
  const hasFacts = openBlockers(item).length > 0 || item.acceptanceCriteria.length > 0;
  const assignee = item.assignee ? <Assignee item={item} /> : null;
  const classes = [
    'workitem-card',
    item.status === 'done' && 'is-done',
    working && 'live-rail',
    selection?.selected && 'is-selected',
    selection?.blocked && 'is-unselectable',
    grabbed && 'is-grabbed',
    dragging && 'is-dragging',
  ]
    .filter(Boolean)
    .join(' ');

  const click = (event: MouseEvent<HTMLElement>) => {
    // A modified click on the title is the link's own (a new tab); the rest of the card opens it here
    if ((event.target as HTMLElement).closest('a') && (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1)) return;
    event.preventDefault();
    if (selection) {
      if (!selection.blocked) selection.onToggle();
      return;
    }
    onOpen();
  };

  const why = selection?.blocked ? t(`select.why.${selection.blocked}`) : undefined;
  const a11y = selection
    ? { role: 'checkbox', 'aria-checked': selection.selected, 'aria-disabled': selection.blocked ? true : undefined, 'aria-description': why }
    : { role: 'article', 'aria-roledescription': t('card.roledescription'), 'aria-description': t('card.hint') };

  let meta: ReactNode = null;
  // An epic's card counts its items instead; on All projects it still names its project
  if (item.type === 'epic')
    meta = project ? (
      <div className="workitem-card-meta">
        <span className="workitem-project" title={t('card.project')}>
          <Folder size={13} strokeWidth={1.75} aria-hidden />
          {project}
        </span>
      </div>
    ) : null;
  else if (project || item.epic || item.labels.length > 0 || (!hasFacts && assignee))
    meta = (
      <div className="workitem-card-meta">
        {project && (
          <span className="workitem-project" title={t('card.project')}>
            <Folder size={13} strokeWidth={1.75} aria-hidden />
            {project}
          </span>
        )}
        {item.epic && <EpicLabel epic={item.epic} />}
        {item.labels.map((label) => (
          <span key={label} className="workitem-label">
            {label}
          </span>
        ))}
        {!hasFacts && assignee && (
          <>
            <span className="grow" />
            {assignee}
          </>
        )}
      </div>
    );

  // A div with the role, not an <article>: while selecting, the card is a checkbox, and an article
  // may not take that role
  return (
    <div
      className={classes}
      data-item-id={item.id}
      data-status={item.status}
      tabIndex={0}
      aria-label={`${item.key} · ${item.title}`}
      {...a11y}
      title={why}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={click}
      onKeyDown={onKeyDown}
    >
      <div className="workitem-card-top">
        {/* Only a chosen card shows its box, as the reference draws it: the pressed "Select" already
            says every card can be picked, and the ones that cannot say why on hover */}
        {selection?.selected && (
          <span className="checkbox" data-state="checked" aria-hidden>
            <Check size={11} strokeWidth={3} />
          </span>
        )}
        {working ? (
          <>
            <Spinner variant="ring" className="workitem-card-spin" />
            <span className="sr-only">{t('card.working')}</span>
          </>
        ) : (
          <WorkItemTypeIcon type={item.type} />
        )}
        <WorkItemKey value={item.key} />
        <span className="grow" />
        <PriorityMark priority={item.priority} />
      </div>
      <p className="workitem-card-title">
        {/* Out of the tab order: the card is the stop, and this is for a middle click or a new tab.
            A card that is a checkbox holds no link: a control inside a control is two targets */}
        {selection ? (
          item.title
        ) : (
          <Link to={taskPath(item.key)} className="workitem-card-link" tabIndex={-1} draggable={false}>
            {item.title}
          </Link>
        )}
      </p>
      {meta}
      {item.type === 'epic' && <EpicProgress progress={epic} />}
      <LiveLine item={item} sources={live} />
      {hasFacts && (
        <div className="workitem-card-foot">
          {facts}
          <span className="grow" />
          {assignee}
        </div>
      )}
    </div>
  );
}
