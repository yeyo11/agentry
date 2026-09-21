/**
 * Every widget a dashboard can show. A widget is a type in this list and nothing else: the page
 * knows no widget by name, it draws the layout it is given (see `layout.ts`). Adding a widget is a
 * definition here plus its component; editing and storing a layout per project will read the same
 * list to offer what can be added.
 */
import type { Project } from '@agentry/shared';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { layoutOf, validateLayout, type DashboardLayout, type DashboardScope, type WidgetRule, type WidgetScope, type WidgetSize } from './layout';

export interface WidgetProps {
  /** The project the dashboard is about; `null` on All projects */
  project: Project | null;
  size: WidgetSize;
  config?: Record<string, unknown>;
  /** The widget's heading, already translated from its `titleKey` */
  title: string;
  /** Unique on the page, for the ids a widget's heading and regions need */
  id: string;
}

/** The widget types this version knows; a stored layout may name others, which validation drops. */
export type WidgetType = 'now' | 'orchestrations' | 'limits' | 'pickUp' | 'today' | 'schedules' | 'projects' | 'quickStart' | 'memory' | 'worktrees' | 'resources' | 'export';

export interface WidgetDefinition extends WidgetRule {
  type: WidgetType;
  /** Under the `home` namespace */
  titleKey: `widgets.${WidgetType}.title`;
  sizes: readonly WidgetSize[];
  defaultSize: WidgetSize;
  scope: WidgetScope;
  /**
   * Draws the widget, frame included, or nothing at all when it has nothing to say (the grid drops
   * an empty cell). Lazy: the widgets that share a module load together, the heavy ones on their own.
   */
  component: LazyExoticComponent<ComponentType<WidgetProps>>;
}

const live = <K extends keyof typeof import('./widgets/live')>(name: K) =>
  lazy(() => import('./widgets/live').then((m) => ({ default: m[name] })));
const usage = <K extends keyof typeof import('./widgets/usage')>(name: K) =>
  lazy(() => import('./widgets/usage').then((m) => ({ default: m[name] })));
const project = <K extends keyof typeof import('./widgets/project')>(name: K) =>
  lazy(() => import('./widgets/project').then((m) => ({ default: m[name] })));

export const WIDGETS: readonly WidgetDefinition[] = [
  { type: 'now', titleKey: 'widgets.now.title', sizes: ['l', 'full'], defaultSize: 'full', scope: 'both', component: live('NowWidget') },
  { type: 'orchestrations', titleKey: 'widgets.orchestrations.title', sizes: ['m', 'l', 'full'], defaultSize: 'l', scope: 'both', component: live('OrchestrationsWidget') },
  { type: 'limits', titleKey: 'widgets.limits.title', sizes: ['s', 'm'], defaultSize: 's', scope: 'both', component: usage('LimitsWidget') },
  { type: 'pickUp', titleKey: 'widgets.pickUp.title', sizes: ['m', 'l', 'full'], defaultSize: 'm', scope: 'both', component: live('PickUpWidget') },
  { type: 'today', titleKey: 'widgets.today.title', sizes: ['m', 'l'], defaultSize: 'm', scope: 'both', component: usage('TodayWidget') },
  { type: 'schedules', titleKey: 'widgets.schedules.title', sizes: ['s', 'm'], defaultSize: 's', scope: 'both', component: live('SchedulesWidget') },
  { type: 'projects', titleKey: 'widgets.projects.title', sizes: ['m', 'l', 'full'], defaultSize: 'l', scope: 'global', component: live('ProjectsWidget') },
  { type: 'quickStart', titleKey: 'widgets.quickStart.title', sizes: ['m', 'l', 'full'], defaultSize: 'l', scope: 'project', component: lazy(() => import('./widgets/QuickStart')) },
  { type: 'memory', titleKey: 'widgets.memory.title', sizes: ['s', 'm', 'l'], defaultSize: 's', scope: 'project', component: project('MemoryWidget') },
  { type: 'worktrees', titleKey: 'widgets.worktrees.title', sizes: ['s', 'm', 'l'], defaultSize: 's', scope: 'project', component: project('WorktreesWidget') },
  { type: 'resources', titleKey: 'widgets.resources.title', sizes: ['s', 'm'], defaultSize: 's', scope: 'project', component: project('ResourcesWidget') },
  { type: 'export', titleKey: 'widgets.export.title', sizes: ['m', 'l', 'full'], defaultSize: 'full', scope: 'project', component: project('ExportWidget') },
];

const BY_TYPE = new Map<string, WidgetDefinition>(WIDGETS.map((widget) => [widget.type, widget]));

export const widgetDefinition = (type: string): WidgetDefinition | undefined => BY_TYPE.get(type);

/* The order a person reads in: what is live, then what to pick up, then the project's own things. */
const DEFAULT_TYPES: Record<DashboardScope, readonly WidgetType[]> = {
  project: ['now', 'quickStart', 'limits', 'orchestrations', 'schedules', 'pickUp', 'today', 'memory', 'worktrees', 'resources', 'export'],
  global: ['now', 'orchestrations', 'limits', 'pickUp', 'today', 'schedules', 'projects'],
};

/** The layout this version ships: every dashboard shows it until layouts can be edited and stored. */
export function defaultLayout(scope: DashboardScope): DashboardLayout {
  return layoutOf(DEFAULT_TYPES[scope], WIDGETS, scope);
}

/** A stored (or any) layout, reduced to what this version can draw; the default when it is not a layout. */
export function resolveLayout(input: unknown, scope: DashboardScope): DashboardLayout {
  return validateLayout(input, WIDGETS, scope) ?? defaultLayout(scope);
}
