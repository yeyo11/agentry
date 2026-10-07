#!/usr/bin/env node
// Where the time of Agentry's orchestrations went, as Markdown tables (or raw figures with --json).
//
//   node scripts/orchestration-timings.mjs [id…] [--min-tasks N] [--json]
//
// Reads a running Agentry at AGENTRY_API_URL (the API root, e.g. http://127.0.0.1:8787/api), sending
// AGENTRY_API_TOKEN as a Bearer token when it is set. Everything comes from the API: the graphs'
// timings (GET /orchestrations/:id/timings) and, for the breakdown inside the workers, the
// transcripts the CLI wrote, read through GET /chats/:id/export?format=json. No dependencies.

// What a worker's Bash command counts as. Adapt the patterns to another repository's tooling; the
// first match wins, and a command that matches none is not counted in any row.
const COMMAND_KINDS = [
  { key: 'tests', label: '`pnpm test`', pattern: /\bpnpm\s+(?:-r\s+|--filter\s+\S+\s+)?(?:run\s+)?test\b|\bnode\s+--test\b|\bvitest\b/ },
  { key: 'typecheck', label: 'Type check', pattern: /\btsc\b|\bpnpm\s+(?:-r\s+|--filter\s+\S+\s+)?(?:run\s+)?typecheck\b/ },
  { key: 'polling', label: '`until … sleep` / `while sleep` polling', pattern: /\b(?:until|while)\b[^\n]*\bsleep\b|\bsleep\s+\d+\s*;[^\n]*\b(?:tail|cat|grep)\b/ },
  { key: 'reads', label: 'Bash reads (`grep`, `sed`, `cat`…)', pattern: /^\s*(?:cd\s+\S+\s*&&\s*)?(?:grep|rg|sed|cat|head|tail|ls|find|wc|awk)\b/ },
];

const HOUR = 3_600_000;
const MIN = 60_000;
const LIMIT_WAIT_MIN_MS = 5 * MIN;

// ---------- arguments ----------

const args = process.argv.slice(2);
const json = args.includes('--json');
let minTasks = 5;
const ids = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') continue;
  if (arg === '--min-tasks') {
    minTasks = Number(args[++i]);
    if (!Number.isInteger(minTasks) || minTasks < 0) fail('--min-tasks needs a whole number, e.g. --min-tasks 5');
    continue;
  }
  if (arg === '--help' || arg === '-h') {
    process.stdout.write('node scripts/orchestration-timings.mjs [id…] [--min-tasks N] [--json]\n');
    process.exit(0);
  }
  if (arg.startsWith('--')) fail(`unknown option ${arg}`);
  ids.push(arg);
}

const base = process.env.AGENTRY_API_URL?.replace(/\/+$/, '');
if (!base) {
  fail(
    'AGENTRY_API_URL is not set. Point it at the API of the Agentry to measure, e.g.\n' +
      '  AGENTRY_API_URL=http://127.0.0.1:8787/api node scripts/orchestration-timings.mjs\n' +
      'A chat started by Agentry has it already. No port is guessed: a desktop app and a dev server often run side by side.',
  );
}
const headers = process.env.AGENTRY_API_TOKEN ? { authorization: `Bearer ${process.env.AGENTRY_API_TOKEN}` } : {};

function fail(message) {
  process.stderr.write(`orchestration-timings: ${message}\n`);
  process.exit(1);
}

async function get(path) {
  let res;
  try {
    res = await fetch(`${base}${path}`, { headers });
  } catch (err) {
    fail(`could not reach ${base}${path}: ${err.cause?.message ?? err.message}`);
  }
  if (res.status === 401 || res.status === 403) fail(`${base} refused the request (${res.status}): set AGENTRY_API_TOKEN`);
  if (!res.ok) throw Object.assign(new Error(`${path} answered ${res.status}`), { status: res.status });
  return res.json();
}

// ---------- figures ----------

const hours = (ms) => (ms / HOUR).toFixed(1);
const minutes = (ms) => String(Math.round(ms / MIN));
const share = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)} %` : '–');
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/**
 * Where a worker's time went, from its transcript: a model turn runs from the entry before an
 * assistant entry to it, and a tool call from its `tool_use` to its `tool_result`.
 */
function workerBreakdown(entries) {
  const out = { turns: [], commands: Object.fromEntries(COMMAND_KINDS.map((k) => [k.key, { count: 0, ms: 0 }])) };
  const calls = new Map();
  let previous = null;
  for (const entry of entries) {
    if (entry.isSidechain) continue;
    const at = ms(entry.timestamp);
    if (Number.isNaN(at)) continue;
    if (entry.role === 'assistant' && previous !== null && previous.role !== 'assistant') out.turns.push(Math.max(0, at - previous.at));
    for (const block of entry.blocks ?? []) {
      if (block.type === 'tool_use' && block.name === 'Bash') calls.set(block.id, { at, command: String(block.input?.command ?? '') });
      if (block.type === 'tool_result') {
        const call = calls.get(block.toolUseId);
        if (!call) continue;
        calls.delete(block.toolUseId);
        const kind = COMMAND_KINDS.find((k) => k.pattern.test(call.command));
        if (!kind) continue;
        out.commands[kind.key].count += 1;
        out.commands[kind.key].ms += Math.max(0, at - call.at);
      }
    }
    previous = { role: entry.role, at };
  }
  return out;
}

// ---------- reading ----------

const all = await get('/orchestrations');
// An id, the start of one, or a graph's name
const matches = (o, id) => o.id.startsWith(id) || o.name === id;
const chosen = ids.length ? all.filter((o) => ids.some((id) => matches(o, id))) : all.filter((o) => o.tasks.length >= minTasks);
const unmatched = ids.filter((id) => !all.some((o) => matches(o, id)));
if (unmatched.length) fail(`no orchestration matches ${unmatched.join(', ')}`);

const graphs = [];
for (const orch of chosen) {
  let timings;
  try {
    timings = await get(`/orchestrations/${orch.id}/timings`);
  } catch (err) {
    if (err.status === 404) fail(`${base} has no GET /orchestrations/:id/timings: it runs an Agentry older than this script`);
    throw err;
  }
  graphs.push({ id: orch.id, name: orch.name, status: orch.status, tasks: orch.tasks.length, timings });
}

// The task chats of the chosen graphs, read by their link: a server that words no role linked only tasks with a taskId
const chats = await get('/chats?origin=orchestration');
const chosenIds = new Set(graphs.map((g) => g.id));
const workers = chats.filter((c) => c.orchestration && chosenIds.has(c.orchestration.id) && (c.orchestration.role ? c.orchestration.role === 'task' : c.orchestration.taskId !== null));
const inside = { chats: 0, turns: [], commands: Object.fromEntries(COMMAND_KINDS.map((k) => [k.key, { count: 0, ms: 0 }])), totalMs: 0 };
for (const chat of workers) {
  let exported;
  try {
    exported = await get(`/chats/${chat.id}/export?format=json`);
  } catch {
    continue; // a chat whose transcript is gone has nothing to read
  }
  const b = workerBreakdown(exported.entries ?? []);
  inside.chats += 1;
  inside.turns.push(...b.turns);
  for (const k of COMMAND_KINDS) {
    inside.commands[k.key].count += b.commands[k.key].count;
    inside.commands[k.key].ms += b.commands[k.key].ms;
  }
  inside.totalMs += (chat.executions ?? []).reduce((sum, e) => sum + Math.max(0, ms(e.endedAt ?? new Date().toISOString()) - ms(e.startedAt)), 0);
}

if (json) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), minTasks, graphs, workers: inside }, null, 2)}\n`);
  process.exit(0);
}

// ---------- tables ----------

const lines = [];
const table = (head, rows) => {
  lines.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`), '');
};
const phase = (g, name) => g.timings.phases.find((p) => p.phase === name);

const finished = graphs.filter((g) => g.timings.endedAt !== null);
const tasksMs = finished.reduce((sum, g) => sum + (phase(g, 'tasks')?.durationMs ?? 0), 0);
const afterMs = finished.reduce((sum, g) => sum + g.timings.afterTasksMs, 0);
lines.push(`## Phase split (${finished.length} finished graph${finished.length === 1 ? '' : 's'}${ids.length ? '' : ` with ${minTasks} tasks or more`})`, '');
table(['Phase', 'Hours', 'Share'], [
  ['Tasks (first task started → last task ended)', hours(tasksMs), share(tasksMs, tasksMs + afterMs)],
  ['After the tasks: integration, verification, synthesis', hours(afterMs), share(afterMs, tasksMs + afterMs)],
]);

lines.push('## After the tasks', '');
table(
  ['Graph', 'After the tasks', 'Agentry running checks', 'Fixer'],
  graphs.map((g) => {
    const v = g.timings.verification;
    const fixes = v?.fixes.length ?? 0;
    // A graph stored before every run was kept has only each check's last run: what the other phases
    // leave of the time after the tasks is the closer figure, marked as derived
    const runsKept = !g.timings.missing.includes('verification.runs');
    const others = ['integration', 'synthesis'].reduce((sum, name) => sum + (phase(g, name)?.durationMs ?? 0), 0);
    const checks = v ? (runsKept ? minutes(v.checksMs) : `~${minutes(Math.max(v.checksMs, g.timings.afterTasksMs - v.fixerMs - others))}`) : '–';
    return [
      g.name,
      `${minutes(g.timings.afterTasksMs)} min`,
      checks,
      v ? (fixes ? `${minutes(v.fixerMs)}${fixes > 1 ? ` (${fixes} attempts)` : ''}` : g.timings.missing.includes('verification.fixes') ? '–' : '0') : '–',
    ];
  }),
);

lines.push('## Critical paths', '');
table(
  ['Graph', 'Critical path', 'Length', 'Tasks phase', 'Parallelism'],
  graphs.map((g) => [
    g.name,
    g.timings.criticalPath.links.map((l) => l.taskId).join(' → ') || '–',
    `${minutes(g.timings.criticalPath.durationMs)} min`,
    phase(g, 'tasks') ? `${minutes(phase(g, 'tasks').durationMs)} min` : '–',
    g.timings.parallelism === null ? '–' : g.timings.parallelism.toFixed(1),
  ]),
);

const limitWaits = graphs.flatMap((g) => g.timings.waits.items.filter((w) => w.kind === 'limit' && w.durationMs > LIMIT_WAIT_MIN_MS).map((w) => ({ g, w })));
lines.push(`## Limit waits over ${minutes(LIMIT_WAIT_MIN_MS)} min`, '');
if (limitWaits.length) {
  table(['Task', 'Waited', 'From', 'Why'], limitWaits.map(({ g, w }) => [`${g.name}:${w.taskId}`, `${minutes(w.durationMs)} min`, w.startedAt.slice(0, 16).replace('T', ' '), (w.reason ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 80)]));
} else lines.push('None.', '');

const turnMs = inside.turns.reduce((a, b) => a + b, 0);
lines.push(`## Inside the workers (${inside.chats} chats, ${hours(inside.totalMs)} h)`, '');
table(['Where', 'Hours', 'Share', 'Note'], [
  ['Model turns', hours(turnMs), share(turnMs, inside.totalMs), `${inside.turns.length.toLocaleString('en')} turns, median ${(median(inside.turns) / 1000).toFixed(1)} s`],
  ...COMMAND_KINDS.map((k) => {
    const c = inside.commands[k.key];
    return [k.label, hours(c.ms), share(c.ms, inside.totalMs), `${c.count.toLocaleString('en')} calls`];
  }),
]);

const missing = graphs.filter((g) => g.timings.missing.length);
if (missing.length) {
  lines.push(
    `${missing.length} graph${missing.length === 1 ? ' was' : 's were'} stored before some figures were recorded; a \`~\` figure is derived from the others. ` +
      `Missing: ${missing.map((g) => `${g.name} (${g.timings.missing.join(', ')})`).join('; ')}.`,
    '',
  );
}
process.stdout.write(lines.join('\n'));
