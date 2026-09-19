import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Row height assumed for a row that has never been on screen, until a real one is measured. */
const FIRST_GUESS = 140;

/** Rows kept mounted beyond each edge of the viewport. */
const OVERSCAN = 6;

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
  children,
}: {
  items: T[];
  itemKey: (item: T, index: number) => string;
  className?: string;
  /** Follow the newest row, for a transcript that is still being written */
  pinToBottom?: boolean;
  /** The window reached the first row held: whatever comes before it, if anything, is wanted now. */
  onReachTop?: () => void;
  children: (item: T, index: number) => ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // The gap belongs to the layout, and the virtualizer has to account for it to place rows
  const [gap, setGap] = useState(0);
  // The list rarely starts at the top of its scroller: cards, a header and the button that loads
  // earlier messages all sit above it, and that distance changes as they come and go.
  const [margin, setMargin] = useState(0);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    // Found from where we are rendered rather than by a global selector, the way ScrollJump does
    const found = el.closest<HTMLElement>('[data-scroll-root], .main');
    const offset = found ? el.getBoundingClientRect().top - found.getBoundingClientRect().top + found.scrollTop : 0;
    setScroller(found);
    setGap(Number.parseFloat(getComputedStyle(el).rowGap) || 0);
    setMargin((held) => (Math.abs(held - offset) > 0.5 ? offset : held));
  });

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
    followOnAppend: pinToBottom,
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

  // Opening a transcript lands on its newest message. Rows are estimated until they render, so the
  // bottom keeps moving as they are measured: follow it while the total grows, which stops as soon
  // as the rows on screen are measured, or as soon as the reader scrolls away and unsets this.
  useEffect(() => {
    if (pinToBottom && items.length > 0) rows.scrollToEnd();
  }, [pinToBottom, items.length, total, rows]);

  // Pinned, the window only starts at the first row because nothing has been scrolled yet: a list
  // mounts at its top before it is taken to its end. Loading on that would fetch pages nobody
  // asked for, twice over, since `onReachTop` changes as soon as the first of them lands.
  useEffect(() => {
    if (first?.index === 0 && !pinToBottom) onReachTop?.();
  }, [first?.index, onReachTop, pinToBottom]);

  return (
    <div ref={host} className={className} style={{ paddingTop: before, paddingBottom: after }}>
      {visible.map((row) => {
        const item = items[row.index];
        if (item === undefined) return null;
        return (
          // The wrapper is what the virtualizer measures; the row inside it stays as it was
          <div key={row.key} data-index={row.index} ref={rows.measureElement}>
            {children(item, row.index)}
          </div>
        );
      })}
    </div>
  );
}
