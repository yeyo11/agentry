import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router-dom';
import { useConfirm } from '../components/Dialog';

interface DirtyApi {
  keys: ReadonlySet<string>;
  set: (key: string, dirty: boolean) => void;
}

const DirtyContext = createContext<DirtyApi | null>(null);

/** Built on each render so it follows the language the person is reading right now. */
function useDiscardPrompt() {
  const { t } = useTranslation('components');
  return {
    title: t('dirty.title'),
    body: t('dirty.body'),
    confirmLabel: t('dirty.discard'),
    cancelLabel: t('dirty.keepEditing'),
    danger: true,
  };
}

/** Tracks which editors hold unsaved changes so navigation inside the page can be guarded. */
export function DirtyProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set());
  const confirm = useConfirm();
  const discardPrompt = useDiscardPrompt();

  // Leaving the page (sidebar, links, back button). Query-string changes on the same page are
  // tab/scope switches, which the pages guard themselves with useLeaveGuard.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => keys.size > 0 && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    let cancelled = false;
    void confirm(discardPrompt).then((leave) => {
      if (cancelled) return;
      if (leave) blocker.proceed();
      else blocker.reset();
    });
    return () => {
      cancelled = true;
    };
  }, [blocker, confirm, discardPrompt]);

  const set = useCallback((key: string, dirty: boolean) => {
    setKeys((current) => {
      if (current.has(key) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  useEffect(() => {
    if (keys.size === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [keys]);

  const value = useMemo(() => ({ keys, set }), [keys, set]);
  return <DirtyContext.Provider value={value}>{children}</DirtyContext.Provider>;
}

function useDirtyApi(): DirtyApi {
  const api = useContext(DirtyContext);
  if (!api) throw new Error('DirtyProvider is missing');
  return api;
}

/** Registers `key` as dirty while `dirty` is true; cleared automatically on unmount. */
export function useDirty(key: string, dirty: boolean): void {
  const { set } = useDirtyApi();
  useEffect(() => {
    set(key, dirty);
    return () => set(key, false);
  }, [key, dirty, set]);
}

export function useDirtyKeys(): ReadonlySet<string> {
  return useDirtyApi().keys;
}

/** Resolves to true when it is safe to leave: nothing is dirty, or the user chose to discard. */
export function useLeaveGuard(): () => Promise<boolean> {
  const { keys } = useDirtyApi();
  const confirm = useConfirm();
  const discardPrompt = useDiscardPrompt();
  return useCallback(async () => {
    if (keys.size === 0) return true;
    return confirm(discardPrompt);
  }, [keys, confirm, discardPrompt]);
}
