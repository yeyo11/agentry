import type { Project } from '@agentry/shared';
import { Plus } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, keys } from '../../api';
import { CodeEditor } from '../../components/CodeEditor';
import { useConfirm } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { Card, Empty, ErrorBox, PathLabel, Skeleton, Tag } from '../../components/ui';
import { useDirty, useLeaveGuard } from '../../lib/dirty';
import { timeAgo } from '../../lib/format';

const TYPE_TONE: Record<string, string> = { user: 'info', feedback: 'warn', project: 'idle', reference: 'ok' };
const NAME_RE = /^[\w.-]{1,80}\.md$/;

const memoryTemplate = (name: string) => `---
name: ${name.replace(/\.md$/, '')}
description: One-line summary, used to decide relevance during recall
metadata:
  type: feedback
---

The fact to remember.

**Why:** the reason behind it.

**How to apply:** when and how to act on it.
`;

interface Draft {
  name: string;
  content: string;
  saved: string;
  isNew: boolean;
}

function MemoryFiles({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const guard = useLeaveGuard();
  const queryKey = keys.memoryFiles(projectId);
  const { data, error, isLoading } = useQuery({ queryKey, queryFn: () => api.memoryFiles(projectId) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const files = data ?? [];
  const hasIndex = files.some((f) => f.isIndex);

  const dirty = draft !== null && (draft.isNew || draft.content !== draft.saved);
  useDirty('memory', dirty);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: keys.memoryProjects });
  };

  const save = useMutation({
    mutationFn: (d: Draft) => api.putMemoryFile(projectId, d.name, d.content),
    onSuccess: (saved, d) => {
      refresh();
      setDraft({ name: saved.name, content: saved.content, saved: saved.content, isNew: false });
      toast.success(
        `${saved.name} saved`,
        d.isNew && !saved.isIndex ? 'Remember to add a one-line pointer to it in MEMORY.md.' : saved.path,
      );
    },
    onError: (err) => toast.error('Could not save the memory', err),
  });

  const remove = useMutation({
    mutationFn: (name: string) => api.deleteMemoryFile(projectId, name),
    onSuccess: (_result, name) => {
      refresh();
      setDraft(null);
      toast.success(`${name} deleted`, name === 'MEMORY.md' ? undefined : 'Remove its pointer from MEMORY.md too.');
    },
    onError: (err) => toast.error('Could not delete the memory', err),
  });

  const open = async (name: string) => {
    if (draft?.name === name && !draft.isNew) return;
    if (!(await guard())) return;
    const file = files.find((f) => f.name === name);
    if (file) setDraft({ name, content: file.content, saved: file.content, isNew: false });
  };

  const fileName = naming === null ? '' : naming.endsWith('.md') ? naming : `${naming}.md`;
  const nameValid = NAME_RE.test(fileName);
  const nameTaken = files.some((f) => f.name === fileName);
  const create = () => {
    if (!nameValid || nameTaken) return;
    setDraft({
      name: fileName,
      content: fileName === 'MEMORY.md' ? '- [Title](file.md) — one-line hook\n' : memoryTemplate(fileName),
      saved: '',
      isNew: true,
    });
    setNaming(null);
  };
  const trySave = () => draft && dirty && !save.isPending && save.mutate(draft);
  const current = draft && !draft.isNew ? files.find((f) => f.name === draft.name) : undefined;

  return (
    <Card
      title="Memory files"
      actions={
        <button className="btn btn-small btn-primary" onClick={() => void guard().then((ok) => ok && setNaming(''))}>
          <Plus size={14} strokeWidth={2} aria-hidden />
          New memory
        </button>
      }
    >
      <p className="small muted">
        <span className="mono">MEMORY.md</span> is the index loaded into every session of this project: keep one line per memory,
        pointing to its file. The other files hold one fact each and are read on demand.
      </p>
      {!isLoading && files.length > 0 && !hasIndex && (
        <div className="alert alert-warn" role="alert">
          <strong>No MEMORY.md index</strong>
          <div>
            Without it, sessions will not know these memories exist.{' '}
            <button type="button" className="link-btn" onClick={() => setNaming('MEMORY.md')}>
              Create it
            </button>
          </div>
        </div>
      )}
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
                placeholder="short-kebab-case-name"
                aria-label="New memory file name"
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
              {naming && !nameValid && <span className="field-hint text-err">Letters, digits, dots, dashes and underscores; .md is added</span>}
            </form>
          )}
          {isLoading ? (
            <Skeleton rows={4} />
          ) : (
            <>
              {(files.length > 0 || draft?.isNew) && (
                <ul className="master-list" aria-label="Memory files">
                  {draft?.isNew && (
                    <li>
                      <div className="master-item master-item-on" aria-current="true">
                        <span className="strong break mono">{draft.name}</span>
                        <Tag tone="warn">new · unsaved</Tag>
                      </div>
                    </li>
                  )}
                  {files.map((file) => {
                    const on = draft?.name === file.name && !draft.isNew;
                    return (
                      <li key={file.name}>
                        <button
                          type="button"
                          aria-current={on ? 'true' : undefined}
                          className={`master-item ${on ? 'master-item-on' : ''}`}
                          onClick={() => void open(file.name)}
                        >
                          <span className="master-item-head">
                            <span className="strong break mono">{file.name}</span>
                            {file.isIndex ? <Tag tone="active">index</Tag> : file.type && <Tag tone={TYPE_TONE[file.type] ?? 'muted'}>{file.type}</Tag>}
                          </span>
                          <span className="small muted break">
                            {file.isIndex ? 'Loaded into every session' : (file.description ?? 'No description')}
                          </span>
                          <span className="small muted">{timeAgo(file.updatedAt)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {files.length === 0 && !draft?.isNew && naming === null && <div className="small muted master-empty">No memories yet.</div>}
            </>
          )}
        </div>

        <div className="detail">
          {!draft ? (
            <Empty
              title={files.length === 0 ? 'No memories in this project' : 'Select a memory'}
              action={
                files.length === 0 && (
                  <button type="button" className="btn btn-primary" onClick={() => setNaming('')}>
                    Write the first memory
                  </button>
                )
              }
            >
              {files.length === 0
                ? 'Claude saves facts about you, your feedback and the project here so they survive across sessions.'
                : 'Pick a file from the list to read or edit it.'}
            </Empty>
          ) : (
            <div className="form">
              <div className="editor-meta">
                <strong className="mono">{draft.name}</strong>
                {current && <PathLabel path={current.path} />}
                {dirty && <Tag tone="warn">{draft.isNew ? 'not saved yet' : 'unsaved changes'}</Tag>}
              </div>
              <CodeEditor
                key={`${projectId}:${draft.name}:${draft.isNew}`}
                language="markdown"
                ariaLabel={`Contents of ${draft.name}`}
                minHeight="380px"
                value={draft.content}
                onChange={(content) => setDraft((d) => (d ? { ...d, content } : d))}
                onSave={trySave}
              />
              <div className="form-actions">
                <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
                  {save.isPending ? 'Saving…' : draft.isNew ? 'Create memory' : 'Save'}
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
                        title: `Delete ${draft.name}?`,
                        body: draft.name === 'MEMORY.md' ? 'Without the index, sessions no longer learn about the other memory files.' : 'Claude will no longer recall this. This cannot be undone.',
                        confirmLabel: 'Delete memory',
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

/** The memory files Claude Code keeps for one project: a list and an editor. */
export function ProjectMemory({ project }: { project: Project }) {
  // Keyed so a draft never carries over to another project's files
  return <MemoryFiles key={project.id} projectId={project.id} />;
}
