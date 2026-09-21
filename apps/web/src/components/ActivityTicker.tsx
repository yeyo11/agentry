import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { activityTarget, activityVerb, elapsedSince, formatElapsed, type TickerActivity } from '../lib/live';
import { useClockTick, useMotionLevel } from '../lib/motion';
import { AnimatePresence, EASE_OUT, motion } from './motion';
import { Spinner } from './Spinner';

/** A screen reader is not a ticker: it hears what changed, and no more often than this. */
const ANNOUNCE_EVERY_MS = 5000;

/**
 * The one line that says what an agent is doing right now, from the same stream-json events the
 * transcript is built from: a spinner, a verb, what it is working on in mono, and how long it has
 * been at it. It is one line and it ends in an ellipsis; it never wraps.
 */
export function ActivityTicker({
  activity,
  className = '',
  showElapsed = true,
}: {
  activity: TickerActivity | null | undefined;
  className?: string;
  showElapsed?: boolean;
}) {
  const { t } = useTranslation('primitives');
  const level = useMotionLevel();
  const tick = useClockTick(1000);
  const verb = activity ? t(`activity.${activityVerb(activity)}`) : '';
  const target = activity ? activityTarget(activity) : '';
  const since = activity?.since;
  // The tick is a dependency, not a value: it is what makes the clock below read the time again.
  const elapsed = useMemo(() => (since && showElapsed ? formatElapsed(elapsedSince(since)) : ''), [since, showElapsed, tick]);
  const announcement = useThrottled(activity ? [verb, target].filter(Boolean).join(' ') : '');

  if (!activity) return null;

  return (
    <span className={`ticker ${className}`.trim()}>
      <span className="ticker-line" aria-hidden>
        <Spinner className="ticker-spinner" />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={`${verb}|${target}`}
            className="ticker-what"
            initial={level === 'full' ? { opacity: 0, y: 4 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={level === 'full' ? { opacity: 0, y: -4 } : { opacity: 0 }}
            transition={{ duration: 0.16, ease: EASE_OUT }}
          >
            <span className="ticker-verb">{verb}</span>
            {target && <span className="ticker-target">{target}</span>}
          </motion.span>
        </AnimatePresence>
        {elapsed && <span className="ticker-elapsed">{elapsed}</span>}
      </span>
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </span>
  );
}

/** Holds a value back until enough time has passed since the last one it let through. */
function useThrottled(value: string): string {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const since = Date.now() - last.current;
    if (since >= ANNOUNCE_EVERY_MS) {
      last.current = Date.now();
      setShown(value);
      return;
    }
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown(value);
    }, ANNOUNCE_EVERY_MS - since);
    return () => clearTimeout(timer);
  }, [value]);
  return shown;
}
