import type { Project, ProjectWorktree } from '@agentry/shared';
import { GitBranch, MessageSquarePlus, MessagesSquare, Workflow } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ICON_SM } from '../../components/icons';
import { Card, Empty } from '../../components/ui';

/** One worktree of the project: its branch, who made it, and a way into a chat in it. */
function WorktreeRow({ worktree }: { worktree: ProjectWorktree }) {
  const creator = worktree.createdBy;
  return (
    <li className="worktree-row">
      <div className="worktree-main">
        <span className="worktree-branch mono break">
          <GitBranch {...ICON_SM} />
          {worktree.branch ?? worktree.name}
        </span>
        <span className="small muted mono break">{worktree.path}</span>
        {creator && (
          <span className="small muted meta">
            <Link to={`/orchestration/${encodeURIComponent(creator.orchestrationId)}`} className="meta-icon">
              <Workflow size={12} strokeWidth={1.75} aria-hidden /> {creator.orchestrationName} · {creator.taskName}
            </Link>
          </span>
        )}
      </div>
      <div className="worktree-tags">
        <Link
          to={`/chats/new?cwd=${encodeURIComponent(worktree.path)}`}
          className="btn btn-small"
          aria-label={`New chat in ${worktree.branch ?? worktree.name ?? worktree.path}`}
        >
          <MessageSquarePlus {...ICON_SM} /> New chat here
        </Link>
      </div>
    </li>
  );
}

/** The git worktrees of the project, including the ones orchestration tasks created. */
export function ProjectWorktrees({ project }: { project: Project }) {
  return (
    <Card
      title="Worktrees"
      actions={
        <Link to={`/chats?project=${encodeURIComponent(project.id)}`} className="btn btn-small">
          <MessagesSquare {...ICON_SM} /> Chats
        </Link>
      }
    >
      {project.worktrees.length === 0 ? (
        <Empty title="This project has no worktrees" icon={GitBranch}>
          Worktrees made with <span className="mono">git worktree add</span>, or by an orchestration task, show up here.
        </Empty>
      ) : (
        <ul className="worktree-list">
          {project.worktrees.map((worktree) => (
            <WorktreeRow key={worktree.path} worktree={worktree} />
          ))}
        </ul>
      )}
    </Card>
  );
}
