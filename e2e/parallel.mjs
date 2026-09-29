// `E2E_SHARDS=N`: N copies of the runner at once, each on shard k/N with its own sandbox, port and
// Chrome, and one report in the order a single run would print it. The children are started as the
// leaders of their own process groups and stopped by PID with SIGTERM first, so each one still
// closes its own server, browser and sandbox from its 'exit' handler.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { killGroup } from './processes.mjs';

const STATUS = /^([✓✗]) (\S+\.spec\.mjs)\b/;
const SKIPPED = /^- (\S+\.spec\.mjs) \(/;
const SUMMARY = /^(all \d+ spec file\(s\) passed|\d+ spec\(s\) failed)$/;

/**
 * Cuts one child's stdout into spec blocks. A block is what a spec printed while it ran, its
 * `✓`/`✗`/`-` line, and the indented lines under it (a failure's message). Any other line (the
 * server restart, the stop after a timeout) is the shard's own and goes to `other`. The child's
 * summary is dropped: the parent writes its own over every shard.
 */
export function createBlockReader({ block, other }) {
  let pending = [];
  let current = null;
  let summary = false;
  const close = () => {
    if (current) block(current.file, current.lines.join('\n'), current.ok);
    current = null;
  };
  return {
    line(text) {
      if (summary) return;
      const status = STATUS.exec(text);
      const skipped = status ? null : SKIPPED.exec(text);
      if (status || skipped) {
        close();
        current = { file: status ? status[2] : skipped[1], lines: [...pending, text], ok: status ? status[1] === '✓' : true };
        pending = [];
        // Nothing is printed under a pass or a skip, so there is no reason to hold it back
        if (current.ok) close();
      } else if (current && text.startsWith('  ')) {
        current.lines.push(text);
      } else if (text === 'failed:' || SUMMARY.test(text)) {
        close();
        summary = true;
      } else if (text.startsWith('- ')) {
        close();
        other(text);
      } else {
        close();
        pending.push(text);
      }
    },
    end() {
      close();
      for (const text of pending) if (text.trim()) other(text);
      pending = [];
    },
  };
}

/** Prints blocks in `order`, each once every block before it has been printed. */
export function createMerger(order, write) {
  const blocks = new Map();
  let cursor = 0;
  return {
    add(file, text) {
      if (blocks.has(file)) return;
      blocks.set(file, text);
      while (cursor < order.length && blocks.has(order[cursor])) write(blocks.get(order[cursor++]));
    },
    has: (file) => blocks.has(file),
  };
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

/**
 * Runs `shards` (from `splitSpecs`) as children of `runner` and returns the exit code. `order` is
 * the global spec order; `basePort`, when given, is the first of `shards.length` consecutive ports.
 */
export async function runShards({ runner, args, shards, order, basePort, runLimitMs }) {
  const count = shards.length;
  const ports = [];
  for (let k = 0; k < count; k++) ports.push(basePort ? basePort + k : await freePort());
  console.log(`- ${count} shards in parallel, on ports ${ports.join(', ')}`);

  const children = [];
  // Every way out passes through 'exit': SIGTERM to every child at once, then wait for each
  process.on('exit', () => {
    for (const child of children) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    for (const child of children) killGroup(child.pid, { graceMs: 15_000 });
  });
  const stop = (code, message) => {
    console.error(`\n${message}`);
    process.exit(code);
  };
  for (const [signal, number] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(signal, () => stop(128 + number, `${signal}: stopping the e2e run`));
  process.on('uncaughtException', (error) => stop(1, `the e2e run crashed: ${error?.stack ?? error}`));
  process.on('unhandledRejection', (error) => stop(1, `the e2e run crashed on an unhandled rejection: ${error?.stack ?? error}`));
  setTimeout(() => stop(1, `the e2e run exceeded ${runLimitMs / 1000}s: stopping it (set E2E_TIMEOUT to allow longer)`), runLimitMs).unref();

  const results = new Map();
  const merger = createMerger(order, (text) => console.log(text));
  const started = Date.now();
  const runs = shards.map(async (shard, i) => {
    const k = i + 1;
    const child = spawn(process.execPath, [runner, ...args], {
      env: { ...process.env, E2E_SHARD: `${k}/${count}`, E2E_SHARDS: '', E2E_PORT: String(ports[i]), E2E_CDP_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    children.push(child);
    const reader = createBlockReader({
      block: (file, text, ok) => {
        results.set(file, ok);
        merger.add(file, text);
      },
      other: (text) => console.log(`[shard ${k}] ${text}`),
    });
    let rest = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const text of lines) reader.line(text);
    });
    let errRest = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const lines = (errRest + chunk).split('\n');
      errRest = lines.pop() ?? '';
      for (const text of lines) if (text.trim()) console.error(`[shard ${k}] ${text}`);
    });
    const [code, signal] = await once(child, 'exit');
    // The pipes close once the last writer has; a server that inherited stderr must not hold the report
    if (child.stdout.readable) await Promise.race([once(child.stdout, 'close'), new Promise((r) => setTimeout(r, 3000))]);
    if (rest) reader.line(rest);
    if (errRest.trim()) console.error(`[shard ${k}] ${errRest}`);
    reader.end();
    const seconds = (Date.now() - started) / 1000;
    // Specs a failed shard never reached (it crashed, its server did not start, or a spec timed out
    // and the browser was not safe to reuse) count as failed: nothing proved them
    for (const file of shard.files) {
      if (merger.has(file)) continue;
      results.set(file, false);
      merger.add(file, `✗ ${file}\n  not run: shard ${k} ended early (${signal ?? `exit ${code}`})`);
    }
    return { k, code: code ?? 1, seconds, files: shard.files, estimate: shard.seconds };
  });
  const ended = await Promise.all(runs);
  const failed = order.filter((file) => results.get(file) === false);
  console.log('');
  for (const r of ended) console.log(`shard ${r.k}/${count}: ${r.files.length} spec(s), ${r.seconds.toFixed(1)}s (estimated ${Math.round(r.estimate)}s)${r.code ? `, exit ${r.code}` : ''}`);
  const bad = ended.some((r) => r.code !== 0);
  if (failed.length) console.log(`\nfailed:\n${failed.map((f) => `✗ ${f}`).join('\n')}`);
  console.log(failed.length ? `${failed.length} spec(s) failed` : bad ? '\na shard failed outside its specs' : `\nall ${order.length} spec file(s) passed`);
  return bad || failed.length ? 1 : 0;
}
