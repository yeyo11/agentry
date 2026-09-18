import type { ConfigFileVariant } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, keys, type Scope } from '../../api';
import { CodeEditor } from '../../components/CodeEditor';
import { useToast } from '../../components/Toast';
import { Card, ErrorBox, PathLabel, Segmented, Skeleton, Tag } from '../../components/ui';
import { useDirty, useLeaveGuard } from '../../lib/dirty';

const VARIANTS = [
  { value: 'shared', label: 'CLAUDE.md', title: 'Shared with the team (meant to be committed)' },
  { value: 'local', label: 'CLAUDE.local.md', title: 'Personal notes for this project (not committed)' },
] as const;

function InstructionsEditor({ scope, variant }: { scope: Scope; variant: ConfigFileVariant }) {
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
      toast.success('Instructions saved', doc.path);
    },
    onError: (err) => toast.error('Could not save the instructions', err),
  });

  if (isLoading) return <Skeleton rows={8} />;
  return (
    <div className="form">
      <ErrorBox error={error} />
      {data && (
        <div className="editor-meta">
          <PathLabel path={data.path} />
          {!data.exists && <Tag tone="info">does not exist yet · saved on first write</Tag>}
          {dirty && <Tag tone="warn">unsaved changes</Tag>}
        </div>
      )}
      <CodeEditor
        language="markdown"
        ariaLabel="Instructions"
        minHeight="360px"
        placeholder={
          scope.projectId
            ? '# Project instructions\n\nConventions, commands and context Claude should know in this project.'
            : '# Instructions applied to every session of this account'
        }
        value={content ?? ''}
        onChange={setContent}
        onSave={() => dirty && !save.isPending && save.mutate()}
      />
      <div className="form-actions">
        <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button className="btn" disabled={!dirty} onClick={() => setContent(data?.content ?? '')}>
          Discard
        </button>
        <span className="small muted push-right">Ctrl/⌘+S saves</span>
      </div>
    </div>
  );
}

export function InstructionsTab({ scope, scopeKey }: { scope: Scope; scopeKey: string }) {
  const [variant, setVariant] = useState<ConfigFileVariant>('shared');
  const guard = useLeaveGuard();
  const effective: ConfigFileVariant = scope.projectId ? variant : 'shared';

  return (
    <Card
      title={scope.projectId ? 'Project instructions' : 'User instructions (CLAUDE.md)'}
      actions={
        scope.projectId && (
          <Segmented
            label="Instructions file"
            value={effective}
            options={VARIANTS}
            onChange={(next) => void guard().then((ok) => ok && setVariant(next))}
          />
        )
      }
    >
      <InstructionsEditor key={`${scopeKey}:${effective}`} scope={scope} variant={effective} />
    </Card>
  );
}
