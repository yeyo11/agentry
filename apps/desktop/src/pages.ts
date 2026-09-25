/** Scheme of the links on the error page; the main process intercepts them instead of navigating */
export const ACTION_SCHEME = 'agentry-action:';

/*
 * These pages load before the web UI and cannot read its tokens, so they carry the Night Shift dark
 * palette as literals (apps/web/src/styles/tokens.css, `:root`). Keep the two in step. Fonts are the
 * system's: Geist ships inside the web bundle, which is exactly what has not loaded yet.
 */
const BASE_STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center; flex-direction: column;
         gap: 14px; background: #09090b; color: #f4f4f5; text-align: center;
         font: 14px/1.5 'Geist Variable', 'Geist', ui-sans-serif, system-ui, sans-serif; }
  h1 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0; color: #a1a1aa; max-width: 560px; }
  .mono { font-family: 'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; color: #8b8b95; }
  pre { margin: 0; max-width: 640px; max-height: 40vh; overflow: auto; text-align: left; white-space: pre-wrap;
        background: #0f0f12; border: 1px solid rgba(255, 255, 255, 0.07); border-radius: 12px; padding: 12px 14px;
        font: 12px/1.55 'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace; color: #a1a1aa; }
  .row { display: flex; gap: 8px; }
  /* The window has no system title bar: these pages are dragged by their body, like the UI by its top bar */
  body { -webkit-app-region: drag; user-select: none; padding-top: 52px; box-sizing: border-box; }
  a, pre { -webkit-app-region: no-drag; }
  pre { user-select: text; }
  a.btn { display: inline-flex; align-items: center; min-height: 36px; padding: 0 14px; box-sizing: border-box;
          border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.12); background: #151518;
          color: #f4f4f5; font-weight: 500; text-decoration: none; }
  a.btn:hover { background: #1c1c21; }
  a.btn:focus-visible { outline: 2px solid rgba(236, 138, 102, 0.6); outline-offset: 2px; }
  /* The brand gradient, as .btn-primary in the web UI */
  a.primary { border-color: transparent; color: #fff; font-weight: 600;
              background: linear-gradient(135deg, #b35a36 0%, #b04a5e 55%, #9c3f77 100%);
              box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 6px 20px -6px rgba(176, 74, 94, 0.55); }
  a.primary:hover { background: linear-gradient(135deg, #b35a36 0%, #b04a5e 55%, #9c3f77 100%); filter: brightness(1.08); }
`;

/**
 * `docs/design-system/illustrations/offline.svg`, as is: the standalone file carries its own styles,
 * dark fallbacks for every token and its reduced-motion rule. A test keeps the copy identical.
 */
export const OFFLINE_ILLUSTRATION = `<svg class="il il-bad" xmlns="http://www.w3.org/2000/svg" width="240" height="160" role="img" aria-label="offline" viewBox="0 0 240 160" aria-hidden="true"><style>.il { display: block; width: 240px; height: 160px; overflow: visible; --il-tone: var(--accent, #ec8a66); }
.il-sm { width: 160px; height: 107px; }
.il-lg { width: 300px; height: 200px; }
.il-warn { --il-tone: var(--warn, #f0b95c); }
.il-bad { --il-tone: var(--bad, #f87b7f); }
.il-live { --il-tone: var(--live, #22d3ee); }
.il .s0 { fill: var(--bg-1, #0f0f12); }
.il .s1 { fill: var(--bg-2, #151518); }
.il .s2 { fill: var(--bg-3, #1c1c21); }
.il .s3 { fill: var(--bg-4, #26262c); }
.il .ln { fill: none; stroke: var(--line-3, rgba(255, 255, 255, 0.2)); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.il .ln-soft { fill: none; stroke: var(--line-2, rgba(255, 255, 255, 0.12)); stroke-width: 1.5; stroke-linecap: round; }
.il .ln-ink { fill: none; stroke: var(--fg-3, #8b8b95); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.il .ln-grad { fill: none; stroke: url(#il-grad); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.il .ln-tone { fill: none; stroke: var(--il-tone); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.il .f-grad { fill: url(#il-grad); }
.il .f-tone { fill: var(--il-tone); }
.il .f-tone-soft { fill: color-mix(in srgb, var(--il-tone) 16%, transparent); }
.il .f-ink { fill: var(--fg-3, #8b8b95); }
.il .f-fg { fill: var(--fg, #f4f4f5); }
.il .f-live { fill: var(--live, #22d3ee); }
.il .f-ok { fill: var(--ok, #4ade9a); }
.il .f-white { fill: #fff; }
.il .f-dots { fill: url(#il-dots); }
.il .dot-fill { fill: var(--line-2, rgba(255, 255, 255, 0.12)); }
.il .stop-a { stop-color: var(--accent, #ec8a66); }
.il .stop-b { stop-color: var(--accent-2, #e0668f); }
.il .stop-in { stop-color: #fff; }
.il .stop-out { stop-color: #000; }
.il .txt { font-family: var(--mono, 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace); font-size: 9px; fill: var(--fg-2, #a1a1aa); }
.il .txt-tone { font-family: var(--mono, 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace); font-size: 9px; fill: var(--il-tone); }
.il .txt-big { font-family: var(--mono, 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace); font-size: 13px; font-weight: 600; fill: var(--fg-3, #8b8b95); }
.il .halo { fill: url(#il-grad); opacity: 0.22; filter: blur(14px); }
.il .a-float { animation: il-float 4.8s ease-in-out infinite; }
.il .a-float-2 { animation: il-float 5.6s ease-in-out 0.8s infinite; }
.il .a-blink { animation: caret-blink 1s steps(1) infinite; }
.il .a-dash { stroke-dasharray: 4 6; animation: il-dash 1.6s linear infinite; }
.il .a-pulse { transform-box: fill-box; transform-origin: center; animation: il-pulse 2.2s ease-in-out infinite; }
.il .a-orbit { transform-origin: 120px 80px; animation: spin 24s linear infinite; }
.il .a-orbit-rev { transform-origin: 120px 80px; animation: spin 36s linear infinite reverse; }
@keyframes il-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
@keyframes il-dash { to { stroke-dashoffset: -20; } }
@keyframes il-pulse { 0%, 100% { opacity: 0.55; transform: scale(0.92); } 50% { opacity: 1; transform: scale(1.08); } }
[data-motion="subtle"] .il *, [data-motion="off"] .il * { animation: none !important; }
.il .c0 { fill: var(--bg-1, #0f0f12); stroke: var(--line-3, rgba(255, 255, 255, 0.2)); stroke-width: 1.5; }
.il .c1 { fill: var(--bg-2, #151518); stroke: var(--line-3, rgba(255, 255, 255, 0.2)); stroke-width: 1.5; }
.il .c2 { fill: var(--bg-3, #1c1c21); stroke: var(--line-3, rgba(255, 255, 255, 0.2)); stroke-width: 1.5; }
.il .cg { fill: var(--bg-2, #151518); stroke: url(#il-grad); stroke-width: 1.75; }
.il .ln-white { fill: none; stroke: #fff; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.il .ln-ok { fill: none; stroke: var(--ok, #4ade9a); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.il .trk { fill: none; stroke: var(--bg-4, #26262c); stroke-linecap: round; }
.il .w3 { stroke-width: 3; } .il .w4 { stroke-width: 4; } .il .w8 { stroke-width: 8; } .il .w12 { stroke-width: 12; }
.il .dash { stroke-dasharray: 2 6; }
.il .dash-lg { stroke-dasharray: 5 5; }
.il .f-accent { fill: var(--accent, #ec8a66); }
.il .glyph { font-family: var(--mono, 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace); font-size: 17px; font-weight: 600; fill: url(#il-grad); }
.il .glyph-white { font-family: var(--mono, 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace); font-size: 15px; font-weight: 600; fill: #fff; }
@keyframes spin { to { transform: rotate(360deg); } } @keyframes caret-blink { 50% { opacity: 0; } } @media (prefers-reduced-motion: reduce) { .il * { animation: none !important; } }</style><defs><linearGradient id="il-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="stop-a"></stop><stop offset="1" class="stop-b"></stop></linearGradient><pattern id="il-dots" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" class="dot-fill"></circle></pattern><radialGradient id="il-fade-g" cx="0.5" cy="0.5" r="0.5"><stop offset="0" class="stop-in"></stop><stop offset="1" class="stop-out"></stop></radialGradient><mask id="il-fade"><rect x="0" y="0" width="240" height="160" fill="url(#il-fade-g)"></rect></mask></defs><rect x="0" y="0" width="240" height="160" class="f-dots" mask="url(#il-fade)"></rect>
<rect x="24" y="56" width="66" height="44" rx="7" class="c1"></rect><rect x="34" y="68" width="30" height="5" rx="2.5" class="s3"></rect><rect x="34" y="79" width="20" height="5" rx="2.5" class="s3"></rect>
<path d="M16 104 H98 L92 111 H22 Z" class="c2"></path>
<path d="M98 82 H114" class="ln"></path>
<circle cx="126" cy="82" r="11" class="f-tone-soft"></circle><path d="M122 78 l8 8 M130 78 l-8 8" class="ln-tone"></path>
<path d="M138 82 H154" class="ln a-dash"></path>
<rect x="154" y="42" width="64" height="24" rx="6" class="c2"></rect><rect x="154" y="70" width="64" height="24" rx="6" class="c2"></rect><rect x="154" y="98" width="64" height="24" rx="6" class="c2"></rect>
<circle cx="166" cy="54" r="3" class="f-ink"></circle><circle cx="166" cy="82" r="3" class="f-ink"></circle><circle cx="166" cy="110" r="3.5" class="f-tone a-pulse"></circle>
<rect x="178" y="52" width="30" height="4" rx="2" class="s3"></rect><rect x="178" y="80" width="30" height="4" rx="2" class="s3"></rect><rect x="178" y="108" width="30" height="4" rx="2" class="s3"></rect>
</svg>`;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const toDataUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

export function splashUrl(): string {
  // A ring in the brand gradient: a conic gradient masked to its outer band. Reduced motion keeps
  // the ring and stops the turn; "Starting…" says the rest.
  return toDataUrl(`<!doctype html><meta charset="utf-8"><title>Agentry</title><style>${BASE_STYLE}
    .spin { width: 28px; height: 28px; border-radius: 50%;
            background: conic-gradient(from 0deg, rgba(236, 138, 102, 0) 0deg, #ec8a66 200deg, #e0668f 360deg);
            -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px));
            mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px));
            animation: s 0.8s linear infinite; }
    @keyframes s { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
  </style><div class="spin"></div><h1>Agentry</h1><p>Starting…</p>`);
}

export function errorUrl(title: string, detail: string, logPath: string): string {
  return toDataUrl(`<!doctype html><meta charset="utf-8"><title>Agentry</title><style>${BASE_STYLE}</style>
    ${OFFLINE_ILLUSTRATION}
    <h1>${escapeHtml(title)}</h1>
    <pre>${escapeHtml(detail)}</pre>
    <p class="mono">Log: ${escapeHtml(logPath)}</p>
    <div class="row">
      <a class="btn primary" href="${ACTION_SCHEME}restart">Restart</a>
      <a class="btn" href="${ACTION_SCHEME}logs">Open logs folder</a>
    </div>`);
}
