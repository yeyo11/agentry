import type { ProjectSummary } from '@agentry/shared';
import { ChevronsUpDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjects, type Scope } from '../../api';
import { Checkbox } from '../../components/controls';
import { shortPath } from '../../lib/format';

export interface ScopeState {
  scope: Scope;
  /** Stable string for React keys and effects */
  scopeKey: string;
  project: ProjectSummary | undefined;
  projects: ProjectSummary[];
  /** The URL names a project the API does not know (yet) */
  unknownProject: boolean;
}

export function useScopeState(projectId: string | undefined): ScopeState {
  const { data, isSuccess } = useProjects(30_000);
  return useMemo(() => {
    const projects = data ?? [];
    const project = projectId ? projects.find((p) => p.id === projectId) : undefined;
    return {
      scope: projectId ? { projectId } : {},
      scopeKey: projectId ?? 'user',
      project,
      projects,
      unknownProject: Boolean(projectId) && isSuccess && !project,
    };
  }, [data, isSuccess, projectId]);
}

/** Searchable scope selector: the user scope, or any project known to the wrapper. */
export function ScopePicker({
  state,
  onSelect,
}: {
  state: ScopeState;
  onSelect: (projectId: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [showTemporary, setShowTemporary] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const needle = filter.trim().toLowerCase();
  // Temporary projects (under the OS temp dir) stay out of the way unless one is already selected
  const candidates = state.projects.filter((p) => showTemporary || !p.temporary || p.id === state.scope.projectId);
  const hiddenTemporary = state.projects.length - candidates.length;
  const matches = candidates.filter(
    (p) => !needle || p.name.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle),
  );
  const showUser = !needle || 'user'.includes(needle);

  const choose = (projectId: string | undefined) => {
    setOpen(false);
    setFilter('');
    onSelect(projectId);
  };

  return (
    <div className="scope-picker" ref={rootRef}>
      <button
        type="button"
        className="btn scope-picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="muted">Scope</span>
        <strong className="ellipsis">{state.project ? state.project.name : state.scope.projectId ? 'Unknown project' : 'User'}</strong>
        <ChevronsUpDown size={14} strokeWidth={1.75} aria-hidden className="muted" />
      </button>
      {open && (
        <div className="popover" role="listbox" aria-label="Configuration scope">
          <input
            ref={inputRef}
            value={filter}
            placeholder="Search projects…"
            aria-label="Search projects"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'Enter') {
                if (showUser && !needle) choose(undefined);
                else if (matches[0]) choose(matches[0].id);
              }
            }}
          />
          <div className="popover-list">
            {showUser && (
              <button
                type="button"
                role="option"
                aria-selected={!state.scope.projectId}
                className={`popover-item ${!state.scope.projectId ? 'popover-item-on' : ''}`}
                onClick={() => choose(undefined)}
              >
                <strong>User</strong>
                <span className="small muted">Applies to every project of this account</span>
              </button>
            )}
            {matches.map((project) => (
              <button
                key={project.id}
                type="button"
                role="option"
                aria-selected={project.id === state.scope.projectId}
                className={`popover-item ${project.id === state.scope.projectId ? 'popover-item-on' : ''}`}
                title={project.path}
                onClick={() => choose(project.id)}
              >
                <strong className="ellipsis">
                  {project.name}
                  {project.temporary && <span className="badge popover-badge">temporary</span>}
                </strong>
                <span className="small muted mono ellipsis">{shortPath(project.path, 44)}</span>
              </button>
            ))}
            {!showUser && matches.length === 0 && <div className="small muted popover-empty">No project matches</div>}
          </div>
          {(hiddenTemporary > 0 || showTemporary) && (
            <Checkbox className="check small popover-foot" checked={showTemporary} onChange={setShowTemporary}>
              Show temporary projects{hiddenTemporary > 0 ? ` (${hiddenTemporary})` : ''}
            </Checkbox>
          )}
        </div>
      )}
    </div>
  );
}
