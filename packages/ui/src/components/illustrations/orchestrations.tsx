// Ported from docs/design-system/illustrations/orchestrations.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
export function Orchestrations() {
  return (
    <>
      <path d="M73 80 C 92 80, 94 46, 107 46" className="ln a-dash" />
      <path d="M73 80 C 92 80, 94 114, 107 114" className="ln a-dash" />
      <path d="M133 46 C 150 46, 148 80, 163 80" className="ln-grad a-dash" />
      <path d="M133 114 C 150 114, 148 80, 163 80" className="ln-grad a-dash" />
      <circle cx="60" cy="80" r="13" className="c2" /><circle cx="60" cy="80" r="4" className="f-ink" />
      <circle cx="120" cy="46" r="13" className="c2" /><path d="M114 46 l4 4 l8 -8" className="ln-ok" />
      <circle cx="120" cy="114" r="13" className="c2" /><circle cx="120" cy="114" r="5" className="f-live a-pulse" />
      <circle cx="182" cy="80" r="28" className="halo" /><circle cx="182" cy="80" r="19" className="f-grad" /><path d="M174 80 l5 5 l10 -11" className="ln-white" />
    </>
  );
}
