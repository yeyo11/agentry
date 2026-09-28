import type { DocumentFile, DocumentTie, Project } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, FileText, Pencil, Trash2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiRequestError, api, keys, useDocumentFile } from '../../api';
import { CodeEditor } from '../../components/CodeEditor';
import { MoreActions } from '../../components/controls';
import type { MenuEntry } from '../../components/controls/Menu';
import { useConfirm } from '../../components/Dialog';
import { ICON_SM } from '../../components/icons';
import { PhoneHeader } from '../../components/shell/PhoneHeader';
import { useToast } from '../../components/Toast';
import { Empty, ErrorBox, Segmented, Skeleton, Tag } from '../../components/ui';
import { useDirty } from '../../lib/dirty';
import { timeAgo } from '../../lib/format';
import { queryView } from '../../lib/query-view';
import { shortcut } from '../../lib/shortcut';
import { taskPath } from '../../lib/work-items';
import { mainTie } from './model';
import { RoleAvatar, useRoleName } from '../team/RoleAvatar';

const Markdown = lazy(() => import('../../components/Markdown'));

export type PaneMode = 'view' | 'edit';

const shortId = (id: string | null) => (id ? id.slice(0, 6) : '');

/**
 * Where a generated document came from: the role that wrote it, the item, the chat and when. A
 * document a person tied by hand says only which item it belongs to.
 */
export function DocumentOrigin({ tie }: { tie: DocumentTie }) {
  const { t } = useTranslation('documents');
  const roleName = useRoleName();
  return (
    <div className="doc-origin">
      {tie.teamRole ? (
        <>
          <RoleAvatar role={tie.teamRole} size="sm" />
          <span>
            {t('origin.wroteBy')} <b>{roleName(tie.teamRole)}</b> {t('origin.from')}
          </span>
        </>
      ) : (
        <span>{t('origin.tiedTo')}</span>
      )}
      <Link to={taskPath(tie.item.key)} className="workitem-key boxed workitem-key-link" title={tie.item.title}>
        {tie.item.key}
      </Link>
      <span className="doc-fill" />
      <span className="mono small muted">
        {tie.chatId ? (
          <>
            <Link to={`/chats/${tie.chatId}`} className="doc-origin-chat">
              {t('origin.chat', { id: shortId(tie.chatId) })}
            </Link>
            {' · '}
          </>
        ) : null}
        {timeAgo(tie.createdAt)}
      </span>
    </div>
  );
}

/** The rendered document, at reading width. */
export function DocumentView({ content }: { content: string }) {
  return (
    <article className="doc-view rich md">
      <Suspense fallback={<div className="doc-plain">{content}</div>}>
        <Markdown text={content} />
      </Suspense>
    </article>
  );
}

interface Draft {
  path: string;
  content: string;
  /** What the file held when the editor opened it, to know what is unsaved */
  saved: string;
  /** Its `updatedAt` then: a write is refused if an agent changed the file since */
  base: string | null;
}

/**
 * A file of the documents folder: rendered, or in the one editor with its path bar. The edit keeps
 * its draft across a refetch, so an agent writing the same file never replaces what the person
 * types; saving then is refused (409) and the person reloads it on purpose.
 */
export function DocumentPane({
  project,
  path,
  mode,
  onMode,
  onClosed,
  onCancel,
  phone = false,
  phoneHead,
}: {
  project: Project;
  path: string;
  mode: PaneMode;
  onMode: (mode: PaneMode) => void;
  /** The file was deleted */
  onClosed: () => void;
  /** A phone's "Cancel": back to the document, leaving the edit */
  onCancel?: () => void;
  phone?: boolean;
  /**
   * A phone reading the document: the screen's own header (MobileDocumento), whose "⋯" holds what
   * the desktop's pane bar menu does. Where the list is when there is no screen to go back to.
   */
  phoneHead?: { title: ReactNode; backLabel: string; fallback: string };
}) {
  const { t } = useTranslation(['documents', 'common']);
  const file = useDocumentFile(project.id, path);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState(false);
  const data = file.data;

  // The editor starts from what is on disk each time it opens
  useEffect(() => {
    if (mode === 'edit' && data && (draft === null || draft.path !== data.path)) {
      setDraft({ path: data.path, content: data.content, saved: data.content, base: data.updatedAt });
      setConflict(false);
    }
    if (mode === 'view' && draft !== null) setDraft(null);
  }, [mode, data, draft]);

  const dirty = mode === 'edit' && draft !== null && draft.content !== draft.saved;
  useDirty(`document:${path}`, dirty);

  const save = useMutation({
    mutationFn: (d: Draft) => api.writeDocument(project.id, d.path, { content: d.content, baseUpdatedAt: d.base }),
    onSuccess: (saved: DocumentFile) => {
      qc.setQueryData(keys.documentFile(project.id, saved.path), saved);
      void qc.invalidateQueries({ queryKey: keys.documentTree(project.id) });
      setDraft({ path: saved.path, content: saved.content, saved: saved.content, base: saved.updatedAt });
      setConflict(false);
      toast.success(t('pane.saved', { path: saved.path }));
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 409) setConflict(true);
      else toast.error(t('pane.saveFailed'), error);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteDocument(project.id, path),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.documentsOf(project.id) });
      toast.success(t('pane.deleted', { path }));
      onClosed();
    },
    onError: (error) => toast.error(t('pane.deleteFailed'), error),
  });

  const reload = () => {
    void file.refetch().then((next) => {
      if (next.data) setDraft({ path: next.data.path, content: next.data.content, saved: next.data.content, base: next.data.updatedAt });
      setConflict(false);
    });
  };

  const entries: MenuEntry[] = [
    { id: 'copy', label: t('pane.copyPath'), icon: Copy, onSelect: () => void navigator.clipboard?.writeText(path) },
    {
      id: 'delete',
      label: t('pane.delete'),
      icon: Trash2,
      destructive: true,
      onSelect: () =>
        void confirm({
          title: t('pane.deleteTitle', { path }),
          body: (file.data?.ties.length ?? 0) > 0 ? t('pane.deleteTiedBody', { count: file.data?.ties.length ?? 0 }) : t('pane.deleteBody'),
          confirmLabel: t('pane.delete'),
          danger: true,
        }).then((ok) => ok && remove.mutate()),
    },
  ];
  const head =
    phone && mode === 'view' && phoneHead ? (
      <PhoneHeader className="doc-phone-head" title={phoneHead.title} subtitle={path} back={{ label: phoneHead.backLabel, fallback: phoneHead.fallback }} more={file.data ? entries : []} moreTitle={path} />
    ) : null;

  const view = queryView(file);
  if (view === 'loading') {
    return (
      <>
        {head}
        <div className="doc-pane-body">
          <Skeleton rows={6} height={16} />
        </div>
      </>
    );
  }
  // A refetch that fails keeps the file drawn, and an edit in progress keeps its text
  if (view !== 'shown' || !data) {
    return (
      <>
        {head}
        <div className="doc-pane-body">
          <ErrorBox error={file.error} title={t('pane.readFailed')} />
          {!file.error && <Empty icon={FileText} title={t('pane.gone')} />}
        </div>
      </>
    );
  }

  const tie = mainTie(data.ties);
  const trySave = () => draft && dirty && !save.isPending && save.mutate(draft);
  const discard = () => draft && setDraft({ ...draft, content: draft.saved });

  const menu = <MoreActions label={t('pane.more')} entries={entries} />;

  const conflictBox = conflict && (
    <div className="alert alert-warn" role="alert">
      <div className="alert-body">
        <strong>{t('pane.conflict')}</strong>
        <div>{t('pane.conflictHint')}</div>
      </div>
      <button type="button" className="btn btn-small" onClick={reload}>
        {t('pane.reload')}
      </button>
    </div>
  );

  const editor = draft && (
    <CodeEditor
      key={`${project.id}:${data.path}`}
      language="markdown"
      ariaLabel={t('pane.contents', { path: data.path })}
      minHeight={phone ? '420px' : '460px'}
      value={draft.content}
      onChange={(content) => setDraft((d) => (d ? { ...d, content } : d))}
      onSave={trySave}
    />
  );

  const saveButton = (
    <button type="button" className="btn btn-primary doc-save" disabled={!dirty || save.isPending} onClick={trySave}>
      <Check {...ICON_SM} />
      {save.isPending ? t('pane.saving') : t('pane.save')}
    </button>
  );
  const discardButton = (
    <button type="button" className={phone ? 'btn' : 'btn doc-quiet'} disabled={!dirty} onClick={discard}>
      {t('pane.discard')}
    </button>
  );

  if (phone) {
    if (mode === 'edit') {
      return (
        <div className="doc-phone-edit">
          {/* The editor fills the screen, so the file it holds names the page */}
          <h1 className="sr-only">{data.path}</h1>
          <div className="doc-phone-edit-head">
            <button type="button" className="link-btn doc-phone-cancel" onClick={onCancel}>
              {t('documents:phone.cancel')}
            </button>
            <span className="doc-phone-edit-where">
              <span className="mono small muted ellipsis" title={data.path}>
                {data.path}
              </span>
              {dirty && <Tag tone="warn">{t('pane.unsaved')}</Tag>}
            </span>
          </div>
          <PhoneEditTabs draft={draft} editor={editor} />
          {conflictBox}
          <div className="doc-phone-foot">
            {discardButton}
            {saveButton}
          </div>
        </div>
      );
    }
    return (
      <div className="doc-phone-view">
        {head}
        {tie && <DocumentOrigin tie={tie} />}
        <DocumentView content={data.content} />
        <div className="doc-phone-foot">
          <button type="button" className="btn btn-block" onClick={() => onMode('edit')}>
            <Pencil {...ICON_SM} />
            {t('pane.edit')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="doc-pane-bar">
        <FileText {...ICON_SM} className="muted" />
        <span className="doc-pane-path mono ellipsis" title={data.path}>
          {data.path}
        </span>
        {mode === 'view' && data.updatedAt && <span className="small muted doc-pane-when">{t('pane.edited', { when: timeAgo(data.updatedAt) })}</span>}
        <Segmented<PaneMode>
          label={t('pane.mode')}
          value={mode}
          onChange={onMode}
          options={[
            { value: 'view', label: t('pane.view') },
            { value: 'edit', label: t('pane.edit') },
          ]}
        />
        {menu}
      </div>
      <div className={`doc-pane-body ${mode === 'edit' ? 'is-edit' : ''}`.trim()}>
        {tie && <DocumentOrigin tie={tie} />}
        {conflictBox}
        {mode === 'view' ? <DocumentView content={data.content} /> : editor}
      </div>
      {mode === 'edit' && (
        <div className="doc-pane-foot">
          <span className="small muted">{t('pane.markdown')}</span>
          <kbd className="kbd">{shortcut('S')}</kbd>
          <span className="doc-fill" />
          {dirty && <Tag tone="warn">{t('pane.unsaved')}</Tag>}
          {discardButton}
          {saveButton}
        </div>
      )}
    </>
  );
}

/** On a phone, the editor and a preview of the draft take turns in the one screen. */
function PhoneEditTabs({ draft, editor }: { draft: Draft | null; editor: ReactNode }) {
  const { t } = useTranslation('documents');
  const [tab, setTab] = useState<'preview' | 'markdown'>('markdown');
  return (
    <>
      <Segmented<'preview' | 'markdown'>
        label={t('pane.mode')}
        value={tab}
        onChange={setTab}
        options={[
          { value: 'preview', label: t('pane.preview') },
          { value: 'markdown', label: t('pane.markdown') },
        ]}
      />
      {tab === 'markdown' ? editor : draft && <DocumentView content={draft.content} />}
    </>
  );
}
