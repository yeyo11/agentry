import type { ReactNode } from 'react';

/**
 * The frame every widget wears: a heading that names the region, an optional count or state next
 * to it, and the link to the full view on the right. Flat, border-first, like the rest of the page.
 */
export function WidgetCard({
  id,
  title,
  aside,
  actions,
  children,
  className = '',
}: {
  id: string;
  title: string;
  /** Next to the heading: a count, a state */
  aside?: ReactNode;
  /** On the right of the head: where "see all" goes */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const heading = `${id}-title`;
  return (
    <section className={`card widget ${className}`.trim()} aria-labelledby={heading}>
      <div className="widget-head">
        <h2 id={heading} className="widget-title">
          {title}
        </h2>
        {aside !== undefined && <span className="widget-aside">{aside}</span>}
        {actions && <span className="widget-actions">{actions}</span>}
      </div>
      {children}
    </section>
  );
}
