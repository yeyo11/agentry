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
/** How long iOS takes to slide its keyboard away, after which the viewport is read once more */
const KEYBOARD_CLOSE_MS = 350;

export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let last = -1;
    let timer: number | undefined;
    // A keyboard was measured open since the last time a field let go of the focus
    let measuredOpen = false;
    const unscroll = () => {
      if (viewport.scale <= 1.01 && (viewport.offsetTop > 0 || window.scrollY > 0)) window.scrollTo(0, 0);
    };
    const update = () => {
      // `visualViewport.height` is what is visible measured through the zoom, so a page the reader
      // pinched into would otherwise read as a keyboard covering most of it
      const covered = Math.round(window.innerHeight - viewport.height * viewport.scale);
      const inset = covered >= KEYBOARD_MIN_PX ? covered : 0;
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
    // iOS does not always send a last resize once its keyboard has slid away: a field losing focus
    // reads the viewport again when the slide is over, and undoes the scroll if the keyboard is gone
    const onFocusOut = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        update();
        if (last === 0 && measuredOpen) {
          measuredOpen = false;
          unscroll();
        }
      }, KEYBOARD_CLOSE_MS);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      window.clearTimeout(timer);
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      document.removeEventListener('focusout', onFocusOut);
      root.style.removeProperty('--keyboard-inset');
      delete root.dataset.keyboard;
    };
  }, []);
}

