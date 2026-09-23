import { useCallback, useMemo } from 'react';
import { DETAIL_PARAM, decodeDetail, encodeDetail, type DetailRef } from '@agentry/shared';
import { useSearchParams } from 'react-router-dom';

/*
 * The side panel as a place in the address bar. The encoding itself moved to `@agentry/shared`, so
 * that the notification mapping the server also runs can build the same links; what is left here is
 * the hook that turns one into a navigation.
 */

export { DETAIL_PARAM, decodeDetail, detailHref, encodeDetail, type DetailRef } from '@agentry/shared';

/**
 * The panel is part of the address (`?detail=…`), so opening one is a navigation: Back closes it
 * and a reload brings it back. Other search params of the page are left as they are.
 */
export function useDetailPanel(): { current: DetailRef | null; open: (ref: DetailRef) => void; close: () => void } {
  const [params, setParams] = useSearchParams();
  const value = params.get(DETAIL_PARAM);
  const current = useMemo(() => decodeDetail(value), [value]);
  const open = useCallback(
    (ref: DetailRef) =>
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set(DETAIL_PARAM, encodeDetail(ref));
          return next;
        },
        // Opening another panel from inside one replaces it rather than stacking Back steps
        { replace: value !== null },
      ),
    [setParams, value],
  );
  const close = useCallback(
    () =>
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete(DETAIL_PARAM);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  return { current, open, close };
}
