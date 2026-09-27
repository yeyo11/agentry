import type { ProjectModule } from '@agentry/shared';

/**
 * A project's own tabs, each at `/?view=<id>`, in the order the strip draws them after Resumen (the
 * dashboard, which has no `view`). Team and Documents join once orchestration 3 builds them.
 */
export const PROJECT_VIEWS = ['board', 'memory', 'resources', 'worktrees', 'settings'] as const;

export type ProjectViewId = (typeof PROJECT_VIEWS)[number];

/** The module a tab belongs to: it exists only while that module is on. The others are always there. */
export const VIEW_MODULE: Partial<Record<ProjectViewId, ProjectModule>> = { board: 'board', memory: 'memory' };

export const asProjectView = (value: string | null): ProjectViewId | null => PROJECT_VIEWS.find((id) => id === value) ?? null;

/** The tabs a project with these modules shows. */
export function projectViews(modules: readonly ProjectModule[]): ProjectViewId[] {
  return PROJECT_VIEWS.filter((id) => {
    const module = VIEW_MODULE[id];
    return module === undefined || modules.includes(module);
  });
}

/**
 * `?tab=` is what the page used before it was a dashboard, and links to it live in bookmarks and in
 * other pages: its values that are still screens become `?view=`, `activity` (now the dashboard
 * itself) is dropped. The rest of the query, the section and the project, is kept. `null` when
 * there is nothing to redirect.
 */
export function legacyTabRedirect(params: URLSearchParams): string | null {
  const tab = params.get('tab');
  if (tab === null) return null;
  const next = new URLSearchParams(params);
  next.delete('tab');
  const view = asProjectView(tab);
  if (view && !next.has('view')) next.set('view', view);
  const query = next.toString();
  return query ? `?${query}` : '';
}
