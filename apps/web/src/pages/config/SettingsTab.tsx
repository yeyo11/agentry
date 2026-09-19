import type { ConfigFileVariant } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, type Scope } from '../../api';
import { CodeEditor } from '../../components/CodeEditor';
import { useToast } from '../../components/Toast';
import { Card, ErrorBox, PathLabel, Segmented, Skeleton, Tag } from '../../components/ui';
import { useDirty, useLeaveGuard } from '../../lib/dirty';
import { SettingsGuided } from './SettingsGuided';
import { changedKeys, parseObject, setIn } from './settingsModel';

const VARIANTS = [
  { value: 'shared', label: 'settings.json' },
  { value: 'local', label: 'settings.local.json' },
] as const;

const MODES = ['guided', 'raw'] as const;

const format = (value: unknown) => JSON.stringify(value, null, 2);

function SettingsEditor({ scope, variant, filesHref }: { scope: Scope; variant: ConfigFileVariant; filesHref: string }) {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const toast = useToast();
  const queryKey = keys.settings(scope, variant);
  const { data, error, isLoading } = useQuery({ queryKey, queryFn: () => api.getSettings(scope, variant) });

  // The JSON text is the single source of truth: the guided editor parses it and writes it
  // back, so switching modes never loses edits and unknown keys always survive.
  const [text, setText] = useState<string | null>(null);
  const [mode, setMode] = useState<'guided' | 'raw'>('guided');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (data && text === null) setText(format(data.settings));
  }, [data, text]);

  const parsed = useMemo(() => parseObject(text ?? '{}'), [text]);
  const savedText = data ? format(data.settings) : null;
  const dirty = text !== null && savedText !== null && (parsed.value ? format(parsed.value) !== savedText : true);
  const changes = data && parsed.value ? changedKeys(data.settings, parsed.value) : [];
  useDirty('settings', dirty);

  const save = useMutation({
    mutationFn: () => {
      if (!parsed.value) throw new Error(parsed.error ?? t('settings.invalidJson'));
      return api.putSettings(scope, variant, parsed.value);
    },
    onSuccess: (doc) => {
      queryClient.setQueryData(queryKey, doc);
      setText(format(doc.settings));
      setRevision((r) => r + 1);
      toast.success(t('settings.saved'), doc.path);
    },
    onError: (err) => toast.error(t('settings.saveFailed'), err),
  });
  const trySave = () => dirty && parsed.value && !save.isPending && save.mutate();

  if (isLoading) return <Skeleton rows={8} />;
  return (
    <div className="form">
      <ErrorBox error={error} />
      <div className="editor-meta">
        {data && <PathLabel path={data.path} />}
        {data && !data.exists && <Tag tone="info">{t('shared.notYet')}</Tag>}
        <span className="push-right">
          <Segmented
            label={t('settings.editorMode')}
            value={mode}
            options={MODES.map((value) => ({ value, label: t(`settings.modes.${value}`) }))}
            onChange={(next) => {
              if (next === 'guided' && !parsed.value) {
                toast.error(t('settings.fixFirst'), new Error(parsed.error ?? t('settings.invalidJson')));
                return;
              }
              setMode(next);
            }}
          />
        </span>
      </div>

      {mode === 'guided' && parsed.value ? (
        <SettingsGuided
          key={revision}
          settings={parsed.value}
          filesHref={filesHref}
          set={(path, value) => setText((current) => format(setIn(parseObject(current ?? '{}').value ?? {}, path, value)))}
        />
      ) : (
        <>
          <CodeEditor
            language="json"
            ariaLabel={t('settings.editor')}
            minHeight="420px"
            invalid={Boolean(parsed.error)}
            value={text ?? ''}
            onChange={setText}
            onSave={trySave}
          />
          {parsed.error && (
            <div className="alert alert-warn" role="alert">
              {t('settings.invalidJsonDetail', { error: parsed.error })}
            </div>
          )}
        </>
      )}

      <div className="save-bar">
        <div className="form-actions">
          <button className="btn btn-primary" disabled={!dirty || !parsed.value || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('shared.saving') : t('settings.save')}
          </button>
          <button
            className="btn"
            disabled={!dirty}
            onClick={() => {
              setText(savedText);
              setRevision((r) => r + 1);
            }}
          >
            {t('shared.discard')}
          </button>
        </div>
        <div className="change-list" aria-live="polite">
          {!dirty ? (
            <span className="small muted">{t('settings.noChanges')}</span>
          ) : changes.length === 0 ? (
            <span className="small muted">{parsed.value ? t('settings.formattingOnly') : t('settings.cannotSave')}</span>
          ) : (
            changes.map(({ key, change }) => (
              <span key={key} className={`change change-${change}`} title={t(`settings.change.${change}`)}>
                {change === 'added' ? '+' : change === 'removed' ? '−' : '~'} {key}
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function SettingsTab({ scope, scopeKey, filesHref }: { scope: Scope; scopeKey: string; filesHref: string }) {
  const { t } = useTranslation('config');
  const [variant, setVariant] = useState<ConfigFileVariant>('shared');
  const guard = useLeaveGuard();
  const effective: ConfigFileVariant = scope.projectId ? variant : 'shared';

  return (
    <Card
      title={scope.projectId ? t('settings.projectTitle') : t('settings.userTitle')}
      actions={
        scope.projectId && (
          <Segmented
            label={t('settings.file')}
            value={effective}
            options={VARIANTS.map((v) => ({ ...v, title: t(`settings.variants.${v.value}`) }))}
            onChange={(next) => void guard().then((ok) => ok && setVariant(next))}
          />
        )
      }
    >
      <SettingsEditor key={`${scopeKey}:${effective}`} scope={scope} variant={effective} filesHref={filesHref} />
    </Card>
  );
}
