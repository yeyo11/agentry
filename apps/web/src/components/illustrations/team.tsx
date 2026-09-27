// Ported from docs/design-system/illustrations/team.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
// The slots name the template's roles by the acronyms a team uses in either language.
export function Team() {
  return (
    <>
      <path d="M120 70 V90 M64 106 V90 H176 V106" className="ln-soft dash" />
      <rect x="40" y="106" width="48" height="36" rx="9" className="ln-soft dash-lg" />
      <rect x="96" y="106" width="48" height="36" rx="9" className="ln-soft dash-lg" />
      <rect x="152" y="106" width="48" height="36" rx="9" className="ln-soft dash-lg" />
      <text x="64" y="127" textAnchor="middle" className="txt">PO</text>
      <text x="120" y="127" textAnchor="middle" className="txt">DEV</text>
      <text x="176" y="127" textAnchor="middle" className="txt">QA</text>
      <g className="a-float">
        <rect x="92" y="24" width="56" height="46" rx="10" className="cg" />
        <text x="101" y="44" className="glyph">›_</text>
        <rect x="101" y="53" width="30" height="5" rx="2.5" className="s3" />
        <rect x="101" y="61" width="18" height="3" rx="1.5" className="s3" />
      </g>
      <circle cx="212" cy="126" r="17" className="halo" />
      <circle cx="212" cy="126" r="13" className="f-grad a-pulse" /><path d="M212 120 v12 M206 126 h12" className="ln-white" />
    </>
  );
}
