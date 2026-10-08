/**
 * A Home layout is data, not markup: a list of widgets by type, size and config, in the order they
 * are drawn. The web renders whatever layout passes here and the API refuses to store one that does
 * not, so both sides read the same rules from this file. Pure, so what a layout may contain is unit
 * tested without either side.
 */

export const WIDGET_SIZES = ['s', 'm', 'l', 'full'] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** Where a widget makes sense: on one project's Home, on All projects, or on both. */
export type WidgetScope = 'project' | 'global' | 'both';

/** The Home being drawn: a project's, or All projects. */
export type DashboardScope = 'project' | 'global';

/** The widget types this version knows; a stored layout may name others, which validation drops. */
export type WidgetType =
  | 'kpis'
  | 'now'
  | 'orchestrations'
  | 'limits'
  | 'pickUp'
  | 'today'
  | 'schedules'
  | 'projects'
  | 'quickStart'
  | 'memory'
  | 'worktrees'
  | 'resources'
  | 'export'
  | 'documents'
  | 'flows';

export interface LayoutWidget {
  /** Unique within a layout: two widgets of one type can live side by side with different configs */
  id: string;
  type: string;
  size: WidgetSize;
  /** What this instance was set up with; each widget type reads only the keys it knows */
  config?: Record<string, unknown>;
}

export interface DashboardLayout {
  version: 1;
  /** In the order they are drawn within their area */
  widgets: LayoutWidget[];
}

/** What validation needs to know about a widget type. */
export interface WidgetRule {
  type: string;
  sizes: readonly WidgetSize[];
  defaultSize: WidgetSize;
  scope: WidgetScope;
}

/** The key under which All projects' layout is stored and served; a project's is its id. */
export const ALL_PROJECTS_LAYOUT = 'all';

/** Every widget type Home can draw, with the sizes and dashboards it allows. */
export const WIDGET_RULES: readonly (WidgetRule & { type: WidgetType })[] = [
  { type: 'kpis', sizes: ['l'], defaultSize: 'l', scope: 'both' },
  { type: 'limits', sizes: ['s'], defaultSize: 's', scope: 'both' },
  { type: 'now', sizes: ['l', 'full'], defaultSize: 'full', scope: 'both' },
  { type: 'orchestrations', sizes: ['m', 'l', 'full'], defaultSize: 'l', scope: 'both' },
  { type: 'pickUp', sizes: ['m', 'l', 'full'], defaultSize: 'm', scope: 'both' },
  { type: 'today', sizes: ['m', 'l'], defaultSize: 'm', scope: 'both' },
  { type: 'schedules', sizes: ['s', 'm'], defaultSize: 's', scope: 'both' },
  { type: 'projects', sizes: ['m', 'l', 'full'], defaultSize: 'l', scope: 'global' },
  { type: 'quickStart', sizes: ['m', 'l', 'full'], defaultSize: 'l', scope: 'project' },
  { type: 'memory', sizes: ['s', 'm', 'l'], defaultSize: 's', scope: 'project' },
  { type: 'worktrees', sizes: ['s', 'm', 'l'], defaultSize: 's', scope: 'project' },
  { type: 'resources', sizes: ['s', 'm'], defaultSize: 's', scope: 'project' },
  { type: 'export', sizes: ['m', 'l', 'full'], defaultSize: 'full', scope: 'project' },
  { type: 'documents', sizes: ['m', 'l', 'full'], defaultSize: 'm', scope: 'project' },
  { type: 'flows', sizes: ['m', 'l', 'full'], defaultSize: 'm', scope: 'project' },
];

/** More than a Home can hold; a larger layout is a mistake, not a design. */
export const MAX_LAYOUT_WIDGETS = 40;
const MAX_ID_LENGTH = 64;
/** A widget's config is a handful of numbers and flags */
const MAX_CONFIG_BYTES = 2048;

export const fitsScope = (rule: Pick<WidgetRule, 'scope'>, scope: DashboardScope): boolean => rule.scope === 'both' || rule.scope === scope;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isSize = (value: unknown): value is WidgetSize => typeof value === 'string' && (WIDGET_SIZES as readonly string[]).includes(value);

/**
 * Keeps what can be drawn and drops the rest: a widget whose type is unknown (removed, or from a
 * newer version), one that does not belong on this dashboard, a repeated id. A size the type does
 * not offer falls back to its default rather than dropping the widget. `null` when the input is not
 * a layout at all, so the caller falls back to the default instead of drawing an empty page.
 */
export function validateLayout(input: unknown, rules: readonly WidgetRule[], scope: DashboardScope): DashboardLayout | null {
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.widgets)) return null;
  const byType = new Map(rules.map((rule) => [rule.type, rule]));
  const seen = new Set<string>();
  const widgets: LayoutWidget[] = [];
  for (const raw of input.widgets) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '' || typeof raw.type !== 'string') continue;
    const rule = byType.get(raw.type);
    if (!rule || !fitsScope(rule, scope) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const size = isSize(raw.size) && rule.sizes.includes(raw.size) ? raw.size : rule.defaultSize;
    widgets.push({ id: raw.id, type: raw.type, size, ...(isRecord(raw.config) ? { config: { ...raw.config } } : {}) });
  }
  return { version: 1, widgets };
}

/**
 * Why a layout may not be stored, or `null` when it may. Stricter than `validateLayout`, which
 * repairs what it reads: a save that would silently lose a widget tells the client instead.
 */
export function layoutProblem(input: unknown, scope: DashboardScope, rules: readonly WidgetRule[] = WIDGET_RULES): string | null {
  if (!isRecord(input) || input.version !== 1) return 'a layout is an object with version 1';
  if (!Array.isArray(input.widgets)) return 'widgets must be an array';
  if (input.widgets.length > MAX_LAYOUT_WIDGETS) return `a layout holds at most ${MAX_LAYOUT_WIDGETS} widgets`;
  const byType = new Map(rules.map((rule) => [rule.type, rule]));
  const seen = new Set<string>();
  for (const [index, raw] of input.widgets.entries()) {
    const at = `widgets[${index}]`;
    if (!isRecord(raw)) return `${at} must be an object`;
    if (typeof raw.id !== 'string' || raw.id === '' || raw.id.length > MAX_ID_LENGTH) return `${at}.id must be a text of 1 to ${MAX_ID_LENGTH} characters`;
    if (seen.has(raw.id)) return `${at}.id '${raw.id}' is repeated`;
    seen.add(raw.id);
    const rule = typeof raw.type === 'string' ? byType.get(raw.type) : undefined;
    if (!rule) return `${at}.type is not a widget this version knows`;
    if (!fitsScope(rule, scope)) return `${at}.type '${rule.type}' does not belong on ${scope === 'project' ? "a project's" : 'All projects'} Home`;
    if (!isSize(raw.size) || !rule.sizes.includes(raw.size)) return `${at}.size must be one of ${rule.sizes.join(', ')}`;
    if (raw.config !== undefined) {
      if (!isRecord(raw.config)) return `${at}.config must be an object`;
      if (JSON.stringify(raw.config).length > MAX_CONFIG_BYTES) return `${at}.config is too large`;
    }
  }
  return null;
}

/** A layout of every type listed, each at its default size, with its type as its id. */
export function layoutOf(types: readonly string[], rules: readonly WidgetRule[], scope: DashboardScope): DashboardLayout {
  const byType = new Map(rules.map((rule) => [rule.type, rule]));
  const widgets = types.flatMap((type): LayoutWidget[] => {
    const rule = byType.get(type);
    return rule && fitsScope(rule, scope) ? [{ id: type, type, size: rule.defaultSize }] : [];
  });
  return { version: 1, widgets };
}
