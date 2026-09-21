import type { EditorSettings } from '@agentry/shared';
import { Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Card, ErrorBox, Field, Skeleton } from '../../components/ui';
import { DEFAULT_EDITOR, diffCommand, editorLink, mapPath, sanitizeEditor, templateProblem } from '../../lib/editor';
import { saveEditorSettings, useEditorState } from '../../lib/editor-sync';

/** A path that looks like the ones a worker's files have, so the preview shows what a link will be. */
const SAMPLE = { path: '/workspace/app/src/index.ts', line: 42, other: '/workspace/app-review/src/index.ts' };

/**
 * How the panel builds links into the person's editor. Kept on the server, so every browser builds
 * the same links, and applied wherever a changed file or a worktree is shown.
 */
export function EditorTab() {
  const { t } = useTranslation('observe');
  const { settings, ready } = useEditorState();
  // The form starts from what the server has, not from what this browser had before it answered
  if (!ready) {
    return (
      <Card title={t('editor.title')}>
        <Skeleton rows={5} />
      </Card>
    );
  }
  return <EditorForm saved={settings} />;
}

function EditorForm({ saved }: { saved: EditorSettings }) {
  const { t } = useTranslation(['observe', 'common']);
  const toast = useToast();
  const [template, setTemplate] = useState(saved.template);
  const [diff, setDiff] = useState(saved.diffCommand ?? '');
  const [rows, setRows] = useState<Array<{ from: string; to: string }>>(saved.pathMap ?? []);

  const draft: EditorSettings = sanitizeEditor({ template, diffCommand: diff, pathMap: rows });
  const problem = templateProblem(template);
  const link = problem ? null : editorLink(draft, SAMPLE.path, SAMPLE.line);
  const command = diffCommand(draft, SAMPLE.other, SAMPLE.path);

  const update = (index: number, patch: Partial<{ from: string; to: string }>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const save = useMutation({
    mutationFn: (next: EditorSettings) => saveEditorSettings(next),
    onSuccess: (kept, next) => {
      setTemplate(kept.template);
      setDiff(kept.diffCommand ?? '');
      setRows(kept.pathMap ?? []);
      toast.success(t(next === DEFAULT_EDITOR ? 'observe:editor.resetDone' : 'observe:editor.saved'));
    },
  });

  return (
    <Card title={t('observe:editor.title')}>
      <div className="stack">
        <p className="small muted">{t('observe:editor.intro')}</p>

        <Field label={t('observe:editor.template')} hint={t('observe:editor.templateHint')}>
          <input className="mono" value={template} onChange={(e) => setTemplate(e.target.value)} spellCheck={false} aria-invalid={problem !== null} />
        </Field>
        {problem && (
          <p className="alert alert-warn small" role="status">
            {t(`observe:editor.problem.${problem}`)}
          </p>
        )}

        <Field label={t('observe:editor.diffCommand')} hint={t('observe:editor.diffCommandHint')}>
          <input className="mono" value={diff} onChange={(e) => setDiff(e.target.value)} placeholder="code --diff {left} {right}" spellCheck={false} />
        </Field>

        <fieldset className="stack-tight obs-map">
          <legend className="field-label">{t('observe:editor.pathMap')}</legend>
          <p className="small muted">{t('observe:editor.pathMapHint')}</p>
          {rows.map((row, i) => (
            <div key={i} className="obs-map-row">
              <input
                className="mono"
                value={row.from}
                onChange={(e) => update(i, { from: e.target.value })}
                placeholder={t('observe:editor.from')}
                aria-label={t('observe:editor.fromRow', { n: i + 1 })}
                spellCheck={false}
              />
              <span aria-hidden>→</span>
              <input
                className="mono"
                value={row.to}
                onChange={(e) => update(i, { to: e.target.value })}
                placeholder={t('observe:editor.to')}
                aria-label={t('observe:editor.toRow', { n: i + 1 })}
                spellCheck={false}
              />
              <button type="button" className="icon-btn" aria-label={t('observe:editor.removeRow', { n: i + 1 })} onClick={() => setRows((current) => current.filter((_, j) => j !== i))}>
                <Trash2 {...ICON_SM} />
              </button>
            </div>
          ))}
          <div>
            <button type="button" className="btn btn-small" onClick={() => setRows((current) => [...current, { from: '', to: '' }])}>
              <Plus {...ICON_SM} /> {t('observe:editor.addRow')}
            </button>
          </div>
        </fieldset>

        <div className="stack-tight obs-preview">
          <h3 className="obs-head">{t('observe:editor.preview')}</h3>
          <dl className="kv">
            <dt>{t('observe:editor.previewPath')}</dt>
            <dd className="mono break">{SAMPLE.path}</dd>
            <dt>{t('observe:editor.previewHost')}</dt>
            <dd className="mono break">{mapPath(SAMPLE.path, draft.pathMap)}</dd>
            <dt>{t('observe:editor.previewLink')}</dt>
            <dd className="mono break" data-testid="editor-preview">
              {link ?? '—'}
            </dd>
            {command && (
              <>
                <dt>{t('observe:editor.previewDiff')}</dt>
                <dd className="mono break">{command}</dd>
              </>
            )}
          </dl>
        </div>

        <ErrorBox error={save.error} />
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={() => save.mutate(draft)} disabled={problem !== null || save.isPending}>
            <Save {...ICON_SM} /> {save.isPending ? t('observe:editor.saving') : t('observe:editor.save')}
          </button>
          <button type="button" className="btn" onClick={() => save.mutate(DEFAULT_EDITOR)} disabled={save.isPending}>
            <RotateCcw {...ICON_SM} /> {t('observe:editor.reset')}
          </button>
        </div>
      </div>
    </Card>
  );
}
