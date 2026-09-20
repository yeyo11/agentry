import type { ChatProject, ChatWorktree } from '@agentry/shared';
import { GitBranch } from 'lucide-react';
import { Link } from 'react-router-dom';
import { shortPath } from '../lib/format';

/**
 * Where a chat works: the project, and the worktree branch when it runs in one. The project comes
 * first because that is what a person recognises; a worktree path alone reads as yet another
 * project. A chat under no project shows its directory instead.
 */
export function Location({ project, worktree, cwd }: { project: ChatProject | null; worktree: ChatWorktree | null; cwd: string }) {
  return (
    <span className="location" title={worktree?.path ?? cwd}>
      {project ? (
        <Link to={`/chats?project=${encodeURIComponent(project.id)}`} className="location-project">
          {project.name}
        </Link>
      ) : (
        <span className="location-project mono">{shortPath(cwd, 44)}</span>
      )}
      {worktree && (
        <span className="location-branch mono">
          <GitBranch size={12} strokeWidth={1.75} aria-hidden />
          <span className="ellipsis">{worktree.branch ?? worktree.name ?? 'worktree'}</span>
        </span>
      )}
    </span>
  );
}
