import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Core } from '../src/index.ts';
import { usageReport, type ChatSpend } from '../src/usage-report.ts';
import { encodeProjectId } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

// What a chat has used and spent is read from its transcript, so these tests write transcripts the way
// the CLI does: one line per content block, each carrying the whole message's usage.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

function setup() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  return { config, core: new Core(config) };
}

interface Turn {
  id: string;
  model: string;
  at: string;
  in: number;
  out?: number;
  read?: number;
  create?: number;
  /** Written by a subagent, inside its parent's transcript */
  sidechain?: boolean;
  /** How many content blocks the message was written as */
  blocks?: number;
}

/** The lines of a transcript with these responses, each after a user turn. */
function transcript(sessionId: string, cwd: string, turns: Turn[]): string {
  const lines: object[] = [];
  let n = 0;
  for (const t of turns) {
    lines.push({ type: 'user', uuid: `u${++n}`, timestamp: t.at, cwd, sessionId, isSidechain: t.sidechain === true, message: { role: 'user', content: `turn ${t.id}` } });
    for (let block = 0; block < (t.blocks ?? 1); block++) {
      lines.push({
        type: 'assistant',
        uuid: `a${++n}`,
        timestamp: t.at,
        cwd,
        sessionId,
        isSidechain: t.sidechain === true,
        message: {
          id: t.id,
          role: 'assistant',
          model: t.model,
          content: [{ type: 'text', text: `block ${String(block)}` }],
          usage: { input_tokens: t.in, output_tokens: t.out ?? 1, cache_read_input_tokens: t.read ?? 0, cache_creation_input_tokens: t.create ?? 0 },
        },
      });
    }
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** Writes a chat a terminal started: a transcript and nothing Agentry knows. */
function terminalChat(config: ReturnType<typeof tempConfig>, sessionId: string, turns: Turn[], project = 'terminal-project'): string {
  const cwd = join(config.workspaceDir, project);
  mkdirSync(cwd, { recursive: true });
  const dir = join(config.projectsDir, encodeProjectId(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, transcript(sessionId, cwd, turns));
  return file;
}

const DAY = '2026-03-10T10:00:00Z';

// ---------- context in use ----------

test('context is the last response, so the CLI compacting shows as a drop and spending does not', async () => {
  const { config, core } = setup();
  try {
    const file = terminalChat(config, 'compact-1', [
      { id: 'm1', model: 'claude-opus-5', at: DAY, in: 3, out: 500, read: 90_000 },
      { id: 'm2', model: 'claude-opus-5', at: DAY, in: 3, out: 500, read: 180_000, create: 4_000, blocks: 3 },
    ]);
    const before = await core.chats.get('compact-1');
    assert.equal(before?.context?.used, 184_003);
    assert.equal(before?.cost.total.total, 3 + 500 + 90_000 + 3 + 500 + 180_000 + 4_000, 'a message written as three blocks is counted once');

    // The CLI compacts and the next response reads far less
    appendFileSync(file, transcript('compact-1', '/x', [{ id: 'm3', model: 'claude-opus-5', at: DAY, in: 3, out: 300, read: 25_000 }]));
    const after = await core.chats.get('compact-1');
    assert.equal(after?.context?.used, 25_003);
    assert.equal(after?.cost.total.total, (before?.cost.total.total ?? 0) + 3 + 300 + 25_000, 'what was paid for only grows');
  } finally {
    core.shutdown();
  }
});

test('a subagent is spent but never fills the chat context', async () => {
  const { config, core } = setup();
  try {
    terminalChat(config, 'sidechain-1', [
      { id: 'm1', model: 'claude-opus-5', at: DAY, in: 2, out: 10, read: 40_000 },
      { id: 's1', model: 'claude-haiku-4-5-20251001', at: DAY, in: 2, out: 10, read: 150_000, sidechain: true },
    ]);
    const chat = await core.chats.get('sidechain-1');
    assert.equal(chat?.context?.used, 40_002, "the subagent's window is its own");
    assert.equal(chat?.cost.total.cacheRead, 190_000, 'but what it read was paid for');
    assert.deepEqual(chat?.cost.tokens.map((t) => t.model), ['claude-opus-5', 'claude-haiku-4-5-20251001']);
  } finally {
    core.shutdown();
  }
});

// ---------- per model ----------

test('a chat that changed model keeps its tokens per model and its context follows the last answer', async () => {
  const { config, core } = setup();
  try {
    terminalChat(config, 'switch-1', [
      { id: 'm1', model: 'claude-opus-5', at: DAY, in: 10, out: 20 },
      { id: 'm2', model: 'claude-opus-5[1m]', at: DAY, in: 100, out: 200, read: 328_000 },
      { id: 'm3', model: 'claude-opus-5', at: DAY, in: 1_000, out: 2_000 },
    ]);
    const chat = await core.chats.get('switch-1');
    assert.deepEqual(
      chat?.cost.tokens.map((t) => [t.model, t.total]),
      [
        ['claude-opus-5', 10 + 20 + 1_000 + 2_000],
        ['claude-opus-5[1m]', 100 + 200 + 328_000],
      ],
      'the variant suffix is part of the model id',
    );
    assert.equal(chat?.context?.used, 1_000);
  } finally {
    core.shutdown();
  }
});

// ---------- the window ----------

test('a model whose window was never reported gets tokens and no percentage', async () => {
  const { config, core } = setup();
  try {
    terminalChat(config, 'unknown-1', [{ id: 'm1', model: 'claude-mystery-9', at: DAY, in: 5, out: 5, read: 328_000 }]);
    const chat = await core.chats.get('unknown-1');
    assert.deepEqual(chat?.context, { used: 328_005, window: null });
    assert.equal(chat?.cost.total.total, 328_010);
  } finally {
    core.shutdown();
  }
});

test('the window of a model is what the CLI last reported for that exact id', async () => {
  const { config, core } = setup();
  try {
    terminalChat(config, 'window-1', [{ id: 'm1', model: 'claude-opus-5[1m]', at: DAY, in: 5, out: 5, read: 328_000 }]);
    terminalChat(config, 'window-2', [{ id: 'm1', model: 'claude-opus-5', at: DAY, in: 5, out: 5, read: 100_000 }]);
    assert.equal((await core.chats.get('window-1'))?.context?.window, null, 'nothing has reported it yet');

    // An execution Agentry runs ends with a result that carries the window of the model that answered
    const started = core.runtime.start({ prompt: 'work', keepAlive: false });
    const until = Date.now() + 8_000;
    while (core.runtime.get(started.id)?.executions.every((e) => e.endedAt === null) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));

    assert.equal((await core.chats.get('window-1'))?.context?.window, 1_000_000, 'read from a transcript, measured against what the CLI reported');
    assert.equal((await core.chats.get('window-2'))?.context?.window, null, 'the plain id is a different model: nothing is inferred from its variant');
  } finally {
    core.shutdown();
  }
});

// ---------- cost ----------

test('cost exists only where the CLI reported one: a chat from a terminal has tokens and no dollars', async () => {
  const { config, core } = setup();
  try {
    terminalChat(config, 'terminal-1', [{ id: 'm1', model: 'claude-opus-5', at: DAY, in: 5, out: 5, read: 1_000 }]);
    assert.equal((await core.chats.get('terminal-1'))?.cost.usd, null);

    const started = core.runtime.start({ prompt: 'work', keepAlive: false });
    const until = Date.now() + 8_000;
    while (core.runtime.get(started.id)?.executions.every((e) => e.endedAt === null) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await core.chats.get(started.id))?.cost.usd, 0.01);
  } finally {
    core.shutdown();
  }
});

// ---------- totals ----------

const spend = (over: Partial<ChatSpend> & { chatId: string }): ChatSpend => ({ project: null, orchestration: null, days: [], costs: [], ...over });
const tokens = (day: string, model: string | null, n: number): ChatSpend['days'][number] => ({ day, model, input: n, output: 0, cacheRead: 0, cacheCreation: 0, total: n });

test('totals per day, per project and per orchestration keep tokens real and say what the cost leaves out', () => {
  const app = { id: 'app', name: 'app' };
  const report = usageReport([
    spend({ chatId: 'a', project: app, days: [tokens('2026-03-09', 'opus', 100), tokens('2026-03-10', 'opus', 50), tokens('2026-03-10', 'haiku', 5)], costs: [{ day: '2026-03-10', usd: 0.5 }] }),
    // From a terminal: tokens, and no cost to add
    spend({ chatId: 'b', project: app, days: [tokens('2026-03-10', 'opus', 1_000)] }),
    spend({ chatId: 'c', orchestration: { id: 'o1', name: 'big job' }, days: [tokens('2026-03-10', 'opus', 10)], costs: [{ day: '2026-03-10', usd: 0.25 }] }),
  ]);

  assert.equal(report.total.total.total, 1_165);
  assert.equal(report.total.costUsd, 0.75);
  assert.equal(report.total.chatsWithoutCost, 1);

  assert.deepEqual(report.days.map((d) => [d.day, d.total.total, d.costUsd]), [
    ['2026-03-09', 100, null],
    ['2026-03-10', 1_065, 0.75],
  ]);
  assert.deepEqual(report.days[1]?.tokens.map((t) => [t.model, t.total]), [['opus', 1_060], ['haiku', 5]], 'per model, most first');

  const appRow = report.projects.find((p) => p.project?.id === 'app');
  assert.equal(appRow?.total.total, 1_155);
  assert.equal(appRow?.costUsd, 0.5);
  assert.equal(appRow?.chatsWithoutCost, 1);
  assert.equal(report.projects.find((p) => p.project === null)?.total.total, 10, 'chats under no project are their own row');

  assert.deepEqual(report.orchestrations.map((o) => [o.orchestration.id, o.total.total, o.costUsd]), [['o1', 10, 0.25]]);
});

test('a range keeps only the days asked for, and no cost at all reads as none, not zero', () => {
  const report = usageReport([spend({ chatId: 'a', days: [tokens('2026-03-08', 'opus', 1), tokens('2026-03-09', 'opus', 2), tokens('2026-03-10', 'opus', 4)] })], {
    from: '2026-03-09',
    to: '2026-03-09',
  });
  assert.deepEqual(report.days.map((d) => d.day), ['2026-03-09']);
  assert.equal(report.total.total.total, 2);
  assert.equal(report.total.costUsd, null);
  assert.deepEqual([report.from, report.to], ['2026-03-09', '2026-03-09']);
});

test('the report reads every chat through the service, worker and housekeeping chats included', async () => {
  const { config, core } = setup();
  try {
    terminalChat(config, 'usage-1', [{ id: 'm1', model: 'claude-opus-5', at: DAY, in: 7, out: 3 }]);
    const report = await core.chats.usage();
    assert.equal(report.total.total.total, 10);
    assert.equal(report.days[0]?.day, '2026-03-10');
    assert.equal(report.total.chatsWithoutCost, 1);
  } finally {
    core.shutdown();
  }
});
