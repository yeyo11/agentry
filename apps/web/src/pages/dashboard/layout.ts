/**
 * A dashboard's layout is data, not markup: a list of widgets by type, size and config. The rules
 * for what a stored layout may contain live in `@agentry/shared`, so the API that stores it and the
 * page that draws it read the same ones; this file adds what only the page needs (the grid spans)
 * and re-exports the rest where the dashboard's code already imports it from.
 */
import type { WidgetSize } from '@agentry/shared';

export {
  fitsScope,
  layoutOf,
  validateLayout,
  WIDGET_SIZES,
  type DashboardLayout,
  type DashboardScope,
  type LayoutWidget,
  type WidgetRule,
  type WidgetScope,
  type WidgetSize,
} from '@agentry/shared';

/** Columns each size takes on a 12-column grid (desktop) and a 6-column one (tablet); phones stack. */
export const SIZE_SPANS: Record<WidgetSize, { wide: number; medium: number }> = {
  s: { wide: 4, medium: 3 },
  m: { wide: 6, medium: 6 },
  l: { wide: 8, medium: 6 },
  full: { wide: 12, medium: 6 },
};

/** A number from a widget's config, or the fallback when it is missing or not a sane count. */
export function configCount(config: Record<string, unknown> | undefined, key: string, fallback: number, max = 50): number {
  const value = config?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}
