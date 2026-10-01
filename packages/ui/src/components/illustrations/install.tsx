// Ported from docs/design-system/illustrations/install.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
export function Install() {
  return (
    <>
      <g className="a-float"><path d="M50 36 V70 M38 58 l12 12 l12 -12 M34 84 h32" className="ln-grad w3" /></g>
      <rect x="86" y="12" width="68" height="136" rx="15" className="c1" />
      <rect x="108" y="18" width="24" height="5" rx="2.5" className="s3" /><rect x="108" y="139" width="24" height="3" rx="1.5" className="s3" />
      <circle cx="120" cy="70" r="26" className="halo" />
      <rect x="104" y="54" width="32" height="32" rx="9" className="f-grad" />
      <circle cx="112" cy="63" r="3" className="f-white" /><circle cx="128" cy="63" r="3" className="f-white" /><circle cx="120" cy="77" r="3" className="f-white" />
      <path d="M113.5 65.5 L118.5 74.5 M126.5 65.5 L121.5 74.5" className="ln-white" style={{ strokeWidth: 1.5 }} />
      <rect x="108" y="92" width="24" height="4" rx="2" className="s3" />
      <g className="a-float-2"><rect x="144" y="32" width="86" height="36" rx="10" className="c2" /><rect x="152" y="41" width="18" height="18" rx="5" className="f-grad" /><rect x="176" y="43" width="44" height="5" rx="2.5" className="s3" /><rect x="176" y="53" width="30" height="5" rx="2.5" className="s3" /><circle cx="228" cy="34" r="4.5" className="f-accent" /></g>
    </>
  );
}
