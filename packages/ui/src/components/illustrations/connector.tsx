// Ported from docs/design-system/illustrations/connector.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
export function Connector() {
  return (
    <>
      <path d="M20 130 C 56 130, 58 100, 84 100" className="ln-ink w3" />
      <rect x="84" y="84" width="42" height="32" rx="8" className="c2" />
      <path d="M98 84 V70 M112 84 V70" className="ln-ink w3" />
      <g className="a-pulse"><path d="M104 58 V48 M118 60 L126 52 M92 60 L84 52" className="ln-grad" /></g>
      <path d="M176 36 L206 47 V74 C206 96 194 108 176 116 C158 108 146 96 146 74 V47 Z" className="c1" />
      <path d="M176 36 L206 47 V74 C206 96 194 108 176 116 C158 108 146 96 146 74 V47 Z" className="ln-tone" />
      <path d="M176 60 V80 M176 92 V92.5" className="ln-tone w3" />
    </>
  );
}
