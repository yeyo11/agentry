// Ported from docs/design-system/illustrations/board.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
import type { DrawingProps } from './Illustration';

/** A key longer than the reference's `AGN-1` is squeezed into the card rather than spilling out of it. */
const FITS = 8;

export function Board({ text = 'AGN-1' }: DrawingProps) {
  return (
    <>
      <rect x="34" y="32" width="52" height="102" rx="10" className="c0" />
      <rect x="94" y="32" width="52" height="102" rx="10" className="c0" />
      <rect x="154" y="32" width="52" height="102" rx="10" className="c0" />
      <rect x="42" y="42" width="20" height="4" rx="2" className="s3" /><circle cx="77" cy="44" r="2.5" className="f-ink" />
      <rect x="102" y="42" width="24" height="4" rx="2" className="s3" /><circle cx="137" cy="44" r="2.5" className="f-ink" />
      <rect x="162" y="42" width="16" height="4" rx="2" className="s3" /><path d="M193.5 44 l1.8 1.8 l3.2 -3.4" className="ln-ok" />
      <rect x="41" y="56" width="38" height="24" rx="5" className="ln-soft dash-lg" />
      <rect x="101" y="56" width="38" height="24" rx="5" className="ln-soft dash-lg" />
      <rect x="101" y="86" width="38" height="24" rx="5" className="ln-soft dash-lg" />
      <rect x="161" y="56" width="38" height="24" rx="5" className="ln-soft dash-lg" />
      <g className="a-float">
        <g transform="rotate(-8 64 58)">
          <rect x="34" y="42" width="64" height="34" rx="7" className="cg" />
          <text x="42" y="56" className="txt" {...(text.length > FITS ? { textLength: 40, lengthAdjust: 'spacingAndGlyphs' } : {})}>
            {text}
          </text>
          <rect x="42" y="63" width="36" height="5" rx="2.5" className="s3" />
          <circle cx="88" cy="53" r="2.5" className="f-grad" />
        </g>
      </g>
      <circle cx="212" cy="126" r="17" className="halo" />
      <circle cx="212" cy="126" r="13" className="f-grad a-pulse" /><path d="M212 120 v12 M206 126 h12" className="ln-white" />
    </>
  );
}
