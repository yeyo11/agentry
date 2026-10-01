// Ported from docs/design-system/illustrations/quota.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
export function Quota() {
  return (
    <>
      <path d="M58 118 A62 62 0 0 1 182 118" className="trk w12" />
      <path d="M58 118 A62 62 0 0 1 182 118" className="ln-tone w12" />
      <path d="M120 118 L176 108" className="ln-ink w3" /><circle cx="120" cy="118" r="6" className="f-fg" />
      <text x="58" y="138" textAnchor="middle" className="txt">0</text><text x="182" y="138" textAnchor="middle" className="txt-tone">100%</text>
      <g className="a-float"><path d="M196 30 h22 M196 62 h22 M199 30 c0 10 8 12 8 16 c0 4 -8 6 -8 16 M215 30 c0 10 -8 12 -8 16 c0 4 8 6 8 16" className="ln-grad" /></g>
      <g className="a-float-2"><rect x="18" y="28" width="58" height="22" rx="11" className="c2" /><text x="47" y="42.5" textAnchor="middle" className="txt">19 min</text></g>
    </>
  );
}
