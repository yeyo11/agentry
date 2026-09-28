import type { WorkItemRef, WorkItemRelation, WorkItemRelationType } from '@agentry/shared';
import { Plus, Search, X } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useWorkItemList } from '../../../api';
import { Dialog } from '../../../components/Dialog';
import { ICON_SM, WorkItemKey, WorkItemStatusIcon } from '../../../components/icons';
import { Segmented } from '../../../components/ui';
import { columnMeta, taskPath } from '../../../lib/work-items';

/**
 * Picks another item of the project to relate to, and which way: it blocks this one, or this one
 * blocks it. Shared by the item's page and the New task form, which relates an item that does not
 * exist yet.
 */
export function RelationDialog({
  projectId,
  exclude,
  onPick,
  onClose,
}: {
  projectId: string;
  /** The item itself and the ones already related */
  exclude: ReadonlySet<string>;
  onPick: (type: WorkItemRelationType, item: WorkItemRef) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('workItem');
  const { t: tt } = useTranslation('tasks');
  const [type, setType] = useState<WorkItemRelationType>('blocked_by');
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const found = useWorkItemList(projectId, query ? { q: query } : {});
  const items = (found.data ?? []).filter((item) => !exclude.has(item.id)).slice(0, 12);
  return (
    <Dialog title={t('relations.addTitle')} onClose={onClose} width={560}>
      <div className="relation-dialog">
        <Segmented<WorkItemRelationType>
          label={t('relations.kind')}
          value={type}
          onChange={setType}
          options={[
            { value: 'blocked_by', label: t('relations.blockedBy') },
            { value: 'blocks', label: t('relations.blocks') },
          ]}
        />
        <label className="relation-search">
          <Search {...ICON_SM} />
          <input
            data-autofocus
            type="search"
            value={q}
            placeholder={t('relations.search')}
            aria-label={t('relations.search')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Enter takes the first match, the one a typed key finds on its own, once the results
              // are for what is typed now and not for the letters before
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const first = items[0];
              if (first && query === q.trim() && !found.isFetching) onPick(type, first);
            }}
          />
        </label>
        {items.length === 0 ? (
          <p className="muted small">{found.isLoading ? t('relations.searching') : t('relations.noMatch')}</p>
        ) : (
          <ul className="relation-results" aria-label={t('relations.results')}>
            {items.map((item) => (
              <li key={item.id}>
                <button type="button" className="relation-row relation-pick" onClick={() => onPick(type, item)}>
                  <WorkItemStatusIcon status={item.status} />
                  <WorkItemKey value={item.key} />
                  <span className="relation-title">{item.title}</span>
                  <span className="muted small">{tt(columnMeta(item.status).label)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** One relation: which way, the other item's column, key and title, and a way to take it off. */
export function RelationRow({ relation, onRemove, linked = true }: { relation: WorkItemRelation; onRemove: () => void; linked?: boolean }) {
  const { t } = useTranslation('workItem');
  const { t: tt } = useTranslation('tasks');
  const { item } = relation;
  const title = linked ? (
    <Link to={taskPath(item.key)} className="relation-title relation-link">
      {item.title}
    </Link>
  ) : (
    <span className="relation-title">{item.title}</span>
  );
  return (
    <div className="relation-row">
      <span className="relation-kind">{t(relation.type === 'blocks' ? 'relations.blocks' : 'relations.blockedBy')}</span>
      <span className="relation-item">
        <WorkItemStatusIcon status={item.status} decorative />
        <WorkItemKey value={item.key} />
        {title}
      </span>
      <span className={`relation-status small ${item.status === 'done' ? 'text-ok' : 'muted'}`}>{tt(columnMeta(item.status).label)}</span>
      <button type="button" className="icon-btn relation-remove" aria-label={t('relations.remove', { key: item.key })} onClick={onRemove}>
        <X {...ICON_SM} />
      </button>
    </div>
  );
}

/** Blocks and blocked by, with add and remove. Orchestrating a selection turns them into the graph's order. */
export function Relations({
  itemId,
  projectId,
  relations,
  onAdd,
  onRemove,
  compact = false,
}: {
  itemId: string;
  projectId: string;
  relations: WorkItemRelation[];
  onAdd: (type: WorkItemRelationType, item: WorkItemRef) => void;
  onRemove: (otherId: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation('workItem');
  const [adding, setAdding] = useState(false);
  const exclude = new Set([itemId, ...relations.map((r) => r.item.id)]);
  return (
    <section className="workitem-section" aria-labelledby={`relations-${itemId}`}>
      <div className="workitem-section-head">
        <h2 id={`relations-${itemId}`} className={compact ? 'section-label grow' : 'workitem-h2 grow'}>
          {t('relations.title')}
        </h2>
        <button type="button" className="btn btn-small workitem-add" onClick={() => setAdding(true)}>
          <Plus {...ICON_SM} />
          {t('relations.add')}
        </button>
      </div>
      {relations.length === 0 ? (
        <p className="muted small workitem-none">{t('relations.none')}</p>
      ) : (
        <div className="workitem-card relations">
          {relations.map((relation) => (
            <RelationRow key={`${relation.type}-${relation.item.id}`} relation={relation} onRemove={() => onRemove(relation.item.id)} />
          ))}
        </div>
      )}
      {adding && (
        <RelationDialog
          projectId={projectId}
          exclude={exclude}
          onClose={() => setAdding(false)}
          onPick={(type, item) => {
            setAdding(false);
            onAdd(type, item);
          }}
        />
      )}
    </section>
  );
}
