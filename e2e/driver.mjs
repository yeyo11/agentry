// Dependency-free browser driver over the Chrome DevTools Protocol (Node 22+: global fetch/WebSocket).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { killGroup } from './processes.mjs';

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

/**
 * Chrome picks its own debugging port (`--remote-debugging-port=0`), so a browser left over from an
 * earlier run, or a second suite beside this one, can never be mistaken for ours by a fixed port.
 * It says which port in two places: a `DevTools listening on ws://…` line on stderr, and the
 * `DevToolsActivePort` file in the profile. Either will do, and whichever comes first is taken: on
 * the CI runner the file once did not appear within the wait at all. When neither comes,
 * the error carries the end of what Chrome printed, since that is where it says why.
 */
async function devtoolsEndpoint(profile, chrome, output, wait = 30_000) {
  const file = join(profile, 'DevToolsActivePort');
  for (let waited = 0; waited < wait; waited += 100) {
    const announced = /DevTools listening on ws:\/\/[^:\s]+:(\d+)\//.exec(output.text);
    if (announced) return Number(announced[1]);
    if (existsSync(file)) {
      const [port] = readFileSync(file, 'utf8').split('\n');
      if (Number(port) > 0) return Number(port);
    }
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      throw new Error(`Chrome exited (${chrome.exitCode ?? chrome.signalCode}) before it exposed a debugging port${tail(output.text)}`);
    }
    await sleep(100);
  }
  throw new Error(`Chrome did not expose a debugging port in ${wait / 1000} s${tail(output.text)}`);
}

const tail = (text) => (text.trim() ? `. Chrome printed:\n${text.trim().split('\n').slice(-15).join('\n')}` : '');

/**
 * Starts headless Chrome and returns `{ page, close, pid }`. `close()` is idempotent and also runs
 * from the process's 'exit', so the browser goes down on every way out: the end of the run, a
 * failure, a timeout, a signal turned into an exit, an uncaught error. It is killed by the PID of
 * the process started here (as the leader of its own group, so renderers and helpers go with it),
 * never by matching a name.
 */
export async function launch({ baseUrl, port = 0, shotsDir }) {
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'agentry-e2e-chrome-'));
  // Its own process group, so the renderers and helpers go down with it and none outlives the run
  const chrome = spawn(
    findChrome(),
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--lang=en-US', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1440,900', 'about:blank'],
    // Specs click buttons by their English text; on a non-English host locale (LANG/LANGUAGE),
    // Chrome otherwise reports navigator.language from the OS regardless of --lang.
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true, env: { ...process.env, LANGUAGE: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } },
  );
  // Read for the port, and kept draining for the browser's whole life: a pipe nobody reads fills up
  // and blocks Chrome on its next write. Only the start is kept, which is where the port and any
  // reason it could not start are
  const output = { text: '' };
  chrome.stderr.setEncoding('utf8');
  chrome.stderr.on('data', (chunk) => {
    if (output.text.length < 64_000) output.text += chunk;
  });
  // The pipe must not keep the harness alive on its own: the browser's lifetime is `close()`'s business
  chrome.stderr.unref?.();
  // A Chrome that cannot start emits 'error' (nothing to kill then); without a listener it would be an uncaught one
  chrome.on('error', () => {});
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      ws?.close();
    } catch {
      // the socket is gone with the browser
    }
    killGroup(chrome.pid);
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  };
  process.once('exit', close);
  let ws;
  try {
    const debuggingPort = port || (await devtoolsEndpoint(profile, chrome, output));
    let target;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        target = (await (await fetch(`http://127.0.0.1:${debuggingPort}/json`)).json()).find((t) => t.type === 'page');
      } catch {
        await sleep(250);
      }
    }
    if (!target) throw new Error('Chrome did not expose a debugging target');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('could not connect to Chrome over the DevTools socket'));
    });
  } catch (error) {
    close();
    throw error;
  }

  let id = 0;
  const pending = new Map();
  // A browser that dies mid-run answers nothing: fail what is waiting now instead of after the CDP timeout
  ws.onclose = () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('Chrome closed the DevTools connection'));
    }
    pending.clear();
  };
  const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { resolve, timer } = pending.get(d.id);
      clearTimeout(timer);
      resolve(d);
      pending.delete(d.id);
    } else if (d.method === 'Runtime.exceptionThrown') {
      errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    } else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
      errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`Chrome did not answer ${method} within ${CDP_TIMEOUT_MS / 1000}s`));
      }, CDP_TIMEOUT_MS);
      pending.set(i, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');

  const page = {
    baseUrl,
    sleep,
    /**
     * Leaves the app and forgets what it stored (localStorage, sessionStorage, IndexedDB, cookies),
     * so a spec starts from a fresh browser and not from what the specs before it left behind: the
     * notification centre, for one, keeps every finished chat in localStorage.
     */
    async reset() {
      // Blank first: the page being left would otherwise write its state back, and its event stream would go on
      await send('Page.navigate', { url: 'about:blank' });
      await send('Storage.clearDataForOrigin', { origin: new URL(baseUrl).origin, storageTypes: 'local_storage,session_storage,indexeddb,cookies' });
    },
    /**
     * Runs `source` in every document loaded from now on, before any of the page's own scripts,
     * which is the only way to stand between the app and what it opens on load (its event stream).
     * Returns what removes it again, which a spec must call so the next one gets an untouched page.
     */
    async onNewDocument(source) {
      const added = await send('Page.addScriptToEvaluateOnNewDocument', { source });
      const identifier = added.result.identifier;
      return () => send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    },
    /**
     * Makes every request whose URL matches one of `patterns` (`*` wildcards) fail, the way a file
     * a deploy removed fails, and skips the service worker so its cache cannot answer instead.
     * Returns what lifts the block, which a spec must call before it finishes.
     */
    async blockUrls(patterns) {
      await send('Network.enable');
      await send('Network.setBypassServiceWorker', { bypass: true });
      await send('Network.setBlockedURLs', { urls: patterns });
      return async () => {
        await send('Network.setBlockedURLs', { urls: [] });
        await send('Network.setBypassServiceWorker', { bypass: false });
        await send('Network.disable');
      };
    },
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
  return { page, close, pid: chrome.pid };
}
