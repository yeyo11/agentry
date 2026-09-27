import { useMemo } from 'react';
import { encodeQr } from '../lib/qr';

// The standard asks for four light modules around the code; a camera needs them to find its edge
const QUIET = 4;

/**
 * `text` as a QR code, drawn as one SVG path so it stays sharp at any size. Its colours come from
 * `.qr` (dark on light in both themes), and it carries its own name, because a picture of an
 * address says nothing to a screen reader. Nothing is drawn for text too long to encode.
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const qr = useMemo(() => encodeQr(text), [text]);
  if (!qr) return null;
  const extent = qr.size + QUIET * 2;
  let path = '';
  qr.modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    }),
  );
  return (
    <svg className="qr" viewBox={`0 0 ${extent} ${extent}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect className="qr-paper" width={extent} height={extent} />
      <path className="qr-ink" d={path} />
    </svg>
  );
}
