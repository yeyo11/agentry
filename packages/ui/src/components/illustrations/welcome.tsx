// Ported from docs/design-system/illustrations/welcome.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
export function Welcome() {
  return (
    <>
      <ellipse cx="120" cy="80" rx="96" ry="34" className="ln-soft" />
      <circle cx="120" cy="80" r="54" className="ln-soft dash a-orbit" />
      <path d="M104 70 L78 44 M138 70 L166 38 M138 92 L168 120" className="ln-soft a-dash" />
      <circle cx="120" cy="80" r="34" className="halo" />
      <circle cx="120" cy="80" r="24" className="f-grad" />
      <text x="120" y="85.5" textAnchor="middle" className="glyph-white">›_</text>
      <g className="a-float"><rect x="12" y="28" width="70" height="22" rx="11" className="c2" /><circle cx="25" cy="39" r="3.5" className="f-live a-pulse" /><text x="34" y="42.5" className="txt">tests</text></g>
      <g className="a-float-2"><rect x="158" y="22" width="70" height="22" rx="11" className="c2" /><circle cx="171" cy="33" r="3.5" className="f-ok" /><text x="180" y="36.5" className="txt">review</text></g>
      <g className="a-float"><rect x="164" y="114" width="64" height="22" rx="11" className="c2" /><circle cx="177" cy="125" r="3.5" className="f-grad" /><text x="186" y="128.5" className="txt">docs</text></g>
    </>
  );
}
