#!/usr/bin/env node
// Wire-format bench: compact JSON against TOON for what the list tools of @agentry/mcp answer.
// Plan: docs/plans/agent-wire-format.md ("The bench").
//
// For each list tool it reads the real data from a running Agentry, narrows it with the tool's own
// field selector, encodes it both ways, and asks a few questions whose answers are in the data. Every
// question goes through `claude -p --output-format stream-json`, once per format; the input tokens
// come from the CLI's `result` event, which counts with Claude's own tokenizer. Nothing else is
// called: no SDK and no tokenizer endpoint (the one rule). Answers are checked against the data.
//
//   AGENTRY_API_URL=http://127.0.0.1:PORT/api AGENTRY_API_TOKEN=... \
//     node scripts/wire-format-bench.mjs [--model sonnet] [--max-usd 3] [--json]
//
// It needs `@toon-format/toon` to encode; it resolves it from packages/mcp.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const MODEL = flag('model', 'sonnet');
const MAX_USD = Number(flag('max-usd', '3'));
const base = process.env.AGENTRY_API_URL?.replace(/\/+$/, '');
const token = process.env.AGENTRY_API_TOKEN;
if (!base) {
  console.error('AGENTRY_API_URL is not set');
  process.exit(2);
}

const fields = await import(pathToFileURL(join(root, 'packages/mcp/src/fields.ts')).href);
const { encode } = await import(pathToFileURL(join(root, 'packages/mcp/node_modules/@toon-format/toon/dist/index.mjs')).href);

async function get(path) {
  const res = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

const count = (rows, test) => rows.filter(test).length;
const maxBy = (rows, key) => rows.reduce((best, r) => ((r[key] ?? -Infinity) > (best[key] ?? -Infinity) ? r : best));
const commonest = (rows, key) => {
  const tally = new Map();
  for (const r of rows) if (r[key] !== undefined) tally.set(r[key], (tally.get(r[key]) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
};
/** The less common value that still occurs, so a question has a short, non-trivial set as its answer */
const rarest = (rows, key) => {
  const tally = new Map();
  for (const r of rows) if (r[key] !== undefined) tally.set(r[key], (tally.get(r[key]) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => a[1] - b[1])[0][0];
};

// Each tool: how its rows are read, and the questions (answer: a set of ids, or one value).
const TOOLS = [
  {
    tool: 'list_chats',
    load: async () => fields.chatRows(await get('/chats?limit=50')),
    questions: (rows) => {
      const state = rarest(rows, 'state');
      const origin = commonest(rows, 'origin')[0];
      return [
        { q: `Which chats are in state "${state}"? Answer with their ids.`, set: rows.filter((r) => r.state === state).map((r) => r.id) },
        { q: 'Which chat has the highest messageCount? Answer with its id.', value: maxBy(rows, 'messageCount').id },
        { q: `How many chats have origin "${origin}"? Answer with the number.`, value: String(count(rows, (r) => r.origin === origin)) },
      ];
    },
  },
  {
    tool: 'list_projects',
    load: async () => fields.projectRows(await get('/projects')),
    questions: (rows) => [
      { q: 'Which project has the highest chatCount? Answer with its id.', value: maxBy(rows, 'chatCount').id },
      { q: 'Which projects have more than 5 chats? Answer with their ids.', set: rows.filter((r) => (r.chatCount ?? 0) > 5).map((r) => r.id) },
      { q: 'How many projects have a chatCount above 0? Answer with the number.', value: String(count(rows, (r) => (r.chatCount ?? 0) > 0)) },
    ],
  },
  {
    tool: 'list_orchestrations',
    load: async () => fields.orchestrationRows((await get('/orchestrations')).slice(0, 30)),
    questions: (rows) => {
      const status = rarest(rows, 'status');
      return [
        { q: `Which orchestrations have status "${status}"? Answer with their ids.`, set: rows.filter((r) => r.status === status).map((r) => r.id) },
        { q: 'Which orchestration has the highest costUsd? Answer with its id.', value: maxBy(rows, 'costUsd').id },
        { q: 'Which orchestration has the most tasks in total (tasks.total)? Answer with its id, or the first of them if tied.', value: rows.reduce((b, r) => (r.tasks.total > b.tasks.total ? r : b)).id },
      ];
    },
  },
  {
    tool: 'list_providers',
    load: async () => fields.providerRows(await get('/providers')),
    questions: (rows) => {
      const state = commonest(rows, 'state')[0];
      return [
        { q: `Which providers are in state "${state}"? Answer with their ids.`, set: rows.filter((r) => r.state === state).map((r) => r.id) },
        { q: 'How many providers have a limit entry? Answer with the number.', value: String(count(rows, (r) => r.limit !== undefined)) },
        { q: 'Which provider has the highest limit.utilization? Answer with its id, or "none" if no provider has one.', value: rows.some((r) => r.limit?.utilization !== undefined) ? maxBy(rows.map((r) => ({ id: r.id, u: r.limit?.utilization })), 'u').id : 'none' },
      ];
    },
  },
];

const scratch = mkdtempSync(join(tmpdir(), 'wire-bench-'));
const SYSTEM = 'You answer questions about data you are given. Reply with one JSON object {"answer": ...} and nothing else.';
let spent = 0;

/** One `claude -p` call; the prompt goes in on stdin. Returns the answer text, input tokens and cost. */
function ask(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--output-format', 'stream-json', '--verbose', '--model', MODEL, '--system-prompt', SYSTEM, '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--no-session-persistence'],
      { cwd: scratch, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENTRY_API_TOKEN: '' } },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', () => {
      const result = out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((e) => e?.type === 'result');
      if (!result || result.is_error) return reject(new Error(`claude failed: ${result?.result ?? err.slice(0, 300)}`));
      const u = result.usage ?? {};
      resolve({
        text: String(result.result ?? ''),
        // The cache counters are input too: the CLI caches its own preamble, and that cancels out
        // against the baseline below
        tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        usd: result.total_cost_usd ?? 0,
      });
    });
    child.stdin.end(prompt);
  });
}

const promptOf = (data, question) => `Data:\n${data}\n\nQuestion: ${question}`;

function answerOf(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]).answer;
  } catch {
    return undefined;
  }
}

function right(question, answer) {
  if (answer === undefined) return false;
  if (question.set) {
    const given = (Array.isArray(answer) ? answer : [answer]).map(String).sort();
    const want = [...question.set].map(String).sort();
    return given.length === want.length && given.every((v, i) => v === want[i]);
  }
  return String(answer).trim() === question.value;
}

const baseline = await ask(promptOf('(none)', 'Reply with {"answer": "ok"}.'));
spent += baseline.usd;

const results = [];
try {
  for (const spec of TOOLS) {
    const rows = await spec.load();
    const json = JSON.stringify(rows);
    const toon = encode(rows);
    const questions = spec.questions(rows);
    const row = { tool: spec.tool, rows: Array.isArray(rows) ? rows.length : undefined, chars: { json: json.length, toon: toon.length }, json: { tokens: 0, right: 0 }, toon: { tokens: 0, right: 0 }, questions: questions.length };
    for (const question of questions) {
      for (const [format, data] of [['json', json], ['toon', toon]]) {
        if (spent > MAX_USD) throw new Error(`budget of ${MAX_USD} USD reached`);
        const res = await ask(promptOf(data, question.q));
        spent += res.usd;
        // The same question text is in both formats, so its tokens cancel in the comparison
        row[format].tokens += Math.max(0, res.tokens - baseline.tokens);
        if (right(question, answerOf(res.text))) row[format].right += 1;
      }
    }
    row.saving = row.json.tokens > 0 ? (row.json.tokens - row.toon.tokens) / row.json.tokens : 0;
    results.push(row);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (args.includes('--json')) console.log(JSON.stringify({ model: MODEL, usd: spent, results }, null, 2));
else {
  console.log('| Tool | Rows | JSON tokens | TOON tokens | Saving | JSON right | TOON right |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    const pct = `${r.saving >= 0 ? '−' : '+'}${Math.abs(Math.round(r.saving * 100))} %`;
    console.log(`| ${r.tool} | ${r.rows ?? '-'} | ${r.json.tokens} | ${r.toon.tokens} | ${pct} | ${r.json.right}/${r.questions} | ${r.toon.right}/${r.questions} |`);
  }
  console.log(`\nModel ${MODEL}, cost ${spent.toFixed(2)} USD. Tokens are summed over the questions of each tool, minus the CLI's own preamble (${baseline.tokens}) per call.`);
}
