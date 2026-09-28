// Ported from docs/design-system/illustrations/board.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
import type { DrawingProps } from './Illustration';

/** A key longer than the reference's `AGN-1` is squeezed into the card rather than spilling out of it. */
const FITS = 8;

/** The five fixed columns, left to right: where each one's heading bar, mark and first slot go. */
const COLUMNS = [
  { x: 18, head: 14 },
  { x: 60, head: 18 },
  { x: 102, head: 16 },
  { x: 144, head: 20 },
  { x: 186, head: 12 },
] as const;

/**
 * The board's five fixed columns (decision 9: the draft had three) and the first card floating into
 * Por hacer with the project's key. No "+" disc: it read as a button that did nothing.
 */
export function Board({ text = 'AGN-1' }: DrawingProps) {
  return (
    <>
      {COLUMNS.map(({ x, head }, i) => (
        <g key={x}>
          <rect x={x} y="30" width="36" height="104" rx="8" className="c0" />
          <rect x={x + 6} y="39" width={head} height="4" rx="2" className="s3" />
          {i === COLUMNS.length - 1 ? <path d={`M${x + 25} 41 l1.6 1.6 l3 -3.2`} className="ln-ok" /> : <circle cx={x + 29} cy="41" r="2" className="f-ink" />}
          <rect x={x + 5} y="50" width="26" height="17" rx="4" className="ln-soft dash-lg" />
          {i === 0 && <rect x={x + 5} y="72" width="26" height="17" rx="4" className="ln-soft dash-lg" />}
        </g>
      ))}
      <g className="a-float">
        <g transform="rotate(-6 76 80)">
          <rect x="46" y="64" width="60" height="32" rx="7" className="cg" />
          <text x="54" y="78" className="txt" {...(text.length > FITS ? { textLength: 40, lengthAdjust: 'spacingAndGlyphs' } : {})}>
            {text}
          </text>
          <rect x="54" y="84" width="34" height="4" rx="2" className="s3" />
        </g>
      </g>
    </>
  );
}
