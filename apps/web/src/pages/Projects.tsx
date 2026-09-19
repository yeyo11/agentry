import type { ProjectSummary } from '@agentry/shared';
import { Brain, FolderGit2, GitBranch, History, Play, Plus, Settings2, Workflow } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, keys, useProjects } from '../api';
import { Checkbox, Collapsible } from '../components/controls';
import { Card, Empty, ErrorBox, Field, Loading, PageHeader, Tag } from '../components/ui';
import { ICON_SM, Monogram } from '../components/icons';
import { Stagger } from '../components/motion';
import { timeAgo } from '../lib/format';

function NewProjectForm({ onDone }: { onDone: () => void }) {
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
    <Card title="New project in the workspace">
      <div className="form">
        <Field label="Name" hint="Directory name inside the workspace: letters, digits, dashes, dots and underscores.">
          <input value={name} placeholder="my-project" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Git repository (optional)" hint="Cloned into the new directory. Leave empty for an empty project.">
          <input value={gitUrl} placeholder="https://github.com/owner/repo.git" onChange={(e) => setGitUrl(e.target.value)} />
        </Field>
        <ErrorBox error={create.error} title="Could not create the project" />
        <div className="form-actions">
          <button className="btn btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? (gitUrl.trim() ? 'Cloning…' : 'Creating…') : 'Create project'}
          </button>
          <button className="btn" onClick={onDone}>
            Cancel
          </button>
        </div>
      </div>
    </Card>
  );
}

const liveIn = (p: ProjectSummary) => p.activeRuns + (p.activeSessions ?? 0);

/** One worktree of a project: its branch, who made it, and whether anything is working in it now. */
function WorktreeRow({ worktree }: { worktree: ProjectSummary }) {
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
            <Link to={`/orchestration/${creator.orchestrationId}`} className="meta-icon" title="Created by this orchestration task">
              <Workflow size={12} strokeWidth={1.75} aria-hidden /> {creator.orchestrationName} · {creator.taskName}
            </Link>
          ) : null}
          <span>
            {worktree.sessionCount} session{worktree.sessionCount === 1 ? '' : 's'}
          </span>
          {worktree.lastActivity && <span>{timeAgo(worktree.lastActivity)}</span>}
        </span>
      </div>
      <div className="worktree-tags">
        {live > 0 && <Tag tone="active">{live} active</Tag>}
        {!worktree.exists && <Tag tone="warn">removed</Tag>}
        {worktree.sessionCount > 0 && (
          <Link to={`/sessions?project=${encodeURIComponent(worktree.id)}`} className="btn btn-small" aria-label={`Sessions in ${worktree.name}`}>
            <History {...ICON_SM} />
          </Link>
        )}
      </div>
    </li>
  );
}

export function Projects() {
  const [creating, setCreating] = useState(false);
  const [showTemporary, setShowTemporary] = useState(false);
  const { data, error, isLoading } = useProjects(5000);
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
        title="Projects"
        subtitle={`${projects.length} projects · workspace directories and directories with Claude Code history; worktrees are listed under their repository`}
        actions={
          <>
            {temporaryCount > 0 && (
              <Checkbox checked={showTemporary} onChange={setShowTemporary} tooltip="Projects under the OS temp directory">
                Show temporary ({temporaryCount})
              </Checkbox>
            )}
            {!creating && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={14} strokeWidth={2} aria-hidden />
              New project
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
        <Empty icon={FolderGit2} title="No projects yet">
          Projects appear once a session has run in a directory.
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
                {project.temporary && <Tag>temporary</Tag>}
                {project.worktree && <Tag>worktree</Tag>}
                {live > 0 && <Tag tone="active">{live} active</Tag>}
                {!project.exists && <Tag tone="warn">missing on disk</Tag>}
              </div>
              <div className="meta">
                <span>{project.sessionCount} sessions</span>
                <span>last activity {timeAgo(project.lastActivity)}</span>
                {project.worktree && project.parentPath && (
                  <span className="mono ellipsis" title={project.parentPath}>
                    worktree of {project.parentPath}
                  </span>
                )}
              </div>
              {worktrees.length > 0 && (
                <Collapsible
                  className="fold worktree-fold"
                  defaultOpen={liveWorktrees > 0}
                  title={
                    <span>
                      {worktrees.length} worktree{worktrees.length === 1 ? '' : 's'}
                      {liveWorktrees > 0 && <span className="muted"> · {liveWorktrees} in use</span>}
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
                  <History {...ICON_SM} /> Sessions
                </Link>
                <Link to={`/config?project=${encodeURIComponent(project.id)}`} className="btn btn-small">
                  <Settings2 {...ICON_SM} /> Config
                </Link>
                <Link to={`/memory?project=${encodeURIComponent(project.id)}`} className="btn btn-small">
                  <Brain {...ICON_SM} /> Memory
                </Link>
                {project.exists && (
                  <Link to={`/runs/new?cwd=${encodeURIComponent(project.path)}`} className="btn btn-small btn-primary">
                    <Play {...ICON_SM} /> New run here
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
