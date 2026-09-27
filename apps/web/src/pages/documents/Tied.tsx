import type { DocumentKind, Project, WorkItem } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus, Search, Sparkles } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, useWorkItemList } from '../../api';
import { Select } from '../../components/controls';
import { Dialog } from '../../components/Dialog';
import { ICON_SM, WorkItemKey, WorkItemStatusIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { formatNumber } from '../../lib/format';
import { DOCUMENT_KINDS, newDocumentContent, newDocumentPath, normalizeNewPath, type TiedDocument } from './model';
import { RoleAvatar, useRoleName } from '../team/RoleAvatar';

/** The mono tag of a kind of document (SPEC, ADR, INFO, DOC). */
export function DocumentKindTag({ kind }: { kind: DocumentKind }) {
  const { t } = useTranslation('documents');
  return (
    <span className="doc-kind" title={t(`kinds.${kind}.name`)}>
      {t(`kinds.${kind}.tag`)}
    </span>
  );
}

/** One document tied to an item: its kind, title, the item's key and the role that wrote it. */
function TiedRow({ doc, selected, onOpen, phone }: { doc: TiedDocument; selected: boolean; onOpen: (path: string) => void; phone: boolean }) {
  const { t } = useTranslation('documents');
  const roleName = useRoleName();
  const who = doc.tie.teamRole ? roleName(doc.tie.teamRole) : t('tied.byHand');
  return (
    <li>
      <button type="button" className={`doc-row ${selected ? 'is-selected' : ''}`.trim()} aria-current={selected ? 'true' : undefined} onClick={() => onOpen(doc.path)}>
        <DocumentKindTag kind={doc.tie.kind} />
        <span className="doc-row-main">
          <span className="doc-row-title">{doc.title}</span>
          <span className="doc-row-meta">
            <WorkItemKey value={doc.tie.item.key} />
            <span>{who}</span>
          </span>
        </span>
        {phone ? <ChevronRight {...ICON_SM} className="doc-row-chevron" /> : doc.tie.teamRole && <RoleAvatar role={doc.tie.teamRole} size="sm" />}
      </button>
    </li>
  );
}

export function TiedList({
  docs,
  selected,
  onOpen,
  phone = false,
}: {
  docs: readonly TiedDocument[];
  selected: string | null;
  onOpen: (path: string) => void;
  phone?: boolean;
}) {
  const { t } = useTranslation('documents');
  if (phone) {
    if (docs.length === 0) return null;
    return (
      <section className="doc-phone-section" aria-labelledby="doc-tied-title">
        <div className="doc-phone-label">
          <h2 id="doc-tied-title" className="section-label doc-fill">
            {t('tied.title')}
          </h2>
          <span className="mono small muted tnum">{formatNumber(docs.length)}</span>
        </div>
        <ul className="card doc-rows">
          {docs.map((doc) => (
            <TiedRow key={doc.path} doc={doc} selected={false} onOpen={onOpen} phone />
          ))}
        </ul>
      </section>
    );
  }
  return (
    <section className="card doc-tied" aria-labelledby="doc-tied-title">
      <div className="card-head">
        <h2 id="doc-tied-title">{t('tied.title')}</h2>
        <span className="count">{formatNumber(docs.length)}</span>
      </div>
      {docs.length === 0 ? (
        <p className="small muted doc-card-note">{t('tied.none')}</p>
      ) : (
        <ul className="doc-rows">
          {docs.map((doc) => (
            <TiedRow key={doc.path} doc={doc} selected={doc.path === selected} onOpen={onOpen} phone={false} />
          ))}
        </ul>
      )}
    </section>
  );
}

type NewFrom = 'blank' | 'item';

/** "New document": written by the person, blank or tied to an item from the start. */
export function NewDocumentCard({ onNew }: { onNew: (from: NewFrom) => void }) {
  const { t } = useTranslation('documents');
  return (
    <section className="card doc-new" aria-labelledby="doc-new-title">
      <div className="card-head">
        <h2 id="doc-new-title">{t('new.title')}</h2>
      </div>
      <p className="small muted doc-card-note">{t('new.hint')}</p>
      <div className="doc-new-actions">
        <button type="button" className="btn btn-small" onClick={() => onNew('blank')}>
          <Plus {...ICON_SM} />
          {t('new.blank')}
        </button>
        <button type="button" className="btn btn-small" onClick={() => onNew('item')}>
          <Sparkles {...ICON_SM} />
          {t('new.fromItem')}
        </button>
      </div>
    </section>
  );
}

/**
 * Writes a new Markdown file in the documents folder and opens it in the editor. From an item, the
 * file is tied to it (a `document` link, role `reference`) with the kind picked, and its path starts
 * from the item's key.
 */
export function NewDocumentDialog({
  project,
  root,
  from,
  onCreated,
  onClose,
}: {
  project: Project;
  root: string;
  from: NewFrom;
  onCreated: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(['documents', 'common']);
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<DocumentKind>(from === 'item' ? 'spec' : 'doc');
  const [item, setItem] = useState<WorkItem | null>(null);
  const [title, setTitle] = useState('');
  const [path, setPath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const found = useWorkItemList(project.id, query ? { q: query } : {}, from === 'item' && item === null);

  const suggested = newDocumentPath(root, kind, { key: item?.key, title: title || item?.title || t('new.untitled') });
  const typed = pathTouched ? path : suggested;
  const finalPath = normalizeNewPath(root, typed);
  const heading = title.trim() || item?.title || '';

  const create = useMutation({
    mutationFn: async () => {
      if (!finalPath) throw new Error(t('new.badPath'));
      const exists = await api.documentFile(project.id, finalPath).then(
        () => true,
        () => false,
      );
      if (exists) throw new Error(t('new.exists', { path: finalPath }));
      const written = await api.writeDocument(project.id, finalPath, {
        content: newDocumentContent(heading || t('new.untitled'), item ?? undefined),
        baseUpdatedAt: null,
      });
      if (item) await api.tieDocument(item.id, { path: written.path, kind });
      return written;
    },
    onSuccess: (written) => {
      void qc.invalidateQueries({ queryKey: keys.documentsOf(project.id) });
      if (item) void qc.invalidateQueries({ queryKey: keys.workItem(item.id) });
      onCreated(written.path);
    },
    onError: (error) => toast.error(t('new.failed'), error),
  });

  const items = (found.data ?? []).slice(0, 10);
  const ready = finalPath !== null && (from === 'blank' || item !== null) && !create.isPending;

  return (
    <Dialog
      title={from === 'item' ? t('new.fromItemTitle') : t('new.blankTitle')}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => create.mutate()}>
            {create.isPending ? t('new.creating') : t('new.create')}
          </button>
        </>
      }
    >
      <form
        className="form doc-new-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) create.mutate();
        }}
      >
        {from === 'item' && (
          <div className="field">
            <span className="field-label">{t('new.item')}</span>
            {item ? (
              <div className="doc-new-item">
                <WorkItemStatusIcon status={item.status} />
                <WorkItemKey value={item.key} />
                <span className="doc-fill ellipsis">{item.title}</span>
                <button type="button" className="btn doc-quiet btn-small" onClick={() => setItem(null)}>
                  {t('new.changeItem')}
                </button>
              </div>
            ) : (
              <>
                <label className="relation-search">
                  <Search {...ICON_SM} />
                  <input data-autofocus type="search" value={q} placeholder={t('new.searchItem')} aria-label={t('new.searchItem')} onChange={(e) => setQ(e.target.value)} />
                </label>
                {items.length === 0 ? (
                  <p className="muted small">{found.isLoading ? t('new.searching') : t('new.noItem')}</p>
                ) : (
                  <ul className="relation-results" aria-label={t('new.items')}>
                    {items.map((candidate) => (
                      <li key={candidate.id}>
                        <button type="button" className="relation-row relation-pick" onClick={() => setItem(candidate)}>
                          <WorkItemStatusIcon status={candidate.status} />
                          <WorkItemKey value={candidate.key} />
                          <span className="relation-title">{candidate.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
        {from === 'item' && (
          <label className="field">
            <span className="field-label">{t('new.kind')}</span>
            <Select<DocumentKind>
              aria-label={t('new.kind')}
              value={kind}
              onChange={setKind}
              options={DOCUMENT_KINDS.map((value) => ({ value, label: t(`kinds.${value}.name`) }))}
            />
          </label>
        )}
        <label className="field">
          <span className="field-label">{t('new.heading')}</span>
          <input
            data-autofocus={from === 'blank' ? true : undefined}
            value={title}
            placeholder={item?.title ?? t('new.headingPlaceholder')}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">{t('new.path')}</span>
          <input
            className={`mono ${finalPath === null ? 'is-invalid' : ''}`.trim()}
            value={typed}
            onChange={(e) => {
              setPathTouched(true);
              setPath(e.target.value);
            }}
          />
          <span className={`field-hint ${finalPath === null ? 'text-err' : ''}`.trim()}>{finalPath === null ? t('new.badPath') : t('new.pathHint', { root })}</span>
        </label>
      </form>
    </Dialog>
  );
}
