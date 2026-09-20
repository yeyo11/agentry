// Dependency-free browser driver over the Chrome DevTools Protocol (Node 22+: global fetch/WebSocket).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A call to the browser that gets no answer is a hung Chrome: fail it instead of waiting forever */
const CDP_TIMEOUT_MS = 60_000;

// axe-core is a dev dependency of the workspace root; its source is injected into the page
let axeSource;
const axeScript = () => (axeSource ??= readFileSync(join(dirname(createRequire(import.meta.url).resolve('axe-core')), 'axe.min.js'), 'utf8'));

function findChrome() {
  const candidates = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const bin of candidates) if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0) return bin;
  throw new Error('Chrome/Chromium not found. Set CHROME_BIN.');
}

export async function launch({ baseUrl, port = 9444, shotsDir }) {
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'agentry-e2e-chrome-'));
  // Its own process group, so the renderers and helpers go down with it and none outlives the run
  const chrome = spawn(
    findChrome(),
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--lang=en-US', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1440,900', 'about:blank'],
    // Specs click buttons by their English text; on a non-English host locale (LANG/LANGUAGE),
    // Chrome otherwise reports navigator.language from the OS regardless of --lang.
    { stdio: 'ignore', detached: true, env: { ...process.env, LANGUAGE: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } },
  );
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      ws?.close();
    } catch {
      // the socket is gone with the browser
    }
    try {
      process.kill(-chrome.pid, 'SIGKILL');
    } catch {
      chrome.kill('SIGKILL');
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  };
  // Every way out of the process (a signal turned into an exit, an uncaught error, a normal end) runs it
  process.once('exit', close);
  let ws;
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    } catch {
      await sleep(250);
    }
  }
  if (!target) {
    close();
    throw new Error('Chrome did not expose a debugging target');
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === 'Runtime.exceptionThrown') {
      errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    } else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
      errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        rej(new Error(`Chrome did not answer ${method} within ${CDP_TIMEOUT_MS / 1000}s`));
      }, CDP_TIMEOUT_MS);
      pending.set(i, (message) => {
        clearTimeout(timer);
        res(message);
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');

  const page = {
    baseUrl,
    sleep,
    /** Console errors and uncaught exceptions seen so far; `takeErrors()` also clears them. */
    takeErrors: () => errors.splice(0),
    async goto(path, wait = 1200) {
      await send('Page.navigate', { url: `${baseUrl}${path}` });
      await sleep(wait);
    },
    async eval(body) {
      const r = await send('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed');
      return r.result.result.value;
    },
    /** Polls until `body` (a JS function body) returns something truthy. */
    // Generous by default: pages are code-split and CI runners are slow
    async waitFor(body, { timeout = 20000, label = body } = {}) {
      const end = Date.now() + timeout;
      for (;;) {
        const value = await this.eval(body).catch(() => null);
        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
        await sleep(150);
      }
    },
    /**
     * Clicks the first element matching `selector`; with `text`, the one whose text equals or
     * contains it. Waits for the element: pages are code-split, so they appear asynchronously.
     */
    async click(selector, text, wait = 500) {
      const expression =
        `const els=[...document.querySelectorAll(${JSON.stringify(selector)})];const t=${JSON.stringify(text ?? null)};` +
        `const el=t?els.find(e=>e.textContent.trim()===t)||els.find(e=>e.textContent.includes(t)):els[0];` +
        `if(!el)return false;el.scrollIntoView({block:'center'});el.click();return true;`;
      await this.waitFor(expression, { label: `click ${selector}${text ? ` "${text}"` : ''}` });
      await sleep(wait);
    },
    /**
     * Picks `optionText` in a themed Select: clicks its trigger, then the matching [role=option]
     * in the portalled menu. A synthetic click takes Radix's touch path, which opens and selects.
     */
    async select(triggerSelector, optionText) {
      await this.click(triggerSelector, undefined, 300);
      await this.click('[role=listbox] [role=option]', optionText, 400);
    },
    /** Sets an input/textarea value the way React expects; waits for the element. */
    async fill(selector, value) {
      await this.waitFor(
        `const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;` +
          `const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;` +
          `Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});` +
          `el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;`,
        { label: `fill ${selector}` },
      );
      await sleep(150);
    },
    async focus(selector) {
      await this.waitFor(`const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.focus();return true;`, { label: `focus ${selector}` });
    },
    /** Types into the focused element (real input events; works with CodeMirror). */
    async type(text) {
      await send('Input.insertText', { text });
      await sleep(150);
    },
    /** modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift */
    async key(key, modifiers = 0) {
      const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, modifiers, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Enter: 13, Escape: 27, Tab: 9, ArrowUp: 38, ArrowDown: 40 }[key] };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(250);
    },
    /**
     * A key press as a keyboard sends it, with the character that follows: this is what activates a
     * focused link or button (Enter) or presses it (Space). `key()` sends the bare event, enough for
     * handlers of keydown but not for the browser's own default actions.
     */
    async press(key, modifiers = 0) {
      const codes = { Enter: [13, '\r'], ' ': [32, ' '], Tab: [9, undefined], Escape: [27, undefined], ArrowUp: [38, undefined], ArrowDown: [40, undefined], ArrowLeft: [37, undefined], ArrowRight: [39, undefined], Home: [36, undefined], End: [35, undefined] };
      const [windowsVirtualKeyCode, text] = codes[key] ?? [key.toUpperCase().charCodeAt(0), key];
      const base = { key, code: key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key, modifiers, windowsVirtualKeyCode };
      await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(250);
    },
    /** Animations and transitions collapse to nothing, so a scan never sees a page half faded in. */
    async reduceMotion(on = true) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] });
    },
    /**
     * Runs axe-core on the page, or on the elements matching `include`, and returns the violations
     * trimmed to what is needed to fix them. `rules` is axe's own `{ id: { enabled } }` map.
     */
    async axe({ include, rules = {} } = {}) {
      const loaded = await send('Runtime.evaluate', { expression: `typeof window.axe === 'object'`, returnByValue: true });
      if (!loaded.result.result.value) {
        const injected = await send('Runtime.evaluate', { expression: axeScript() });
        if (injected.result.exceptionDetails) throw new Error(`axe-core did not load: ${injected.result.exceptionDetails.exception?.description ?? injected.result.exceptionDetails.text}`);
      }
      const options = { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'], rules };
      const body =
        `const result = await Promise.race([axe.run(${include ? JSON.stringify({ include: [include] }) : 'document'}, ${JSON.stringify(options)}), ` +
        `new Promise((_, reject) => setTimeout(() => reject(new Error('axe did not finish within 30s')), 30000))]);` +
        `return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 140), why: n.failureSummary?.replace(/\\s+/g, ' ').slice(0, 260) ?? '' })) }));`;
      return this.eval(body);
    },
    text: (selector = 'body') => page.eval(`return document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`),
    async viewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
    },
    async shot(name) {
      if (!shotsDir) return;
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    },
  };
  return { page, close };
}
