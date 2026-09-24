/**
 * The visible window, when the on-screen keyboard is up.
 *
 * `interactive-widget=resizes-content` (index.html) is the whole answer wherever it is honoured:
 * the layout viewport shrinks, `100dvh` is the room that is left, and nothing here has anything to
 * report. iOS ignores it — the keyboard only shrinks the *visual* viewport there — so the height it
 * covers is measured and the shell (styles/shell.css) takes it off its own height. Without that the
 * app is laid out behind the keyboard and the browser scrolls the window to reveal the field, which
 * takes the top bar off screen and leaves nothing that can be scrolled back.
 */
import { useEffect } from 'react';

/** Under this the difference is a browser's own bar sliding in or out, not a keyboard. */
const KEYBOARD_MIN_PX = 80;

export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let last = -1;
    const update = () => {
      // `visualViewport.height` is what is visible measured through the zoom, so a page the reader
      // pinched into would otherwise read as a keyboard covering most of it
      const covered = Math.round(window.innerHeight - viewport.height * viewport.scale);
      const inset = covered >= KEYBOARD_MIN_PX ? covered : 0;
      if (inset !== last) {
        last = inset;
        if (inset) root.style.setProperty('--keyboard-inset', `${inset}px`);
        else root.style.removeProperty('--keyboard-inset');
      }
      // Once the layout ends above the keyboard, a window the browser scrolled to reveal the field
      // has nothing left to reveal: put it back, or the top bar stays off screen for good. Only
      // then — where the keyboard cannot be measured, that scroll is the browser's own way of
      // keeping the field visible and undoing it would leave the field under the keyboard — and
      // never while the page is zoomed, where the reader is the one who moved it.
      if (inset > 0 && viewport.scale <= 1.01 && (viewport.offsetTop > 0 || window.scrollY > 0)) window.scrollTo(0, 0);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.style.removeProperty('--keyboard-inset');
    };
  }, []);
}

