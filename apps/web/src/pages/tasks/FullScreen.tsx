import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { hasOpenLayer } from '@agentry/ui/components/controls/layer';
import { modalStack } from '@agentry/ui/components/modal-stack';

/**
 * The phone's full screen: "Cancel · New task · key" on top, the form, and "Create task" at the
 * bottom. Escape closes it and focus returns where it was, as a dialog does.
 */
export function FullScreen({ title, aside, onClose, children, footer }: { title: string; aside?: ReactNode; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const { t } = useTranslation('workItem');
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !hasOpenLayer()) {
        event.stopPropagation();
        close.current();
      }
    };
    // Its relation picker is a dialog on top of it: Escape there closes the picker, not the form
    const pop = modalStack().push(onKey);
    return () => {
      pop();
      previous?.focus?.();
    };
  }, []);
  return createPortal(
    <div ref={panel} className="newtask-screen" role="dialog" aria-modal="true" aria-labelledby={id}>
      {/* A div, not a header: outside a sectioning element a header is the page's banner, and the
          shell's top bar already is that */}
      <div className="newtask-screen-head">
        <button type="button" className="btn newtask-cancel" onClick={onClose}>
          {t('actions.cancel')}
        </button>
        <h2 id={id}>{title}</h2>
        <span className="newtask-screen-aside">{aside}</span>
      </div>
      <div className="newtask-screen-body">{children}</div>
      <div className="newtask-screen-foot">{footer}</div>
    </div>,
    document.body,
  );
}
