import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Closer to the end than this is at the end: coming back there follows again. */
const NEAR_END_PX = 80;

/** How long after a wheel, a touch or a key a scroll away from the end is taken as the reader's. */
const INTENT_MS = 250;

/** Keys that scroll up when the scroller has focus. */
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);

/**
 * Keeps a scroller at its end while what is in it grows, and is the only thing that does: rows
 * being measured, stored messages, the block being streamed and the prompts under it all change
 * its height, and each of them scrolling on its own fought the others every frame.
 *
 * Whatever sits directly in the scroller is watched for size, so the pin happens after layout and
 * before paint, without reading the page on every update. Only the reader lets go of the end: a
 * scroll away from it counts when it follows a wheel, a touch, a key or a drag of the scrollbar,
 * never when it is the page's own (a smooth jump to the latest, content moving under the view),
 * which is what made the jump button flicker.
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
    let intentUntil = 0;
    let dragging = false;
    const intend = () => {
      intentUntil = performance.now() + INTENT_MS;
    };
    const pin = () => {
      if (following.current) el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance < NEAR_END_PX) {
        if (!following.current) {
          following.current = true;
          setFollowState(true);
        }
        return;
      }
      if (following.current && (dragging || performance.now() < intentUntil)) {
        following.current = false;
        setFollowState(false);
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) intend();
    };
    const onKey = (event: KeyboardEvent) => {
      if (UP_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)) intend();
    };
    // A press on the scroller itself rather than on anything in it is a press on its scrollbar
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === el) dragging = true;
    };
    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      intend();
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
    el.addEventListener('touchmove', intend, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    pin();
    return () => {
      sizes.disconnect();
      children.disconnect();
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', intend);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [ref, mounted]);

  return { follow, setFollow, jumpToLatest };
}
