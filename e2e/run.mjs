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
// A spec that exports `fakeCli = true` runs against the fake `claude` of e2e/fake-cli instead of the
// real one: the server is restarted with it first on PATH, and those specs run after every other,
// so a spec that did not ask never sees it. See e2e/fake-cli/README.md.
// Agentry's own release check never reaches GitHub: AGENTRY_RELEASES_URL points at a fixture served
// here, whose tag a spec sets through `releases.set(tag)`. The daily check is off, so only a spec
// that presses Check for updates (or posts /system/release/check) learns of a release.
// Shards: E2E_SHARD=k/N runs only shard k of N (1-based) in this process, which is what each CI
// matrix job does. E2E_SHARDS=N runs all N at once as children, each with its own sandbox, port and
// Chrome, and prints one report in the order a single run would (default: one shard per two cores,
// at most 4, never more than there are groups; E2E_PORT, when set, is the first of N ports). The
// split is greedy longest-first over e2e/timings.json (seconds per spec, checked in so every CI job
// computes the same split; a spec missing from it weighs the median), and every fakeCli spec stays
// in one shard, behind one restart of its server. See e2e/shards.mjs.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { availableParallelism, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './driver.mjs';
import { runShards } from './parallel.mjs';
import { killGroup } from './processes.mjs';
import { defaultShardCount, groupSpecs, loadTimings, parseCount, parseShard, splitSpecs } from './shards.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
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
const RUN_LIMIT_MS = envMs('E2E_TIMEOUT', 1_500_000);
const specsDir = process.env.E2E_SPECS_DIR ? resolve(process.env.E2E_SPECS_DIR) : join(here, 'specs');

if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
  console.error('apps/web/dist is missing: run `pnpm build` first.');
  process.exit(2);
}

const wanted = process.argv.slice(2);
const allSpecs = readdirSync(specsDir)
  .filter((f) => f.endsWith('.spec.mjs'))
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)))
  .sort();
// Loaded up front, to know which want the fake CLI: those run last, behind one restart of the server,
// and they are the one group the split keeps together
const allLoaded = [];
for (const file of allSpecs) {
  try {
    allLoaded.push({ file, spec: await import(join(specsDir, file)) });
  } catch (error) {
    allLoaded.push({ file, error });
  }
}
const wantsFake = (entry) => entry.spec?.fakeCli === true;
const entries = allLoaded.map((e) => ({ file: e.file, fake: wantsFake(e) }));
const timings = loadTimings(resolve(specsDir, '..', 'timings.json'));

const shardText = process.env.E2E_SHARD;
const shard = shardText ? parseShard(shardText) : null;
if (shardText && !shard) {
  console.error(`E2E_SHARD must be k/N with 1 ≤ k ≤ N, got "${shardText}"`);
  process.exit(2);
}
const countText = process.env.E2E_SHARDS;
if (!shard && countText && !parseCount(countText)) {
  console.error(`E2E_SHARDS must be a whole number of 1 or more, got "${countText}"`);
  process.exit(2);
}
if (!shard) {
  const groups = groupSpecs(entries, timings).length;
  const count = Math.max(1, Math.min(countText ? Number(countText) : defaultShardCount(availableParallelism(), groups), groups));
  if (count > 1) {
    const order = [...entries.filter((e) => !e.fake), ...entries.filter((e) => e.fake)].map((e) => e.file);
    const basePort = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : undefined;
    process.exit(await runShards({ runner: fileURLToPath(import.meta.url), args: wanted, shards: splitSpecs(entries, timings, count), order, basePort, runLimitMs: RUN_LIMIT_MS }));
  }
}
const mine = shard ? new Set(splitSpecs(entries, timings, shard.count)[shard.index - 1]?.files) : null;
const specs = mine ? allSpecs.filter((f) => mine.has(f)) : allSpecs;
const loaded = mine ? allLoaded.filter((e) => mine.has(e.file)) : allLoaded;

const PORT = Number(process.env.E2E_PORT || 8799);
const baseUrl = `http://127.0.0.1:${PORT}`;

// GitHub's latest-release shape, reduced to the fields the check reads
const releases = {
  tag: 'v999.0.0',
  set(tag) {
    releases.tag = tag;
  },
  get url() {
    return `https://github.com/yeyo11/agentry/releases/tag/${releases.tag}`;
  },
};
const releaseFixture = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ tag_name: releases.tag, html_url: releases.url, published_at: '2026-09-01T12:00:00Z', draft: false, prerelease: false }));
});
releaseFixture.listen(0, '127.0.0.1');
await once(releaseFixture, 'listening');
// It must not keep the run alive on its own; the process ending closes it
releaseFixture.unref();
const releasesUrl = `http://127.0.0.1:${releaseFixture.address().port}/repos/yeyo11/agentry/releases/latest`;

const sandbox = mkdtempSync(join(tmpdir(), 'agentry-e2e-'));
// Specs seed transcripts and files straight into these directories
const dirs = {
  configDir: live ? null : join(sandbox, 'claude'),
  workspaceDir: join(sandbox, 'workspace'),
  dataDir: join(sandbox, 'data'),
};
// The other providers' state lives in the sandbox too, never in the real home: the homes are named
// here and created by the specs that need a provider that was "used before" (e2e/specs/providers.spec.mjs)
const providerHomes = { codex: join(sandbox, 'codex-home'), gemini: join(sandbox, 'gemini-home'), copilot: join(sandbox, 'copilot-home'), xdgConfig: join(sandbox, 'xdg-config'), xdgData: join(sandbox, 'xdg-data') };
// Without a provider that works, the first-run Providers step stands in for the app on every page
// load, and no other spec could see the app. So the sandbox starts as a machine that finished that
// step (`setupSeen`) and has one agent ready: Codex, a fake (e2e/fake-providers) reached by
// the override in providers.json, not by PATH. The providers spec restores both before it ends.
mkdirSync(dirs.dataDir, { recursive: true });
writeFileSync(join(dirs.dataDir, 'app-settings.json'), `${JSON.stringify({ setupSeen: true }, null, 2)}\n`);
writeFileSync(
  join(dirs.dataDir, 'providers.json'),
  `${JSON.stringify({ providers: { codex: { enabled: true, binaryPath: join(here, 'fake-providers', 'codex') } }, order: ['claude-code', 'codex', 'gemini', 'copilot', 'opencode'], defaultProvider: null }, null, 2)}\n`,
);
// The code hosts are fakes too (e2e/fake-hosts), reached by the override in hosts.json: no real gh or
// glab on the machine changes what the Integrations and merge request specs see
writeFileSync(
  join(dirs.dataDir, 'hosts.json'),
  `${JSON.stringify({ hosts: { github: { enabled: true, binaryPath: join(here, 'fake-hosts', 'gh') }, gitlab: { enabled: true, binaryPath: join(here, 'fake-hosts', 'glab') } } }, null, 2)}\n`,
);
// YouTrack's program is a fake too (e2e/fake-trackers), reached by the override in trackers.json; the
// address and token stay unset, so a spec saves them like a person does
writeFileSync(
  join(dirs.dataDir, 'trackers.json'),
  `${JSON.stringify({ trackers: { youtrack: { enabled: true, binaryPath: join(here, 'fake-trackers', 'youtrack-app') } } }, null, 2)}\n`,
);
// glab lists the hosts it knows in its own config.yml: the sandbox has one, with gitlab.com and an
// account, so a real ~/.config/glab-cli never changes what the specs see
const glabConfigDir = join(sandbox, 'glab-config');
mkdirSync(glabConfigDir, { recursive: true });
writeFileSync(join(glabConfigDir, 'config.yml'), 'hosts:\n  gitlab.com:\n    user: tanuki\n');
const env = {
  ...process.env,
  GLAB_CONFIG_DIR: glabConfigDir,
  CODEX_HOME: providerHomes.codex,
  GEMINI_CLI_HOME: providerHomes.gemini,
  COPILOT_HOME: providerHomes.copilot,
  // OpenCode keeps its config and data under the XDG directories, so the server's point at the
  // sandbox and a real ~/.config/opencode never makes it "used before" here
  XDG_CONFIG_HOME: providerHomes.xdgConfig,
  XDG_DATA_HOME: providerHomes.xdgData,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  AGENTRY_WORKSPACE_DIR: join(sandbox, 'workspace'),
  AGENTRY_DATA_DIR: join(sandbox, 'data'),
  // The build this run is about, and not whatever the environment already pointed at. Inherited
  // from a shell that had it set — a desktop install exports it for its own packaged bundle — the
  // server serves that instead, and the suite reports on a build nobody asked it to look at. The
  // check above proves this directory exists; it is also the one every spec means.
  AGENTRY_WEB_DIST: join(root, 'apps/web/dist'),
  AGENTRY_RELEASES_URL: releasesUrl,
  AGENTRY_UPDATE_CHECK: 'off',
  // The Updates card offers the Docker commands, the one distribution a browser run can stand for
  AGENTRY_DISTRIBUTION: 'docker',
  // ...which turns the tunnel off by default; the Remote access specs need it offered. No spec can
  // open a real one: the suite runs with authentication off, and the tunnel refuses to start then
  AGENTRY_TUNNEL: 'on',
  // The tunnel's CLI is the core tests' fake, on a node file of the sandbox's own: the suite never
  // asks, let alone changes, the real Tailscale of the machine it runs on
  TAILSCALE_BIN: join(root, 'packages/core/test/fixtures/fake-tailscale.mjs'),
  FAKE_TAILSCALE_STATE: join(sandbox, 'tailscale-node.json'),
  // Live specs need the real login; everything else runs against an empty config dir
  ...(live ? {} : { CLAUDE_CONFIG_DIR: join(sandbox, 'claude') }),
};
// The fake CLI's sandbox: the same directories, with the fake first on PATH. The config directory is
// always the sandbox's, live or not, since the fake has no login to need the real one. Health is
// checked every half second, so a signal reaches the page within a spec's patience.
// `scripts` is the fake's scripts file (AGENTRY_FAKE_CLI_SCRIPTS): a spec writes it to script a turn it
// cannot type itself, such as the prompt an assistant run is started with. The fake reads it anew on
// every turn, and a missing file scripts nothing.
const fakeCli = { bin: join(here, 'fake-cli', 'claude'), log: join(sandbox, 'fake-cli.jsonl'), scripts: join(sandbox, 'fake-cli-scripts.json') };
const fakeEnv = {
  ...env,
  PATH: [join(here, 'fake-cli'), process.env.PATH].filter(Boolean).join(delimiter),
  CLAUDE_CONFIG_DIR: join(sandbox, 'claude'),
  AGENTRY_HEALTH_INTERVAL_MS: '500',
  AGENTRY_FAKE_CLI_LOG: fakeCli.log,
  AGENTRY_FAKE_CLI_SCRIPTS: fakeCli.scripts,
  AGENTRY_FAKE_CLI_HEARTBEAT_MS: '500',
  // By absolute path, not by PATH alone: the API puts the login shell's PATH first, and on a machine
  // with Claude Code in ~/.local/bin that found the real CLI, so every fakeCli spec talked to it and
  // ran out its time
  CLAUDE_BIN: join(here, 'fake-cli', 'claude'),
};

/** The server running now, and which CLI it was given */
let server = null;
let serverCli = null;
/** The last lines the server wrote to stderr: what a failed start is reported with */
let serverStderr = '';
const STDERR_TAIL_CHARS = 4000;
function startServer(cli) {
  // Its own process group: `pnpm`, `tsx` and the API are killed together, by the leader's PID
  const child = spawn('pnpm', ['--filter', '@agentry/api', 'start'], { cwd: root, env: cli === 'fake' ? fakeEnv : env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  serverStderr = '';
  // Still shown as it comes, as when stderr was inherited; kept as well, so a start that fails can say why
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    if (server === child) serverStderr = (serverStderr + chunk).slice(-STDERR_TAIL_CHARS);
  });
  child.on('error', () => {});
  server = child;
  serverCli = cli;
}
function stopServer() {
  // SIGTERM first: the API closes its database on it. Synchronous, so the port is free when it returns
  if (server) killGroup(server.pid, { graceMs: 3000 });
  server = null;
}
// 'exit' is the one hook every way out passes through (the browser closes itself from its own
// handler, registered when it launches). The server goes first, then the sandbox it was using.
process.on('exit', () => {
  stopServer();
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

// Generous on purpose: a loaded machine (CI running suites side by side, shards starting together)
// has taken well over 20 s to boot `pnpm`, `tsx` and the API. A server that died is reported at once.
const SERVER_START_LIMIT_MS = envMs('E2E_SERVER_START_TIMEOUT', 120_000);

/**
 * Resolves once the API answers. `/api/health` is the probe because it is cheap and never measures
 * anything (`/api/system` may start a `claude` process), and it answers only after every route is
 * registered, since the server listens last. Its `ok` field speaks of the CLI's login, which the
 * sandbox does not have: any 200 means the server is ready.
 */
async function waitForServer() {
  const child = server;
  // Already gone if it failed between the spawn and this call
  let exited = child.exitCode !== null || child.signalCode !== null ? { code: child.exitCode, signal: child.signalCode } : null;
  const onExit = (code, signal) => (exited = { code, signal });
  child.once('exit', onExit);
  const started = Date.now();
  try {
    while (Date.now() - started < SERVER_START_LIMIT_MS) {
      if (exited) {
        throw new Error(`the API exited before it answered (${exited.signal ?? `code ${exited.code}`}):\n${serverStderr.trim() || '(no stderr)'}`);
      }
      try {
        const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`the API did not answer /api/health within ${SERVER_START_LIMIT_MS / 1000}s (set E2E_SERVER_START_TIMEOUT to allow longer):\n${serverStderr.trim() || '(no stderr)'}`);
  } finally {
    child.off('exit', onExit);
  }
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

const ordered = [...loaded.filter((e) => !wantsFake(e)), ...loaded.filter(wantsFake)];
const firstToRun = ordered.find((e) => !(e.spec?.live && !live));
startServer(firstToRun && wantsFake(firstToRun) ? 'fake' : 'real');

let failed = 0;
const failedFiles = [];
let browser;
try {
  await waitForServer();
  // Chrome chooses its debugging port, so a second suite can run beside this one given its own E2E_PORT
  browser = await launch({ baseUrl, port: Number(process.env.E2E_CDP_PORT ?? 0), shotsDir: process.env.E2E_SHOTS });
  for (const { file, spec, error } of ordered) {
    if (error) {
      failed++;
      failedFiles.push(file);
      console.log(`✗ ${file}\n  could not be loaded: ${error.message}`);
      continue;
    }
    if (spec.live && !live) {
      console.log(`- ${file} (skipped: set E2E_LIVE=1)`);
      continue;
    }
    const cli = wantsFake({ spec }) ? 'fake' : 'real';
    if (cli !== serverCli) {
      console.log(`- restarting the server with the ${cli === 'fake' ? 'fake CLI (e2e/fake-cli)' : 'real CLI'}`);
      stopServer();
      startServer(cli);
      await waitForServer();
    }
    const started = Date.now();
    // A spec with a lot to scan says so with `export const timeout`
    const limit = spec.timeout ?? SPEC_LIMIT_MS;
    try {
      await browser.page.reset();
      browser.page.takeErrors();
      const context = cli === 'fake' ? { page: browser.page, api, check, dirs: { ...dirs, configDir: join(sandbox, 'claude') }, fakeCli, releases } : { page: browser.page, api, check, dirs, releases };
      await within(spec.default(context), limit, file);
      const errors = browser.page.takeErrors();
      check(errors.length === 0, `console errors:\n  ${[...new Set(errors)].join('\n  ')}`);
      console.log(`✓ ${file} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (error) {
      failed++;
      failedFiles.push(file);
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
// The failed files come last, so the tail of the output (all a fixer may be shown) names them
if (failedFiles.length) console.log(`\nfailed:\n${failedFiles.map((f) => `✗ ${f}`).join('\n')}`);
console.log(failed ? `${failedFiles.length ? '' : '\n'}${failed} spec(s) failed` : `\nall ${specs.length} spec file(s) passed`);
process.exit(failed ? 1 : 0);
