import { Plus } from 'lucide-react';
import { RESOURCE_FORMATS, type ConfigResource, type ResourceKind } from '@agentry/shared';
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
import { frontmatterProblem } from './frontmatter';

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
  workflows: (name) =>
    `export const meta = {\n  name: '${name}',\n  description: 'What this workflow does',\n  phases: [{title: 'Work'}],\n}\n\nconst result = await agent('Reply with only the word: done', {label: 'worker', phase: 'Work'})\n\nreturn { result }\n`,
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

/** A resource's name as the API takes it: a file or directory name without its extension. */
export const RESOURCE_NAME = /^[\w-]{1,64}$/;

/** The resource open in the editor: one that exists, or a new one not written yet. */
interface Draft {
  name: string;
  isNew: boolean;
  /** What the save answered, which stands in until the list is fetched again */
  saved?: ConfigResource;
}

export function ResourcesTab({ scope, kind }: { scope: Scope; kind: ResourceKind }) {
  const { t } = useTranslation(['config', 'common']);
  const k = (phrase: KindPhrase) => t(`resources.kinds.${kind}.${phrase}`);
  const guard = useLeaveGuard();
  const queryKey = keys.resources(scope, kind);
  const { data, error, isLoading } = useQuery({ queryKey, queryFn: () => api.resources(scope, kind) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const resources = data ?? [];

  const open = async (name: string) => {
    if (draft?.name === name && !draft.isNew) return;
    if (!(await guard())) return;
    if (resources.some((r) => r.name === name)) setDraft({ name, isNew: false });
  };

  const nameTaken = naming !== null && resources.some((r) => r.name === naming);
  const create = () => {
    if (!naming || !RESOURCE_NAME.test(naming) || nameTaken) return;
    setDraft({ name: naming, isNew: true });
    setNaming(null);
  };
  const current = draft && !draft.isNew ? (resources.find((r) => r.name === draft.name) ?? draft.saved ?? null) : null;

  return (
    <Card
      title={t(`config.tabs.${kind}`)}
      actions={
        // One primary per zone: while the list is empty, its empty state holds it
        <button className={`btn btn-small ${resources.length > 0 ? 'btn-primary' : ''}`} onClick={() => void guard().then((ok) => ok && setNaming(''))}>
          <Plus size={14} strokeWidth={2} aria-hidden />
          {k('new')}
        </button>
      }
    >
      <p className="small muted">{k('hint')}</p>
      <ErrorBox error={error} />
      <div className="master-detail">
        <div className="master">
          {naming !== null && <NameForm kind={kind} value={naming} taken={nameTaken} onChange={setNaming} onSubmit={create} onCancel={() => setNaming(null)} />}
          {isLoading ? (
            <Skeleton rows={4} />
          ) : resources.length === 0 && !draft?.isNew ? (
            naming === null && <div className="small muted master-empty">{k('noneInScope')}</div>
          ) : (
            <ul className="master-list" aria-label={t(`config.tabs.${kind}`)}>
              {draft?.isNew && (
                <li>
                  <div className="master-item master-item-on" aria-current="true">
                    <span className="strong break">{draft.name}</span>
                    <Tag tone="warn">{t('resources.newUnsaved')}</Tag>
                  </div>
                </li>
              )}
              {resources.map((resource) => {
                const on = draft?.name === resource.name && !draft.isNew;
                return (
                  <li key={resource.name}>
                    <button
                      type="button"
                      aria-current={on ? 'true' : undefined}
                      className={`master-item ${on ? 'master-item-on' : ''}`}
                      onClick={() => void open(resource.name)}
                    >
                      <span className="strong break">{resource.name}</span>
                      <span className="small muted break">{resource.description ?? t('resources.noDescription')}</span>
                      <span className="small muted">{timeAgo(resource.updatedAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="detail">
          {!draft ? (
            <Empty
              title={resources.length === 0 ? k('noneYet') : k('select')}
              action={
                resources.length === 0 && (
                  <button type="button" className="btn btn-primary" onClick={() => setNaming('')}>
                    {k('createFirst')}
                  </button>
                )
              }
            >
              {resources.length === 0 ? k('hint') : t('resources.pick')}
            </Empty>
          ) : (
            <ResourceEditor
              key={`${draft.name}:${draft.isNew}`}
              scope={scope}
              kind={kind}
              name={draft.name}
              resource={current}
              onSaved={(saved) => setDraft({ name: saved.name, isNew: false, saved })}
              onClosed={() => setDraft(null)}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

/** The name of a new resource, checked as it is typed: its rule, and whether that name is taken. */
export function NameForm({
  kind,
  value,
  taken,
  onChange,
  onSubmit,
  onCancel,
}: {
  kind: ResourceKind;
  value: string;
  taken: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(['config', 'common']);
  const valid = RESOURCE_NAME.test(value);
  return (
    <form
      className="master-new"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <input
        autoFocus
        className={`mono ${value && (!valid || taken) ? 'is-invalid' : ''}`}
        value={value}
        placeholder={t(`resources.kinds.${kind}.namePlaceholder`)}
        aria-label={t(`resources.kinds.${kind}.nameLabel`)}
        onChange={(e) => onChange(e.target.value.trim())}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      />
      <div className="form-actions">
        <button type="submit" className="btn btn-small btn-primary" disabled={!valid || taken}>
          {t('shared.create')}
        </button>
        <button type="button" className="btn btn-small" onClick={onCancel}>
          {t('common:actions.cancel')}
        </button>
      </div>
      {taken && <span className="field-hint text-err">{t('resources.exists')}</span>}
      {value && !valid && <span className="field-hint text-err">{t('resources.nameRule')}</span>}
    </form>
  );
}

/**
 * One resource in the editor: a file that exists (saved, discarded back to what is on disk, or
 * deleted) or a new one, which starts from its kind's template and exists only once saved. The
 * settings' resources and a project's Resources tab both open it; the parent keys it by name so each
 * file starts from its own content.
 */
export function ResourceEditor({
  scope,
  kind,
  name,
  resource,
  onSaved,
  onClosed,
}: {
  scope: Scope;
  kind: ResourceKind;
  name: string;
  /** The file as the API serves it; null for a new one */
  resource: ConfigResource | null;
  onSaved: (saved: ConfigResource) => void;
  /** A new one discarded, or the file deleted */
  onClosed: () => void;
}) {
  const { t } = useTranslation(['config', 'common']);
  const k = (phrase: KindPhrase, options?: { name: string }) => t(`resources.kinds.${kind}.${phrase}`, options ?? {});
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const queryKey = keys.resources(scope, kind);
  const isNew = resource === null;
  const [saved, setSaved] = useState(resource?.content ?? '');
  const [content, setContent] = useState(resource?.content ?? TEMPLATES[kind](name));

  const dirty = isNew || content !== saved;
  useDirty(kind, dirty);
  // Said before saving: the CLI skips a file it cannot read without telling anyone
  const problem = dirty ? frontmatterProblem(kind, content) : null;

  const save = useMutation({
    mutationFn: (text: string) => api.putResource(scope, kind, name, text),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey });
      if (kind === 'workflows') void queryClient.invalidateQueries({ queryKey: keys.savedWorkflowsAll });
      setSaved(result.content);
      setContent(result.content);
      toast.success(k('saved', { name: result.name }), result.path);
      onSaved(result);
    },
    onError: (err) => toast.error(k('saveFailed'), err),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteResource(scope, kind, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      if (kind === 'workflows') void queryClient.invalidateQueries({ queryKey: keys.savedWorkflowsAll });
      toast.success(k('deleted', { name }));
      onClosed();
    },
    onError: (err) => toast.error(k('deleteFailed'), err),
  });

  const trySave = () => dirty && problem === null && !save.isPending && save.mutate(content);

  return (
    <div className="form">
      <div className="editor-meta">
        <strong>{name}</strong>
        {resource && <PathLabel path={resource.path} />}
        {dirty && <Tag tone="warn">{isNew ? t('resources.notSavedYet') : t('shared.unsaved')}</Tag>}
      </div>
      <CodeEditor
        language={resource?.format ?? RESOURCE_FORMATS[kind]}
        ariaLabel={k('content')}
        minHeight="380px"
        value={content}
        onChange={setContent}
        onSave={trySave}
      />
      {problem && (
        <span className="field-error" role="alert">
          {t(`resources.frontmatter.${problem}`)}
        </span>
      )}
      <div className="form-actions">
        <button className="btn btn-primary" disabled={!dirty || problem !== null || save.isPending} onClick={() => save.mutate(content)}>
          {save.isPending ? t('shared.saving') : isNew ? k('create') : t('shared.save')}
        </button>
        <button className="btn" disabled={!dirty} onClick={() => (isNew ? onClosed() : setContent(saved))}>
          {t('shared.discard')}
        </button>
        {!isNew && (
          <button
            className="btn btn-danger push-right"
            disabled={remove.isPending}
            onClick={() =>
              void confirm({
                title: k('deleteTitle', { name }),
                body: kind === 'skills' ? t('resources.deleteSkillBody') : t('resources.deleteFileBody'),
                confirmLabel: t('common:actions.delete'),
                danger: true,
              }).then((ok) => ok && remove.mutate())
            }
          >
            {t('common:actions.delete')}
          </button>
        )}
      </div>
    </div>
  );
}
