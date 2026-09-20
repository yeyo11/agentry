import type { Project } from '@agentry/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useProjects } from '../api';

/*
 * The project the top bar has selected. It scopes Home, Chats and Orchestrations; notifications
 * ignore it, because a chat waiting in another project is still worth knowing about.
 *
 * The choice is kept in the browser and a `?project=<id>` in the address overrides it, which is what
 * makes a link to a project's page work from anywhere. `all` in the address selects no project.
 */

const KEY = 'agentry:project';
export const PARAM = 'project';
export const ALL_PROJECTS = 'all';

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function write(id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    // private mode: the choice just does not persist
  }
}

export interface ProjectScope {
  /** The selected project; null with All projects, and also while the list is loading */
  project: Project | null;
  /** Its id, or null for All projects: what a list passes to `?project=` */
  projectId: string | null;
  /** Every imported project; empty until the first response */
  projects: Project[];
  /** The list has been answered, so `project === null` really means All projects */
  ready: boolean;
  /** `null` selects All projects */
  select: (id: string | null) => void;
}

const Context = createContext<ProjectScope | null>(null);

export function ProjectScopeProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const { data, isSuccess } = useProjects();
  const [stored, setStored] = useState<string | null>(read);
  const linked = params.get(PARAM);

  // A deep link wins over what was chosen before, and becomes the choice
  useEffect(() => {
    if (!linked) return;
    const id = linked === ALL_PROJECTS ? null : linked;
    setStored(id);
    write(id);
  }, [linked]);

  const select = useCallback(
    (id: string | null) => {
      setStored(id);
      write(id);
      // A stale `?project=` in the address would override the choice on the next reload
      if (params.has(PARAM)) {
        setParams(
          (previous) => {
            const next = new URLSearchParams(previous);
            next.delete(PARAM);
            return next;
          },
          { replace: true },
        );
      }
    },
    [params, setParams],
  );

  const value = useMemo<ProjectScope>(() => {
    const projects = data ?? [];
    // The address is read directly too, so the first render of a deep link is already scoped
    const wanted = linked ? (linked === ALL_PROJECTS ? null : linked) : stored;
    // A project that was removed since it was chosen falls back to All projects
    const project = wanted ? (projects.find((p) => p.id === wanted) ?? null) : null;
    return { project, projectId: project?.id ?? null, projects, ready: isSuccess, select };
  }, [data, isSuccess, linked, stored, select]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useProjectScope(): ProjectScope {
  const value = useContext(Context);
  if (!value) throw new Error('useProjectScope needs a ProjectScopeProvider above it');
  return value;
}

/** Whether a directory belongs to a project: its own, or one of its worktrees. */
export function inProject(project: Project, dir: string): boolean {
  const within = (root: string) => dir === root || dir.startsWith(`${root}/`);
  return within(project.path) || project.worktrees.some((w) => within(w.path));
}
