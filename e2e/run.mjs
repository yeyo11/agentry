// End-to-end suite: boots an ISOLATED wrapper (temp config/workspace/data dirs, built UI) and
// drives it with headless Chrome. It never touches the real ~/.claude.
//   pnpm build && pnpm e2e              all specs
//   pnpm e2e config palette             only some
//   E2E_LIVE=1 pnpm e2e chat            specs that talk to Claude (needs a logged-in CLI; costs tokens)
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './driver.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = Number(process.env.E2E_PORT ?? 8799);
const baseUrl = `http://127.0.0.1:${PORT}`;
const live = process.env.E2E_LIVE === '1';

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
const server = spawn('pnpm', ['--filter', '@agentry/api', 'start'], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
const stopServer = () => {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    // already gone
  }
};
process.on('exit', stopServer);

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
const specs = readdirSync(join(here, 'specs'))
  .filter((f) => f.endsWith('.spec.mjs'))
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)))
  .sort();

let failed = 0;
let browser;
try {
  await waitForServer();
  // A second suite can run beside another one given its own E2E_PORT and E2E_CDP_PORT
  browser = await launch({ baseUrl, port: Number(process.env.E2E_CDP_PORT ?? 9444), shotsDir: process.env.E2E_SHOTS });
  for (const file of specs) {
    const spec = await import(join(here, 'specs', file));
    if (spec.live && !live) {
      console.log(`- ${file} (skipped: set E2E_LIVE=1)`);
      continue;
    }
    const started = Date.now();
    try {
      browser.page.takeErrors();
      await spec.default({ page: browser.page, api, check, dirs });
      const errors = browser.page.takeErrors();
      check(errors.length === 0, `console errors:\n  ${[...new Set(errors)].join('\n  ')}`);
      console.log(`✓ ${file} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (error) {
      failed++;
      console.log(`✗ ${file}\n  ${error.message.replaceAll('\n', '\n  ')}`);
      await browser.page.shot(`FAILED-${file}`).catch(() => {});
    }
  }
} catch (error) {
  failed++;
  console.error(error.message);
} finally {
  browser?.close();
  stopServer();
}
console.log(failed ? `\n${failed} spec(s) failed` : `\nall ${specs.length} spec file(s) passed`);
process.exit(failed ? 1 : 0);
