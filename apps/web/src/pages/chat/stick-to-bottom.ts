import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Closer to the end than this is at the end: coming back there follows again. */
const NEAR_END_PX = 80;

/** How long after a wheel, a key or a finger a scroll still counts as the reader's own. */
const INPUT_WINDOW_MS = 1200;

/** Beyond this the end is too far to glide to: the rows in between are estimates, not measured. */
const GLIDE_LIMIT_SCREENS = 2;

/** A glide gets this long to arrive; after it the pin holds the end the plain way again. */
const GLIDE_MS = 700;

/** Keys that scroll up when the scroller, or something in it, has focus. */
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);

/**
 * Keeps a scroller at its end while what is in it grows: rows being measured, stored messages, the
 * block being streamed and the prompts under it all change its height, and each of them scrolling
 * on its own fought the others every frame.
 *
 * Whatever sits directly in the scroller is watched for size, so the pin happens after layout and
 * before paint, without reading the page on every update. It is not the only thing that moves the
 * view — the windowed list anchors to its end as well, which is what keeps a page of older messages
 * from throwing the reader down the transcript — so the pin defers to it: it writes only when the
 * view is actually away from the end, and never over a glide on its way there.
 *
 * Only the reader moving up lets go of the end, and only they: a windowed transcript re-measures
 * rows as they render and moves the scroll position by the difference, which looks exactly like
 * scrolling up and used to leave a conversation that nobody touched showing "jump to latest" while
 * Claude wrote under it.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, mounted: boolean) {
  const [follow, setFollowState] = useState(true);
  const following = useRef(true);
  /** A smooth scroll to the end is in flight: what happens to the view meanwhile is its doing. */
  const gliding = useRef(false);
  const glideEnds = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * To the end in one movement: gliding there when it is within reach, at once when it is a page
   * away. A smooth scroll over rows that have never been measured animates across a height that is
   * a guess, and every row measured on the way moves the end it is heading for: it lands short, in
   * a stretch of transcript that has not been drawn yet.
   */
  const toEnd = useCallback((el: HTMLElement) => {
    const end = el.scrollHeight - el.clientHeight;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || end - el.scrollTop > el.clientHeight * GLIDE_LIMIT_SCREENS) {
      gliding.current = false;
      el.scrollTop = end;
      return;
    }
    gliding.current = true;
    clearTimeout(glideEnds.current);
    glideEnds.current = setTimeout(() => {
      gliding.current = false;
    }, GLIDE_MS);
    el.scrollTo({ top: end, behavior: 'smooth' });
  }, []);

  const setFollow = useCallback(
    (on: boolean) => {
      following.current = on;
      setFollowState(on);
      const el = ref.current;
      if (on && el) toEnd(el);
    },
    [ref, toEnd],
  );

  /** Back to the end, from the button that offers it. */
  const jumpToLatest = useCallback(() => {
    following.current = true;
    setFollowState(true);
    const el = ref.current;
    if (el) toEnd(el);
  }, [ref, toEnd]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastTop = el.scrollTop;
    let touchedAt = 0;
    /** Nothing to scroll: a conversation shorter than its viewport is always at its end. */
    const scrollable = () => el.scrollHeight - el.clientHeight > NEAR_END_PX;
    const resume = () => {
      if (following.current) return;
      following.current = true;
      setFollowState(true);
    };
    const pin = () => {
      // Content that shrank back under the viewport (a card folded, sidechains hidden) has no end
      // to be away from: whoever had scrolled up is at it again
      if (!scrollable()) resume();
      if (following.current) {
        const end = el.scrollHeight - el.clientHeight;
        // Already there: writing it again is a layout read the page does not need, and while the
        // windowed list is measuring rows this runs on every one of them
        if (Math.abs(el.scrollTop - end) > 1) {
          // A glide on its way to the end is cancelled by writing scrollTop; it is sent to the new
          // end instead, so content arriving mid-flight does not turn one movement into two. Unless
          // the end ran away from it by more than a glide covers (a chat came back with thousands
          // of rows held): it would creep over estimated rows until its time ran out, then jump
          if (gliding.current && end - el.scrollTop <= el.clientHeight * GLIDE_LIMIT_SCREENS) el.scrollTo({ top: end, behavior: 'smooth' });
          else {
            gliding.current = false;
            el.scrollTop = end;
          }
        }
      }
      lastTop = el.scrollTop;
    };
    const release = () => {
      if (!following.current || !scrollable()) return;
      following.current = false;
      setFollowState(false);
    };
    const touched = () => {
      touchedAt = performance.now();
      gliding.current = false;
    };
    const onScroll = () => {
      const top = el.scrollTop;
      const movedUp = top < lastTop - 1;
      lastTop = top;
      // A transcript that fits has no end to lose, and a measured row moving the view is not the
      // reader: only a scroll that follows something they did can let go of the end.
      if (!scrollable()) return resume();
      const near = el.scrollHeight - top - el.clientHeight < NEAR_END_PX;
      if (!near && movedUp && performance.now() - touchedAt < INPUT_WINDOW_MS) release();
      else if (near && !movedUp) resume();
    };
    // A small nudge up stays near the end, and while Claude writes the pin would pull it straight
    // back before the scroll could count: a wheel, a key or a finger going up lets go at once
    const onWheel = (event: WheelEvent) => {
      touched();
      if (event.deltaY < 0) release();
    };
    const onKey = (event: KeyboardEvent) => {
      // Keys typed into a field (a prompt's answer) move its caret, not the conversation
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return;
      touched();
      if (UP_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)) release();
    };
    let touchY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touched();
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      touched();
      const y = event.touches[0]?.clientY;
      // The finger going down drags the content down, which shows what is above
      if (touchY !== null && y !== undefined && y > touchY + 2) release();
    };

    const sizes = new ResizeObserver(pin);
    sizes.observe(el);
    for (const child of el.children) sizes.observe(child);
    const children = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) sizes.observe(node);
        for (const node of record.removedNodes) if (node instanceof Element) sizes.unobserve(node);
      }
      pin();
    });
    children.observe(el, { childList: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('keydown', onKey);
    // Dragging the scrollbar scrolls without a wheel or a finger; it still starts with a pointer
    el.addEventListener('pointerdown', touched);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    pin();
    return () => {
      sizes.disconnect();
      children.disconnect();
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('pointerdown', touched);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, [ref, mounted]);

  return { follow, setFollow, jumpToLatest };
}
