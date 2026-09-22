import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Closer to the end than this is at the end: coming back there follows again. */
const NEAR_END_PX = 80;

/** Keys that scroll up when the scroller, or something in it, has focus. */
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);

/**
 * Keeps a scroller at its end while what is in it grows, and is the only thing that does: rows
 * being measured, stored messages, the block being streamed and the prompts under it all change
 * its height, and each of them scrolling on its own fought the others every frame.
 *
 * Whatever sits directly in the scroller is watched for size, so the pin happens after layout and
 * before paint, without reading the page on every update. Only moving up lets go of the end: a
 * view left behind by content growing under it, or on its way down in a smooth jump to the latest,
 * is still following, which is what made the jump button flicker.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, mounted: boolean) {
  const [follow, setFollowState] = useState(true);
  const following = useRef(true);

  const setFollow = useCallback(
    (on: boolean) => {
      following.current = on;
      setFollowState(on);
      const el = ref.current;
      if (on && el) el.scrollTop = el.scrollHeight;
    },
    [ref],
  );

  /** Back to the end, gliding there unless the reader asked for less motion. */
  const jumpToLatest = useCallback(() => {
    following.current = true;
    setFollowState(true);
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  }, [ref]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastTop = el.scrollTop;
    const pin = () => {
      if (following.current) el.scrollTop = el.scrollHeight;
      lastTop = el.scrollTop;
    };
    const release = () => {
      if (!following.current) return;
      following.current = false;
      setFollowState(false);
    };
    const onScroll = () => {
      const top = el.scrollTop;
      const movedUp = top < lastTop - 1;
      lastTop = top;
      const near = el.scrollHeight - top - el.clientHeight < NEAR_END_PX;
      // Rows measured above the view move it by exactly what they move the end, so they never leave
      // it far from the end; moving up and away is the reader (or a jump to a search hit). Coming
      // back near the end follows again, but not on the way up: that is the reader leaving it
      if (!near && movedUp) release();
      else if (near && !movedUp && !following.current) {
        following.current = true;
        setFollowState(true);
      }
    };
    // A small nudge up stays near the end, and while Claude writes the pin would pull it straight
    // back before the scroll could count: a wheel, a key or a finger going up lets go at once
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) release();
    };
    const onKey = (event: KeyboardEvent) => {
      // Keys typed into a field (a prompt's answer) move its caret, not the conversation
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return;
      if (UP_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)) release();
    };
    let touchY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
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
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    pin();
    return () => {
      sizes.disconnect();
      children.disconnect();
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, [ref, mounted]);

  return { follow, setFollow, jumpToLatest };
}
