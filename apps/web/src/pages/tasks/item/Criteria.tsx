import type { AcceptanceCriterion, AcceptanceCriterionInput, WorkItemDetail, WorkItemHistoryEntry } from '@agentry/shared';
import { Pencil, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '../../../components/controls';
import { ICON_SM, Monogram } from '../../../components/icons';
import { formatDateTime, timeAgo } from '../../../lib/format';
import { RoleAvatar, useRoleName } from '../../team/RoleAvatar';
import type { ItemActions } from './hooks';
import { criteriaProgress, shortId } from './model';

/** When a criterion was last checked, and from which chat, read from the history the store wrote. */
function checkedEntry(history: readonly WorkItemHistoryEntry[], criterionId: string): WorkItemHistoryEntry | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!entry || entry.change !== 'criterion') continue;
    const to = entry.to;
    if (to && typeof to === 'object' && !Array.isArray(to) && 'checked' in to && to.id === criterionId) return to.checked ? entry : null;
  }
  return null;
}

/** The agent's mark: the terminal prompt on a neutral tile. */
export function AgentMark({ size = 18, label }: { size?: number; label?: string }) {
  return (
    <span className="agent-mark" style={{ width: size, height: size }} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      ›_
    </span>
  );
}

function CheckedBy({ criterion, entry, person, compact }: { criterion: AcceptanceCriterion; entry: WorkItemHistoryEntry | null; person: string; compact: boolean }) {
  const { t } = useTranslation('workItem');
  const roleName = useRoleName();
  const by = criterion.checkedBy;
  if (!criterion.checked || !by) return null;
  const chat = entry?.cause?.chatId;
  // A team member that checked it is named by its role, as QA checks a criterion while it verifies
  const role = by.kind === 'agent' ? (by.role ?? null) : null;
  const who = by.kind === 'person' ? person : role ? roleName(role) : chat ? t('criteria.byChat', { chat: shortId(chat) }) : t(`actor.${by.kind}`);
  return (
    <span className="criterion-by" title={entry ? formatDateTime(entry.createdAt) : undefined}>
      {by.kind === 'person' ? <Monogram name={person} size={18} /> : role ? <RoleAvatar role={role} size="sm" /> : <AgentMark label={t('actor.agent')} />}
      <span className={compact ? 'sr-only' : ''}>{who}</span>
      {entry && (
        <>
          {!compact && <span aria-hidden>·</span>}
          <span>{timeAgo(entry.createdAt)}</span>
        </>
      )}
    </span>
  );
}

/** The checklist as rows of text fields, to edit, remove and add entries; saved as a whole. */
function CriteriaEditor({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial: AcceptanceCriterionInput[];
  onSave: (rows: AcceptanceCriterionInput[]) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const { t } = useTranslation('workItem');
  const [rows, setRows] = useState<AcceptanceCriterionInput[]>(initial.length ? initial : [{ text: '' }]);
  const set = (index: number, text: string) => setRows((all) => all.map((row, i) => (i === index ? { ...row, text } : row)));
  return (
    <form
      className="criteria-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(rows.filter((row) => row.text.trim()).map((row) => ({ ...row, text: row.text.trim() })));
      }}
    >
      {rows.map((row, index) => (
        <div key={row.id ?? `new-${index}`} className="criteria-editor-row">
          <input value={row.text} autoFocus={index === rows.length - 1 && !row.id} aria-label={t('criteria.nth', { n: index + 1 })} onChange={(e) => set(index, e.target.value)} />
          <button type="button" className="icon-btn" aria-label={t('criteria.removeNth', { n: index + 1 })} onClick={() => setRows((all) => all.filter((_, i) => i !== index))}>
            <X {...ICON_SM} />
          </button>
        </div>
      ))}
      <div className="criteria-editor-foot">
        <button type="button" className="btn btn-small workitem-add" onClick={() => setRows((all) => [...all, { text: '' }])}>
          <Plus {...ICON_SM} />
          {t('criteria.add')}
        </button>
        <span className="grow" />
        <button type="button" className="btn btn-small" onClick={onCancel}>
          {t('actions.cancel')}
        </button>
        <button type="submit" className="btn btn-small" disabled={saving}>
          {t('actions.save')}
        </button>
      </div>
    </form>
  );
}

/**
 * The acceptance checklist: each criterion checked on its own, saying who checked it and when. The
 * whole row is the control, on a phone too, and the box only shows its state: the one place a check
 * mark is always visible (design system, `.ac-row`).
 */
export function Criteria({ item, actions, person, compact = false }: { item: WorkItemDetail; actions: ItemActions; person: string; compact?: boolean }) {
  const { t } = useTranslation('workItem');
  const [editing, setEditing] = useState(false);
  const criteria = item.acceptanceCriteria;
  const { done, total } = criteriaProgress(criteria);
  const save = (rows: AcceptanceCriterionInput[]) => actions.update.mutate({ acceptanceCriteria: rows }, { onSuccess: () => setEditing(false) });

  return (
    <section className="workitem-section" aria-labelledby={`criteria-${item.id}`}>
      <div className="workitem-section-head">
        <h2 id={`criteria-${item.id}`} className={compact ? 'section-label' : 'workitem-h2'}>
          {t('criteria.title')}
        </h2>
        {total > 0 && (
          <>
            <span className="mono small muted tnum">
              {done}/{total}
              <span className="sr-only"> {t('criteria.progress', { done, total })}</span>
            </span>
            {!compact && (
              <span className="milestone-bar criteria-bar" aria-hidden>
                <i className="done" style={{ width: `${(done / total) * 100}%` }} />
              </span>
            )}
          </>
        )}
        <span className="grow" />
        {!editing && total > 0 && (
          <button type="button" className="icon-btn" aria-label={t('criteria.edit')} title={t('criteria.edit')} onClick={() => setEditing(true)}>
            <Pencil {...ICON_SM} />
          </button>
        )}
        {/* A phone has room for the label and the count only: the pencil opens the list to edit and add */}
        {!editing && !(compact && total > 0) && (
          <button type="button" className="btn btn-small workitem-add" onClick={() => setEditing(true)}>
            <Plus {...ICON_SM} />
            {t('criteria.add')}
          </button>
        )}
      </div>
      {editing ? (
        <CriteriaEditor
          initial={[...criteria.map((c) => ({ id: c.id, text: c.text })), ...(total ? [{ text: '' }] : [])]}
          saving={actions.update.isPending}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      ) : total === 0 ? (
        <p className="muted small workitem-none">{t('criteria.none')}</p>
      ) : (
        <div className="workitem-card criteria">
          {criteria.map((criterion) => (
            <Checkbox
              key={criterion.id}
              className={`criterion-row ${criterion.checked ? 'on' : ''}`.trim()}
              checked={criterion.checked}
              onChange={(checked) => actions.check.mutate({ criterionId: criterion.id, checked })}
            >
              <span className="criterion-text">{criterion.text}</span>
              <CheckedBy criterion={criterion} entry={checkedEntry(item.history, criterion.id)} person={person} compact={compact} />
            </Checkbox>
          ))}
        </div>
      )}
    </section>
  );
}
