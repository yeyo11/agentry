/**
 * What a person can do to a Home's layout in edit mode, as pure functions from a layout to a layout:
 * add, remove, move within an area and resize. A widget never leaves its area (the type decides it,
 * see `registry.ts`), and each type appears once. The editor saves whatever these return, and the
 * shared rules validate it again on the server.
 */
import type { DashboardLayout, DashboardScope, LayoutWidget, WidgetSize } from './layout';
import { fitsScope } from './layout';
import { widgetDefinition, WIDGETS, type WidgetArea, type WidgetDefinition } from './registry';

const areaOf = (widget: LayoutWidget): WidgetArea | undefined => widgetDefinition(widget.type)?.area;

/** The widget types a Home of this scope could still take: they fit it and are not on the page yet. */
export function addableWidgets(layout: DashboardLayout, scope: DashboardScope): WidgetDefinition[] {
  const present = new Set(layout.widgets.map((widget) => widget.type));
  return WIDGETS.filter((definition) => fitsScope(definition, scope) && !present.has(definition.type));
}

/** The types already on the page, which the picker lists as taken. */
export function presentWidgets(layout: DashboardLayout): WidgetDefinition[] {
  const present = new Set(layout.widgets.map((widget) => widget.type));
  return WIDGETS.filter((definition) => present.has(definition.type));
}

/** A widget goes to the end of its area at its default size; a type already there stays as it is. */
export function addWidget(layout: DashboardLayout, type: string): DashboardLayout {
  const definition = widgetDefinition(type);
  if (!definition || layout.widgets.some((widget) => widget.type === type)) return layout;
  let at = -1;
  layout.widgets.forEach((widget, index) => {
    if (areaOf(widget) === definition.area) at = index;
  });
  const widgets = [...layout.widgets];
  // With none of its area yet it joins the end, which is where the page draws a lone widget of it anyway
  widgets.splice(at < 0 ? widgets.length : at + 1, 0, { id: type, type, size: definition.defaultSize });
  return { ...layout, widgets };
}

export function removeWidget(layout: DashboardLayout, id: string): DashboardLayout {
  return layout.widgets.some((widget) => widget.id === id) ? { ...layout, widgets: layout.widgets.filter((widget) => widget.id !== id) } : layout;
}

/** A size the type does not offer changes nothing. */
export function resizeWidget(layout: DashboardLayout, id: string, size: WidgetSize): DashboardLayout {
  const widget = layout.widgets.find((candidate) => candidate.id === id);
  if (!widget || widget.size === size || !widgetDefinition(widget.type)?.sizes.includes(size)) return layout;
  return { ...layout, widgets: layout.widgets.map((candidate) => (candidate.id === id ? { ...candidate, size } : candidate)) };
}

/** The widgets of one area, in the order the page draws them. */
export const widgetsInArea = (layout: DashboardLayout, area: WidgetArea): LayoutWidget[] => layout.widgets.filter((widget) => areaOf(widget) === area);

/** Where a widget sits among those of its area, and how many there are; null when it is not on the page. */
export function positionOf(layout: DashboardLayout, id: string): { index: number; count: number } | null {
  const widget = layout.widgets.find((candidate) => candidate.id === id);
  const area = widget && areaOf(widget);
  if (!widget || !area) return null;
  const peers = widgetsInArea(layout, area);
  return { index: peers.findIndex((peer) => peer.id === id), count: peers.length };
}

/** Moves a widget to a place among its area's widgets (0 is first); a place past either end is the end. */
export function moveWidgetTo(layout: DashboardLayout, id: string, place: number): DashboardLayout {
  const widget = layout.widgets.find((candidate) => candidate.id === id);
  const area = widget && areaOf(widget);
  if (!widget || !area) return layout;
  const peers = widgetsInArea(layout, area);
  const from = peers.findIndex((peer) => peer.id === id);
  const to = Math.max(0, Math.min(place, peers.length - 1));
  if (from === to) return layout;
  const order = peers.filter((peer) => peer.id !== id);
  order.splice(to, 0, widget);
  // The area's widgets take, in turn, the places the area's widgets held in the whole list
  let next = 0;
  return { ...layout, widgets: layout.widgets.map((candidate) => (areaOf(candidate) === area ? (order[next++] ?? candidate) : candidate)) };
}

/** One place up (-1) or down (+1) inside the area. */
export function shiftWidget(layout: DashboardLayout, id: string, delta: -1 | 1): DashboardLayout {
  const position = positionOf(layout, id);
  return position ? moveWidgetTo(layout, id, position.index + delta) : layout;
}

export function sameLayout(a: DashboardLayout, b: DashboardLayout): boolean {
  return (
    a.widgets.length === b.widgets.length &&
    a.widgets.every((widget, index) => {
      const other = b.widgets[index];
      return other !== undefined && widget.id === other.id && widget.type === other.type && widget.size === other.size && JSON.stringify(widget.config ?? null) === JSON.stringify(other.config ?? null);
    })
  );
}
