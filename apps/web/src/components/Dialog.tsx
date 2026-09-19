import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { hasOpenLayer } from './controls/layer';
import { ICON } from './icons';
import { EASE_OUT, motion, useReducedMotion } from './motion';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal surface: focus is trapped inside, Esc and the backdrop close it, and focus
 * returns to the element that opened it. `variant="drawer"` slides in from the right.
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  variant = 'modal',
  width,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  variant?: 'modal' | 'drawer';
  width?: number;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const drawer = variant === 'drawer';
  const { t } = useTranslation(['components', 'common']);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // Prefer the first control of the body/footer over the close button in the header
    const initial = panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel?.querySelectorAll<HTMLElement>(FOCUSABLE)[1];
    (initial ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // An open select menu or suggestion list inside the dialog takes Escape first
        if (hasOpenLayer()) return;
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const nodes = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previous?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <motion.div
      className={`overlay overlay-${variant}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduced ? 0 : 0.16 }}
    >
      <motion.div
        ref={panelRef}
        initial={reduced ? false : drawer ? { x: 48, opacity: 0 } : { y: 10, scale: 0.97, opacity: 0 }}
        animate={{ x: 0, y: 0, scale: 1, opacity: 1 }}
        transition={{ duration: 0.22, ease: EASE_OUT }}
        className={`dialog dialog-${variant}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={width ? { width } : undefined}
      >
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" aria-label={t('dialog.close')} onClick={onClose}>
            <X {...ICON} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

// ---------- Promise-based confirmation ----------

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive */
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation(['components', 'common']);
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (options) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );

  const settle = useCallback(
    (ok: boolean) => {
      pending?.resolve(ok);
      setPending(null);
    },
    [pending],
  );

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <Dialog
          title={pending.title}
          onClose={() => settle(false)}
          width={440}
          footer={
            <>
              <button className="btn" onClick={() => settle(false)}>
                {pending.cancelLabel ?? t('common:actions.cancel')}
              </button>
              <button
                className={`btn ${pending.danger ? 'btn-danger-solid' : 'btn-primary'}`}
                data-autofocus
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? t('dialog.confirm')}
              </button>
            </>
          }
        >
          {pending.body ?? t('dialog.areYouSure')}
        </Dialog>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return confirm;
}
