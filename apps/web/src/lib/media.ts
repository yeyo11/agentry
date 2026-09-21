/**
 * Media queries from React, for the handful of places where a breakpoint changes *what* is
 * rendered and not only how it looks: a popover that becomes a sheet, a bottom tab bar that
 * replaces a sidebar. Anything that is only a matter of layout stays in CSS.
 */
import { useSyncExternalStore } from 'react';

/** Below this the UI is a phone's: one column, bottom bars, sheets instead of popovers. */
export const NARROW = '(max-width: 900px)';

/** The width from which a chat can afford a side panel next to its transcript. */
export const WIDE = '(min-width: 1100px)';

/** A finger, not a pointer: touch targets grow and hover-only affordances need another way in. */
export const COARSE = '(pointer: coarse)';

const lists = new Map<string, MediaQueryList>();

function listFor(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || !window.matchMedia) return null;
  const existing = lists.get(query);
  if (existing) return existing;
  const created = window.matchMedia(query);
  lists.set(query, created);
  return created;
}

export function useMediaQuery(query: string): boolean {
  const list = listFor(query);
  return useSyncExternalStore(
    (listener) => {
      list?.addEventListener('change', listener);
      return () => list?.removeEventListener('change', listener);
    },
    () => list?.matches ?? false,
    () => false,
  );
}
