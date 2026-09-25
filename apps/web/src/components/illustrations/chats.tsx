// Ported from docs/design-system/illustrations/chats.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
export function Chats() {
  return (
    <>
      <g className="a-float-2"><path d="M62 86 L56 100 L78 86 Z" className="c2" /><rect x="46" y="30" width="108" height="58" rx="14" className="c2" /><rect x="62" y="46" width="64" height="6" rx="3" className="s3" /><rect x="62" y="60" width="42" height="6" rx="3" className="s3" /></g>
      <g className="a-float"><path d="M176 120 L186 134 L162 120 Z" className="cg" /><rect x="92" y="70" width="104" height="52" rx="14" className="cg" /><text x="106" y="102" className="glyph">›</text><rect x="120" y="89" width="8" height="15" rx="1.5" className="f-grad a-blink" /><rect x="136" y="93" width="44" height="6" rx="3" className="s3" /></g>
      <path d="M200 26 L203 34 L211 37 L203 40 L200 48 L197 40 L189 37 L197 34 Z" className="f-grad a-pulse" />
    </>
  );
}
