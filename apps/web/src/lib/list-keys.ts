import { useEffect, useRef } from 'react';

/**
 * The keys a list answers to, as in a terminal mail reader: `j`/`k` move, `Enter` opens, `x`
 * selects, `/` goes to the search field and `Escape` lets go of the selection.
 */
export type ListKey = 'next' | 'previous' | 'open' | 'select' | 'search' | 'clear';

const KEYS: Record<string, ListKey> = { j: 'next', k: 'previous', Enter: 'open', x: 'select', '/': 'search', Escape: 'clear' };

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface TargetLike {
  tagName: string;
  isContentEditable: boolean;
  getAttribute(name: string): string | null;
}

/** Where a letter is text or a control's own key, and must reach it untouched. */
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const OWN_KEYS_ROLES = new Set(['combobox', 'listbox', 'menu', 'menuitem', 'option', 'radio', 'slider', 'spinbutton', 'tab', 'textbox']);

/**
 * What a key press means to the list, or null when it is someone else's: a letter typed into a
 * field, a shortcut with a modifier, or `Enter` on a button or a link, which already does what it
 * says. `Enter` is the list's only while focus is on nothing in particular.
 */
export function listKeyAction(event: KeyLike, target: TargetLike | null): ListKey | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const action = KEYS[event.key];
  if (!action) return null;
  if (target) {
    if (TYPING_TAGS.has(target.tagName) || target.isContentEditable) return null;
    const role = target.getAttribute('role');
    if (role && OWN_KEYS_ROLES.has(role)) return null;
    if (action === 'open' && (target.tagName === 'A' || target.tagName === 'BUTTON' || role === 'button' || role === 'checkbox')) return null;
  }
  return action;
}

/**
 * Listens on the document while `enabled`, for the page that owns the list. Nothing is handled
 * while a dialog, a menu or a popover is open above the page: its keys are its own.
 */
export function useListKeys(enabled: boolean, handle: (action: ListKey, event: KeyboardEvent) => void, blocked: () => boolean): void {
  const latest = useRef({ handle, blocked });
  latest.current = { handle, blocked };
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || latest.current.blocked()) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = listKeyAction(event, target && target !== document.body ? target : null);
      if (!action) return;
      latest.current.handle(action, event);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}
