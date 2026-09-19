import { Plus } from 'lucide-react';
import type { ResourceKind } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, type Scope } from '../../api';
import { CodeEditor } from '../../components/CodeEditor';
import { useConfirm } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { Card, Empty, ErrorBox, PathLabel, Skeleton, Tag } from '../../components/ui';
import { useDirty, useLeaveGuard } from '../../lib/dirty';
import { timeAgo } from '../../lib/format';

// The starting file content is not translated: it is what the CLI reads, and the frontmatter keys are
// the CLI's own. Every visible string about a kind lives in the `config` locale under resources.kinds.
const TEMPLATES: Record<ResourceKind, (name: string) => string> = {
  agents: (name) =>
    `---\nname: ${name}\ndescription: When Claude should delegate to this agent\ntools: Read, Grep, Glob\nmodel: inherit\n---\n\nYou are a specialist in …\n\nWhen invoked:\n1. …\n`,
  skills: (name) =>
    `---\nname: ${name}\ndescription: What this skill does and when to use it\n---\n\n# ${name}\n\n## Instructions\n\n1. …\n`,
  commands: () =>
    `---\ndescription: What this command does\nargument-hint: [target]\nallowed-tools: Read, Grep\n---\n\nDo the following with $ARGUMENTS:\n\n1. …\n`,
  'output-styles': (name) => `---\nname: ${name}\ndescription: How this style changes the responses\n---\n\n# ${name}\n\nRespond …\n`,
  rules: () => `---\npaths:\n  - "src/**/*.ts"\n---\n\n# Rule\n\n- …\n`,
};

// Spanish nouns differ in gender (el agente, la skill), so each kind carries whole phrases rather
// than one sentence with the noun spliced in
type KindPhrase =
  | 'hint'
  | 'new'
  | 'namePlaceholder'
  | 'nameLabel'
  | 'saved'
  | 'saveFailed'
  | 'deleted'
  | 'deleteFailed'
  | 'noneInScope'
  | 'noneYet'
  | 'select'
  | 'createFirst'
  | 'content'
  | 'create'
  | 'deleteTitle';

interface Draft {
  name: string;
  content: string;
  isNew: boolean;
  /** Content as last saved, to compute the dirty state */
  saved: string;
}

export function ResourcesTab({ scope, kind }: { scope: Scope; kind: ResourceKind }) {
  const { t } = useTranslation(['config', 'common']);
  const k = (phrase: KindPhrase, options?: { name: string }) => t(`resources.kinds.${kind}.${phrase}`, options ?? {});
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const guard = useLeaveGuard();
  const queryKey = keys.resources(scope, kind);
  const { data, error, isLoading } = useQuery({ queryKey, queryFn: () => api.resources(scope, kind) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const resources = data ?? [];

  const dirty = draft !== null && (draft.isNew || draft.content !== draft.saved);
  useDirty(kind, dirty);

  const save = useMutation({
    mutationFn: (d: Draft) => api.putResource(scope, kind, d.name, d.content),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey });
      setDraft({ name: saved.name, content: saved.content, saved: saved.content, isNew: false });
      toast.success(k('saved', { name: saved.name }), saved.path);
    },
    onError: (err) => toast.error(k('saveFailed'), err),
  });

  const remove = useMutation({
    mutationFn: (name: string) => api.deleteResource(scope, kind, name),
    onSuccess: (_result, name) => {
      void queryClient.invalidateQueries({ queryKey });
      setDraft(null);
      toast.success(k('deleted', { name }));
    },
    onError: (err) => toast.error(k('deleteFailed'), err),
  });

  const open = async (name: string) => {
    if (draft?.name === name && !draft.isNew) return;
    if (!(await guard())) return;
    const resource = resources.find((r) => r.name === name);
    if (resource) setDraft({ name, content: resource.content, saved: resource.content, isNew: false });
  };

  const nameValid = naming !== null && /^[\w-]{1,64}$/.test(naming);
  const nameTaken = naming !== null && resources.some((r) => r.name === naming);
  const create = () => {
    if (!naming || !nameValid || nameTaken) return;
    setDraft({ name: naming, content: TEMPLATES[kind](naming), saved: '', isNew: true });
    setNaming(null);
  };
  const trySave = () => draft && dirty && !save.isPending && save.mutate(draft);

  return (
    <Card
      title={t(`config.tabs.${kind}`)}
      actions={
        <button className="btn btn-small btn-primary" onClick={() => void guard().then((ok) => ok && setNaming(''))}>
          <Plus size={14} strokeWidth={2} aria-hidden />
          {k('new')}
        </button>
      }
    >
      <p className="small muted">{k('hint')}</p>
      <ErrorBox error={error} />
      <div className="master-detail">
        <div className="master" role="list" aria-label={t(`config.tabs.${kind}`)}>
          {naming !== null && (
            <form
              className="master-new"
              onSubmit={(e) => {
                e.preventDefault();
                create();
              }}
            >
              <input
                autoFocus
                className={`mono ${naming && (!nameValid || nameTaken) ? 'is-invalid' : ''}`}
                value={naming}
                placeholder={k('namePlaceholder')}
                aria-label={k('nameLabel')}
                onChange={(e) => setNaming(e.target.value.trim())}
                onKeyDown={(e) => e.key === 'Escape' && setNaming(null)}
              />
              <div className="form-actions">
                <button type="submit" className="btn btn-small btn-primary" disabled={!nameValid || nameTaken}>
                  {t('shared.create')}
                </button>
                <button type="button" className="btn btn-small" onClick={() => setNaming(null)}>
                  {t('common:actions.cancel')}
                </button>
              </div>
              {nameTaken && <span className="field-hint text-err">{t('resources.exists')}</span>}
              {naming && !nameValid && <span className="field-hint text-err">{t('resources.nameRule')}</span>}
            </form>
          )}
          {isLoading ? (
            <Skeleton rows={4} />
          ) : resources.length === 0 && !draft?.isNew ? (
            naming === null && <div className="small muted master-empty">{k('noneInScope')}</div>
          ) : (
            <>
              {draft?.isNew && (
                <div className="master-item master-item-on" role="listitem">
                  <span className="strong ellipsis">{draft.name}</span>
                  <Tag tone="warn">{t('resources.newUnsaved')}</Tag>
                </div>
              )}
              {resources.map((resource) => (
                <button
                  key={resource.name}
                  type="button"
                  role="listitem"
                  className={`master-item ${draft?.name === resource.name && !draft.isNew ? 'master-item-on' : ''}`}
                  onClick={() => void open(resource.name)}
                >
                  <span className="strong ellipsis" title={resource.name}>
                    {resource.name}
                  </span>
                  <span className="small muted ellipsis" title={resource.description ?? undefined}>
                    {resource.description ?? t('resources.noDescription')}
                  </span>
                  <span className="small muted">{timeAgo(resource.updatedAt)}</span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="detail">
          {!draft ? (
            <Empty
              title={resources.length === 0 ? k('noneYet') : k('select')}
              action={
                resources.length === 0 && (
                  <button className="btn btn-primary" onClick={() => setNaming('')}>
                    {k('createFirst')}
                  </button>
                )
              }
            >
              {resources.length === 0 ? k('hint') : t('resources.pick')}
            </Empty>
          ) : (
            <div className="form">
              <div className="editor-meta">
                <strong>{draft.name}</strong>
                {!draft.isNew && <PathLabel path={resources.find((r) => r.name === draft.name)?.path ?? ''} />}
                {dirty && <Tag tone="warn">{draft.isNew ? t('resources.notSavedYet') : t('shared.unsaved')}</Tag>}
              </div>
              <CodeEditor
                key={`${draft.name}:${draft.isNew}`}
                language="markdown"
                ariaLabel={k('content')}
                minHeight="380px"
                value={draft.content}
                onChange={(content) => setDraft((d) => (d ? { ...d, content } : d))}
                onSave={trySave}
              />
              <div className="form-actions">
                <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
                  {save.isPending ? t('shared.saving') : draft.isNew ? k('create') : t('shared.save')}
                </button>
                <button
                  className="btn"
                  disabled={!dirty}
                  onClick={() => (draft.isNew ? setDraft(null) : setDraft({ ...draft, content: draft.saved }))}
                >
                  {t('shared.discard')}
                </button>
                {!draft.isNew && (
                  <button
                    className="btn btn-danger push-right"
                    disabled={remove.isPending}
                    onClick={() =>
                      void confirm({
                        title: k('deleteTitle', { name: draft.name }),
                        body: kind === 'skills' ? t('resources.deleteSkillBody') : t('resources.deleteFileBody'),
                        confirmLabel: t('common:actions.delete'),
                        danger: true,
                      }).then((ok) => ok && remove.mutate(draft.name))
                    }
                  >
                    {t('common:actions.delete')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
