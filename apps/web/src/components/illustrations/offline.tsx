// Ported from docs/design-system/illustrations/offline.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
export function Offline() {
  return (
    <>
      <rect x="24" y="56" width="66" height="44" rx="7" className="c1" /><rect x="34" y="68" width="30" height="5" rx="2.5" className="s3" /><rect x="34" y="79" width="20" height="5" rx="2.5" className="s3" />
      <path d="M16 104 H98 L92 111 H22 Z" className="c2" />
      <path d="M98 82 H114" className="ln" />
      <circle cx="126" cy="82" r="11" className="f-tone-soft" /><path d="M122 78 l8 8 M130 78 l-8 8" className="ln-tone" />
      <path d="M138 82 H154" className="ln a-dash" />
      <rect x="154" y="42" width="64" height="24" rx="6" className="c2" /><rect x="154" y="70" width="64" height="24" rx="6" className="c2" /><rect x="154" y="98" width="64" height="24" rx="6" className="c2" />
      <circle cx="166" cy="54" r="3" className="f-ink" /><circle cx="166" cy="82" r="3" className="f-ink" /><circle cx="166" cy="110" r="3.5" className="f-tone a-pulse" />
      <rect x="178" y="52" width="30" height="4" rx="2" className="s3" /><rect x="178" y="80" width="30" height="4" rx="2" className="s3" /><rect x="178" y="108" width="30" height="4" rx="2" className="s3" />
    </>
  );
}
