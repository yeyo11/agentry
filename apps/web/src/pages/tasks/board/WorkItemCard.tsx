import type { WorkItem } from '@agentry/shared';
import { Ban, Check, Folder } from 'lucide-react';
import type { CSSProperties, DragEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Monogram, nameHue, PriorityMark, WorkItemKey, WorkItemTypeIcon } from '../../../components/icons';
import { stripNamesAssignee, taskPath, workItemLiveState, workItemStrip, type WorkItemStripState } from '../../../lib/work-items';
import { RoleAvatar, useRoleName } from '../../team/RoleAvatar';
import type { LiveSources } from './LiveLine';
import { openBlockers, type NotSelectable } from './model';
import { BounceFact, useStripRuns } from './team';
import { WorkItemStrip } from './WorkItemStrip';

const FACT = { size: 12, strokeWidth: 1.75, 'aria-hidden': true } as const;

/** Who an item is assigned to: the person as a round monogram, a team role as its squircle. */
export function Assignee({ item }: { item: Pick<WorkItem, 'assignee'> }) {
  const { t } = useTranslation('tasks');
  const roleName = useRoleName();
  const who = item.assignee;
  if (!who) return null;
  if (who.kind === 'role') return <RoleAvatar role={who.role} size="sm" label={t('card.assignedTo', { role: roleName(who.role) })} />;
  const name = t('toolbar.person');
  const said = t('card.assignedToYou');
  return (
    <span className="workitem-assignee" role="img" aria-label={said} title={said}>
      <Monogram name={name} size={20} />
    </span>
  );
}

/** The checklist as a short bar and its figure: neutral while open, ok once every criterion is checked. */
export function CriteriaFact({ item }: { item: Pick<WorkItem, 'acceptanceCriteria'> }) {
  const { t } = useTranslation('tasks');
  const total = item.acceptanceCriteria.length;
  if (total === 0) return null;
  const done = item.acceptanceCriteria.filter((criterion) => criterion.checked).length;
  const said = t('card.criteria', { done, total });
  return (
    <span className={`workitem-fact workitem-criteria ${done === total ? 'is-full' : ''}`.trim()} title={said}>
      <span className="workitem-criteria-bar" aria-hidden>
        <i style={{ width: `${Math.round((done / total) * 100)}%` }} />
      </span>
      <span aria-hidden>
        {done}/{total}
      </span>
      <span className="sr-only">{said}</span>
    </span>
  );
}

/** The facts under a card or a row: bounces, what it waits for, and the checklist. */
export function CardFacts({ item, short = false }: { item: Pick<WorkItem, 'acceptanceCriteria' | 'relations' | 'bounces'>; short?: boolean }) {
  const { t } = useTranslation('tasks');
  const blockers = openBlockers(item);
  const keys = blockers.map((blocker) => blocker.key).join(', ');
  return (
    <>
      <BounceFact item={item} />
      {blockers.length > 0 && (
        <span className="workitem-fact is-blocked" title={t('card.blockedBy', { keys })}>
          <Ban {...FACT} />
          {short ? t('card.blockedByShort', { keys }) : <span aria-hidden>{keys}</span>}
          {!short && <span className="sr-only">{t('card.blockedBy', { keys })}</span>}
        </span>
      )}
      <CriteriaFact item={item} />
    </>
  );
}

/** Whether a card has anything to say in its facts row. */
export const hasFacts = (item: Pick<WorkItem, 'acceptanceCriteria' | 'relations' | 'bounces'>): boolean =>
  openBlockers(item).length > 0 || item.acceptanceCriteria.length > 0 || (item.bounces ?? 0) > 0;

/** An epic's card counts the items it groups, instead of carrying an epic label of its own. */
export function EpicProgress({ progress }: { progress: { done: number; total: number } | undefined }) {
  const { t } = useTranslation('tasks');
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  if (total === 0)
    return (
      <div className="workitem-card-epic">
        <span>{t('card.noTasksYet')}</span>
      </div>
    );
  const share = Math.round((done / total) * 100);
  return (
    <div className="workitem-card-epic">
      <span className="workitem-ms-bar" role="img" aria-label={t('card.epicProgressLabel', { done, total })}>
        <i className="done" style={{ width: `${share}%` }} />
      </span>
      <span aria-hidden>{t('card.epicProgress', { done, total })}</span>
    </div>
  );
}

/**
 * Where an item goes (`.wi-card-ctx`): its project on All projects, its epic without a box, and its
 * labels as `#tags`. `trailing` ends the line (the assignee of a card with no facts row).
 */
export function CardContext({
  item,
  project,
  trailing,
  phone = false,
}: {
  item: Pick<WorkItem, 'type' | 'epic' | 'labels'>;
  project?: string | undefined;
  trailing?: ReactNode;
  /** A phone row names the project by its monogram, as MobileTareasTodos does */
  phone?: boolean;
}) {
  const { t } = useTranslation('tasks');
  const labels = item.type === 'epic' ? [] : item.labels;
  const epic = item.type === 'epic' ? null : item.epic;
  if (!project && !epic && labels.length === 0 && !trailing) return null;
  return (
    <div className="workitem-context">
      {project && (
        <span className={`workitem-project ${phone ? 'is-phone' : ''}`.trim()} title={t('card.project')}>
          {phone ? <Monogram name={project} size={20} project /> : <Folder size={13} strokeWidth={1.75} aria-hidden />}
          {project}
        </span>
      )}
      {epic && (
        <span className="workitem-epic is-bare" style={{ '--hue': nameHue(epic.id) } as CSSProperties}>
          {epic.title}
        </span>
      )}
      {labels.length > 0 && (
        <span className="workitem-tags">
          {labels.map((label) => (
            <span key={label} className="workitem-tag">
              {label}
            </span>
          ))}
        </span>
      )}
      {trailing && (
        <>
          <span className="grow" />
          {trailing}
        </>
      )}
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
 * One work item on the desktop board, read in five rows (design system, decision 1): what it is,
 * its title, where it goes, its facts, and the strip that says what happens to it now. A card at
 * rest is still; one something works on carries the live rail and a live strip. A card in Done
 * keeps only its first two rows. The card itself is the focus stop: Enter opens the item, Space
 * picks it up to move it with the arrows (the board owns that), and a pointer drags it. In
 * selection mode the whole card is a checkbox instead.
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
  const runs = useStripRuns();
  const strip: WorkItemStripState | null = workItemStrip(item, runs);
  const done = item.status === 'done';
  const working = !done && (workItemLiveState(item) === 'working' || strip?.kind === 'run');
  const classes = [
    'workitem-card',
    done && 'is-done',
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

  // The strip names who acts: the foot does not say it again
  const assignee = item.assignee && !stripNamesAssignee(item.assignee, strip) ? <Assignee item={item} /> : null;
  const facts = item.type !== 'epic' && hasFacts(item);

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
        <WorkItemTypeIcon type={item.type} />
        <WorkItemKey value={item.key} />
        <span className="grow" />
        {!done && <PriorityMark priority={item.priority} />}
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
      {!done && (
        <>
          <CardContext item={item} project={project} trailing={!facts && item.type !== 'epic' ? assignee : null} />
          {item.type === 'epic' && <EpicProgress progress={epic} />}
          {facts && (
            <div className="workitem-card-foot">
              <CardFacts item={item} />
              {assignee}
            </div>
          )}
          <WorkItemStrip item={item} strip={strip} sources={live} />
        </>
      )}
    </div>
  );
}
