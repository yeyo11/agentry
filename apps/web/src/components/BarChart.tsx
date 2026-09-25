import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { labelStride, niceScale } from '../lib/usage-view';
import { useWidth } from '../lib/use-width';

export interface Bar {
  key: string;
  /** Under the bar, when there is room */
  label: string;
  /** Null draws no bar: there is no figure, which is not the same as zero */
  value: number | null;
}

const PAD = { top: 12, right: 8, bottom: 26, left: 56 };
/** Below this width the chart is on a phone: shorter, so the page around it stays in view */
const NARROW = 480;
/** How far from an edge the tooltip stops being centred on its bar, so it never leaves the card */
const TIP_EDGE = 72;

/** A bar with a rounded top and a square foot, so it sits on the baseline. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + w - radius} Q${x + w},${y} ${x + w},${y + radius} V${y + h} Z`;
}

/**
 * One series drawn as bars, from SVG alone. It is a picture for the eye: the figures behind it are
 * in a table beside it, `description` summarises them for a screen reader, and the hovered or
 * focused bar is read out as text in a tooltip, so nothing is said by colour or position alone.
 * The bars take the brand gradient from the theme's tokens, so it reads in both themes; the
 * highest one is the only one at full strength.
 */
export function BarChart({
  bars,
  formatAxis,
  integer,
  label,
  description,
  active,
  onActive,
  tip,
}: {
  bars: readonly Bar[];
  formatAxis: (value: number) => string;
  /** The values are whole numbers: no gridline between two of them */
  integer: boolean;
  /** Names the picture */
  label: string;
  /** What it shows, in words: the total, the peak, the range */
  description: string;
  active: number | null;
  onActive: (index: number | null) => void;
  /** The figures of one bar, shown over it on hover and read out when it is reached by keyboard */
  tip?: (index: number) => ReactNode;
}) {
  const [ref, width] = useWidth(240);
  const descriptionId = useId();
  // An id that is safe inside `url(#…)`
  const gradientId = `bar-grad-${useId().replace(/[^\w-]/g, '')}`;
  const [keyboard, setKeyboard] = useState(false);

  const height = width < NARROW ? 180 : 260;
  const scale = niceScale(Math.max(0, ...bars.map((b) => b.value ?? 0)), 3, integer);
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const step = bars.length > 0 ? plotW / bars.length : plotW;
  const barW = Math.max(2, Math.min(28, step * 0.72));
  const stride = labelStride(bars.length, plotW);
  const y = (v: number) => PAD.top + plotH - (v / scale.max) * plotH;
  const cx = (i: number) => PAD.left + step * i + step / 2;

  let peak: number | null = null;
  for (const [i, bar] of bars.entries()) {
    if (bar.value !== null && bar.value > 0 && (peak === null || bar.value > (bars[peak]?.value ?? 0))) peak = i;
  }

  const move = (event: KeyboardEvent<SVGSVGElement>) => {
    if (bars.length === 0) return;
    const last = bars.length - 1;
    const from = active ?? peak ?? last;
    const keys: Record<string, number> = { ArrowLeft: Math.max(0, from - 1), ArrowRight: Math.min(last, from + 1), Home: 0, End: last };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setKeyboard(true);
    onActive(next);
  };

  const shown = active === null ? undefined : bars[active];
  const tipX = active === null ? 0 : cx(active);
  const tipSide = tipX < PAD.left + TIP_EDGE ? 'is-start' : tipX > width - PAD.right - TIP_EDGE ? 'is-end' : '';

  return (
    <div ref={ref} className="chart">
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
      <svg
        role="img"
        aria-label={label}
        aria-describedby={descriptionId}
        tabIndex={0}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onMouseLeave={() => !keyboard && onActive(null)}
        onKeyDown={move}
        onFocus={() => {
          setKeyboard(true);
          if (active === null) onActive(peak ?? (bars.length > 0 ? bars.length - 1 : null));
        }}
        onBlur={() => {
          setKeyboard(false);
          onActive(null);
        }}
      >
        <defs>
          {/* Top to bottom, from the accent into the rose: the stops take their colour in CSS */}
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="chart-stop-top" />
            <stop offset="100%" className="chart-stop-foot" />
          </linearGradient>
        </defs>
        {scale.ticks.map((tick) => (
          <g key={tick}>
            {tick > 0 && <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />}
            <text className="chart-axis" x={PAD.left - 10} y={y(tick)} textAnchor="end" dominantBaseline="middle">
              {formatAxis(tick)}
            </text>
          </g>
        ))}
        {bars.map((bar, i) => {
          const h = bar.value === null ? 0 : (bar.value / scale.max) * plotH;
          const state = [i === peak ? 'is-peak' : '', active === i ? 'is-active' : ''].filter(Boolean).join(' ');
          return (
            <g key={bar.key}>
              {h > 0 ? (
                <path className={`chart-bar ${state}`} fill={`url(#${gradientId})`} d={barPath(cx(i) - barW / 2, y(bar.value ?? 0), barW, Math.max(h, 1), 4)} />
              ) : (
                // A day with nothing still has its place on the axis, so a gap reads as a quiet day and not a missing one
                bar.value === 0 && <rect className={`chart-stub ${active === i ? 'is-active' : ''}`} x={cx(i) - barW / 2} y={y(0) - 2} width={barW} height={2} />
              )}
              {i % stride === 0 && (
                <text className="chart-axis" x={cx(i)} y={height - 8} textAnchor="middle">
                  {bar.label}
                </text>
              )}
              {/* The hit target is the whole column, not just the bar: an empty day is worth reading too */}
              <rect
                className="chart-hit"
                x={PAD.left + step * i}
                y={PAD.top}
                width={step}
                height={plotH}
                onMouseEnter={() => {
                  setKeyboard(false);
                  onActive(i);
                }}
                onClick={() => onActive(i)}
              />
            </g>
          );
        })}
        <line className="chart-base" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
      </svg>
      {tip && shown && active !== null && (
        <div className={`chart-tip ${tipSide}`} style={{ left: tipX, top: y(shown.value ?? 0) - 8 }} aria-hidden>
          {tip(active)}
        </div>
      )}
      {/* The pointer has the picture; a keyboard reader hears the same figures as it moves */}
      <div className="sr-only" aria-live="polite">
        {tip && keyboard && active !== null ? tip(active) : null}
      </div>
    </div>
  );
}
