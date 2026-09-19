import type { WorkLocation } from '@agentry/shared';
import { GitBranch } from 'lucide-react';
import { Link } from 'react-router-dom';
import { shortPath } from '../lib/format';

/**
 * Where a piece of work happens: the project, and the worktree branch when it runs in one. The
 * project comes first because that is what a person recognises; a worktree path alone reads as
 * yet another project.
 */
export function Location({ location, fallback }: { location?: WorkLocation | null; fallback?: string }) {
  if (!location) return fallback ? <span className="mono" title={fallback}>{shortPath(fallback, 44)}</span> : <span className="muted">—</span>;
  return (
    <span className="location" title={location.path}>
      <Link to={`/sessions?project=${encodeURIComponent(location.projectId)}`} className="location-project">
        {location.projectName}
      </Link>
      {location.worktree && (
        <span className="location-branch mono">
          <GitBranch size={12} strokeWidth={1.75} aria-hidden />
          <span className="ellipsis">{location.worktree.branch ?? location.worktree.name ?? 'worktree'}</span>
        </span>
      )}
    </span>
  );
}
