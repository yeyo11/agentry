// Rasterises the home-screen icons from `public/favicon.svg`, the one place the brand mark lives.
//
//   pnpm --filter @agentry/web icons        (needs Chrome on the PATH, or CHROME_BIN)
//
// Run by hand, not by the build: the PNGs are committed, so a clone, CI and the Docker image never
// need a browser to produce them. Re-run it only when the mark changes.
//
// Chrome is the rasteriser because it is already a development dependency of this repo (the e2e
// suite drives it) and because it renders the SVG with the same engine that will show the icon.
// A native rasteriser (sharp, resvg) would be a compiled dependency installed on every machine for
// four files that change once a year.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');
const iconsDir = join(publicDir, 'icons');

/** The background of the mark, matched literally so a change to favicon.svg fails here loudly. */
const BACKDROP = '<rect width="64" height="64" rx="15" fill="url(#g)"/>';

interface Variant {
  file: string;
  size: number;
  /** Square instead of a rounded rectangle: the platform applies its own mask over the whole tile */
  bleed: boolean;
  /** The mark shrunk about the centre, to fit inside a mask's safe area */
  markScale: number;
  /** iOS composites a transparent icon on black, so the opaque variants say what is behind them */
  background: string;
}

const VARIANTS: Variant[] = [
  { file: 'icon-192.png', size: 192, bleed: false, markScale: 1, background: '00000000' },
  { file: 'icon-512.png', size: 512, bleed: false, markScale: 1, background: '00000000' },
  // Android crops a maskable icon to whatever shape the launcher uses, guaranteeing only the circle
  // of 80% of the width. The mark's far corner sits at 84% of the radius unscaled, so it shrinks.
  { file: 'icon-maskable-512.png', size: 512, bleed: true, markScale: 0.85, background: 'd97757ff' },
  { file: 'apple-touch-icon.png', size: 180, bleed: true, markScale: 1, background: 'd97757ff' },
];

function variantSvg(source: string, { bleed, markScale }: Variant): string {
  const at = source.indexOf(BACKDROP);
  if (at < 0) throw new Error(`favicon.svg no longer contains the backdrop rect this script rewrites:\n${BACKDROP}`);
  const head = source.slice(0, at);
  const rest = source.slice(at + BACKDROP.length);
  const close = rest.lastIndexOf('</svg>');
  const mark = rest.slice(0, close);
  const backdrop = bleed ? BACKDROP.replace(' rx="15"', '') : BACKDROP;
  const scaled = markScale === 1 ? mark : `<g transform="translate(32 32) scale(${markScale}) translate(-32 -32)">${mark}</g>`;
  return head + backdrop + scaled + rest.slice(close);
}

function chrome(): string {
  const candidates = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter((bin) => bin !== undefined);
  for (const bin of candidates) if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0) return bin;
  throw new Error('Chrome/Chromium not found. Set CHROME_BIN.');
}

const bin = chrome();
const source = readFileSync(join(publicDir, 'favicon.svg'), 'utf8');
const work = mkdtempSync(join(tmpdir(), 'agentry-icons-'));
mkdirSync(iconsDir, { recursive: true });

try {
  for (const variant of VARIANTS) {
    const svg = join(work, `${variant.file}.svg`);
    writeFileSync(svg, variantSvg(source, variant));
    const out = join(iconsDir, variant.file);
    const result = spawnSync(
      bin,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        `--user-data-dir=${join(work, 'profile')}`,
        `--default-background-color=${variant.background}`,
        `--window-size=${variant.size},${variant.size}`,
        `--screenshot=${out}`,
        svg,
      ],
      { stdio: 'ignore' },
    );
    if (result.status !== 0) throw new Error(`Chrome failed to render ${variant.file} (exit ${result.status})`);
    console.log(`${variant.file}  ${variant.size}×${variant.size}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
