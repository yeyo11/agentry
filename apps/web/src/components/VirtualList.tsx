import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Row height assumed for a row that has never been on screen, until a real one is measured. */
const FIRST_GUESS = 140;

/** Rows kept mounted beyond each edge of the viewport. */
const OVERSCAN = 6;

/** How long a focused row is held in view while the rows around it are measured. */
const SETTLE_MS = 1500;

/**
 * Windowed list: only the rows near the viewport are in the DOM and the rest are two paddings that
 * stand in for their height. A conversation of a couple of thousand messages is otherwise ~60k
 * nodes on the page, and at that size every forced layout anywhere — the composer measuring itself
 * on each keystroke — walks the whole tree, which is what makes typing stutter.
 *
 * `anchorTo: 'end'` is what makes a transcript behave: heights are measured as rows render, and a
 * row that turns out taller than its estimate must not push what the reader is looking at. It
 * covers loading earlier messages too, which inserts thousands of pixels above the viewport.
 */
export function VirtualList<T>({
  items,
  itemKey,
  className,
  pinToBottom = false,
  onReachTop,
  focus,
  children,
}: {
  items: T[];
  itemKey: (item: T, index: number) => string;
  className?: string;
  /**
   * Whoever owns the scroller keeps it at the end (the list does not scroll there itself: one owner
   * for the pin, or they fight). Said here so the top of a list that has not been scrolled yet
   * does not read as the reader asking for what is above it.
   */
  pinToBottom?: boolean;
  /** The window reached the first row held: whatever comes before it, if anything, is wanted now. */
  onReachTop?: () => void;
  /**
   * A row to bring into view and mark with `data-focused`, e.g. a search hit. A new object scrolls
   * again, even to the same row: pressing Enter on the only hit brings it back.
   */
  focus?: { item: T } | null;
  children: (item: T, index: number) => ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // The gap belongs to the layout, and the virtualizer has to account for it to place rows
  const [gap, setGap] = useState(0);
  // The list rarely starts at the top of its scroller: cards, a header and the button that loads
  // earlier messages all sit above it, and that distance changes as they come and go.
  const [margin, setMargin] = useState(0);

  // Measured when something moves the list rather than on every render: the virtualizer renders
  // on every scrolled frame, and reading layout there forced it once more per frame
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    // Found from where we are rendered rather than by a global selector, the way ScrollJump does
    const found = el.closest<HTMLElement>('[data-scroll-root], .main');
    setScroller(found);
    const measure = () => {
      const offset = found ? el.getBoundingClientRect().top - found.getBoundingClientRect().top + found.scrollTop : 0;
      setGap(Number.parseFloat(getComputedStyle(el).rowGap) || 0);
      setMargin((held) => (Math.abs(held - offset) > 0.5 ? offset : held));
    };
    measure();
    if (!found) return;
    // What moves the list is what sits above it in the scroller: each box before it, on each level
    // up to the scroller, and the list itself (its gap follows the layout)
    const sizes = new ResizeObserver(measure);
    const levels: Element[] = [];
    const watch = () => {
      sizes.disconnect();
      sizes.observe(el);
      for (let node: Element | null = el; node && node !== found; node = node.parentElement) {
        for (let before = node.previousElementSibling; before; before = before.previousElementSibling) sizes.observe(before);
      }
    };
    for (let node: Element | null = el.parentElement; node; node = node === found ? null : node.parentElement) levels.push(node);
    // A box that comes or goes above the list (the button that loads earlier messages) moves it too
    const children = new MutationObserver(() => {
      watch();
      measure();
    });
    for (const level of levels) children.observe(level, { childList: true });
    watch();
    return () => {
      sizes.disconnect();
      children.disconnect();
    };
  }, []);

  const rows = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller,
    estimateSize: () => FIRST_GUESS,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : itemKey(item, index);
    },
    overscan: OVERSCAN,
    gap,
    scrollMargin: margin,
    anchorTo: 'end',
  });

  // The default only compensates a row measured for the first time when it starts above the scroll
  // offset. Loading earlier messages while the header above the list is in view breaks that: the
  // jump lands with freshly prepended rows inside the viewport, just above the row being read, and
  // each one that turns out shorter or taller than its estimate would drag that row with it.
  useLayoutEffect(() => {
    rows.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      const offset = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
      const measured = (key: VirtualItem['key']) => instance.itemSizeCache.has(key);
      if (measured(item.key)) return item.end <= offset && instance.scrollDirection !== 'backward';
      if (item.start < offset) return true;
      const bottom = offset + (instance.scrollRect?.height ?? 0);
      return instance.getVirtualItems().some((v) => v.index > item.index && v.start < bottom && v.end > offset && measured(v.key));
    };
  }, [rows]);

  const visible = rows.getVirtualItems();
  const first = visible[0];
  const last = visible[visible.length - 1];
  const total = rows.getTotalSize();
  // Rows are placed in the scroller's coordinates (they carry `scrollMargin`), while the total is
  // the list's own height, without it. Both paddings are the list's, so the margin comes off first.
  const before = first ? Math.max(0, first.start - margin) : 0;
  const after = last ? Math.max(0, total - (last.end - margin)) : 0;

  // Pinned, the window only starts at the first row because nothing has been scrolled yet: a list
  // mounts at its top before it is taken to its end. Loading on that would fetch pages nobody
  // asked for, twice over, since `onReachTop` changes as soon as the first of them lands.
  useEffect(() => {
    if (first?.index === 0 && !pinToBottom) onReachTop?.();
  }, [first?.index, onReachTop, pinToBottom]);

  const focused = focus ? items.indexOf(focus.item) : -1;
  // One scroll is not enough to reach a row far away: it is placed by estimated heights, which
  // change as the rows around it are measured, and pages loading above it move it too. Keep it in
  // view while that settles, and let go the moment the reader scrolls. A row already in view is
  // left where it is, so whoever scrolled within it (to a match in a tall row) is not undone.
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (!focus || !scroller) return;
    setSettling(true);
    const release = () => setSettling(false);
    const settled = setTimeout(release, SETTLE_MS);
    scroller.addEventListener('wheel', release, { passive: true, once: true });
    scroller.addEventListener('touchmove', release, { passive: true, once: true });
    return () => {
      clearTimeout(settled);
      scroller.removeEventListener('wheel', release);
      scroller.removeEventListener('touchmove', release);
    };
  }, [focus, scroller]);
  useEffect(() => {
    if (!settling || focused < 0 || !scroller) return;
    let frame = 0;
    const hold = () => {
      frame = 0;
      const row = host.current?.querySelector('[data-focused]')?.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      const shown = row ? Math.min(row.bottom, view.bottom) - Math.max(row.top, view.top) : 0;
      if (row && shown >= Math.min(row.height, view.height) / 2) return;
      rows.scrollToIndex(focused, { align: 'center' });
    };
    hold();
    // A row growing above the viewport scrolls it (the list is anchored to its end) without
    // changing anything this effect depends on
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(hold);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [settling, focused, total, scroller, rows]);

  return (
    <div ref={host} className={className} style={{ paddingTop: before, paddingBottom: after }}>
      {visible.map((row) => {
        const item = items[row.index];
        if (item === undefined) return null;
        return (
          // The wrapper is what the virtualizer measures; the row inside it stays as it was
          <div key={row.key} data-index={row.index} data-focused={row.index === focused || undefined} ref={rows.measureElement}>
            {children(item, row.index)}
          </div>
        );
      })}
    </div>
  );
}
