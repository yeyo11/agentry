import type { Project } from '@agentry/shared';
import { Component, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorBox, Skeleton } from '../../components/ui';
import type { DashboardLayout, LayoutWidget } from './layout';
import { widgetDefinition } from './registry';

/** One widget failing to render (or to load its chunk) takes its own cell down, not the dashboard. */
class WidgetBoundary extends Component<{ fallback: (error: unknown) => ReactNode; children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

function Slot({ widget, project }: { widget: LayoutWidget; project: Project | null }) {
  const { t } = useTranslation('home');
  const definition = widgetDefinition(widget.type);
  // A layout reaches here validated, but a type can still vanish between validation and render
  if (!definition) return null;
  const Widget = definition.component;
  const title = t(definition.titleKey);
  return (
    <div className={`widget-slot size-${widget.size}`} data-widget={widget.type}>
      <WidgetBoundary fallback={(error) => <ErrorBox error={error} title={t('dashboard.widgetFailed', { title })} />}>
        <Suspense
          fallback={
            <section className="card widget" aria-busy="true" aria-label={title}>
              <Skeleton rows={3} height={16} />
            </section>
          }
        >
          <Widget project={project} size={widget.size} config={widget.config} title={title} id={`widget-${widget.id}`} />
        </Suspense>
      </WidgetBoundary>
    </div>
  );
}

/**
 * Draws a layout: a 12-column grid on a wide page, 6 on a tablet, one column on a phone, measured
 * on the dashboard's own width so the sidebar being open or folded is accounted for.
 */
export function Dashboard({ layout, project, label }: { layout: DashboardLayout; project: Project | null; label: string }) {
  return (
    <div className="dashboard">
      <div className="dashboard-grid" role="region" aria-label={label}>
        {layout.widgets.map((widget) => (
          <Slot key={widget.id} widget={widget} project={project} />
        ))}
      </div>
    </div>
  );
}
