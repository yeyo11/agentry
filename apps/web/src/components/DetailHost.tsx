import { lazy, Suspense, useCallback, useRef } from 'react';
import { useDetailPanel } from '../lib/detail';

// The transcript renderer, the follow-scroll logic and the readers it needs: none of it is worth
// shipping to someone who never opens a panel
const DetailPanel = lazy(() => import('./DetailPanel'));

/** Mounted once in the shell: shows the panel named by `?detail=…`, whatever page it is on. */
export function DetailHost() {
  const { current, close } = useDetailPanel();
  // The dialog re-focuses whenever its `onClose` changes, and `close` changes with the address
  const latest = useRef(close);
  latest.current = close;
  const onClose = useCallback(() => latest.current(), []);
  if (!current) return null;
  return (
    <Suspense fallback={null}>
      <DetailPanel target={current} onClose={onClose} />
    </Suspense>
  );
}
