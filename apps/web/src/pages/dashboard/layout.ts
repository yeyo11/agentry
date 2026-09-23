/**
 * A dashboard's layout is data, not markup: a list of widgets by type, size and config. Today the
 * page renders a fixed default; a layout stored per project can replace it later without the page
 * changing, because the page renders whatever layout it is given once it has been validated here.
 * Pure, so what a stored layout is allowed to contain is unit tested.
 */

export const WIDGET_SIZES = ['s', 'm', 'l', 'full'] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** Where a widget makes sense: on one project's dashboard, on All projects, or on both. */
export type WidgetScope = 'project' | 'global' | 'both';

/** The dashboard being drawn: a project's, or All projects. */
export type DashboardScope = 'project' | 'global';

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
  widgets: LayoutWidget[];
}

/** What validation needs to know about a widget type: the registry's definitions satisfy it. */
export interface WidgetRule {
  type: string;
  sizes: readonly WidgetSize[];
  defaultSize: WidgetSize;
  scope: WidgetScope;
}

/** Columns each size takes on a 12-column grid (desktop) and a 6-column one (tablet); phones stack. */
export const SIZE_SPANS: Record<WidgetSize, { wide: number; medium: number }> = {
  s: { wide: 4, medium: 3 },
  m: { wide: 6, medium: 6 },
  l: { wide: 8, medium: 6 },
  full: { wide: 12, medium: 6 },
};

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

/** A layout of every type listed, each at its default size, with its type as its id. */
export function layoutOf(types: readonly string[], rules: readonly WidgetRule[], scope: DashboardScope): DashboardLayout {
  const byType = new Map(rules.map((rule) => [rule.type, rule]));
  const widgets = types.flatMap((type): LayoutWidget[] => {
    const rule = byType.get(type);
    return rule && fitsScope(rule, scope) ? [{ id: type, type, size: rule.defaultSize }] : [];
  });
  return { version: 1, widgets };
}

/** A number from a widget's config, or the fallback when it is missing or not a sane count. */
export function configCount(config: Record<string, unknown> | undefined, key: string, fallback: number, max = 50): number {
  const value = config?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}
