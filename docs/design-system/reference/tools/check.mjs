// Measures the prototypes the way the design system's checklist reads them: text contrast in both
// themes (4.5:1, 3:1 for large text) and, on the phone screens, touch targets under 44 px.
// Usage: node docs/design-system/reference/tools/check.mjs [Screen ...]   (no names: every screen)
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../../../../e2e/driver.mjs';

const REF = dirname(dirname(fileURLToPath(import.meta.url)));
const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(REF).filter((f) => /^(Desktop|Mobile)\w+\.html$/.test(f)).map((f) => f.replace(/\.html$/, '')).sort();

// Runs inside the page. Colours go through a canvas so every syntax the stylesheet uses
// (color-mix, oklab, hsl) comes back as sRGB bytes.
const probe = `
// A colour caught mid-transition (the theme was just switched) would read as a failure: stop them all
document.documentElement.setAttribute('data-motion', 'off');
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const cv = document.createElement('canvas'); cv.width = cv.height = 1;
const cx = cv.getContext('2d', { willReadFrequently: true });
const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false; } return true; };
// The background under an element: the solid fills of its ancestors, composed. A gradient or an
// image under it means the ratio cannot be read from colours alone, so it is skipped.
const under = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage !== 'none' && !/radial-gradient/.test(s.backgroundImage) && !s.backgroundImage.startsWith('linear-gradient(rgb') ) return null; const c = rgba(s.backgroundColor); if (c[3] > 0) stack.push(c); if (c[3] === 1) break; } let bg = [255, 255, 255, 1]; for (let i = stack.length - 1; i >= 0; i--) bg = over(stack[i], bg); return bg; };
const who = (el) => { const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : ''; return el.tagName.toLowerCase() + cls; };
const out = { contrast: [], targets: [] };
for (const el of document.querySelectorAll('.app *')) {
  if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
  if (!visible(el) || el.closest('[disabled], svg, .il')) continue;
  const s = getComputedStyle(el);
  if (s.backgroundClip === 'text' || s.webkitBackgroundClip === 'text') continue;
  const bg = under(el); if (!bg) continue;
  let fg = rgba(s.color); let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity; fg = [fg[0], fg[1], fg[2], fg[3] * op];
  const r = ratio(over(fg, bg), bg); const size = parseFloat(s.fontSize); const large = size >= 24 || (size >= 18.66 && +s.fontWeight >= 700);
  if (r < (large ? 3 : 4.5)) out.contrast.push({ el: who(el), text: el.textContent.trim().slice(0, 40), ratio: +r.toFixed(2) });
}
if (document.querySelector('.m-screen')) {
  const sel = 'a[href], button, [role=tab], [role=radio], [role=switch], [role=checkbox], label, input, textarea, .chip, summary';
  for (const el of document.querySelectorAll('.m-screen :is(' + sel + ')')) {
    if (!visible(el) || el.closest('[aria-hidden=true]')) continue;
    // A control inside a bigger control (a switch in its cell) is reached through the bigger one.
    if (el.parentElement?.closest(sel)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 44 || r.width < 44) out.targets.push({ el: who(el), text: (el.getAttribute('aria-label') || el.textContent).trim().slice(0, 40), size: Math.round(r.width) + 'x' + Math.round(r.height) });
  }
}
return out;`;

const { page, close } = await launch({ baseUrl: pathToFileURL(REF + '/').href });
let failures = 0;
try {
  for (const name of names) {
    const mobile = name.startsWith('Mobile');
    await page.viewport(mobile ? 390 : 1440, mobile ? 844 : 1024);
    for (const theme of ['dark', 'light']) {
      // Only the hash changes between the two themes: the page's own hashchange handler repaints it
      await page.goto(`${name}.html${theme === 'light' ? '#light' : ''}`, 700);
      const r = await page.eval(probe);
      const lines = [
        ...r.contrast.map((c) => `  contrast ${c.ratio}  ${c.el}  "${c.text}"`),
        ...(theme === 'dark' ? r.targets.map((t) => `  target ${t.size}  ${t.el}  "${t.text}"`) : []),
      ];
      failures += lines.length;
      console.log(`${name} ${theme}: ${lines.length ? lines.length + ' findings' : 'ok'}`);
      for (const l of lines) console.log(l);
    }
  }
} finally {
  close();
}
console.log(`total findings: ${failures}`);
process.exitCode = failures ? 1 : 0;
