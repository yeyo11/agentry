import { animate } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useMotionLevel } from '../lib/motion';

/**
 * A number that counts from what it was to what it is, in tabular figures so it does not jitter
 * while it runs. The formatting is the caller's (`formatCost`, `formatNumber`…) because only the
 * caller knows whether it is dollars, tokens or tasks. At motion level `off` it simply changes.
 */
export function AnimatedNumber({
  value,
  format = (n) => String(Math.round(n)),
  duration = 0.6,
  className = '',
}: {
  value: number;
  format?: (value: number) => string;
  duration?: number;
  className?: string;
}) {
  const level = useMotionLevel();
  const [shown, setShown] = useState(value);
  const previous = useRef(value);

  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (level === 'off' || from === value || !Number.isFinite(from) || !Number.isFinite(value)) {
      setShown(value);
      return;
    }
    const controls = animate(from, value, { duration, ease: [0.16, 1, 0.3, 1], onUpdate: setShown });
    return () => controls.stop();
  }, [value, level, duration]);

  return <span className={`tnum ${className}`.trim()}>{format(shown)}</span>;
}
