import type { ConfigFileVariant } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, type Scope } from '../../api';
import { CodeEditor } from '../../components/CodeEditor';
import { useToast } from '../../components/Toast';
import { Card, ErrorBox, PathLabel, Segmented, Skeleton, Tag } from '../../components/ui';
import { useDirty, useLeaveGuard } from '../../lib/dirty';

const VARIANTS = [
  { value: 'shared', label: 'CLAUDE.md' },
  { value: 'local', label: 'CLAUDE.local.md' },
] as const;

function InstructionsEditor({ scope, variant }: { scope: Scope; variant: ConfigFileVariant }) {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const toast = useToast();
  const queryKey = keys.instructions(scope, variant);
  const { data, error, isLoading } = useQuery({ queryKey, queryFn: () => api.getInstructions(scope, variant) });
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    if (data && content === null) setContent(data.content);
  }, [data, content]);

  const dirty = data != null && content !== null && content !== data.content;
  useDirty('instructions', dirty);

  const save = useMutation({
    mutationFn: () => api.putInstructions(scope, variant, content ?? ''),
    onSuccess: (doc) => {
      queryClient.setQueryData(queryKey, doc);
      setContent(doc.content);
      toast.success(t('instructions.saved'), doc.path);
    },
    onError: (err) => toast.error(t('instructions.saveFailed'), err),
  });

  if (isLoading) return <Skeleton rows={8} />;
  return (
    <div className="form">
      <ErrorBox error={error} />
      {data && (
        <div className="editor-meta">
          <PathLabel path={data.path} />
          {!data.exists && <Tag tone="info">{t('shared.notYet')}</Tag>}
          {dirty && <Tag tone="warn">{t('shared.unsaved')}</Tag>}
        </div>
      )}
      <CodeEditor
        language="markdown"
        ariaLabel={t('instructions.editor')}
        minHeight="360px"
        placeholder={
          scope.projectId ? t('instructions.projectPlaceholder') : t('instructions.userPlaceholder')
        }
        value={content ?? ''}
        onChange={setContent}
        onSave={() => dirty && !save.isPending && save.mutate()}
      />
      <div className="form-actions">
        <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? t('shared.saving') : t('shared.save')}
        </button>
        <button className="btn" disabled={!dirty} onClick={() => setContent(data?.content ?? '')}>
          {t('shared.discard')}
        </button>
        <span className="small muted push-right">{t('shared.ctrlS')}</span>
      </div>
    </div>
  );
}

export function InstructionsTab({ scope, scopeKey }: { scope: Scope; scopeKey: string }) {
  const { t } = useTranslation('config');
  const [variant, setVariant] = useState<ConfigFileVariant>('shared');
  const guard = useLeaveGuard();
  const effective: ConfigFileVariant = scope.projectId ? variant : 'shared';

  return (
    <Card
      title={scope.projectId ? t('instructions.projectTitle') : t('instructions.userTitle')}
      actions={
        scope.projectId && (
          <Segmented
            label={t('instructions.file')}
            value={effective}
            options={VARIANTS.map((v) => ({ ...v, title: t(`instructions.variants.${v.value}`) }))}
            onChange={(next) => void guard().then((ok) => ok && setVariant(next))}
          />
        )
      }
    >
      <InstructionsEditor key={`${scopeKey}:${effective}`} scope={scope} variant={effective} />
    </Card>
  );
}
