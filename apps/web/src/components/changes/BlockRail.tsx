import { useEffect, useState, type MouseEvent, type RefObject } from 'react';
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
      {marks.map((m) => (
        <i
          key={m.index}
          className={`diff-rail-tick is-${m.kind}${m.index === current ? ' is-current' : ''}`}
          style={{ top: pct((m.newLine - 1) / lines), height: pct(Math.max(m.adds, 1) / lines) }}
        />
      ))}
    </div>
  );
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
