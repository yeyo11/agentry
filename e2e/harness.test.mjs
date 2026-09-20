// The harness's own test: `node --test e2e/harness.test.mjs` (needs `pnpm build` first, like the suite).
// It runs the real runner against specs that hang, crash or wait for a signal, and proves that no
// Chrome and no server outlives the run. Each run gets its own TMPDIR, so the sandbox, the Chrome
// profile and every process's command line can be told apart from anyone else's browser; the test
// only looks at processes, it never kills by pattern (the runner kills by the PID it started).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { groupAlive, killGroup } from './processes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, 'run.mjs');
const linux = existsSync('/proc/self/cmdline');
const skip = linux ? false : 'needs /proc to look for leftover processes';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PIDs whose command line contains `needle`: the way to see a leftover browser without a pattern kill. */
function processesMatching(needle) {
  const found = [];
  for (const entry of readdirSync('/proc').filter((e) => /^\d+$/.test(e))) {
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(needle)) found.push(Number(entry));
    } catch {
      // gone already
    }
  }
  return found;
}
const alive = (pids) => pids.filter((pid) => {
  try {
    // a zombie is a finished process nobody has waited for
    return !readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\)\s+/s, '').startsWith('Z');
  } catch {
    return false;
  }
});

let nextPort = 8900 + (process.pid % 50) * 4;

/**
 * Runs the real runner over one spec. `beforeEnd(ctx)` is called once the spec says it started (a
 * file it writes), while the browser is up.
 */
async function run({ spec, env = {}, beforeEnd }) {
  const dir = mkdtempSync(join(resolve(tmpdir()), 'agentry-harness-test-'));
  const tmp = join(dir, 'tmp');
  const specs = join(dir, 'specs');
  mkdirSync(tmp);
  mkdirSync(specs);
  const ready = join(dir, 'ready');
  writeFileSync(join(specs, 'probe.spec.mjs'), spec.replaceAll('READY', JSON.stringify(ready)));
  const port = nextPort++;
  const child = spawn(process.execPath, [runner], {
    env: { ...process.env, TMPDIR: tmp, E2E_SPECS_DIR: specs, E2E_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const profiles = () => processesMatching(join(tmp, 'agentry-e2e-chrome-'));
  let during = [];
  if (beforeEnd) {
    for (let i = 0; i < 300 && !existsSync(ready); i++) await sleep(100);
    assert.ok(existsSync(ready), `the spec never started:\n${output}`);
    during = alive(profiles());
    await beforeEnd({ child, output: () => output });
  }
  let giveUp;
  const result = await Promise.race([exited, new Promise((r) => (giveUp = setTimeout(() => r({ code: 'harness-test-timeout' }), 90_000)))]);
  clearTimeout(giveUp);
  if (result.code === 'harness-test-timeout') {
    // The runner itself failed to stop: this is what the test exists to catch, but do not leave it running
    killGroup(child.pid);
    assert.fail(`the runner outlived its limits:\n${output}`);
  }
  const survivors = { chrome: alive(profiles()), server: await fetch(`http://127.0.0.1:${port}/api/system`).then(() => true, () => false) };
  const sandboxLeft = readdirSync(tmp).filter((e) => e.startsWith('agentry-e2e-') && !e.startsWith('agentry-e2e-chrome-'));
  rmSync(dir, { recursive: true, force: true });
  return { ...result, output, during, survivors, sandboxLeft };
}

const hang = `export default async () => { (await import('node:fs')).writeFileSync(READY, ''); await new Promise(() => {}); };`;

test('killGroup ends a whole process group, and only that one', { skip }, async () => {
  const leader = spawn('sh', ['-c', 'sleep 60 & sleep 60 & wait'], { detached: true, stdio: 'ignore' });
  const bystander = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  await sleep(300);
  assert.ok(groupAlive(leader.pid));
  killGroup(leader.pid, { graceMs: 1000 });
  assert.equal(groupAlive(leader.pid), false);
  assert.ok(groupAlive(bystander.pid), 'a process in another group is left alone');
  killGroup(bystander.pid);
  assert.equal(groupAlive(bystander.pid), false);
  killGroup(undefined);
});

test('a spec that hangs trips its limit and leaves no browser or server behind', { skip }, async () => {
  const r = await run({ spec: hang, beforeEnd: () => {}, env: { E2E_SPEC_TIMEOUT: '2500' } });
  assert.equal(r.code, 1);
  assert.match(r.output, /probe\.spec\.mjs took longer than 2\.5s/);
  assert.ok(r.during.length > 0, 'a Chrome was running while the spec hung');
  assert.deepEqual(r.survivors, { chrome: [], server: false });
  assert.deepEqual(r.sandboxLeft, []);
});

test('the run limit stops a run even when every spec is within its own', { skip }, async () => {
  const r = await run({ spec: hang, beforeEnd: () => {}, env: { E2E_SPEC_TIMEOUT: '600000', E2E_TIMEOUT: '12000' } });
  assert.equal(r.code, 1);
  assert.match(r.output, /the e2e run exceeded 12s/);
  assert.ok(r.during.length > 0);
  assert.deepEqual(r.survivors, { chrome: [], server: false });
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} closes the browser and the server`, { skip }, async () => {
    const r = await run({ spec: hang, env: { E2E_SPEC_TIMEOUT: '600000' }, beforeEnd: ({ child }) => child.kill(signal) });
    assert.equal(r.code, code);
    assert.ok(r.during.length > 0);
    assert.deepEqual(r.survivors, { chrome: [], server: false });
    assert.deepEqual(r.sandboxLeft, []);
  });
}

test('an uncaught exception closes the browser and the server', { skip }, async () => {
  const spec = `export default async () => { (await import('node:fs')).writeFileSync(READY, ''); setTimeout(() => { throw new Error('boom'); }, 200); await new Promise(() => {}); };`;
  const r = await run({ spec, env: { E2E_SPEC_TIMEOUT: '600000' }, beforeEnd: () => {} });
  assert.equal(r.code, 1);
  assert.match(r.output, /boom/);
  assert.deepEqual(r.survivors, { chrome: [], server: false });
});

test('a failing spec still ends the run cleanly', { skip }, async () => {
  const r = await run({ spec: `export default () => { throw new Error('nope'); };` });
  assert.equal(r.code, 1);
  assert.match(r.output, /nope/);
  assert.deepEqual(r.survivors, { chrome: [], server: false });
});
