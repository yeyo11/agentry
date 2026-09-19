import type { ProjectSummary } from '@agentry/shared';
import { Brain, FolderGit2, GitBranch, History, Play, Plus, Settings2, Workflow } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useProjects } from '../api';
import { Checkbox, Collapsible } from '../components/controls';
import { Card, Empty, ErrorBox, Field, Loading, PageHeader, Tag } from '../components/ui';
import { ICON_SM, Monogram } from '../components/icons';
import { Stagger } from '../components/motion';
import { timeAgo } from '../lib/format';

function NewProjectForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(['work', 'common']);
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const create = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), gitUrl: gitUrl.trim() || undefined }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      onDone();
    },
  });
  return (
    <Card title={t('projects.newProjectCard')}>
      <div className="form">
        <Field label={t('projects.name')} hint={t('projects.nameHint')}>
          <input value={name} placeholder={t('projects.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('projects.gitUrl')} hint={t('projects.gitUrlHint')}>
          <input value={gitUrl} placeholder="https://github.com/owner/repo.git" onChange={(e) => setGitUrl(e.target.value)} />
        </Field>
        <ErrorBox error={create.error} title={t('projects.createFailed')} />
        <div className="form-actions">
          <button className="btn btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? (gitUrl.trim() ? t('projects.cloning') : t('projects.creating')) : t('projects.create')}
          </button>
          <button className="btn" onClick={onDone}>
            {t('common:actions.cancel')}
          </button>
        </div>
      </div>
    </Card>
  );
}

const liveIn = (p: ProjectSummary) => p.activeRuns + (p.activeSessions ?? 0);

/** One worktree of a project: its branch, who made it, and whether anything is working in it now. */
function WorktreeRow({ worktree }: { worktree: ProjectSummary }) {
  const { t } = useTranslation(['work', 'common']);
  const live = liveIn(worktree);
  const creator = worktree.createdBy;
  return (
    <li className={`worktree-row ${live > 0 ? 'is-live' : ''}`}>
      <div className="worktree-main">
        <span className="worktree-branch mono ellipsis" title={worktree.path}>
          <GitBranch {...ICON_SM} aria-hidden />
          {worktree.worktree?.branch ?? worktree.worktree?.name ?? worktree.name}
        </span>
        <span className="small muted meta">
          {creator ? (
            <Link to={`/orchestration/${creator.orchestrationId}`} className="meta-icon" title={t('projects.createdBy')}>
              <Workflow size={12} strokeWidth={1.75} aria-hidden /> {creator.orchestrationName} · {creator.taskName}
            </Link>
          ) : null}
          <span>{t('projects.sessionCount', { count: worktree.sessionCount })}</span>
          {worktree.lastActivity && <span>{timeAgo(worktree.lastActivity)}</span>}
        </span>
      </div>
      <div className="worktree-tags">
        {live > 0 && <Tag tone="active">{t('shared.activeCount', { count: live })}</Tag>}
        {!worktree.exists && <Tag tone="warn">{t('projects.removed')}</Tag>}
        {worktree.sessionCount > 0 && (
          <Link to={`/sessions?project=${encodeURIComponent(worktree.id)}`} className="btn btn-small" aria-label={t('projects.sessionsIn', { name: worktree.name })}>
            <History {...ICON_SM} />
          </Link>
        )}
      </div>
    </li>
  );
}

export function Projects() {
  const { t } = useTranslation(['work', 'common']);
  const [creating, setCreating] = useState(false);
  const [showTemporary, setShowTemporary] = useState(false);
  const { data, error, isLoading } = useProjects();
  const allProjects = data ?? [];
  const temporaryCount = allProjects.filter((p) => p.temporary).length;
  const visible = showTemporary ? allProjects : allProjects.filter((p) => !p.temporary);
  // Worktrees nest under their repository; one whose repository is filtered out stands on its own
  const ids = new Set(visible.map((p) => p.id));
  const worktreesOf = new Map<string, ProjectSummary[]>();
  for (const p of visible) {
    if (p.parentId && ids.has(p.parentId)) worktreesOf.set(p.parentId, [...(worktreesOf.get(p.parentId) ?? []), p]);
  }
  const projects = visible.filter((p) => !(p.parentId && ids.has(p.parentId)));

  return (
    <>
      <PageHeader
        title={t('projects.title')}
        subtitle={t('projects.subtitle', { count: projects.length })}
        actions={
          <>
            {temporaryCount > 0 && (
              <Checkbox checked={showTemporary} onChange={setShowTemporary} tooltip={t('projects.temporaryTooltip')}>
                {t('projects.showTemporary', { n: temporaryCount })}
              </Checkbox>
            )}
            {!creating && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={14} strokeWidth={2} aria-hidden />
              {t('projects.newProject')}
            </button>
          )}
          </>
        }
      />
      {creating && <NewProjectForm onDone={() => setCreating(false)} />}
      <ErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : projects.length === 0 ? (
        <Empty icon={FolderGit2} title={t('projects.empty')}>
          {t('projects.emptyHint')}
        </Empty>
      ) : (
        <Stagger className="cards project-cards">
          {projects.map((project) => {
            const worktrees = worktreesOf.get(project.id) ?? [];
            // Work in a worktree is work in this project
            const live = liveIn(project) + worktrees.reduce((n, w) => n + liveIn(w), 0);
            const liveWorktrees = worktrees.filter((w) => liveIn(w) > 0).length;
            return (
            <div key={project.id} className={`card card-interactive project-card ${live > 0 ? 'is-live' : ''}`}>
              <div className="project-head">
                <Monogram name={project.name} />
                <div className="project-head-text">
                  <div className="project-name ellipsis" title={project.name}>
                    {project.name}
                  </div>
                  <div className="mono small muted ellipsis" title={project.path}>
                    {project.path}
                  </div>
                </div>
                {project.temporary && <Tag>{t('shared.temporary')}</Tag>}
                {project.worktree && <Tag>{t('projects.worktree')}</Tag>}
                {live > 0 && <Tag tone="active">{t('shared.activeCount', { count: live })}</Tag>}
                {!project.exists && <Tag tone="warn">{t('projects.missing')}</Tag>}
              </div>
              <div className="meta">
                <span>{t('projects.sessions', { count: project.sessionCount })}</span>
                <span>{t('projects.lastActivity', { ago: timeAgo(project.lastActivity) })}</span>
                {project.worktree && project.parentPath && (
                  <span className="mono ellipsis" title={project.parentPath}>
                    {t('projects.worktreeOf', { path: project.parentPath })}
                  </span>
                )}
              </div>
              {worktrees.length > 0 && (
                <Collapsible
                  className="fold worktree-fold"
                  defaultOpen={liveWorktrees > 0}
                  title={
                    <span>
                      {t('projects.worktrees', { count: worktrees.length })}
                      {liveWorktrees > 0 && <span className="muted">{t('projects.inUse', { n: liveWorktrees })}</span>}
                    </span>
                  }
                >
                  <ul className="worktree-list">
                    {[...worktrees]
                      .sort((a, b) => liveIn(b) - liveIn(a) || (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
                      .map((w) => (
                        <WorktreeRow key={w.id} worktree={w} />
                      ))}
                  </ul>
                </Collapsible>
              )}
              <div className="card-foot">
                <Link to={`/sessions?project=${encodeURIComponent(project.id)}`} className="btn btn-small">
                  <History {...ICON_SM} /> {t('projects.sessionsButton')}
                </Link>
                <Link to={`/config?project=${encodeURIComponent(project.id)}`} className="btn btn-small">
                  <Settings2 {...ICON_SM} /> {t('projects.configButton')}
                </Link>
                <Link to={`/memory?project=${encodeURIComponent(project.id)}`} className="btn btn-small">
                  <Brain {...ICON_SM} /> {t('projects.memoryButton')}
                </Link>
                {project.exists && (
                  <Link to={`/runs/new?cwd=${encodeURIComponent(project.path)}`} className="btn btn-small btn-primary">
                    <Play {...ICON_SM} /> {t('projects.newRunHere')}
                  </Link>
                )}
              </div>
            </div>
            );
          })}
        </Stagger>
      )}
    </>
  );
}
