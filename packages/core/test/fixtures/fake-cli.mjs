#!/usr/bin/env node
// The replay fake: stands in for `gh`, `glab`, `acli` or `youtrack-app` and answers each call with
// what the real CLI printed when it was recorded (`recordings/index.json`, built by
// `packages/core/scripts/recordings-index.mjs`). stdout and stderr are replayed byte for byte from
// the capture files, each on its own stream, and the process exits with the recorded code.
//
// Which CLI it is: the basename of the path it was started through (a symlink or copy named `gh`,
// `glab`, `acli` or `youtrack-app`), else `FAKE_CLI`. Environment:
//
//   FAKE_CLI             the CLI, when the file is run as `node fake-cli.mjs`
//   FAKE_CLI_VERSION     the recorded release to answer as (default: gh 2.92.0, glab 1.120.0)
//   FAKE_CLI_LABELS      comma-separated capture labels to prefer (`auth-status-json-none`): the
//                        same argv was recorded in several states (signed out, merged, ...), and
//                        this picks one without changing the argv
//   FAKE_CLI_RECORDINGS  another recordings directory (default: `recordings/` next to this file)
//   FAKE_CLI_LOG         a file to append one JSON line per call to (`{ cli, argv, answered }`)
//
// Matching. The recorders printed argv as `$*`, words joined by single spaces, so the call's argv
// is joined the same way and compared with each entry's template, in which `@{host}`, `@{owner}`,
// `@{repo}` and `@{idN}` stand for any host, owner, repository name and number (one value per name
// within a call). An entry that names `env` matches only when those variables have those values.
// An entry with `stdinSha256` matches only when stdin hashes to it, and stdin is read only then:
// the hash of nothing (a call recorded with stdin from /dev/null) matches without reading, so a
// caller that leaves stdin open does not hang the fake. Among matches the fake prefers, in order:
// a label from FAKE_CLI_LABELS, an entry whose `env` is set, the fewest placeholders bound to other
// values than the recorded ones (the same PR number on another repository beats another number),
// a recorded exit 0, then index order. A call nothing matches exits 97 with `unrecorded call` on
// stderr, so a changed argv fails the test that made it instead of being answered by a guess.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIS = ['gh', 'glab', 'acli', 'youtrack-app'];
const DEFAULT_VERSION = { gh: '2.92.0', glab: '1.120.0', 'youtrack-app': '1.0.3' };
const UNRECORDED = 97;
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

const invokedAs = basename(process.argv[1] ?? '').replace(/\.(?:mjs|js)$/, '');
const cli = CLIS.includes(invokedAs) ? invokedAs : process.env.FAKE_CLI;
const argv = process.argv.slice(2);

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(UNRECORDED);
};

if (!cli || !CLIS.includes(cli)) fail(`unrecorded call: no CLI named (run it as gh, glab, acli or youtrack-app, or set FAKE_CLI)`);

const dir = process.env.FAKE_CLI_RECORDINGS ?? join(dirname(fileURLToPath(import.meta.url)), 'recordings');
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
const version = process.env.FAKE_CLI_VERSION ?? DEFAULT_VERSION[cli];
const preferred = new Set((process.env.FAKE_CLI_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const PATTERN = { host: '[A-Za-z0-9.-]+(?::\\d+)?', owner: '[A-Za-z0-9_.-]+', repo: '[A-Za-z0-9_.-]+' };
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The entry's template as an anchored regex whose named groups capture each placeholder. */
function compile(template) {
  const seen = new Set();
  let source = '';
  let last = 0;
  for (const match of template.matchAll(/@\{(\w+)\}/g)) {
    const name = match[1];
    source += escape(template.slice(last, match.index));
    if (seen.has(name)) source += `\\k<${name}>`;
    else {
      seen.add(name);
      source += `(?<${name}>${PATTERN[name] ?? '\\d+'})`;
    }
    last = match.index + match[0].length;
  }
  source += escape(template.slice(last));
  return new RegExp(`^${source}$`);
}

let stdinHash;
const stdinSha256 = () => {
  // Read once, and only when an entry asks: reading a stdin nobody closes would hang the fake.
  stdinHash ??= createHash('sha256').update(readFileSync(0)).digest('hex');
  return stdinHash;
};

const line = argv.join(' ');
const candidates = [];
for (const [position, entry] of index.entries.entries()) {
  if (entry.cli !== cli || entry.version !== version) continue;
  const match = compile(entry.argv.join(' ')).exec(line);
  if (!match) continue;
  if (entry.env && Object.entries(entry.env).some(([name, value]) => process.env[name] !== value)) continue;
  if (entry.stdinSha256 && entry.stdinSha256 !== EMPTY_SHA256 && stdinSha256() !== entry.stdinSha256) continue;
  const groups = match.groups ?? {};
  const differing = Object.entries(entry.vars).filter(([name, value]) => groups[name] !== value).length;
  const label = entry.id.slice(entry.id.lastIndexOf('/') + 1);
  candidates.push({ entry, rank: [preferred.has(label) ? 0 : 1, entry.env ? 0 : 1, differing, entry.exitCode === 0 ? 0 : 1, position] });
}
candidates.sort((a, b) => {
  for (let i = 0; i < a.rank.length; i += 1) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
  return 0;
});
const chosen = candidates[0]?.entry;

if (process.env.FAKE_CLI_LOG) {
  appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ cli, argv, answered: chosen?.id ?? null })}\n`);
}
if (!chosen) fail(`unrecorded call: ${cli} ${version ?? '(no recorded version)'} ${JSON.stringify(argv)}`);

const stdout = readFileSync(join(dir, chosen.stdout));
const stderr = readFileSync(join(dir, chosen.stderr));
// Written through the streams and left to drain: process.exit() right after a large write to a pipe
// can cut it short.
process.stdout.write(stdout, () => {
  process.stderr.write(stderr, () => {
    process.exitCode = chosen.exitCode;
  });
});
