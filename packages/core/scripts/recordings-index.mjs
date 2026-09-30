#!/usr/bin/env node
// Builds `packages/core/test/fixtures/recordings/index.json`, the calls `fake-cli.mjs` can answer,
// from the capture files: every `<cli>/<version>/<label>.meta` with its `.out`, `.err` and `.rc`.
//
//   node packages/core/scripts/recordings-index.mjs [recordings-dir]
//
// A `.meta` is `key: value` lines: `argv:` is the argv as the recorder printed it (`$*`, so words
// joined by single spaces, program name first), `exit:` the code, `env:` extra variables the call
// ran with (`NAME=value`), `stdin-sha256:` the hash of what it read (absent: not recorded) and
// `wrapper:` a command it ran under (`timeout 8`). A call under a wrapper is not indexed: its exit
// code belongs to the wrapper, not to the CLI.
//
// The recorder printed argv joined by spaces, so the index keeps that form: `argv` is the line split
// on single spaces, and the fake compares the joined line. Host, repository and ids are templated
// as `@{host}`, `@{owner}`, `@{repo}` and `@{idN}` (not braces alone, because gh's own `{owner}`
// placeholders, jq's objects and Go templates use them), with the recorded values in `vars`.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIR = resolve(here, '../test/fixtures/recordings');

const REPOSITORIES = ['agentry-probe', 'agentry'];
const OWNER = 'yeyo11';
const HOSTS = ['github.com', 'gitlab.com'];

export function parseMeta(text) {
  const meta = {};
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);
    meta[key] = value.startsWith(' ') ? value.slice(1) : value;
  }
  return meta;
}

/** The argv line (without the program name) with host, repository and ids replaced by placeholders. */
export function templateLine(line) {
  if (line.includes('@{')) throw new Error(`argv already holds "@{": ${line}`);
  const vars = {};
  let out = line;
  const repoAlternation = REPOSITORIES.map((r) => r.replace(/[-]/g, '\\-')).join('|');
  out = out.replace(new RegExp(`(?<![\\w.-])${OWNER}/(${repoAlternation})(?![\\w.-])`, 'g'), (_m, repo) => {
    vars.owner = OWNER;
    if (vars.repo !== undefined && vars.repo !== repo) throw new Error(`two repositories in one call: ${line}`);
    vars.repo = repo;
    return '@{owner}/@{repo}';
  });
  out = out.replace(new RegExp(`(?<![\\w.-])(${HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})(?![\\w-]|\\.\\w)`, 'g'), (host) => {
    if (vars.host !== undefined && vars.host !== host) throw new Error(`two hosts in one call: ${line}`);
    vars.host = host;
    return '@{host}';
  });
  // Ids: a word of digits that is not a flag's value, and a digit segment of a path or URL.
  const ids = new Map();
  const idFor = (value) => {
    if (!ids.has(value)) {
      const name = `id${ids.size}`;
      ids.set(value, name);
      vars[name] = value;
    }
    return `@{${ids.get(value)}}`;
  };
  const words = out.split(' ');
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? '';
    const previous = i > 0 ? (words[i - 1] ?? '') : '';
    if (/^\d+$/.test(word) && !previous.startsWith('-')) {
      words[i] = idFor(word);
    } else if (/^[\w.~%:{}/-]+(?:\?[\w.=&%[\]-]*)?$/.test(word) && word.includes('/') && !previous.startsWith('-')) {
      words[i] = word.replace(/(?<=\/)(\d+)(?=\/|$|\?)/g, (id) => idFor(id));
    }
  }
  return { template: words.join(' '), vars };
}

/** The template with its vars put back; the generator checks it gives the recorded line again. */
export function fillTemplate(template, vars) {
  return template.replace(/@\{(\w+)\}/g, (_m, name) => {
    if (!(name in vars)) throw new Error(`no value for @{${name}}`);
    return vars[name];
  });
}

export function buildIndex(dir = DEFAULT_DIR) {
  const entries = [];
  const skipped = [];
  for (const cli of readdirSync(dir).sort()) {
    const cliDir = join(dir, cli);
    if (!statSync(cliDir).isDirectory()) continue;
    for (const version of readdirSync(cliDir).sort()) {
      const versionDir = join(cliDir, version);
      if (!/^\d+\.\d+\.\d+$/.test(version) || !statSync(versionDir).isDirectory()) continue;
      const labels = [...new Set(readdirSync(versionDir).filter((f) => /\.(out|err|rc|meta)$/.test(f)).map((f) => f.replace(/\.[a-z]+$/, '')))].sort();
      for (const label of labels) {
        const base = join(versionDir, label);
        const missing = ['meta', 'out', 'err', 'rc'].filter((ext) => !existsSync(`${base}.${ext}`));
        if (missing.length > 0) {
          skipped.push({ id: `${cli}/${version}/${label}`, reason: `no .${missing.join(', .')}` });
          continue;
        }
        const meta = parseMeta(readFileSync(`${base}.meta`, 'utf8'));
        if (meta.wrapper) {
          skipped.push({ id: `${cli}/${version}/${label}`, reason: `ran under \`${meta.wrapper}\`` });
          continue;
        }
        const line = meta.argv ?? '';
        if (!line.startsWith(`${cli} `)) throw new Error(`${base}.meta: argv does not start with "${cli} "`);
        const exitCode = Number(readFileSync(`${base}.rc`, 'utf8').trim());
        if (meta.exit !== undefined && Number(meta.exit) !== exitCode) throw new Error(`${base}: .rc and .meta disagree on the exit code`);
        const { template, vars } = templateLine(line.slice(cli.length + 1));
        if (fillTemplate(template, vars) !== line.slice(cli.length + 1)) throw new Error(`${base}: the template does not give the argv back`);
        const env = {};
        for (const pair of (meta.env ?? '').split(' ').filter(Boolean)) {
          const eq = pair.indexOf('=');
          if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        entries.push({
          id: `${cli}/${version}/${label}`,
          cli,
          version,
          argv: template.split(' '),
          vars,
          ...(Object.keys(env).length > 0 ? { env } : {}),
          stdinSha256: meta['stdin-sha256'] || null,
          stdout: `${cli}/${version}/${label}.out`,
          stderr: `${cli}/${version}/${label}.err`,
          exitCode,
        });
      }
    }
  }
  return { entries, skipped };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? DEFAULT_DIR);
  const { entries, skipped } = buildIndex(dir);
  // One entry per line, so a re-recording shows as a readable diff.
  const list = (items) => `[\n${items.map((item) => `  ${JSON.stringify(item)}`).join(',\n')}\n ]`;
  const about = 'Calls fake-cli.mjs replays; built by packages/core/scripts/recordings-index.mjs. Paths are relative to this file.';
  writeFileSync(join(dir, 'index.json'), `{\n "about": ${JSON.stringify(about)},\n "entries": ${list(entries)},\n "notIndexed": ${list(skipped)}\n}\n`);
  process.stdout.write(`${entries.length} calls indexed, ${skipped.length} captures not indexed\n`);
}
