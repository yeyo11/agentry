// Records the README's media: `pnpm build && pnpm media`.
//
// It boots an ISOLATED wrapper the way e2e/run.mjs does (temporary config, workspace and data
// directories; the built UI), with the fake `claude` of e2e/fake-cli first on PATH and a stub
// claude-swap holding three accounts, fills it with invented projects, chats, a graph and schedules,
// and drives one headless Chrome through e2e/driver.mjs at 1280×800 (and 390×844 for the phone still). Nothing of the real ~/.claude,
// no login and no model: every name, prompt and figure in frame is made up here.
//
//   pnpm media                  the tour and every still, into docs/media
//   pnpm media stills           only the stills (or `tour` for only the GIF)
//   MEDIA_OUT=/tmp/m pnpm media somewhere else than docs/media
//   MEDIA_KEEP=1                keeps the sandbox for inspection
//
// The wrapper and Chrome are killed by the PID this script started (each as the leader of its own
// process group) on every way out: the end, a failure, MEDIA_TIMEOUT (ms), a signal, an uncaught error.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import gifenc from 'gifenc';
import { launch } from '../e2e/driver.mjs';
import { killGroup } from '../e2e/processes.mjs';

// gifenc ships CommonJS: its functions come off the default export
const { applyPalette, GIFEncoder, quantize } = gifenc;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.env.MEDIA_OUT ?? join(root, 'docs/media'));
const PORT = Number(process.env.MEDIA_PORT ?? 8797);
const baseUrl = `http://127.0.0.1:${PORT}`;
const WIDTH = 1280;
const HEIGHT = 800;
/** A phone: the chat as it is used on one, composer at the bottom */
const PHONE = { width: 390, height: 844 };
/** What the README can carry at the top without a slow first paint */
const TOUR_MAX_BYTES = 1.5 * 1024 * 1024;
const RUN_LIMIT_MS = Number(process.env.MEDIA_TIMEOUT ?? 600_000);
const wanted = new Set(process.argv.slice(2));
const want = (what) => wanted.size === 0 || wanted.has(what);

if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
  console.error('apps/web/dist is missing: run `pnpm build` first.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A fixed path, because it is in frame (a chat's directory, a graph's): a random suffix would change
// every recording. Created here and refused if it exists, so nothing of anyone else's is ever reused
// or removed; a run killed with SIGKILL leaves it behind, and says so the next time.
const sandbox = join(tmpdir(), 'agentry-demo');
try {
  mkdirSync(sandbox);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error(`${sandbox} already exists: another recording is running, or one was killed before it could clean up. Remove it and try again.`);
  process.exit(2);
}
const dirs = {
  config: join(sandbox, 'claude'),
  workspace: join(sandbox, 'work'),
  data: join(sandbox, 'data'),
  shots: join(sandbox, 'shots'),
  bin: join(sandbox, 'bin'),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const cswap = join(dirs.bin, 'cswap');
const scriptsFile = join(sandbox, 'fake-cli-scripts.json');
const gitConfig = join(sandbox, 'gitconfig');
// Commits in frame (the seeded history, the workers' and the merges) carry an invented author
writeFileSync(gitConfig, '[user]\n\tname = Agentry Demo\n\temail = demo@agentry.dev\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  PATH: [join(root, 'e2e/fake-cli'), process.env.PATH].filter(Boolean).join(delimiter),
  CLAUDE_CONFIG_DIR: dirs.config,
  AGENTRY_WORKSPACE_DIR: dirs.workspace,
  AGENTRY_DATA_DIR: dirs.data,
  // The UI just built: a terminal of the desktop app inherits the installed app's own
  AGENTRY_WEB_DIST: join(root, 'apps/web/dist'),
  CSWAP_BIN: cswap,
  AGENTRY_HEALTH_INTERVAL_MS: '1000',
  AGENTRY_FAKE_CLI_HEARTBEAT_MS: '1000',
  AGENTRY_FAKE_CLI_SCRIPTS: scriptsFile,
  // What the fake workers heard and ran: the first place to look when a scene does not come out
  AGENTRY_FAKE_CLI_LOG: join(sandbox, 'fake-cli.jsonl'),
  AGENTRY_FAKE_CLI_TURN_COST_USD: '0.18',
  AGENTRY_FAKE_CLI_VERSION: '2.1.0',
  AGENTRY_FAKE_CLI_AUTH: JSON.stringify({ authMethod: 'claude.ai', email: 'maya@northwind.dev', orgName: 'Northwind Labs', subscriptionType: 'team' }),
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  TZ: 'UTC',
};
// Named by PATH alone, so the variable must not point anywhere else
delete env.CLAUDE_BIN;
delete env.AGENTRY_AUTH_TOKEN;
// Chrome takes this process's environment: the times it prints are in the zone the server reads cron in
process.env.TZ = 'UTC';

// ---------- every way out ----------

let server = null;
let browser = null;
process.on('exit', () => {
  // The browser closes itself from its own 'exit' handler; the wrapper goes by the PID started here
  if (server) killGroup(server.pid, { graceMs: 3000 });
  server = null;
  if (process.env.MEDIA_KEEP !== '1') rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
  else console.error(`sandbox kept at ${sandbox}`);
});
const stop = (code, message) => {
  console.error(`\n${message}`);
  process.exit(code);
};
for (const [signal, number] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(signal, () => stop(128 + number, `${signal}: stopping the recorder`));
process.on('uncaughtException', (error) => stop(1, `the recorder crashed: ${error?.stack ?? error}`));
process.on('unhandledRejection', (error) => stop(1, `the recorder crashed on an unhandled rejection: ${error?.stack ?? error}`));
setTimeout(() => stop(1, `the recorder took longer than ${RUN_LIMIT_MS / 1000}s: stopping it (set MEDIA_TIMEOUT to allow longer)`), RUN_LIMIT_MS).unref();

// ---------- the API ----------

const api = {
  async request(method, path, body) {
    const res = await fetch(`${baseUrl}/api${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  },
  get: (path) => api.request('GET', path),
  post: (path, body) => api.request('POST', path, body),
  put: (path, body) => api.request('PUT', path, body),
};

async function until(condition, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await condition().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(250);
  }
}

// ---------- the invented world ----------

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

/** Where each account's five-hour window stands now: one near its limit, two with room. */
const ACCOUNTS = [
  { number: 1, now: 82, resetsInHours: 1.3, perHour: 22 },
  { number: 2, now: 12, resetsInHours: 3.6, perHour: 8 },
  { number: 3, now: 3, resetsInHours: 4.8, perHour: 3 },
];

/** The stub claude-swap: the three accounts, with the week besides the five hours. */
function writeCswap() {
  const at = new Date().toISOString();
  const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
  const window = (pct, hours, name) => ({ pct, resetsAt: inHours(hours), countdown: null, ...(name ? { name } : {}) });
  const list = {
    schemaVersion: 1,
    activeAccountNumber: 1,
    accounts: [
      { number: 1, email: 'maya@northwind.dev', organizationName: 'Northwind Labs', alias: 'main', active: true, usageStatus: 'ok', usage: { fiveHour: window(ACCOUNTS[0].now, ACCOUNTS[0].resetsInHours), sevenDay: window(46, 76), scoped: [window(31, 76, 'Opus')] }, usageFetchedAt: at },
      { number: 2, email: 'ops@northwind.dev', organizationName: 'Northwind Labs', alias: 'ops', active: false, usageStatus: 'ok', usage: { fiveHour: window(ACCOUNTS[1].now, ACCOUNTS[1].resetsInHours), sevenDay: window(27, 100), scoped: [window(9, 100, 'Opus')] }, usageFetchedAt: at },
      { number: 3, email: 'maya.side@fastmail.dev', organizationName: null, alias: null, active: false, usageStatus: 'ok', usage: { fiveHour: window(ACCOUNTS[2].now, ACCOUNTS[2].resetsInHours), sevenDay: window(64, 22) }, usageFetchedAt: at },
    ],
  };
  writeFileSync(cswap, `#!/bin/sh\ncase "$1" in\n  --version) echo "cswap 0.26.0" ;;\n  list) cat <<'JSON'\n${JSON.stringify(list)}\nJSON\n ;;\n  *) echo "not part of the recorder's stub: $*" >&2; exit 2 ;;\nesac\n`);
  chmodSync(cswap, 0o755);
}

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${res.stderr}`);
  return res.stdout.trim();
}

/** A small repository with a history, so a worktree has something to branch from and a diff has a base. */
function repository(name, files) {
  const dir = join(dirs.workspace, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial import');
  return dir;
}

const HARBOR = {
  'package.json': `${JSON.stringify({ name: 'harbor-api', version: '1.8.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  'README.md': '# harbor-api\n\nOrders and shipments for the Harbor storefront.\n',
  'src/server.js': "import { createServer } from 'node:http';\nimport { orders } from './routes/orders.js';\n\nexport const server = createServer((req, res) => orders(req, res));\n",
  'src/routes/orders.js':
    "const ORDERS = [{ id: 'ord_1', total: 42 }, { id: 'ord_2', total: 17 }];\n\nexport function list() {\n  return ORDERS;\n}\n\nexport function orders(req, res) {\n  res.setHeader('content-type', 'application/json');\n  res.end(JSON.stringify(list()));\n}\n",
  'test/orders.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { list } from '../src/routes/orders.js';\n\ntest('lists the orders', () => {\n  assert.equal(list().length, 2);\n});\n",
};
const LUMEN = {
  'package.json': `${JSON.stringify({ name: 'lumen-web', version: '0.9.2', private: true }, null, 2)}\n`,
  'README.md': '# lumen-web\n\nThe Harbor storefront.\n',
  'src/theme.css': ':root {\n  --accent: #e8743b;\n}\n',
};
const ATLAS = { 'README.md': '# atlas-docs\n\nGuides and the API reference.\n', 'guides/getting-started.md': '# Getting started\n' };

/** The CLI's own name for the directory it files a project's transcripts under. */
const projectKey = (path) => path.replace(/[^a-zA-Z0-9]/g, '-');
let uuidSeq = 0;
const uuid = () => `7a1e${String(++uuidSeq).padStart(4, '0')}-0000-4000-8000-${String(uuidSeq).padStart(12, '0')}`;

/**
 * A finished chat, laid out the way the CLI writes one: the prompt, a few steps of the assistant's
 * with their tool calls and results, and usage on every assistant line so it has a cost.
 */
function transcript(cwd, { prompt, startedMinutesAgo, model = 'claude-sonnet-5', steps }) {
  const id = uuid();
  const lines = [];
  let minute = startedMinutesAgo;
  let parent = null;
  const push = (entry) => {
    const uuidOf = uuid();
    lines.push({ ...entry, uuid: uuidOf, parentUuid: parent, sessionId: id, timestamp: minutesAgo(minute), cwd, version: '2.1.277', gitBranch: 'main' });
    parent = uuidOf;
    minute = Math.max(0, minute - 0.4);
  };
  const usage = (out) => ({ input_tokens: 1200, output_tokens: out, cache_read_input_tokens: 18_000, cache_creation_input_tokens: 2400 });
  push({ type: 'user', message: { role: 'user', content: prompt } });
  for (const step of steps) {
    if (step.say) push({ type: 'assistant', message: { id: `msg_${uuid()}`, role: 'assistant', model, content: [{ type: 'text', text: step.say }], usage: usage(320) } });
    if (step.bash) {
      const toolId = `toolu_${uuid().replaceAll('-', '').slice(0, 22)}`;
      push({ type: 'assistant', message: { id: `msg_${uuid()}`, role: 'assistant', model, content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: step.bash, description: step.description ?? step.bash } }], usage: usage(90) } });
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: step.output ?? '' }] } });
    }
  }
  const dir = join(dirs.config, 'projects', projectKey(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return id;
}

function seedChats(harbor, lumen, atlas) {
  transcript(harbor, {
    prompt: 'Why does the checkout test flake on CI but never locally?',
    startedMinutesAgo: 95,
    steps: [
      { say: 'I will run the suite a few times with a fixed seed to see whether the order matters.' },
      { bash: 'for i in 1 2 3; do node --test --test-shuffle; done', output: '# pass 14\n# fail 0\n# pass 13\n# fail 1\n# pass 14\n# fail 0' },
      { say: 'It fails when `refunds.test.js` runs first: it leaves the clock mocked. Restoring it in an `after` hook fixes the flake.' },
    ],
  });
  transcript(harbor, {
    prompt: 'Add cursor pagination to GET /orders',
    startedMinutesAgo: 60 * 5,
    model: 'claude-opus-5',
    steps: [
      { say: 'Reading how the orders route builds its response.' },
      { bash: 'sed -n 1,40p src/routes/orders.js', output: "const ORDERS = [{ id: 'ord_1', total: 42 }, …]" },
      { say: 'Added `?cursor=` and `?limit=` with a 100 cap, and two tests for the edges.' },
    ],
  });
  transcript(harbor, {
    prompt: 'Draft the release notes for 1.8.0 from the merged pull requests',
    startedMinutesAgo: 60 * 26,
    steps: [
      { bash: 'git log --oneline v1.7.0..HEAD', output: 'a41c2d9 feat: webhook retries\n19be07a fix: totals round half to even\n…' },
      { say: 'Drafted `CHANGELOG.md` for 1.8.0: two features, three fixes, no breaking change.' },
    ],
  });
  transcript(lumen, {
    prompt: 'Move the theme colours into CSS variables and add a dark theme',
    startedMinutesAgo: 60 * 3,
    steps: [
      { bash: 'grep -rn "#e8743b" src | wc -l', output: '23' },
      { say: 'Replaced 23 literal colours with variables; the dark theme overrides eleven of them.' },
    ],
  });
  transcript(lumen, {
    prompt: 'Upgrade the router to v7 and fix the type errors',
    startedMinutesAgo: 60 * 30,
    steps: [{ bash: 'npx tsc --noEmit | tail -3', output: 'Found 0 errors.' }, { say: 'Upgraded; four loaders needed the new `params` type.' }],
  });
  transcript(atlas, {
    prompt: 'Write a getting-started guide for the orders API',
    startedMinutesAgo: 60 * 50,
    steps: [{ say: 'Wrote `guides/orders.md` with an example request for each endpoint.' }],
  });
}

/**
 * A day of five-hour readings per account, the chart's default range: each window climbs and drops
 * back at its reset, and ends where the stub claude-swap says the account is now.
 */
function seedUsageHistory() {
  const db = new DatabaseSync(join(dirs.data, 'wrapper.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  const insert = db.prepare('INSERT OR IGNORE INTO usage_history (account, window, at, pct) VALUES (?, ?, ?, ?)');
  const WINDOW = 300;
  const busier = [1, 0.7, 1.1, 0.45, 0.9];
  for (const { number, now, resetsInHours, perHour } of ACCOUNTS) {
    const into = WINDOW - resetsInHours * 60;
    for (let ago = 24 * 60; ago >= 0; ago -= 15) {
      const at = into - ago;
      const windows = Math.floor(at / WINDOW);
      const minute = at - windows * WINDOW;
      // The window running now ends at the reading claude-swap reports; the ones before ran at their own pace
      const pct = windows === 0 ? (now * minute) / into : Math.min(100, (perHour * busier[Math.abs(windows) % busier.length] * minute) / 60);
      insert.run(number, '5h', minutesAgo(ago), Math.round(pct * 10) / 10);
    }
  }
  db.close();
}

/** Lines a fake worker plays instead of calling a model; keyed by a text its prompt contains. */
const SCRIPTS = {};
const writeScripts = () => writeFileSync(scriptsFile, JSON.stringify(SCRIPTS, null, 2));
/** A shell command that writes a file, for a `run:` line: one argument per line of it, since a script line cannot hold a newline. */
const writeFile = (path, content) => `mkdir -p ${dirname(path)} && printf '%s\\n' ${content.replace(/\n$/, '').split('\n').map(shellQuote).join(' ')} > ${path}`;
const shellQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

const CHAT_PROMPT = 'Add a rate limit to the public orders endpoint and cover it with a test';
SCRIPTS[CHAT_PROMPT] = [
  'say: I will look at how the orders route answers first, so the limit sits in front of it.',
  'run: sed -n 1,20p src/routes/orders.js',
  'say: One handler and no middleware yet. A token bucket per client address keeps it small: 60 requests a minute, then 429 with Retry-After.',
  `run: ${writeFile('src/middleware/rate-limit.js', "const WINDOW_MS = 60_000;\nconst LIMIT = 60;\nconst seen = new Map();\n\n/** 60 requests a minute per address; the 61st gets 429 and when to come back. */\nexport function rateLimit(req, res) {\n  const key = req.socket.remoteAddress ?? 'unknown';\n  const now = Date.now();\n  const hits = (seen.get(key) ?? []).filter((t) => now - t < WINDOW_MS);\n  hits.push(now);\n  seen.set(key, hits);\n  if (hits.length <= LIMIT) return false;\n  res.statusCode = 429;\n  res.setHeader('retry-after', String(Math.ceil((hits[0] + WINDOW_MS - now) / 1000)));\n  res.end();\n  return true;\n}\n")}`,
  `run: ${writeFile('src/server.js', "import { createServer } from 'node:http';\nimport { rateLimit } from './middleware/rate-limit.js';\nimport { orders } from './routes/orders.js';\n\nexport const server = createServer((req, res) => {\n  if (rateLimit(req, res)) return;\n  orders(req, res);\n});\n")}`,
  `run: ${writeFile('test/rate-limit.test.js', "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { rateLimit } from '../src/middleware/rate-limit.js';\n\nconst call = () => {\n  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() {} };\n  return { limited: rateLimit({ socket: { remoteAddress: '10.0.0.7' } }, res), res };\n};\n\ntest('the 61st request in a minute is refused with Retry-After', () => {\n  for (let i = 0; i < 60; i++) assert.equal(call().limited, false);\n  const last = call();\n  assert.equal(last.limited, true);\n  assert.equal(last.res.statusCode, 429);\n  assert.ok(Number(last.res.headers['retry-after']) > 0);\n});\n")}`,
  'run: node --test',
  'run: git add -A && git commit -qm "feat: rate limit the public orders endpoint"',
  `run: printf '%s\\n' '' '## Rate limit' '' 'GET /orders answers 429 with Retry-After past 60 requests a minute per address.' >> README.md`,
  'say: Both tests pass and the limit is committed. I will keep the suite running in watch mode while I check the Retry-After arithmetic against the edge of the window.',
  'run: node --test --watch test/',
].join('\n');

/** The graph in frame: four workers on their own worktrees, then the checks on the merged branch. */
const GRAPH_TASKS = [
  {
    id: 'schema',
    name: 'Order schema v2',
    prompt: 'Define the v2 order shape: money in minor units and an explicit currency.',
    script: ['say: Money moves to minor units with an ISO currency beside it.', `run: ${writeFile('src/schema/order.js', "export const ORDER_V2 = { id: 'string', totalMinor: 'integer', currency: 'ISO 4217' };\n")}`, 'run: sleep 3', 'run: git add -A && git commit -qm "feat: order schema v2"', 'say: Schema v2 is in src/schema/order.js.'],
  },
  {
    id: 'pagination',
    name: 'Cursor pagination',
    prompt: 'Page GET /orders with an opaque cursor and a limit capped at 100.',
    dependsOn: ['schema'],
    script: ['say: The cursor is the last id, base64url-encoded, so it stays opaque.', `run: ${writeFile('src/routes/page.js', "export const page = (items, limit = 20) => items.slice(0, Math.min(limit, 100));\n")}`, 'run: sleep 9', 'run: git add -A && git commit -qm "feat: cursor pagination for orders"', 'say: GET /orders takes ?cursor and ?limit.'],
  },
  {
    id: 'filters',
    name: 'Status filters',
    prompt: 'Filter GET /orders by status and by creation date.',
    dependsOn: ['schema'],
    script: ['say: Filters parse into one predicate, so pagination applies after them.', `run: ${writeFile('src/routes/filters.js', "export const byStatus = (status) => (order) => !status || order.status === status;\n")}`, 'run: sleep 12', 'run: git add -A && git commit -qm "feat: status and date filters"', 'say: ?status and ?since are parsed and tested.'],
  },
  {
    id: 'docs',
    name: 'API reference',
    prompt: 'Document the v2 orders endpoints in the API reference.',
    dependsOn: ['pagination', 'filters'],
    script: ['say: One page per endpoint, each with a request and its answer.', `run: ${writeFile('docs/orders-v2.md', '# Orders v2\n\n`GET /orders?cursor=&limit=&status=`\n')}`, 'run: sleep 3', 'run: git add -A && git commit -qm "docs: orders v2 reference"', 'say: docs/orders-v2.md covers the three parameters.'],
  },
];
for (const task of GRAPH_TASKS) SCRIPTS[task.prompt] = task.script.join('\n');

// ---------- PNG in, GIF out ----------

/** Chrome's screenshots are 8-bit, non-interlaced RGB or RGBA: that much PNG is all this reads. */
function decodePng(buffer) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('latin1', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, color, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) throw new Error(`unexpected PNG: depth ${depth}, colour type ${color}, interlace ${interlace}`);
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = cur[x * channels];
      rgba[o + 1] = cur[x * channels + 1];
      rgba[o + 2] = cur[x * channels + 2];
      rgba[o + 3] = 255;
    }
    prev = cur;
  }
  return { width, height, rgba };
}

/**
 * One palette for the whole tour, from a sample of every frame: the UI is a few flat colours, and a
 * shared palette is what lets a pixel that did not change be written as transparent, which is most
 * of every frame and what keeps the file small.
 */
function encodeGif(frames, width, height) {
  const sample = new Uint8Array(frames.length * Math.ceil((width * height) / 7) * 4);
  let n = 0;
  for (const { rgba } of frames) {
    for (let p = 0; p < width * height; p += 7) {
      sample.set(rgba.subarray(p * 4, p * 4 + 4), n);
      n += 4;
    }
  }
  const palette = quantize(sample.subarray(0, n), 255, { format: 'rgb565' });
  const transparentIndex = palette.length;
  palette.push([0, 0, 0]);
  const gif = GIFEncoder();
  let previous = null;
  for (const [i, frame] of frames.entries()) {
    const index = applyPalette(frame.rgba, palette.slice(0, transparentIndex), 'rgb565');
    if (previous) {
      for (let p = 0; p < index.length; p++) {
        if (index[p] === previous[p]) index[p] = transparentIndex;
        else previous[p] = index[p];
      }
    } else previous = index.slice();
    gif.writeFrame(index, width, height, { palette: i === 0 ? palette : undefined, delay: frame.delay, transparent: i > 0, transparentIndex, dispose: 1, repeat: 0 });
  }
  gif.finish();
  return gif.bytes();
}

// ---------- driving the page ----------

let page;
async function capture() {
  await page.shot('frame');
  return readFileSync(join(dirs.shots, 'frame.png'));
}
async function still(name) {
  const png = await capture();
  writeFileSync(join(OUT, name), png);
  console.log(`  ${name} (${Math.round(png.length / 1024)} KB)`);
}
/** Frames of the tour: a still held for `ms`, or the same screen again merged into the one before. */
const frames = [];
async function hold(ms) {
  const png = await capture();
  // Kept with the sandbox, to look at a scene frame by frame
  if (process.env.MEDIA_KEEP === '1') writeFileSync(join(dirs.shots, `tour-${String(frames.length).padStart(3, '0')}.png`), png);
  const { width, height, rgba } = decodePng(png);
  if (width !== WIDTH || height !== HEIGHT) throw new Error(`a frame came out ${width}×${height}, not ${WIDTH}×${HEIGHT}`);
  const last = frames.at(-1);
  if (last && Buffer.compare(Buffer.from(last.rgba.buffer), Buffer.from(rgba.buffer)) === 0) last.delay += ms;
  else frames.push({ rgba, delay: ms });
}
const visible = (selector, text) =>
  page.waitFor(`return [...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => e.offsetParent !== null && ${text ? `e.innerText.includes(${JSON.stringify(text)})` : 'true'})`, { label: `${selector}${text ? ` "${text}"` : ''}` });
async function settle() {
  // Fonts, lazy chunks and the first answers of the API; then no transition half-way through
  await page.eval('await document.fonts.ready; return true;');
  // A page just opened says so while its event stream connects: not a state worth a frame
  await page.waitFor(`return !document.body.innerText.includes('Reconnecting')`, { label: 'the event stream to connect', timeout: 15_000 });
  await sleep(600);
}

/**
 * Scrolls whatever scrolls `selector`'s element until the element is near its top, a few pixels a
 * frame, so the tour moves instead of jumping. Without a tour to record it is one jump.
 */
async function glide(selector, record, { text = '', steps = 8, offset = 16 } = {}) {
  const delta = await page.eval(
    `const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => (e.innerText ?? e.textContent ?? "").trim().startsWith(${JSON.stringify(text)})); if (!el) return 0;` +
      `let s = el.parentElement; while (s && !(/(auto|scroll)/.test(getComputedStyle(s).overflowY) && s.scrollHeight > s.clientHeight)) s = s.parentElement;` +
      `s ??= document.scrollingElement; s.style.scrollBehavior = 'auto'; window.__glide = s;` +
      `return Math.round(el.getBoundingClientRect().top - Math.max(0, s.getBoundingClientRect().top) - ${offset});`,
  );
  const count = record ? steps : 1;
  for (let i = 1; i <= count; i++) {
    await page.eval(`window.__glide.scrollTop += ${Math.round(delta / count)}; return true;`);
    if (record) await hold(70);
  }
  await sleep(200);
}

// ---------- the scenes ----------

async function homeScene(projectId, { record = false, stillName }) {
  await page.goto(`/?project=${encodeURIComponent(projectId)}`, 1500);
  await visible('main h1', 'harbor-api');
  // The dashboard: what needs a person and what works right now at the top, the rest of the project below
  await visible('main .widget', 'Pick up again');
  await visible('main .widget .ticker');
  await settle();
  if (stillName) await still(stillName);
  if (!record) return;
  await hold(2400);
  await glide('main .widget-slot', true, { text: 'Pick up again', steps: 5 });
  await hold(1600);
}

/** The palette, opened from the keyboard, finds the chat that is working and opens it. */
async function paletteScene(record) {
  await page.key('k', 2);
  await visible('[role=dialog][aria-label="Command palette"]');
  await sleep(300);
  if (record) await hold(600);
  for (const ch of 'harbor') {
    await page.type(ch);
    if (record) await hold(200);
  }
  await visible('.palette-option-title');
  await sleep(300);
  if (record) await hold(1500);
  await page.key('Enter');
  await page.waitFor(`return location.pathname.startsWith('/chats/') && !document.querySelector('.palette')`, { label: 'the palette to open the chat' });
}

/** The working chat: its steps folded, the ticker saying what runs now, the inspector beside it. */
async function chatScene(chatId, { record, navigate, stillName }) {
  if (navigate) await page.goto(`/chats/${chatId}`, 1500);
  await visible('main', 'in watch mode');
  await visible('main .ticker', 'node --test --watch');
  await visible('aside.chat-inspector');
  await settle();
  if (record) await hold(2400);
  // What it changed, from the inspector's Changes tab
  await page.click('aside.chat-inspector [role=tab]', 'Changes', 600);
  await visible('aside.chat-inspector', 'rate-limit.js');
  await settle();
  if (stillName) await still(stillName);
  if (!record) return;
  await hold(2200);
  // The diff of one file
  await page.click('aside.chat-inspector button', 'src/middleware/rate-limit.js', 900);
  await hold(2600);
  await page.key('Escape');
  await sleep(400);
  // Back to the Summary tab, so the stills taken after the tour start from the inspector's default
  await page.click('aside.chat-inspector [role=tab]', 'Summary', 300);
}

/** The same chat on a phone: one-line header, the transcript, the pill composer and its status line. */
async function phoneChatScene(chatId, { stillName }) {
  await page.viewport(PHONE.width, PHONE.height);
  await page.goto(`/chats/${chatId}`, 1500);
  await visible('main', 'in watch mode');
  await visible('main .ticker', 'node --test --watch');
  await visible('.composer-status');
  await settle();
  await still(stillName);
  await page.viewport(WIDTH, HEIGHT);
}

async function graphScene(harbor, { record, stillName }) {
  const graphId = await startGraph(harbor);
  // Two workers running side by side, the first one done: the moment the board says the most
  await until(async () => {
    const tasks = (await api.get(`/orchestrations/${graphId}`)).tasks;
    return tasks.find((t) => t.id === 'schema')?.status === 'completed' && tasks.filter((t) => t.status === 'running').length === 2;
  }, 'two workers of the graph running at once', 60_000);
  await page.goto(`/orchestration/${graphId}`, 1500);
  // The stepper follows the stage that runs: its two tasks, each with what it is doing
  await visible('main .stepper');
  await visible('main', 'Cursor pagination');
  await visible('main .ticker');
  await settle();
  if (stillName) await still(stillName);
  if (!record) return;
  await hold(2600);
  // Then the rest of it, merged and checked, which is not worth recording as it happens
  await until(async () => (await api.get(`/orchestrations/${graphId}`)).verification?.status === 'passed', 'the checks on the merged branch to pass', 120_000);
  await visible('main .stepper', 'Verification');
  await sleep(1500);
  await settle();
  await hold(1400);
  // The checks' step, picked from the stepper
  await page.click('main .stepper button', 'Verification', 900);
  await settle();
  await hold(2600);
}

async function accountsScene({ record, stillName }) {
  await page.goto('/accounts', 1500);
  await visible('main', 'maya@northwind.dev');
  await page.waitFor(`return !!document.querySelector('main svg[role=img]')`, { label: 'the usage chart' });
  await settle();
  if (stillName) await still(stillName);
  if (!record) return;
  await hold(2400);
  await glide('main svg[role=img]', true, { steps: 5, offset: 120 });
  await hold(2200);
}

async function schedulesScene({ stillName }) {
  await page.goto('/schedules', 1500);
  await visible('main', 'Nightly dependency audit');
  await page.click('main button', 'Run history', 800);
  await visible('main', 'Overlapped');
  await settle();
  if (stillName) await still(stillName);
}

// ---------- the recording ----------

async function main() {
  writeCswap();
  mkdirSync(OUT, { recursive: true });
  const harbor = repository('harbor-api', HARBOR);
  const lumen = repository('lumen-web', LUMEN);
  const atlas = repository('atlas-docs', ATLAS);
  seedChats(harbor, lumen, atlas);
  writeScripts();

  server = spawn('pnpm', ['--filter', '@agentry/api', 'start'], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
  server.on('error', () => {});
  await until(async () => (await fetch(`${baseUrl}/api/system`)).ok, 'the wrapper to start', 30_000);
  seedUsageHistory();

  const projects = {};
  for (const [name, path] of [['harbor-api', harbor], ['lumen-web', lumen], ['atlas-docs', atlas]]) {
    projects[name] = (await api.post('/projects/import', { path, name })).id;
  }
  await api.get('/accounts?refresh=1');
  await seedSchedules(harbor);

  // The live chat: a worktree of its own, files written and committed for real, a watcher still running
  const chat = await api.post('/chats', { prompt: CHAT_PROMPT, cwd: harbor, worktree: 'rate-limit', model: 'sonnet', permissionMode: 'acceptEdits' });
  await until(async () => (await api.get(`/chats/${chat.id}/changes`))?.summary?.uncommitted?.length >= 1, 'the chat to write its files', 30_000);

  browser = await launch({ baseUrl, shotsDir: dirs.shots });
  page = browser.page;
  await page.viewport(WIDTH, HEIGHT);
  await page.goto('/', 800);
  await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true;`);
  console.log(`recording into ${OUT}`);

  const record = want('tour');
  const stills = want('stills');
  if (record) {
    await homeScene(projects['harbor-api'], { record });
    await paletteScene(true);
  }
  await chatScene(chat.id, { record, navigate: !record, stillName: stills && 'chat.png' });
  if (stills) await phoneChatScene(chat.id, { stillName: 'chat-mobile.png' });
  await graphScene(harbor, { record, stillName: stills && 'orchestration.png' });
  // The dashboard's still once the graph has run, so its Orchestrations widget has one to follow
  if (stills) await homeScene(projects['harbor-api'], { stillName: 'home.png' });
  await accountsScene({ record, stillName: stills && 'accounts.png' });
  if (stills) await schedulesScene({ stillName: 'schedules.png' });
  if (record) writeTour();
}

function writeTour() {
  const bytes = encodeGif(frames, WIDTH, HEIGHT);
  writeFileSync(join(OUT, 'tour.gif'), bytes);
  const seconds = frames.reduce((s, f) => s + f.delay, 0) / 1000;
  console.log(`  tour.gif (${frames.length} frames, ${seconds.toFixed(1)} s, ${Math.round(bytes.length / 1024)} KB)`);
  if (bytes.length > TOUR_MAX_BYTES) throw new Error(`tour.gif is ${bytes.length} bytes, over the ${TOUR_MAX_BYTES} the README can carry`);
}

/** The cron slot `back` periods before now, at `hour`:00 UTC: a history that agrees with the expression beside it. */
function slotBefore(hour, back, periodDays = 1) {
  const slot = new Date();
  slot.setUTCHours(hour, 0, 0, 0);
  if (slot.getTime() > Date.now()) slot.setUTCDate(slot.getUTCDate() - periodDays);
  slot.setUTCDate(slot.getUTCDate() - periodDays * back);
  return slot;
}

async function seedSchedules(harbor) {
  const audit = await api.post('/schedules', {
    name: 'Nightly dependency audit',
    cron: '0 3 * * *',
    timezone: 'UTC',
    overlap: 'skip',
    target: { kind: 'chat', chat: { prompt: 'Audit the dependencies for advisories and open a pull request for the safe upgrades', cwd: harbor, permissionMode: 'acceptEdits', permissionPrompts: 'none' } },
  });
  const notes = await api.post('/schedules', {
    name: 'Weekly release notes',
    cron: '0 9 * * 1',
    timezone: 'UTC',
    overlap: 'queue',
    target: {
      kind: 'orchestration',
      spec: { name: 'release-notes', objective: "Draft the week's release notes", cwd: harbor, worktree: false, permissionPrompts: 'none', tasks: [{ id: 'notes', name: 'Release notes', prompt: 'Draft the release notes from the merged pull requests' }] },
    },
  });
  await api.post('/schedules', {
    name: 'Flaky test sweep',
    cron: '30 */6 * * *',
    timezone: 'UTC',
    enabled: false,
    target: { kind: 'chat', chat: { prompt: 'Run the suite five times shuffled and report any test that fails only sometimes', cwd: harbor, permissionPrompts: 'none' } },
  });
  // A history to read, written where the scheduler writes it: the audit skipped the night a run was still going
  const db = new DatabaseSync(join(dirs.data, 'wrapper.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  const insert = db.prepare('INSERT INTO schedule_runs (id, schedule_id, at, slot, status, chat_id, orchestration_id, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const run = (scheduleId, slot, status, error = null) => insert.run(uuid(), scheduleId, new Date(slot.getTime() + 1000).toISOString(), slot.toISOString(), status, null, null, error);
  run(audit.id, slotBefore(3, 3), 'started');
  run(audit.id, slotBefore(3, 2), 'started');
  run(audit.id, slotBefore(3, 1), 'overlapped', 'the run of the slot before was still working');
  run(audit.id, slotBefore(3, 0), 'started');
  const monday = slotBefore(9, 0);
  while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() - 1);
  run(notes.id, monday, 'started');
  db.close();
}

async function startGraph(harbor) {
  const orch = await api.post('/orchestrations', {
    name: 'orders-v2',
    objective: 'Ship version 2 of the orders API: pagination, filters and docs',
    cwd: harbor,
    worktree: true,
    concurrency: 2,
    maxAttempts: 1,
    synthesize: false,
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    permissionPrompts: 'none',
    verification: { commands: ['node --test', 'node --check src/server.js'], install: null, fixer: true, maxAttempts: 1, maxCostUsd: 1.5, failGraph: true, timeoutMinutes: 5 },
    tasks: GRAPH_TASKS.map(({ script: _script, ...task }) => task),
  });
  return orch.id;
}

try {
  await main();
} catch (error) {
  // What the page showed when it went wrong, beside the sandbox MEDIA_KEEP=1 leaves behind
  await page?.shot('FAILED').catch(() => {});
  throw error;
} finally {
  browser?.close();
}
console.log('done');
process.exit(0);
