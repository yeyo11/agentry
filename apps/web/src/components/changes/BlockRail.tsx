import { useEffect, useMemo, useState, type MouseEvent, type RefObject } from 'react';
import type { BlockMark } from '../../lib/diff';

// The block rail (design system §5): the whole file to scale beside the diff, a mark per change
// block, the viewport as a box, and a click that jumps to the nearest block. `j`/`k` do the same
// from the keyboard, so the rail itself stays out of the accessibility tree.

/** Part of the file, as fractions of its height */
export interface RailView {
  top: number;
  height: number;
}

const pct = (fraction: number) => `${(Math.min(1, Math.max(0, fraction)) * 100).toFixed(2)}%`;

/** Stretches of the rail a tick can stand for on its own: below this a tick is under a pixel apart */
export const RAIL_BUCKETS = 240;

export interface RailTick {
  key: number;
  kind: BlockMark['kind'];
  /** Fractions of the file's height */
  top: number;
  height: number;
  current: boolean;
}

/**
 * The ticks the rail draws: one per block, except that blocks landing on the same stretch of the
 * rail become one tick. A generated file has thousands of blocks for a few hundred pixels, and a
 * tick per block is what made every scroll frame lay out thousands of boxes.
 */
export function railTicks(marks: BlockMark[], total: number, current: number | null = null, buckets = RAIL_BUCKETS): RailTick[] {
  const lines = Math.max(total, 1);
  const ticks: RailTick[] = [];
  let bucket = -1;
  for (const m of marks) {
    const top = (m.newLine - 1) / lines;
    const height = Math.max(m.adds, 1) / lines;
    const at = Math.floor(top * buckets);
    const last = ticks[ticks.length - 1];
    if (last && at === bucket) {
      last.height = Math.max(last.height, top + height - last.top);
      if (last.kind !== m.kind) last.kind = 'mod';
      if (m.index === current) last.current = true;
      continue;
    }
    bucket = at;
    ticks.push({ key: m.index, kind: m.kind, top, height, current: m.index === current });
  }
  return ticks;
}

export function BlockRail({
  marks,
  total,
  current = null,
  view = null,
  onJump,
}: {
  marks: BlockMark[];
  /** Lines of the file the rail stands for */
  total: number;
  current?: number | null;
  view?: RailView | null;
  onJump?: (block: number) => void;
}) {
  const lines = Math.max(total, 1);
  // Built once per diff and block, so the view box moving on every scroll re-renders nothing else
  const ticks = useMemo(
    () =>
      railTicks(marks, lines, current).map((tick) => (
        <i key={tick.key} className={`diff-rail-tick is-${tick.kind}${tick.current ? ' is-current' : ''}`} style={{ top: pct(tick.top), height: pct(tick.height) }} />
      )),
    [marks, lines, current],
  );
  const jump = (e: MouseEvent<HTMLDivElement>) => {
    if (!onJump || marks.length === 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const line = ((e.clientY - box.top) / Math.max(box.height, 1)) * lines + 1;
    let nearest = marks[0]!;
    for (const m of marks) if (Math.abs(m.newLine - line) < Math.abs(nearest.newLine - line)) nearest = m;
    onJump(nearest.index);
  };
  return (
    <div className="diff-rail" aria-hidden="true" onClick={jump}>
      {view && <div className="diff-rail-view" style={{ top: pct(view.top), height: pct(view.height) }} />}
      {ticks}
    </div>
  );
}

/**
 * The rail beside a scrolling diff. It keeps the view box to itself, so a scroll re-renders the
 * rail and not the rows of the diff; and it mounts with the diff, so both elements exist by then.
 */
export function ScrollingBlockRail({
  scroller,
  content,
  ...rail
}: Omit<Parameters<typeof BlockRail>[0], 'view'> & { scroller: RefObject<HTMLElement | null>; content: RefObject<HTMLElement | null> }) {
  const view = useRailView(scroller, content);
  return <BlockRail {...rail} view={view} />;
}

/**
 * The part of `content` that `scroller` shows, as fractions of the content's height, kept up to
 * date as it scrolls and resizes.
 */
export function useRailView(scroller: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>): RailView | null {
  const [view, setView] = useState<RailView | null>(null);
  useEffect(() => {
    const s = scroller.current;
    const c = content.current;
    if (!s || !c) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const height = c.scrollHeight || 1;
      const top = c.getBoundingClientRect().top - s.getBoundingClientRect().top;
      const next = { top: Math.max(0, -top) / height, height: Math.min(1, s.clientHeight / height) };
      setView((held) => (held && Math.abs(held.top - next.top) < 0.001 && Math.abs(held.height - next.height) < 0.001 ? held : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    s.addEventListener('scroll', schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(s);
    resize.observe(c);
    return () => {
      s.removeEventListener('scroll', schedule);
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scroller, content]);
  return view;
}
