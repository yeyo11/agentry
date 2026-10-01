import { useTranslation } from 'react-i18next';
import type { WorkItemPriority, WorkItemRef, WorkItemStatus, WorkItemType } from '@agentry/shared';
import { columnMeta, priorityMeta } from '../lib/work-items';
import { nameHue } from '@agentry/ui/components/icons';

// ---------- work items: the marks every Tasks screen draws the same way (styles/work-item-marks.css)

/**
 * A column's glyph: told by shape (dashed, empty, half, three quarters, ticked), and only Done is
 * coloured, ok. Named for a screen reader unless `decorative`, for where its word is already beside it.
 */
export function WorkItemStatusIcon({ status, decorative = false }: { status: WorkItemStatus; decorative?: boolean }) {
  const { t } = useTranslation('tasks');
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': t(columnMeta(status).label) };
  return (
    <svg className={`workitem-status ${status === 'done' ? 's-done' : ''}`.trim()} viewBox="0 0 16 16" data-status={status} {...a11y}>
      {status === 'backlog' && <circle cx="8" cy="8" r="6" strokeDasharray="2.4 2.2" />}
      {status === 'todo' && <circle cx="8" cy="8" r="6" />}
      {status === 'in_progress' && (
        <>
          <circle cx="8" cy="8" r="6" />
          <path className="fill" d="M8 4a4 4 0 0 1 0 8z" />
        </>
      )}
      {status === 'in_review' && (
        <>
          <circle cx="8" cy="8" r="6" />
          <path className="fill" d="M8 4a4 4 0 1 1-4 4h4z" />
        </>
      )}
      {status === 'done' && (
        <>
          <circle className="fill" cx="8" cy="8" r="7" />
          <path className="tick" d="M5.2 8.3l1.9 1.9 3.7-4" />
        </>
      )}
    </svg>
  );
}

const TYPE_PATHS: Record<WorkItemType, string> = {
  epic: 'M12 3l9 9-9 9-9-9zM12 8.5l3.5 3.5-3.5 3.5L8.5 12z',
  story: 'M7 3.5h10v17l-5-3.8-5 3.8z',
  task: 'M5 5h14v14H5zM9 12l2 2 4-4.5',
  bug: 'M9 7a3 3 0 0 1 6 0M8 9h8v5a4 4 0 0 1-8 0zM12 9v9M4 13h4M16 13h4M5 7.5l3 2M19 7.5l-3 2M5.5 19l2.8-2.4M18.5 19l-2.8-2.4',
};

/** Epic, story, task or bug by shape, all neutral. */
export function WorkItemTypeIcon({ type, large = false, decorative = false }: { type: WorkItemType; large?: boolean; decorative?: boolean }) {
  const { t } = useTranslation('tasks');
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': t(`type.${type}`) };
  return (
    <svg className={`workitem-type ${large ? 'lg' : ''}`.trim()} viewBox="0 0 24 24" data-type={type} {...a11y}>
      <path d={TYPE_PATHS[type]} />
    </svg>
  );
}

/**
 * Priority is not a status: three neutral bars, and urgent the only mark in a colour, the accent,
 * which no status uses. Its word is always said, to a screen reader and on hover.
 */
export function PriorityMark({ priority }: { priority: WorkItemPriority }) {
  const { t } = useTranslation('tasks');
  const meta = priorityMeta(priority);
  const label = t(meta.aria);
  return (
    <span className={`priority-mark p-${priority}`} role="img" aria-label={label} title={label}>
      <i />
      <i />
      <i />
    </span>
  );
}

/** `AGN-12`, in mono and tabular; `boxed` where it heads a page or a row of its own. */
export function WorkItemKey({ value, boxed = false }: { value: string; boxed?: boolean }) {
  return <span className={`workitem-key ${boxed ? 'boxed' : ''}`.trim()}>{value}</span>;
}

/** An epic's label: neutral, with the epic's own hue only on its diamond. */
export function EpicLabel({ epic }: { epic: Pick<WorkItemRef, 'id' | 'title'> }) {
  return (
    <span className="workitem-epic" style={{ '--hue': nameHue(epic.id) } as React.CSSProperties}>
      {epic.title}
    </span>
  );
}
