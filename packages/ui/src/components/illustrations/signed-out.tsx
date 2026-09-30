// Ported from docs/design-system/illustrations/signed-out.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
export function SignedOut() {
  return (
    <>
      <path d="M101 76 V60 a19 19 0 0 1 38 0 V76" className="ln-ink w4" />
      <rect x="88" y="72" width="64" height="56" rx="12" className="c2" />
      <circle cx="120" cy="95" r="7" className="f-grad" /><rect x="117" y="99" width="6" height="14" rx="3" className="f-grad" />
      <g className="a-float"><circle cx="188" cy="52" r="11" className="ln-grad w3" /><path d="M188 63 V104 M188 84 h8 M188 96 h6" className="ln-grad w3" /></g>
      <g className="a-float-2"><rect x="16" y="98" width="60" height="22" rx="11" className="c2" /><text x="46" y="112.5" textAnchor="middle" className="txt">••••••</text></g>
    </>
  );
}
