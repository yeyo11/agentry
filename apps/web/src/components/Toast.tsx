import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { errorMessage } from '../lib/format';
import { Collapsible } from './controls';
import { ICON, ICON_SM } from './icons';
import { AnimatePresence, motion, SPRING, useReducedMotion } from './motion';

type ToastTone = 'ok' | 'bad' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  /** Long text (e.g. CLI output), shown collapsed */
  detail?: string;
  lifetime: number;
}

interface ToastApi {
  success: (title: string, detail?: string) => void;
  error: (title: string, error?: unknown) => void;
  info: (title: string, detail?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const LIFETIME_MS: Record<ToastTone, number> = { ok: 4000, info: 5000, bad: 9000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const reduced = useReducedMotion();

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (tone: ToastTone, title: string, detail?: string) => {
      const id = nextId.current++;
      const lifetime = LIFETIME_MS[tone] + (detail ? 4000 : 0);
      setItems((list) => [...list.slice(-4), { id, tone, title, detail, lifetime }]);
      window.setTimeout(() => dismiss(id), lifetime);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, detail) => push('ok', title, detail),
      info: (title, detail) => push('info', title, detail),
      error: (title, error) => push('bad', title, error ? errorMessage(error) : undefined),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        <AnimatePresence initial={false}>
        {items.map((toast) => (
          <motion.div
            key={toast.id}
            layout={!reduced}
            className={`toast toast-${toast.tone}`}
            role={toast.tone === 'bad' ? 'alert' : 'status'}
            initial={reduced ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.96, transition: { duration: 0.15 } }}
            transition={SPRING}
          >
            <span className="toast-icon" aria-hidden>
              {toast.tone === 'ok' ? <CircleCheck {...ICON} /> : toast.tone === 'bad' ? <CircleAlert {...ICON} /> : <Info {...ICON} />}
            </span>
            <div className="toast-body">
              <div className="toast-title">{toast.title}</div>
              {toast.detail &&
                (toast.detail.length > 140 || toast.detail.includes('\n') ? (
                  <Collapsible title="Show output" triggerClassName="small muted">
                    <pre className="toast-detail">{toast.detail}</pre>
                  </Collapsible>
                ) : (
                  <div className="small muted break">{toast.detail}</div>
                ))}
            </div>
            <button className="icon-btn" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}>
              <X {...ICON_SM} />
            </button>
            <span className="toast-timer" style={{ '--toast-life': `${toast.lifetime}ms` } as CSSProperties} aria-hidden />
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
