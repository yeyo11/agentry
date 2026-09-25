// Reusable motion primitives. Everything here degrades to a static render when the user asks
// for reduced motion (both through CSS and motion's useReducedMotion).
import { animate, AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Children, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const SPRING = { type: 'spring', stiffness: 520, damping: 38, mass: 0.7 } as const;

/** Fade + small rise, used once per route change (keyed by pathname by the caller). */
export function PageTransition({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}

const STAGGER_STEP = 0.025;
const STAGGER_CAP = 12; // items after this one appear together so long lists never feel slow

/**
 * Staggered entrance for grids and lists. Children are wrapped one by one, so callers keep
 * rendering plain elements: `<Stagger className="cards">{items.map(…)}</Stagger>`.
 */
export function Stagger({
  children,
  className,
  itemClassName,
  style,
}: {
  children: ReactNode;
  className?: string;
  itemClassName?: string;
  style?: CSSProperties;
}) {
  const reduced = useReducedMotion();
  return (
    <div className={className} style={style}>
      {Children.toArray(children).map((child, i) => (
        <motion.div
          key={(child as { key?: string | null }).key ?? i}
          className={itemClassName ?? 'stagger-item'}
          initial={reduced ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: EASE_OUT, delay: Math.min(i, STAGGER_CAP) * STAGGER_STEP }}
        >
          {child}
        </motion.div>
      ))}
    </div>
  );
}

/** Height-animated region for custom accordions and trees. */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className={className}
          style={{ overflow: 'hidden' }}
          initial={reduced ? false : { height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: EASE_OUT }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** A stable id for a shared-layout indicator (one per tab bar / segmented control instance). */
export function useIndicatorId(prefix: string): string {
  return `${prefix}-${useId()}`;
}

/** The sliding underline / pill; render it inside the active item only. */
export function SlidingIndicator({ layoutId, className }: { layoutId: string; className: string }) {
  const reduced = useReducedMotion();
  return <motion.span aria-hidden className={className} layoutId={layoutId} transition={reduced ? { duration: 0 } : SPRING} />;
}

export type DotTone = 'ok' | 'warn' | 'bad' | 'info' | 'idle' | 'active' | 'muted';

/** Status dot; `live` adds the expanding ping ring used for anything that is happening right now. */
export function StatusDot({ tone = 'muted', live = false, title }: { tone?: DotTone; live?: boolean; title?: string }) {
  return (
    <span className={`status-dot tone-${tone} ${live ? 'is-live' : ''}`} title={title} role={title ? 'img' : undefined} aria-label={title}>
      {live && <span className="status-dot-ping" aria-hidden />}
    </span>
  );
}

/** Three bouncing dots shown while Claude is producing a turn. */
export function ThinkingDots({ label }: { label?: string }) {
  const { t } = useTranslation('components');
  return (
    <span className="thinking-dots" role="status" aria-label={label ?? t('ui.claudeIsWorking')}>
      <span />
      <span />
      <span />
    </span>
  );
}

export type UsageTone = 'neutral' | 'warn' | 'bad';

/**
 * The colour of a bar or ring for context, limits or quota (design system §2): neutral below 60 %,
 * warn from 60 %, bad from 75 % or when exhausted. `percent` is 0..100.
 */
export function usageTone(percent: number, exhausted = false): UsageTone {
  if (exhausted || percent >= 75) return 'bad';
  if (percent >= 60) return 'warn';
  return 'neutral';
}

/** Animated SVG ring: usage gauges and stage progress. `value` is 0..1. */
export function ProgressRing({
  value,
  size = 72,
  stroke = 6,
  tone = 'accent',
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  /** `accent` is the brand sweep for a figure that is not a limit; limits take `usageTone` */
  tone?: 'accent' | 'neutral' | 'ok' | 'warn' | 'bad';
  children?: ReactNode;
}) {
  const reduced = useReducedMotion();
  const gradientId = useId();
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, value));
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const offset = circumference * (1 - (mounted || reduced ? clamped : 0));
  return (
    <span className={`ring ring-${tone}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            {/* In style, not as attributes: SVG presentation attributes do not resolve var() */}
            <stop offset="0%" style={{ stopColor: 'var(--ring-from)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--ring-to)' }} />
          </linearGradient>
        </defs>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} fill="none" />
        <circle
          className="ring-value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {children && <span className="ring-label">{children}</span>}
    </span>
  );
}

export { AnimatePresence, motion, useReducedMotion };
