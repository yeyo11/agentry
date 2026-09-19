import { Plus } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { api, keys } from '../api';
import { CodeEditor } from '../components/CodeEditor';
import { useConfirm } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { Card, Empty, ErrorBox, PageHeader, PathLabel, Skeleton, Tag } from '../components/ui';
import { DirtyProvider, useDirty, useLeaveGuard } from '../lib/dirty';
import { shortPath, timeAgo } from '../lib/format';

const TYPE_TONE: Record<string, string> = { user: 'info', feedback: 'warn', project: 'idle', reference: 'ok' };
const NAME_RE = /^[\w.-]{1,80}\.md$/;

// The starter content is file content Claude reads back, so it is not translated
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
  const { t } = useTranslation('config');
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
        t('memory.saved', { name: saved.name }),
        d.isNew && !saved.isIndex ? t('memory.savedHint') : saved.path,
      );
    },
    onError: (err) => toast.error(t('memory.saveFailed'), err),
  });

  const remove = useMutation({
    mutationFn: (name: string) => api.deleteMemoryFile(projectId, name),
    onSuccess: (_result, name) => {
      refresh();
      setDraft(null);
      toast.success(t('memory.deleted', { name }), name === 'MEMORY.md' ? undefined : t('memory.deletedHint'));
    },
    onError: (err) => toast.error(t('memory.deleteFailed'), err),
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
      title={t('memory.files')}
      actions={
        <button className="btn btn-small btn-primary" onClick={() => void guard().then((ok) => ok && setNaming(''))}>
          <Plus size={14} strokeWidth={2} aria-hidden />
          {t('memory.new')}
        </button>
      }
    >
      <p className="small muted">
        <Trans t={t} i18nKey="memory.intro" components={{ mono: <span className="mono" /> }} />
      </p>
      {!isLoading && files.length > 0 && !hasIndex && (
        <div className="alert alert-warn" role="alert">
          <strong>{t('memory.noIndex')}</strong>
          <div>
            {t('memory.noIndexHint')}{' '}
            <button className="link-btn" onClick={() => setNaming('MEMORY.md')}>
              {t('memory.createIt')}
            </button>
          </div>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="master-detail">
        <div className="master" role="list" aria-label={t('memory.files')}>
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
                placeholder={t('memory.namePlaceholder')}
                aria-label={t('memory.nameLabel')}
                onChange={(e) => setNaming(e.target.value.trim())}
                onKeyDown={(e) => e.key === 'Escape' && setNaming(null)}
              />
              <div className="form-actions">
                <button type="submit" className="btn btn-small btn-primary" disabled={!nameValid || nameTaken}>
                  {t('shared.create')}
                </button>
                <button type="button" className="btn btn-small" onClick={() => setNaming(null)}>
                  {t('shared.cancel')}
                </button>
              </div>
              {nameTaken && <span className="field-hint text-err">{t('resources.exists')}</span>}
              {naming && !nameValid && <span className="field-hint text-err">{t('memory.nameRule')}</span>}
            </form>
          )}
          {isLoading ? (
            <Skeleton rows={4} />
          ) : (
            <>
              {draft?.isNew && (
                <div className="master-item master-item-on" role="listitem">
                  <span className="strong ellipsis mono">{draft.name}</span>
                  <Tag tone="warn">{t('resources.newUnsaved')}</Tag>
                </div>
              )}
              {files.map((file) => (
                <button
                  key={file.name}
                  type="button"
                  role="listitem"
                  className={`master-item ${draft?.name === file.name && !draft.isNew ? 'master-item-on' : ''}`}
                  onClick={() => void open(file.name)}
                >
                  <span className="master-item-head">
                    <span className="strong ellipsis mono" title={file.name}>
                      {file.name}
                    </span>
                    {file.isIndex ? <Tag tone="active">{t('memory.index')}</Tag> : file.type && <Tag tone={TYPE_TONE[file.type] ?? 'muted'}>{file.type}</Tag>}
                  </span>
                  <span className="small muted ellipsis" title={file.description ?? undefined}>
                    {file.isIndex ? t('memory.loadedEverySession') : (file.description ?? t('resources.noDescription'))}
                  </span>
                  <span className="small muted">{timeAgo(file.updatedAt)}</span>
                </button>
              ))}
              {files.length === 0 && !draft?.isNew && naming === null && <div className="small muted master-empty">{t('memory.noneYet')}</div>}
            </>
          )}
        </div>

        <div className="detail">
          {!draft ? (
            <Empty
              title={files.length === 0 ? t('memory.noneInProject') : t('memory.select')}
              action={
                files.length === 0 && (
                  <button className="btn btn-primary" onClick={() => setNaming('')}>
                    {t('memory.writeFirst')}
                  </button>
                )
              }
            >
              {files.length === 0 ? t('memory.emptyHint') : t('memory.pick')}
            </Empty>
          ) : (
            <div className="form">
              <div className="editor-meta">
                <strong className="mono">{draft.name}</strong>
                {current && <PathLabel path={current.path} />}
                {dirty && <Tag tone="warn">{draft.isNew ? t('resources.notSavedYet') : t('shared.unsaved')}</Tag>}
              </div>
              <CodeEditor
                key={`${projectId}:${draft.name}:${draft.isNew}`}
                language="markdown"
                ariaLabel={t('files.contents', { path: draft.name })}
                minHeight="380px"
                value={draft.content}
                onChange={(content) => setDraft((d) => (d ? { ...d, content } : d))}
                onSave={trySave}
              />
              <div className="form-actions">
                <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
                  {save.isPending ? t('shared.saving') : draft.isNew ? t('memory.create') : t('shared.save')}
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
                        title: t('files.deleteTitle', { path: draft.name }),
                        body: draft.name === 'MEMORY.md' ? t('memory.deleteIndexBody') : t('memory.deleteBody'),
                        confirmLabel: t('memory.delete'),
                        danger: true,
                      }).then((ok) => ok && remove.mutate(draft.name))
                    }
                  >
                    {t('shared.delete')}
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

function MemoryInner() {
  const { t } = useTranslation('config');
  const [params, setParams] = useSearchParams();
  const guard = useLeaveGuard();
  const { data, error, isLoading } = useQuery({ queryKey: keys.memoryProjects, queryFn: api.memoryProjects, refetchInterval: 15_000 });
  const projects = data ?? [];
  const selected = params.get('project') ?? projects[0]?.projectId;
  const current = projects.find((p) => p.projectId === selected);

  return (
    <>
      <PageHeader
        title={t('memory.title')}
        subtitle={t('memory.subtitle')}
      />
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={5} />
      ) : projects.length === 0 ? (
        <Empty title={t('memory.noProjects')}>{t('memory.noProjectsHint')}</Empty>
      ) : (
        <div className="memory-layout">
          <nav className="card project-rail" aria-label={t('memory.projects')}>
            {projects.map((project) => (
              <button
                key={project.projectId}
                type="button"
                className={`master-item ${project.projectId === selected ? 'master-item-on' : ''}`}
                title={project.projectPath}
                aria-current={project.projectId === selected}
                onClick={() =>
                  project.projectId !== selected &&
                  void guard().then((ok) => ok && setParams({ project: project.projectId }, { replace: true }))
                }
              >
                <span className="master-item-head">
                  <span className="strong ellipsis">{project.projectName}</span>
                  <span className={`count ${project.fileCount > 0 ? 'count-on' : ''}`}>{project.fileCount}</span>
                </span>
                <span className="small muted mono ellipsis">{shortPath(project.projectPath, 34)}</span>
              </button>
            ))}
          </nav>
          <div className="memory-main">
            {selected && (current || params.get('project')) ? (
              <MemoryFiles key={selected} projectId={selected} />
            ) : (
              <Empty title={t('memory.selectProject')} />
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function Memory() {
  return (
    <DirtyProvider>
      <MemoryInner />
    </DirtyProvider>
  );
}
