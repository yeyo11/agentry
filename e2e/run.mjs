// End-to-end suite: boots an ISOLATED wrapper (temp config/workspace/data dirs, built UI) and
// drives it with headless Chrome. It never touches the real ~/.claude.
//   pnpm build && pnpm e2e              all specs
//   pnpm e2e config palette             only some
//   E2E_LIVE=1 pnpm e2e chat            specs that talk to Claude (needs a logged-in CLI; costs tokens)
// A hung run cannot outlive its limits: E2E_SPEC_TIMEOUT (ms, per spec; a spec may export `timeout`)
// and E2E_TIMEOUT (ms, whole run). The server and the browser are closed on every way out (end,
// failure, timeout, SIGINT/SIGTERM/SIGHUP, uncaught error), by the PID of what this run started.
// E2E_SPECS_DIR runs the specs of another directory (the harness's own test uses it); E2E_KEEP=1
// keeps the temporary sandbox for inspection.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './driver.mjs';
import { killGroup } from './processes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = Number(process.env.E2E_PORT ?? 8799);
const baseUrl = `http://127.0.0.1:${PORT}`;
const live = process.env.E2E_LIVE === '1';
// A run that hangs holds a browser and a server: both have a limit, and both are closed on the way out
function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!(Number(raw) > 0)) {
    console.error(`${name} must be a number of milliseconds greater than 0, got "${raw}"`);
    process.exit(2);
  }
  return Number(raw);
}
const SPEC_LIMIT_MS = envMs('E2E_SPEC_TIMEOUT', 180_000);
const RUN_LIMIT_MS = envMs('E2E_TIMEOUT', 900_000);
const specsDir = process.env.E2E_SPECS_DIR ? resolve(process.env.E2E_SPECS_DIR) : join(here, 'specs');

if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
  console.error('apps/web/dist is missing: run `pnpm build` first.');
  process.exit(2);
}

const sandbox = mkdtempSync(join(tmpdir(), 'agentry-e2e-'));
// Specs seed transcripts and files straight into these directories
const dirs = {
  configDir: live ? null : join(sandbox, 'claude'),
  workspaceDir: join(sandbox, 'workspace'),
  dataDir: join(sandbox, 'data'),
};
const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  AGENTRY_WORKSPACE_DIR: join(sandbox, 'workspace'),
  AGENTRY_DATA_DIR: join(sandbox, 'data'),
  // Live specs need the real login; everything else runs against an empty config dir
  ...(live ? {} : { CLAUDE_CONFIG_DIR: join(sandbox, 'claude'), CSWAP_BIN: join(sandbox, 'no-cswap') }),
};
// Its own process group: `pnpm`, `tsx` and the API are killed together, by the leader's PID
const server = spawn('pnpm', ['--filter', '@agentry/api', 'start'], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
server.on('error', () => {});
// 'exit' is the one hook every way out passes through (the browser closes itself from its own
// handler, registered when it launches). The server goes first, then the sandbox it was using.
process.on('exit', () => {
  // SIGTERM first: the API closes its database on it
  killGroup(server.pid, { graceMs: 3000 });
  if (process.env.E2E_KEEP !== '1') rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
});
const stop = (code, message) => {
  console.error(`\n${message}`);
  process.exit(code);
};
// A signal ends the process through 'exit'; 128 + the signal number is the shell's convention
for (const [signal, number] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(signal, () => stop(128 + number, `${signal}: stopping the e2e run`));
process.on('uncaughtException', (error) => stop(1, `the e2e run crashed: ${error?.stack ?? error}`));
process.on('unhandledRejection', (error) => stop(1, `the e2e run crashed on an unhandled rejection: ${error?.stack ?? error}`));
setTimeout(() => stop(1, `the e2e run exceeded ${RUN_LIMIT_MS / 1000}s: stopping it (set E2E_TIMEOUT to allow longer)`), RUN_LIMIT_MS).unref();

/** Rejects when `work` outlives `ms`; the caller must not go on driving the browser afterwards. */
function within(work, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${baseUrl}/api/system`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('API did not start');
}

const api = {
  baseUrl,
  async request(method, path, body) {
    const res = await fetch(`${baseUrl}/api${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  },
  get: (path) => api.request('GET', path),
  put: (path, body) => api.request('PUT', path, body),
  post: (path, body) => api.request('POST', path, body),
  del: (path) => api.request('DELETE', path),
};

function check(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

const wanted = process.argv.slice(2);
const specs = readdirSync(specsDir)
  .filter((f) => f.endsWith('.spec.mjs'))
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)))
  .sort();

let failed = 0;
let browser;
try {
  await waitForServer();
  // Chrome chooses its debugging port, so a second suite can run beside this one given its own E2E_PORT
  browser = await launch({ baseUrl, port: Number(process.env.E2E_CDP_PORT ?? 0), shotsDir: process.env.E2E_SHOTS });
  for (const file of specs) {
    const spec = await import(join(specsDir, file));
    if (spec.live && !live) {
      console.log(`- ${file} (skipped: set E2E_LIVE=1)`);
      continue;
    }
    const started = Date.now();
    // A spec with a lot to scan says so with `export const timeout`
    const limit = spec.timeout ?? SPEC_LIMIT_MS;
    try {
      await browser.page.reset();
      browser.page.takeErrors();
      await within(spec.default({ page: browser.page, api, check, dirs }), limit, file);
      const errors = browser.page.takeErrors();
      check(errors.length === 0, `console errors:\n  ${[...new Set(errors)].join('\n  ')}`);
      console.log(`✓ ${file} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (error) {
      failed++;
      console.log(`✗ ${file}\n  ${error.message.replaceAll('\n', '\n  ')}`);
      await browser.page.shot(`FAILED-${file}`).catch(() => {});
      // A spec that timed out is still running in the background: the browser is not safe to reuse
      if (error.message.endsWith(`took longer than ${limit / 1000}s`)) {
        console.log('- stopping: the timed-out spec may still be driving the browser');
        break;
      }
    }
  }
} catch (error) {
  failed++;
  console.error(error.message);
} finally {
  // The 'exit' handlers would do it too; closing here keeps the browser from lingering while the summary prints
  browser?.close();
}
console.log(failed ? `\n${failed} spec(s) failed` : `\nall ${specs.length} spec file(s) passed`);
process.exit(failed ? 1 : 0);
