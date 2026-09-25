// Ported from docs/design-system/illustrations/cli-missing.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
export function CliMissing() {
  return (
    <>
      <rect x="34" y="26" width="170" height="110" rx="12" className="c0" />
      <path d="M34 46 H204" className="ln-soft" />
      <circle cx="48" cy="36" r="3" className="s3" /><circle cx="58" cy="36" r="3" className="s3" /><circle cx="68" cy="36" r="3" className="s3" />
      <text x="48" y="66" className="txt">$ claude --version</text>
      <text x="48" y="83" className="txt-tone">command not found: claude</text>
      <text x="48" y="104" className="txt">$</text><rect x="58" y="95" width="6" height="12" rx="1" className="f-grad a-blink" />
      <g className="a-float"><circle cx="206" cy="30" r="14" className="f-tone-soft" /><circle cx="206" cy="30" r="14" className="ln-tone" /><path d="M206 23 V31 M206 36.5 V37" className="ln-tone w3" /></g>
    </>
  );
}
