import { spinnerGlyph } from '../lib/live';
import { useAnimationFrameIndex, useDecorativeMotion } from '../lib/motion';

/**
 * The braille spinner a terminal draws. It is decoration: it carries no text of its own, so
 * whatever it means ("Working", "Running") is said in words beside it or by a `role="status"`
 * further up. At `subtle` and `off` it holds a still glyph instead of turning.
 */
export function Spinner({ className = '' }: { className?: string }) {
  const moving = useDecorativeMotion();
  const frame = useAnimationFrameIndex();
  return (
    <span className={`spinner-glyph ${className}`.trim()} aria-hidden>
      {spinnerGlyph(frame, moving)}
    </span>
  );
}
