import type { WorkItemDetail } from '@agentry/shared';
import { Pencil } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CodeEditor } from '../../../components/CodeEditor';
import { ICON_SM } from '@agentry/ui/components/icons';
import { useDirty } from '../../../lib/dirty';
import type { ItemActions } from './hooks';

const Markdown = lazy(() => import('@agentry/ui/components/Markdown'));

/** The title as the page's heading, renamed in place: Enter saves, Escape leaves it as it was. */
export function Title({ item, actions }: { item: WorkItemDetail; actions: ItemActions }) {
  const { t } = useTranslation('workItem');
  const [draft, setDraft] = useState<string | null>(null);
  useDirty(`workitem:${item.id}:title`, draft !== null && draft.trim() !== '' && draft.trim() !== item.title);
  const save = () => {
    const title = draft?.trim();
    setDraft(null);
    if (title && title !== item.title) actions.update.mutate({ title });
  };
  if (draft !== null) {
    return (
      <input
        className="workitem-title-input"
        autoFocus
        value={draft}
        aria-label={t('fields.title')}
        maxLength={300}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
    );
  }
  return (
    <div className="workitem-title">
      <h1>{item.title}</h1>
      <button type="button" className="icon-btn workitem-edit" aria-label={t('actions.editTitle')} title={t('actions.editTitle')} onClick={() => setDraft(item.title)}>
        <Pencil {...ICON_SM} />
      </button>
    </div>
  );
}

/**
 * The description, Markdown, read as the chat renders a message and edited in the app's code editor
 * in its Markdown mode, the one editor every file and resource is edited in.
 */
export function Description({ item, actions }: { item: WorkItemDetail; actions: ItemActions }) {
  const { t } = useTranslation('workItem');
  const [draft, setDraft] = useState<string | null>(null);
  // Leaving the page, closing the panel or switching project asks before this text is lost
  useDirty(`workitem:${item.id}:description`, draft !== null && draft !== item.description);
  const save = () => {
    if (draft === null) return;
    if (draft === item.description) return setDraft(null);
    actions.update.mutate({ description: draft }, { onSuccess: () => setDraft(null) });
  };
  if (draft !== null) {
    return (
      <div className="workitem-description is-editing">
        <CodeEditor
          value={draft}
          onChange={setDraft}
          language="markdown"
          minHeight="140px"
          maxHeight="420px"
          ariaLabel={t('fields.description')}
          placeholder={t('description.placeholder')}
          onSave={save}
        />
        <div className="workitem-edit-actions">
          <span className="mono small muted">{t('description.markdown')}</span>
          <span className="grow" />
          <button type="button" className="btn btn-small" onClick={() => setDraft(null)}>
            {t('actions.cancel')}
          </button>
          <button type="button" className="btn btn-small" onClick={save} disabled={actions.update.isPending}>
            {t('actions.save')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="workitem-description">
      {item.description.trim() ? (
        <div className="workitem-description-text">
          <Suspense fallback={<p>{item.description}</p>}>
            <Markdown text={item.description} />
          </Suspense>
        </div>
      ) : (
        <p className="muted workitem-none">{t('description.empty')}</p>
      )}
      <button
        type="button"
        className="icon-btn workitem-edit"
        aria-label={t('actions.editDescription')}
        title={t('actions.editDescription')}
        onClick={() => setDraft(item.description)}
      >
        <Pencil {...ICON_SM} />
      </button>
    </div>
  );
}
