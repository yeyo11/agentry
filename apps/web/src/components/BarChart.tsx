import { useId, useState } from 'react';
import { labelStride, niceScale } from '../lib/usage-view';
import { useWidth } from '../lib/use-width';

export interface Bar {
  key: string;
  /** Under the bar, when there is room */
  label: string;
  /** Null draws no bar: there is no figure, which is not the same as zero */
  value: number | null;
}

const HEIGHT = 220;
const PAD = { top: 10, right: 8, bottom: 26, left: 56 };

/** A bar with a rounded top and a square foot, so it sits on the baseline. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + w - radius} Q${x + w},${y} ${x + w},${y + radius} V${y + h} Z`;
}

/**
 * One series drawn as bars, from SVG alone. It is a picture for the eye: the figures behind it are
 * in a table beside it, `description` summarises them for a screen reader, and the hovered bar is
 * read out as text by the caller, so nothing is said by colour or position alone. Colours are the
 * theme's tokens, so it reads in both themes.
 */
export function BarChart({
  bars,
  formatAxis,
  integer,
  label,
  description,
  active,
  onActive,
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
}) {
  const [ref, width] = useWidth(240);
  const descriptionId = useId();
  const scale = niceScale(Math.max(0, ...bars.map((b) => b.value ?? 0)), 3, integer);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const step = bars.length > 0 ? plotW / bars.length : plotW;
  const barW = Math.max(2, Math.min(28, step * 0.7));
  const stride = labelStride(bars.length, plotW);
  const y = (v: number) => PAD.top + plotH - (v / scale.max) * plotH;

  return (
    <div ref={ref} className="chart">
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
      <svg role="img" aria-label={label} aria-describedby={descriptionId} width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} onMouseLeave={() => onActive(null)}>
        {scale.ticks.map((tick) => (
          <g key={tick}>
            <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
            <text className="chart-axis" x={PAD.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
              {formatAxis(tick)}
            </text>
          </g>
        ))}
        {bars.map((bar, i) => {
          const cx = PAD.left + step * i + step / 2;
          const h = bar.value === null ? 0 : (bar.value / scale.max) * plotH;
          return (
            <g key={bar.key}>
              {h > 0 && <path className={`chart-bar ${active === i ? 'is-active' : ''}`} d={barPath(cx - barW / 2, y(bar.value ?? 0), barW, Math.max(h, 1), 4)} />}
              {i % stride === 0 && (
                <text className="chart-axis" x={cx} y={HEIGHT - 8} textAnchor="middle">
                  {bar.label}
                </text>
              )}
              {/* The hit target is the whole column, not just the bar: an empty day is worth reading too */}
              <rect className="chart-hit" x={PAD.left + step * i} y={PAD.top} width={step} height={plotH} onMouseEnter={() => onActive(i)} />
            </g>
          );
        })}
        <line className="chart-base" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
      </svg>
    </div>
  );
}
