import type { Project, ProjectCandidate } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Download, Eraser, FolderGit2, FolderPlus, GitBranch, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, keys, useProjectCandidates, useProjects } from '../api';
import { Collapsible, Combobox } from '../components/controls';
import { useConfirm } from '../components/Dialog';
import { ICON_SM, Monogram } from '../components/icons';
import { Stagger } from '../components/motion';
import { useToast } from '../components/Toast';
import { Card, Empty, ErrorBox, Field, Loading, PageHeader, Tag } from '../components/ui';
import { timeAgo } from '../lib/format';

/** What a change to the projects makes stale: the list, what is offered, and everything scoped by a project. */
function useRefreshProjects() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: keys.projects });
    void queryClient.invalidateQueries({ queryKey: keys.chats });
    void queryClient.invalidateQueries({ queryKey: keys.overview });
    void queryClient.invalidateQueries({ queryKey: keys.memoryProjects });
  };
}

function ImportForm({ candidates, onDone }: { candidates: ProjectCandidate[]; onDone: () => void }) {
  const refresh = useRefreshProjects();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: () => api.importProject({ path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) }),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  return (
    <Card title="Import a directory">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="Directory" hint="An absolute path. Every chat that ran under it becomes part of the project. A git worktree is refused: import its repository.">
          <Combobox
            aria-label="Directory"
            placeholder="/home/you/code/my-project"
            value={path}
            onChange={setPath}
            options={candidates.map((c) => ({ value: c.path, label: c.name, hint: `${c.chatCount} chats · ${c.path}` }))}
          />
        </Field>
        <Field label="Name (optional)" hint="Defaults to the directory's name.">
          <input value={name} placeholder="my-project" onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorBox error={add.error} title="Could not import the directory" />
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!path.trim() || add.isPending}>
            {add.isPending ? 'Importing…' : 'Import'}
          </button>
          <button type="button" className="btn" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

function NewProjectForm({ onDone }: { onDone: () => void }) {
  const refresh = useRefreshProjects();
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const create = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), gitUrl: gitUrl.trim() || undefined }),
    onSuccess: () => {
      refresh();
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

/** The directories with the most chats: what a first start offers instead of an empty screen. */
function Candidates({ candidates, first }: { candidates: ProjectCandidate[]; first: boolean }) {
  const refresh = useRefreshProjects();
  const toast = useToast();
  const add = useMutation({
    mutationFn: (candidate: ProjectCandidate) => api.importProject({ path: candidate.path }),
    onSuccess: (project) => {
      refresh();
      toast.success(`Imported ${project.name}`, `${project.chatCount} chats adopted`);
    },
    onError: (error) => toast.error('Could not import the directory', error),
  });
  const list = (
    <ul className="candidate-list">
      {candidates.map((c) => (
        <li key={c.path} className="candidate-row">
          <div className="candidate-main">
            <strong className="break">{c.name}</strong>
            <span className="mono small muted break">{c.path}</span>
            <span className="small muted">
              {c.chatCount} chat{c.chatCount === 1 ? '' : 's'}
              {c.lastActivity ? ` · last ${timeAgo(c.lastActivity)}` : ''}
            </span>
          </div>
          <button type="button" className="btn btn-small" disabled={add.isPending} onClick={() => add.mutate(c)} aria-label={`Import ${c.name}`}>
            <Download {...ICON_SM} /> Import
          </button>
        </li>
      ))}
    </ul>
  );
  if (first) {
    return (
      <Card title="Start with the directories you already work in">
        <p className="muted">
          Claude Code has run in these directories the most. Import the ones that are projects: their chats join them, and the rest stay
          out of the way. You can import any other directory by hand.
        </p>
        {list}
      </Card>
    );
  }
  return (
    <Collapsible className="card fold-card" title={<span className="fold-card-title">Other directories with chats ({candidates.length})</span>}>
      {list}
    </Collapsible>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const refresh = useRefreshProjects();
  const confirm = useConfirm();
  const toast = useToast();
  const [renaming, setRenaming] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: (name: string) => api.renameProject(project.id, name),
    onSuccess: () => {
      refresh();
      setRenaming(null);
    },
    onError: (error) => toast.error('Could not rename the project', error),
  });
  const remove = useMutation({
    mutationFn: () => api.removeProject(project.id),
    onSuccess: () => {
      refresh();
      toast.success(`Removed ${project.name}`, 'Nothing on disk changed');
    },
    onError: (error) => toast.error('Could not remove the project', error),
  });
  const purge = useMutation({
    mutationFn: () => api.purgeProject(project.id),
    onSuccess: (done) => {
      refresh();
      toast.success(`Purged what Claude Code kept about ${project.name}`, done.detail);
    },
    onError: (error) => toast.error('Could not purge the project', error),
  });

  const askRemove = async () => {
    const ok = await confirm({
      title: `Remove ${project.name}?`,
      body: (
        <>
          Agentry forgets this directory. Nothing on disk changes, and importing it again brings its {project.chatCount} chats back.
        </>
      ),
      confirmLabel: 'Remove project',
    });
    if (ok) remove.mutate();
  };
  const askPurge = async () => {
    const ok = await confirm({
      title: `Purge what Claude Code keeps about ${project.name}?`,
      body: (
        <>
          This deletes its transcripts, background tasks, file history and its entry in Claude Code&apos;s configuration
          (<code>claude project purge</code>), so its {project.chatCount} chats are gone for good. Your files are not touched. The
          project stays imported. <strong>This cannot be undone.</strong>
        </>
      ),
      confirmLabel: 'Purge for good',
      danger: true,
    });
    if (ok) purge.mutate();
  };

  return (
    <div className="card project-card">
      <div className="project-head">
        <Monogram name={project.name} />
        <div className="project-head-text">
          {renaming === null ? (
            <h2 className="project-name break">{project.name}</h2>
          ) : (
            <form
              className="rename-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (renaming.trim()) rename.mutate(renaming.trim());
              }}
            >
              <input aria-label="Project name" value={renaming} onChange={(e) => setRenaming(e.target.value)} autoFocus />
              <button type="submit" className="btn btn-small btn-primary" disabled={!renaming.trim() || rename.isPending}>
                Save
              </button>
              <button type="button" className="btn btn-small" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </form>
          )}
          <div className="mono small muted break">{project.path}</div>
        </div>
        {!project.exists && <Tag tone="warn">missing on disk</Tag>}
      </div>
      <div className="meta">
        <span>
          {project.chatCount} chat{project.chatCount === 1 ? '' : 's'}
        </span>
        <span>last activity {timeAgo(project.lastActivity)}</span>
        {project.worktrees.length > 0 && (
          <span className="meta-icon">
            <GitBranch size={12} strokeWidth={1.75} aria-hidden /> {project.worktrees.length} worktree{project.worktrees.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="card-foot">
        <Link to={`/?project=${encodeURIComponent(project.id)}`} className="btn btn-small btn-primary" aria-label={`Open ${project.name}`}>
          Open <ArrowRight {...ICON_SM} />
        </Link>
        <button type="button" className="btn btn-small" onClick={() => setRenaming(project.name)} disabled={renaming !== null} aria-label={`Rename ${project.name}`}>
          <Pencil {...ICON_SM} /> Rename
        </button>
        <button type="button" className="btn btn-small" onClick={() => void askRemove()} disabled={remove.isPending} aria-label={`Remove ${project.name}`}>
          <Trash2 {...ICON_SM} /> Remove
        </button>
        <button type="button" className="btn btn-small btn-danger" onClick={() => void askPurge()} disabled={purge.isPending} aria-label={`Purge Claude Code state of ${project.name}`}>
          <Eraser {...ICON_SM} /> Purge Claude Code state
        </button>
      </div>
    </div>
  );
}

export function Projects() {
  const [adding, setAdding] = useState<'import' | 'create' | null>(null);
  const { data, error, isLoading } = useProjects();
  const projects = data ?? [];
  // Candidates are always there to offer; the page decides how loudly, and only asks once it knows
  const candidates = useProjectCandidates(!isLoading);
  const offered = candidates.data ?? [];
  const first = !isLoading && projects.length === 0;

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle={`${projects.length} imported · a project is a directory you import by hand; its worktrees belong to it`}
        actions={
          adding === null && (
            <>
              <button className="btn" onClick={() => setAdding('create')}>
                <Plus size={14} strokeWidth={2} aria-hidden />
                New project
              </button>
              <button className="btn btn-primary" onClick={() => setAdding('import')}>
                <FolderPlus size={14} strokeWidth={2} aria-hidden />
                Import a directory
              </button>
            </>
          )
        }
      />
      {adding === 'import' && <ImportForm candidates={offered} onDone={() => setAdding(null)} />}
      {adding === 'create' && <NewProjectForm onDone={() => setAdding(null)} />}
      <ErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : projects.length === 0 ? (
        offered.length === 0 && (
          <Empty icon={FolderGit2} title="No projects yet">
            Import a directory to make it a project, or create one in the workspace.
          </Empty>
        )
      ) : (
        <Stagger className="cards project-cards">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </Stagger>
      )}
      {offered.length > 0 && <Candidates candidates={offered} first={first} />}
    </>
  );
}
