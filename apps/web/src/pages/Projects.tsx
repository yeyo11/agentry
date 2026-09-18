import { Brain, FolderGit2, History, Play, Plus, Settings2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, keys, useProjects } from '../api';
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

export function Projects() {
  const [creating, setCreating] = useState(false);
  const [showTemporary, setShowTemporary] = useState(false);
  const { data, error, isLoading } = useProjects(5000);
  const allProjects = data ?? [];
  const temporaryCount = allProjects.filter((p) => p.temporary).length;
  const projects = showTemporary ? allProjects : allProjects.filter((p) => !p.temporary);

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle={`${projects.length} projects · workspace directories and directories with Claude Code history`}
        actions={
          <>
            {temporaryCount > 0 && (
              <label className="check" title="Projects under the OS temp directory">
                <input type="checkbox" checked={showTemporary} onChange={(e) => setShowTemporary(e.target.checked)} /> Show temporary (
                {temporaryCount})
              </label>
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
        <Stagger className="cards">
          {projects.map((project) => (
            <div key={project.id} className={`card card-interactive project-card ${project.activeRuns > 0 ? 'is-live' : ''}`}>
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
                {project.activeRuns > 0 && <Tag tone="active">{project.activeRuns} active</Tag>}
                {!project.exists && <Tag tone="warn">missing on disk</Tag>}
              </div>
              <div className="meta">
                <span>{project.sessionCount} sessions</span>
                <span>last activity {timeAgo(project.lastActivity)}</span>
              </div>
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
          ))}
        </Stagger>
      )}
    </>
  );
}
