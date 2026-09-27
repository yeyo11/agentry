/**
 * The visible window, when the on-screen keyboard is up.
 *
 * `interactive-widget=resizes-content` (index.html) is the whole answer wherever it is honoured:
 * the layout viewport shrinks, `100dvh` is the room that is left, and nothing here has anything to
 * report. iOS ignores it — the keyboard only shrinks the *visual* viewport there — so the height it
 * covers is measured and the shell (styles/shell.css) takes it off its own height. Without that the
 * app is laid out behind the keyboard and the browser scrolls the window to reveal the field, which
 * takes the top bar off screen and leaves nothing that can be scrolled back.
 *
 * While it is up, `data-keyboard="open"` on `<html>` says so: the keyboard then covers the home
 * indicator, the tab bar and the FAB, and the room the page keeps for them would only push the
 * focused field that far above the keyboard.
 */
import { useEffect } from 'react';

/** Under this the difference is a browser's own bar sliding in or out, not a keyboard. */
const KEYBOARD_MIN_PX = 80;
/**
 * When the viewport is read again after a field lets go of the focus: iOS slides its keyboard away
 * over about a third of a second and may send its last resize halfway, with a height that is
 * neither open nor closed, so one late read is not enough.
 */
const SETTLE_READS_MS = [120, 350, 700];

/** Whether an on-screen keyboard can be up for this element: only something that takes typing. */
function takesTyping(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable || element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLSelectElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(element.type);
}

export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let last = -1;
    let timers: number[] = [];
    // A keyboard was measured open since the last time a field let go of the focus
    let measuredOpen = false;
    const unscroll = () => {
      if (viewport.scale <= 1.01 && (viewport.offsetTop > 0 || window.scrollY > 0)) window.scrollTo(0, 0);
    };
    const update = () => {
      // `visualViewport.height` is what is visible measured through the zoom, so a page the reader
      // pinched into would otherwise read as a keyboard covering most of it
      const covered = Math.round(window.innerHeight - viewport.height * viewport.scale);
      // No field has the focus, so no keyboard is up, whatever a stale reading says: iOS can leave
      // the last one taken halfway through its closing slide
      const inset = covered >= KEYBOARD_MIN_PX && takesTyping(document.activeElement) ? covered : 0;
      if (inset !== last) {
        // The keyboard measured open has just gone: the scroll the browser made to reveal the field
        // stays behind unless undone, leaving the top bar off screen and an empty band where the
        // keyboard was. Only after a measured keyboard: where none was measured (Android resizing
        // the page itself) there is nothing of ours to undo.
        const closed = last > 0 && inset === 0;
        last = inset;
        if (closed) unscroll();
        if (inset) {
          root.style.setProperty('--keyboard-inset', `${inset}px`);
          root.dataset.keyboard = 'open';
        } else {
          root.style.removeProperty('--keyboard-inset');
          delete root.dataset.keyboard;
        }
      }
      // Once the layout ends above the keyboard, a window the browser scrolled to reveal the field
      // has nothing left to reveal: put it back, or the top bar stays off screen for good. Only
      // then — where the keyboard cannot be measured, that scroll is the browser's own way of
      // keeping the field visible and undoing it would leave the field under the keyboard — and
      // never while the page is zoomed, where the reader is the one who moved it.
      if (inset > 0) {
        measuredOpen = true;
        unscroll();
      }
    };
    // iOS does not always send a last resize once its keyboard has slid away: after a field lets go
    // of the focus the viewport is read again through the slide, and once the keyboard is gone the
    // scroll it left is undone (each time, since iOS may scroll again while the slide ends)
    const settle = () => {
      for (const id of timers) window.clearTimeout(id);
      timers = SETTLE_READS_MS.map((ms) =>
        window.setTimeout(() => {
          update();
          if (last === 0 && measuredOpen) unscroll();
          if (ms === SETTLE_READS_MS[SETTLE_READS_MS.length - 1] && last === 0) measuredOpen = false;
        }, ms),
      );
    };
    const onFocusOut = () => settle();
    // Focus moving from one field to the next is not a keyboard closing: read it as it lands
    const onFocusIn = () => update();
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      for (const id of timers) window.clearTimeout(id);
      document.removeEventListener('focusin', onFocusIn);
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      document.removeEventListener('focusout', onFocusOut);
      root.style.removeProperty('--keyboard-inset');
      delete root.dataset.keyboard;
    };
  }, []);
}

