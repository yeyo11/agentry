import { ArrowDownToLine, ArrowUpToLine } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Tooltip } from './controls/Tooltip';
import { ICON_SM } from './icons';

type Position = 'hidden' | 'top' | 'middle' | 'bottom';

/**
 * Jump-to-either-end control for long scrollers. A transcript of a few hundred messages is
 * otherwise only navigable by dragging: you land on one end and the other is thousands of pixels
 * away. It appears only once the content is worth the shortcut.
 */
export function ScrollJump({ screens = 2, label = 'transcript' }: { screens?: number; label?: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<Position>('hidden');
  const scroller = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // The page's scroll container, found from where we are rendered rather than by a global
    // selector, so this keeps working if the shell is restructured.
    const el = anchor.current?.closest<HTMLElement>('.main') ?? null;
    scroller.current = el;
    if (!el) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight < clientHeight * (screens + 1)) return setPosition('hidden');
      if (scrollTop < 120) return setPosition('top');
      if (scrollTop + clientHeight > scrollHeight - 120) return setPosition('bottom');
      setPosition('middle');
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(onScroll);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [screens]);

  if (position === 'hidden') return <span ref={anchor} hidden />;

  const jump = (to: 'top' | 'bottom') => {
    const el = scroller.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: to === 'top' ? 0 : el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  };

  return (
    <>
      <span ref={anchor} hidden />
      <div className="scroll-jump" role="group" aria-label={`Jump within the ${label}`}>
        {position !== 'top' && (
          <Tooltip content="Oldest (top)">
            <button type="button" className="icon-btn" onClick={() => jump('top')} aria-label={`Jump to the start of the ${label}`}>
              <ArrowUpToLine {...ICON_SM} />
            </button>
          </Tooltip>
        )}
        {position !== 'bottom' && (
          <Tooltip content="Newest (bottom)">
            <button type="button" className="icon-btn" onClick={() => jump('bottom')} aria-label={`Jump to the end of the ${label}`}>
              <ArrowDownToLine {...ICON_SM} />
            </button>
          </Tooltip>
        )}
      </div>
    </>
  );
}
