// Ported from docs/design-system/illustrations/projects.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
export function Projects() {
  return (
    <>
      <path d="M168 99 C 186 99, 184 44, 202 44" className="ln-grad" />
      <path d="M168 99 L 202 99" className="ln" />
      <path d="M168 99 C 186 99, 184 136, 202 136" className="ln a-dash" />
      <circle cx="208" cy="44" r="7" className="f-grad a-pulse" /><circle cx="208" cy="99" r="6" className="c2" /><circle cx="208" cy="136" r="6" className="c2" />
      <path d="M58 60 Q58 50 68 50 L94 50 L104 60 Z" className="c2" />
      <rect x="54" y="58" width="114" height="72" rx="11" className="c2" />
      <rect x="54" y="72" width="114" height="58" rx="11" className="c1" />
      <circle cx="111" cy="101" r="14" className="f-grad" /><path d="M111 94 v14 M104 101 h14" className="ln-white" />
    </>
  );
}
