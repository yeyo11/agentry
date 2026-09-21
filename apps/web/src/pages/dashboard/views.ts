/** A project's own screens, each at `/?view=<id>`; everything else on its page is the dashboard. */
export const PROJECT_VIEWS = ['settings', 'memory', 'resources', 'worktrees'] as const;

export type ProjectViewId = (typeof PROJECT_VIEWS)[number];

export const asProjectView = (value: string | null): ProjectViewId | null => PROJECT_VIEWS.find((id) => id === value) ?? null;

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
