// Rasterizes build/icon.svg into build/icon.png and the Linux icon set build/icons/<n>x<n>.png.
// Zero dependencies (node:zlib only), so it runs on a bare machine without rsvg/inkscape/sharp.
// It understands exactly the SVG subset icon.svg uses: one <g transform="translate() scale()">,
// a <rect rx> filled with a two-point linearGradient in objectBoundingBox units, stroked <path>s
// (M/L/H/V/C, absolute or relative, round caps) and filled <circle>s. Edit the SVG within that
// subset, or render it with a real rasterizer instead (see README.md).
//
// Usage: node apps/desktop/build/render-icons.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 32, 48, 64, 128, 256, 512];
// Samples per pixel axis: small sizes need more to keep the 1px strokes smooth
const supersample = (size) => (size >= 128 ? 3 : 8);

// --- parse -------------------------------------------------------------------------------------

const svg = readFileSync(join(here, 'icon.svg'), 'utf8');
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const num = (tag, name, fallback = 0) => {
  const v = attr(tag, name);
  return v === undefined ? fallback : Number(v);
};
const hex = (s) => {
  const h = s.length === 4 ? s.slice(1).replace(/./g, '$&$&') : s.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};

const canvas = Number(svg.match(/viewBox="0 0 (\d+)/)[1]);

const groupTag = svg.match(/<g [^>]*transform="[^"]*"[^>]*>/)[0];
const [tx, ty] = attr(groupTag, 'transform').match(/translate\(([^)]*)\)/)[1].trim().split(/[\s,]+/).map(Number);
const scale = Number(attr(groupTag, 'transform').match(/scale\(([^)]*)\)/)[1]);

const stops = [...svg.matchAll(/<stop [^>]*>/g)]
  .map(([tag]) => ({ offset: num(tag, 'offset'), color: hex(attr(tag, 'stop-color')) }))
  .sort((a, b) => a.offset - b.offset);

const rectTag = svg.match(/<rect [^>]*>/)[0];
const rect = {
  x: num(rectTag, 'x'),
  y: num(rectTag, 'y'),
  w: num(rectTag, 'width'),
  h: num(rectTag, 'height'),
  r: num(rectTag, 'rx'),
};

const strokeGroup = svg.match(/<g [^>]*stroke="[^"]*"[^>]*>([\s\S]*?)<\/g>/);
const strokeColor = hex(attr(strokeGroup[0], 'stroke'));
const halfWidth = num(strokeGroup[0], 'stroke-width', 1) / 2;
const segments = [...strokeGroup[1].matchAll(/<path [^>]*>/g)].flatMap(([tag]) => flatten(attr(tag, 'd')));

const fillGroup = svg.match(/<g fill="(#[0-9a-fA-F]{3,6})"[^>]*>([\s\S]*?)<\/g>/);
const fillColor = hex(fillGroup[1]);
const circles = [...fillGroup[2].matchAll(/<circle [^>]*>/g)].map(([tag]) => ({
  cx: num(tag, 'cx'),
  cy: num(tag, 'cy'),
  r: num(tag, 'r'),
}));

/** Turns a path's d attribute into straight segments [x0, y0, x1, y1]. */
function flatten(d) {
  const tokens = d.match(/[MmLlHhVvCc]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  const out = [];
  let x = 0;
  let y = 0;
  let cmd = '';
  const line = (nx, ny) => {
    out.push([x, y, nx, ny]);
    x = nx;
    y = ny;
  };
  for (let i = 0; i < tokens.length; ) {
    if (/^[a-z]$/i.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const next = () => Number(tokens[i++]);
    switch (cmd.toUpperCase()) {
      case 'M': {
        const nx = next() + (rel ? x : 0);
        const ny = next() + (rel ? y : 0);
        x = nx;
        y = ny;
        cmd = rel ? 'l' : 'L'; // subsequent pairs are implicit lineto
        break;
      }
      case 'L': {
        const nx = next() + (rel ? x : 0);
        line(nx, next() + (rel ? y : 0));
        break;
      }
      case 'H':
        line(next() + (rel ? x : 0), y);
        break;
      case 'V':
        line(x, next() + (rel ? y : 0));
        break;
      case 'C': {
        const ox = rel ? x : 0;
        const oy = rel ? y : 0;
        const [x1, y1, x2, y2, x3, y3] = [next() + ox, next() + oy, next() + ox, next() + oy, next() + ox, next() + oy];
        const [x0, y0] = [x, y];
        for (let s = 1; s <= 48; s++) {
          const t = s / 48;
          const u = 1 - t;
          line(
            u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
            u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
          );
        }
        break;
      }
      default:
        throw new Error(`render-icons: unsupported path command "${cmd}"`);
    }
  }
  return out;
}

// --- shade -------------------------------------------------------------------------------------

function gradient(px, py) {
  // x1=0 y1=0 x2=1 y2=1 in bounding-box units: project onto the box diagonal
  const t = Math.min(1, Math.max(0, ((px - rect.x) / rect.w + (py - rect.y) / rect.h) / 2));
  let i = 0;
  while (i < stops.length - 2 && t > stops[i + 1].offset) i++;
  const a = stops[i];
  const b = stops[i + 1];
  const f = b.offset === a.offset ? 0 : Math.min(1, Math.max(0, (t - a.offset) / (b.offset - a.offset)));
  return a.color.map((c, k) => c + (b.color[k] - c) * f);
}

function insideRect(px, py) {
  const qx = Math.abs(px - (rect.x + rect.w / 2)) - (rect.w / 2 - rect.r);
  const qy = Math.abs(py - (rect.y + rect.h / 2)) - (rect.h / 2 - rect.r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= rect.r;
}

const strokeBox = segments.reduce(
  ([minX, minY, maxX, maxY], [x0, y0, x1, y1]) => [
    Math.min(minX, x0, x1),
    Math.min(minY, y0, y1),
    Math.max(maxX, x0, x1),
    Math.max(maxY, y0, y1),
  ],
  [Infinity, Infinity, -Infinity, -Infinity],
);

function onStroke(px, py) {
  const [minX, minY, maxX, maxY] = strokeBox;
  if (px < minX - halfWidth || px > maxX + halfWidth || py < minY - halfWidth || py > maxY + halfWidth) return false;
  for (const [x0, y0, x1, y1] of segments) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / len2));
    if (Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)) <= halfWidth) return true;
  }
  return false;
}

const inCircle = (px, py) => circles.some((c) => Math.hypot(px - c.cx, py - c.cy) <= c.r);

/** Straight RGBA (0..1) of one sample, in icon-local coordinates. */
function sample(px, py) {
  // Painter's order: rect, then strokes, then circles (all opaque)
  if (inCircle(px, py)) return [...fillColor, 1];
  if (onStroke(px, py)) return [...strokeColor, 1];
  if (insideRect(px, py)) return [...gradient(px, py), 1];
  return [0, 0, 0, 0];
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const unit = canvas / size;
  const SUPERSAMPLE = supersample(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Accumulate premultiplied color, then un-premultiply
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const cx = (x + (sx + 0.5) / SUPERSAMPLE) * unit;
          const cy = (y + (sy + 0.5) / SUPERSAMPLE) * unit;
          const [sr, sg, sb, sa] = sample((cx - tx) / scale, (cy - ty) / scale);
          r += sr * sa;
          g += sg * sa;
          b += sb * sa;
          a += sa;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        pixels[o] = Math.round((r / a) * 255);
        pixels[o + 1] = Math.round((g / a) * 255);
        pixels[o + 2] = Math.round((b / a) * 255);
      }
      pixels[o + 3] = Math.round((a / SUPERSAMPLE ** 2) * 255);
    }
  }
  return encodePng(size, size, pixels);
}

// --- encode ------------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- write -------------------------------------------------------------------------------------

mkdirSync(join(here, 'icons'), { recursive: true });
for (const size of SIZES) {
  const png = render(size);
  writeFileSync(join(here, 'icons', `${size}x${size}.png`), png);
  if (size === 512) writeFileSync(join(here, 'icon.png'), png);
  console.log(`icons/${size}x${size}.png`);
}
console.log('icon.png');
