import { Plus } from 'lucide-react';
import type { ResourceKind } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, keys, type Scope } from '../../api';
import { CodeEditor } from '../../components/CodeEditor';
import { useConfirm } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { Card, Empty, ErrorBox, PathLabel, Skeleton, Tag } from '../../components/ui';
import { useDirty, useLeaveGuard } from '../../lib/dirty';
import { timeAgo } from '../../lib/format';

interface KindInfo {
  title: string;
  singular: string;
  hint: string;
  template: (name: string) => string;
}

export const RESOURCE_INFO: Record<ResourceKind, KindInfo> = {
  agents: {
    title: 'Agents',
    singular: 'agent',
    hint: 'Subagents Claude can delegate to. The description tells Claude when to use each one.',
    template: (name) =>
      `---\nname: ${name}\ndescription: When Claude should delegate to this agent\ntools: Read, Grep, Glob\nmodel: inherit\n---\n\nYou are a specialist in …\n\nWhen invoked:\n1. …\n`,
  },
  skills: {
    title: 'Skills',
    singular: 'skill',
    hint: 'Packaged instructions Claude loads on demand. Each skill is a directory with a SKILL.md; extra files live in the Files tab.',
    template: (name) =>
      `---\nname: ${name}\ndescription: What this skill does and when to use it\n---\n\n# ${name}\n\n## Instructions\n\n1. …\n`,
  },
  commands: {
    title: 'Commands',
    singular: 'command',
    hint: 'Custom slash commands: the file name is the command name. $ARGUMENTS is replaced with what the user types.',
    template: () =>
      `---\ndescription: What this command does\nargument-hint: [target]\nallowed-tools: Read, Grep\n---\n\nDo the following with $ARGUMENTS:\n\n1. …\n`,
  },
  'output-styles': {
    title: 'Output styles',
    singular: 'output style',
    hint: 'Alternative system-prompt styles, selectable with the outputStyle setting.',
    template: (name) => `---\nname: ${name}\ndescription: How this style changes the responses\n---\n\n# ${name}\n\nRespond …\n`,
  },
  rules: {
    title: 'Rules',
    singular: 'rule',
    hint: 'Modular instructions loaded next to CLAUDE.md. Optional `paths:` frontmatter limits a rule to matching files.',
    template: () => `---\npaths:\n  - "src/**/*.ts"\n---\n\n# Rule\n\n- …\n`,
  },
};

interface Draft {
  name: string;
  content: string;
  isNew: boolean;
  /** Content as last saved, to compute the dirty state */
  saved: string;
}

export function ResourcesTab({ scope, kind }: { scope: Scope; kind: ResourceKind }) {
  const info = RESOURCE_INFO[kind];
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
      toast.success(`${info.singular} “${saved.name}” saved`, saved.path);
    },
    onError: (err) => toast.error(`Could not save the ${info.singular}`, err),
  });

  const remove = useMutation({
    mutationFn: (name: string) => api.deleteResource(scope, kind, name),
    onSuccess: (_result, name) => {
      void queryClient.invalidateQueries({ queryKey });
      setDraft(null);
      toast.success(`${info.singular} “${name}” deleted`);
    },
    onError: (err) => toast.error(`Could not delete the ${info.singular}`, err),
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
    setDraft({ name: naming, content: info.template(naming), saved: '', isNew: true });
    setNaming(null);
  };
  const trySave = () => draft && dirty && !save.isPending && save.mutate(draft);

  return (
    <Card
      title={info.title}
      actions={
        <button className="btn btn-small btn-primary" onClick={() => void guard().then((ok) => ok && setNaming(''))}>
          <Plus size={14} strokeWidth={2} aria-hidden />
          New {info.singular}
        </button>
      }
    >
      <p className="small muted">{info.hint}</p>
      <ErrorBox error={error} />
      <div className="master-detail">
        <div className="master">
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
                placeholder={`${info.singular.replace(' ', '-')}-name`}
                aria-label={`New ${info.singular} name`}
                onChange={(e) => setNaming(e.target.value.trim())}
                onKeyDown={(e) => e.key === 'Escape' && setNaming(null)}
              />
              <div className="form-actions">
                <button type="submit" className="btn btn-small btn-primary" disabled={!nameValid || nameTaken}>
                  Create
                </button>
                <button type="button" className="btn btn-small" onClick={() => setNaming(null)}>
                  Cancel
                </button>
              </div>
              {nameTaken && <span className="field-hint text-err">Already exists</span>}
              {naming && !nameValid && <span className="field-hint text-err">Letters, digits, dashes and underscores only</span>}
            </form>
          )}
          {isLoading ? (
            <Skeleton rows={4} />
          ) : resources.length === 0 && !draft?.isNew ? (
            naming === null && <div className="small muted master-empty">No {info.title.toLowerCase()} in this scope yet.</div>
          ) : (
            <ul className="master-list" aria-label={info.title}>
              {draft?.isNew && (
                <li>
                  <div className="master-item master-item-on" aria-current="true">
                    <span className="strong break">{draft.name}</span>
                    <Tag tone="warn">new · unsaved</Tag>
                  </div>
                </li>
              )}
              {resources.map((resource) => {
                const current = draft?.name === resource.name && !draft.isNew;
                return (
                  <li key={resource.name}>
                    <button
                      type="button"
                      aria-current={current ? 'true' : undefined}
                      className={`master-item ${current ? 'master-item-on' : ''}`}
                      onClick={() => void open(resource.name)}
                    >
                      <span className="strong break">{resource.name}</span>
                      <span className="small muted break">{resource.description ?? 'No description'}</span>
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
              title={resources.length === 0 ? `No ${info.title.toLowerCase()} yet` : `Select a ${info.singular}`}
              action={
                resources.length === 0 && (
                  <button type="button" className="btn btn-primary" onClick={() => setNaming('')}>
                    Create the first {info.singular}
                  </button>
                )
              }
            >
              {resources.length === 0 ? info.hint : 'Pick one from the list to view and edit it.'}
            </Empty>
          ) : (
            <div className="form">
              <div className="editor-meta">
                <strong>{draft.name}</strong>
                {!draft.isNew && <PathLabel path={resources.find((r) => r.name === draft.name)?.path ?? ''} />}
                {dirty && <Tag tone="warn">{draft.isNew ? 'not saved yet' : 'unsaved changes'}</Tag>}
              </div>
              <CodeEditor
                key={`${draft.name}:${draft.isNew}`}
                language="markdown"
                ariaLabel={`${info.singular} content`}
                minHeight="380px"
                value={draft.content}
                onChange={(content) => setDraft((d) => (d ? { ...d, content } : d))}
                onSave={trySave}
              />
              <div className="form-actions">
                <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
                  {save.isPending ? 'Saving…' : draft.isNew ? `Create ${info.singular}` : 'Save'}
                </button>
                <button
                  className="btn"
                  disabled={!dirty}
                  onClick={() => (draft.isNew ? setDraft(null) : setDraft({ ...draft, content: draft.saved }))}
                >
                  Discard
                </button>
                {!draft.isNew && (
                  <button
                    className="btn btn-danger push-right"
                    disabled={remove.isPending}
                    onClick={() =>
                      void confirm({
                        title: `Delete ${info.singular} “${draft.name}”?`,
                        body:
                          kind === 'skills'
                            ? 'The whole skill directory is deleted, including any extra files in it. This cannot be undone.'
                            : 'The file is deleted from disk. This cannot be undone.',
                        confirmLabel: 'Delete',
                        danger: true,
                      }).then((ok) => ok && remove.mutate(draft.name))
                    }
                  >
                    Delete
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
