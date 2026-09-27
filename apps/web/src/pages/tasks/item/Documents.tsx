import type { DocumentKind, WorkItemDetail, WorkItemLink } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useDocuments } from '../../../api';
import { Select } from '../../../components/controls';
import { Dialog } from '../../../components/Dialog';
import { ICON_SM } from '../../../components/icons';
import { useToast } from '../../../components/Toast';
import { useProjectScope } from '../../../lib/project-scope';
import { DOCUMENT_KINDS, baseName, documentLinks, filesOf } from '../../documents/model';
import { RoleAvatar, useRoleName } from '../../documents/RoleTag';
import { DocumentKindTag } from '../../documents/Tied';

/** A document of the item on the Documents tab of its project, opened. */
export function documentHref(projectId: string, path: string): string {
  const query = new URLSearchParams({ project: projectId, view: 'documents', doc: path });
  return `/?${query.toString()}`;
}

function DocumentRow({ link, projectId }: { link: WorkItemLink; projectId: string }) {
  const { t } = useTranslation('documents');
  const roleName = useRoleName();
  const path = link.documentPath ?? '';
  const who = link.teamRole ? roleName(link.teamRole) : t('tied.byHand');
  return (
    <li>
      <Link to={documentHref(projectId, path)} className="doc-row workitem-doc">
        <DocumentKindTag kind={link.documentKind ?? 'doc'} />
        <span className="doc-row-main">
          <span className="doc-row-title">{link.name ?? baseName(path)}</span>
          <span className="doc-row-meta">
            <span className="mono ellipsis">{path}</span>
            <span>{who}</span>
          </span>
        </span>
        {link.teamRole && <RoleAvatar role={link.teamRole} size="sm" />}
      </Link>
    </li>
  );
}

/** Ties a file of the project's documents folder to the item by hand (role `reference`), with its kind. */
function TieDialog({ item, tied, onClose }: { item: WorkItemDetail; tied: ReadonlySet<string>; onClose: () => void }) {
  const { t } = useTranslation(['documents', 'common']);
  const qc = useQueryClient();
  const toast = useToast();
  const docs = useDocuments(item.projectId);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<DocumentKind>('doc');
  const files = useMemo(() => filesOf(docs.data?.tree ?? []).filter((file) => !tied.has(file.path)), [docs.data, tied]);
  const needle = q.trim().toLowerCase();
  const shown = files.filter((file) => !needle || `${file.path} ${file.title ?? ''}`.toLowerCase().includes(needle)).slice(0, 12);
  const tie = useMutation({
    mutationFn: (path: string) => api.tieDocument(item.id, { path, kind }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.workItem(item.id) });
      void qc.invalidateQueries({ queryKey: keys.documentsOf(item.projectId) });
      onClose();
    },
    onError: (error) => toast.error(t('item.tieFailed'), error),
  });
  return (
    <Dialog title={t('item.tieTitle', { key: item.key })} onClose={onClose} width={560}>
      <div className="relation-dialog">
        <label className="field">
          <span className="field-label">{t('new.kind')}</span>
          <Select<DocumentKind> aria-label={t('new.kind')} value={kind} onChange={setKind} options={DOCUMENT_KINDS.map((value) => ({ value, label: t(`kinds.${value}.name`) }))} />
        </label>
        <label className="relation-search">
          <Search {...ICON_SM} />
          <input data-autofocus type="search" value={q} placeholder={t('item.search')} aria-label={t('item.search')} onChange={(e) => setQ(e.target.value)} />
        </label>
        {shown.length === 0 ? (
          <p className="muted small">{docs.isLoading ? t('new.searching') : files.length === 0 ? t('item.noFiles') : t('tree.noMatch')}</p>
        ) : (
          <ul className="relation-results" aria-label={t('item.files')}>
            {shown.map((file) => (
              <li key={file.path}>
                <button type="button" className="relation-row relation-pick" disabled={tie.isPending} onClick={() => tie.mutate(file.path)}>
                  <span className="relation-title">{file.title ?? file.name}</span>
                  <span className="mono small muted ellipsis">{file.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The documents tied to the item (decision 34): the specification the Product Owner wrote while
 * refining, an architecture decision, QA's report, or one a person tied by hand. Shown while the
 * project's Documents module is on, or when the item already has some.
 */
export function ItemDocuments({ item }: { item: WorkItemDetail }) {
  const { t } = useTranslation('documents');
  const { projects } = useProjectScope();
  const [tying, setTying] = useState(false);
  const links = documentLinks(item.links);
  const moduleOn = projects.find((p) => p.id === item.projectId)?.modules.includes('documents') ?? false;
  if (!moduleOn && links.length === 0) return null;
  return (
    <section className="workitem-section workitem-docs" aria-labelledby={`docs-${item.id}`}>
      <div className="workitem-section-head">
        <h2 id={`docs-${item.id}`} className="section-label grow">
          {t('item.title')}
        </h2>
        <span className="count">{links.length}</span>
        {moduleOn && (
          <button type="button" className="link-btn small" onClick={() => setTying(true)}>
            <Link2 {...ICON_SM} />
            {t('item.tie')}
          </button>
        )}
      </div>
      {links.length === 0 ? (
        <p className="muted small workitem-none">{t('item.none')}</p>
      ) : (
        <ul className="doc-rows card">
          {links.map((link) => (
            <DocumentRow key={link.id} link={link} projectId={item.projectId} />
          ))}
        </ul>
      )}
      {tying && <TieDialog item={item} tied={new Set(links.map((link) => link.documentPath ?? ''))} onClose={() => setTying(false)} />}
    </section>
  );
}
