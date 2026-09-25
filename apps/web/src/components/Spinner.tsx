import { spinnerGlyph } from '../lib/live';
import { useAnimationFrameIndex, useDecorativeMotion } from '../lib/motion';

export type SpinnerVariant = 'braille' | 'ring' | 'dots';

/**
 * What an agent at work looks like (docs/design-system.md §3):
 * - `braille`, the terminal's spinner, beside a live verb ("Running");
 * - `ring`, on a task row in progress;
 * - `dots`, while it thinks with no tool running.
 * It is decoration: it carries no text of its own, so whatever it means is said in words beside it
 * or by a `role="status"` further up. At `subtle` and `off` the braille holds a still glyph and the
 * CSS stops the other two.
 */
export function Spinner({ className = '', variant = 'braille' }: { className?: string; variant?: SpinnerVariant }) {
  if (variant === 'ring') return <span className={`spinner-ring ${className}`.trim()} aria-hidden />;
  if (variant === 'dots')
    return (
      <span className={`spinner-dots ${className}`.trim()} aria-hidden>
        <i />
        <i />
        <i />
      </span>
    );
  return <BrailleSpinner className={className} />;
}

function BrailleSpinner({ className }: { className: string }) {
  const moving = useDecorativeMotion();
  const frame = useAnimationFrameIndex();
  return (
    <span className={`spinner-glyph ${className}`.trim()} aria-hidden>
      {spinnerGlyph(frame, moving)}
    </span>
  );
}
