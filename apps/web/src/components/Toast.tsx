import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../lib/format';
import { Collapsible } from './controls/Collapsible';
import { ICON, ICON_SM } from './icons';
import { AnimatePresence, motion, SPRING, useReducedMotion } from './motion';

export type ToastTone = 'ok' | 'bad' | 'warn' | 'info';

/** What a toast that is more than a one-line confirmation can ask for. */
export interface ToastOptions {
  tone: ToastTone;
  title: string;
  detail?: string;
  /** A second toast with the same key replaces the first, and `dismissKey` can close it */
  key?: string;
  /** Stays until dismissed or acted on: for what needs the person */
  persistent?: boolean;
  /** Announced as an alert rather than a status */
  urgent?: boolean;
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOptions {
  id: number;
  lifetime: number;
}

interface ToastApi {
  success: (title: string, detail?: string) => void;
  error: (title: string, error?: unknown) => void;
  info: (title: string, detail?: string) => void;
  show: (options: ToastOptions) => void;
  dismissKey: (key: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const LIFETIME_MS: Record<ToastTone, number> = { ok: 4000, info: 5000, warn: 7000, bad: 9000 };
const MAX_TOASTS = 5;
/** How long a toast lingers once the pointer or focus has left it */
const RESUME_MS = 3000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const reduced = useReducedMotion();
  const timers = useRef(new Map<number, number>());
  const { t } = useTranslation('components');

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  // A toast that goes by itself must not go while someone is reading it or reaching for its button
  const hold = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);
  const release = useCallback(
    (id: number) => {
      if (!timers.current.has(id)) timers.current.set(id, window.setTimeout(() => dismiss(id), RESUME_MS));
    },
    [dismiss],
  );

  const show = useCallback(
    (options: ToastOptions) => {
      const id = nextId.current++;
      const lifetime = LIFETIME_MS[options.tone] + (options.detail ? 4000 : 0);
      setItems((list) => {
        const next = [...list.filter((t) => options.key === undefined || t.key !== options.key), { ...options, id, lifetime }];
        // Over the cap the oldest toast that would have gone by itself makes room: a persistent one
        // is a question waiting for the person and must not be pushed out by chatter
        while (next.length > MAX_TOASTS) {
          const drop = next.findIndex((t) => !t.persistent);
          next.splice(drop === -1 ? 0 : drop, 1);
        }
        return next;
      });
      if (!options.persistent) timers.current.set(id, window.setTimeout(() => dismiss(id), lifetime));
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, detail) => show({ tone: 'ok', title, detail }),
      info: (title, detail) => show({ tone: 'info', title, detail }),
      error: (title, error) => show({ tone: 'bad', title, detail: error ? errorMessage(error) : undefined }),
      show,
      dismissKey: (key) => setItems((list) => list.filter((t) => t.key !== key)),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label={t('toast.region')} aria-live="polite">
        <AnimatePresence initial={false}>
        {items.map((toast) => (
          <motion.div
            key={toast.id}
            layout={!reduced}
            className={`toast toast-${toast.tone}`}
            role={toast.tone === 'bad' || toast.urgent ? 'alert' : 'status'}
            onMouseEnter={() => hold(toast.id)}
            onMouseLeave={() => !toast.persistent && release(toast.id)}
            onFocus={() => hold(toast.id)}
            onBlur={() => !toast.persistent && release(toast.id)}
            initial={reduced ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.96, transition: { duration: 0.15 } }}
            transition={SPRING}
          >
            <span className="toast-icon" aria-hidden>
              {toast.tone === 'ok' ? (
                <CircleCheck {...ICON} />
              ) : toast.tone === 'bad' ? (
                <CircleAlert {...ICON} />
              ) : toast.tone === 'warn' ? (
                <TriangleAlert {...ICON} />
              ) : (
                <Info {...ICON} />
              )}
            </span>
            <div className="toast-body">
              <div className="toast-title">{toast.title}</div>
              {toast.detail &&
                (toast.detail.length > 140 || toast.detail.includes('\n') ? (
                  <Collapsible title={t('toast.showOutput')} triggerClassName="small muted">
                    <pre className="toast-detail">{toast.detail}</pre>
                  </Collapsible>
                ) : (
                  <div className="small muted break">{toast.detail}</div>
                ))}
              {toast.action && (
                <button
                  type="button"
                  className="btn btn-small toast-action"
                  onClick={() => {
                    toast.action?.onClick();
                    dismiss(toast.id);
                  }}
                >
                  {toast.action.label}
                </button>
              )}
            </div>
            <button type="button" className="icon-btn" aria-label={t('toast.dismiss')} onClick={() => dismiss(toast.id)}>
              <X {...ICON_SM} />
            </button>
            {!toast.persistent && <span className="toast-timer" style={{ '--toast-life': `${toast.lifetime}ms` } as CSSProperties} aria-hidden />}
          </motion.div>
        ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}
