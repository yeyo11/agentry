import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Closer to the end than this is at the end: coming back there follows again. */
const NEAR_END_PX = 80;

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
    const onScroll = () => {
      const top = el.scrollTop;
      const movedUp = top < lastTop - 1;
      lastTop = top;
      const near = el.scrollHeight - top - el.clientHeight < NEAR_END_PX;
      if (near === following.current) return;
      // Rows measured above the view move it by exactly what they move the end, so they never leave
      // it far from the end; moving up and away is the reader (or a jump to a search hit)
      if (near || movedUp) {
        following.current = near;
        setFollowState(near);
      }
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
    pin();
    return () => {
      sizes.disconnect();
      children.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  }, [ref, mounted]);

  return { follow, setFollow, jumpToLatest };
}
