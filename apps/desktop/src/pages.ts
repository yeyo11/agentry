/** Scheme of the links on the error page; the main process intercepts them instead of navigating */
export const ACTION_SCHEME = 'agentry-action:';

const BASE_STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center; flex-direction: column;
         gap: 14px; background: #101114; color: #e6e7ea; font: 15px/1.5 system-ui, sans-serif; text-align: center; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; }
  p { margin: 0; color: #9aa0aa; max-width: 560px; }
  pre { margin: 0; max-width: 640px; max-height: 40vh; overflow: auto; text-align: left; white-space: pre-wrap;
        background: #181a1f; border: 1px solid #2a2d34; border-radius: 8px; padding: 10px 12px; font-size: 12px; color: #c4c8d0; }
  .row { display: flex; gap: 10px; }
  a.btn { padding: 7px 16px; border-radius: 7px; border: 1px solid #3a3e48; color: #e6e7ea; text-decoration: none; }
  a.primary { background: #d97757; border-color: #d97757; color: #101114; font-weight: 600; }
`;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const toDataUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

export function splashUrl(): string {
  return toDataUrl(`<!doctype html><meta charset="utf-8"><title>Agentry</title><style>${BASE_STYLE}
    .spin { width: 28px; height: 28px; border: 3px solid #2a2d34; border-top-color: #d97757; border-radius: 50%; animation: s 0.9s linear infinite; }
    @keyframes s { to { transform: rotate(360deg); } }
  </style><div class="spin"></div><h1>Agentry</h1><p>Starting…</p>`);
}

export function errorUrl(title: string, detail: string, logPath: string): string {
  return toDataUrl(`<!doctype html><meta charset="utf-8"><title>Agentry</title><style>${BASE_STYLE}</style>
    <h1>${escapeHtml(title)}</h1>
    <pre>${escapeHtml(detail)}</pre>
    <p>Log: ${escapeHtml(logPath)}</p>
    <div class="row">
      <a class="btn primary" href="${ACTION_SCHEME}restart">Restart</a>
      <a class="btn" href="${ACTION_SCHEME}logs">Open logs folder</a>
    </div>`);
}
