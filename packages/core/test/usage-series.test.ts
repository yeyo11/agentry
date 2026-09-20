import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { Chat } from '@agentry/shared';
import { chatToMarkdown, exportFilename } from '../src/chat-export.ts';
import { Core } from '../src/index.ts';
import type { ChatSpend } from '../src/usage-report.ts';
import { bucketStart, SERIES_MAX_POINTS, usageBreakdown, usageSeries } from '../src/usage-series.ts';
import { encodeProjectId } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

const spend = (over: Partial<ChatSpend> & { chatId: string }): ChatSpend => ({ project: null, orchestration: null, days: [], costs: [], ...over });
const tokens = (day: string, model: string | null, n: number): ChatSpend['days'][number] => ({ day, model, input: n, output: 0, cacheRead: 0, cacheCreation: 0, total: n });
const TODAY = '2026-03-12';

// ---------- series ----------

test('a week starts on Monday, and a day is its own bucket', () => {
  // 2026-03-09 is a Monday
  assert.equal(bucketStart('2026-03-09', 'week'), '2026-03-09');
  assert.equal(bucketStart('2026-03-15', 'week'), '2026-03-09', 'Sunday belongs to the week before it starts again');
  assert.equal(bucketStart('2026-03-16', 'week'), '2026-03-16');
  assert.equal(bucketStart('2026-01-01', 'week'), '2025-12-29', 'across a year');
  assert.equal(bucketStart('2026-03-10', 'day'), '2026-03-10');
});

test('a day series has a point for every day of the range, and the empty ones say nothing was spent', () => {
  const series = usageSeries(
    [
      spend({ chatId: 'a', days: [tokens('2026-03-09', 'opus', 100), tokens('2026-03-11', 'opus', 40)], costs: [{ day: '2026-03-11', usd: 0.5 }] }),
      spend({ chatId: 'b', days: [tokens('2026-03-11', 'haiku', 10)], costs: [{ day: '2026-03-11', usd: 0.25 }] }),
    ],
    'day',
    { from: '2026-03-09', to: '2026-03-12' },
    TODAY,
  );
  assert.equal(series.bucket, 'day');
  assert.deepEqual(series.points, [
    { at: '2026-03-09', costUsd: null, tokens: 100, chats: 1 },
    { at: '2026-03-10', costUsd: null, tokens: 0, chats: 0 },
    { at: '2026-03-11', costUsd: 0.75, tokens: 50, chats: 2 },
    { at: '2026-03-12', costUsd: null, tokens: 0, chats: 0 },
  ]);
});

test('a week series sums the days of each week and begins at the Monday the range starts in', () => {
  const series = usageSeries(
    [spend({ chatId: 'a', days: [tokens('2026-03-08', 'opus', 1), tokens('2026-03-09', 'opus', 2), tokens('2026-03-15', 'opus', 4), tokens('2026-03-16', 'opus', 8)], costs: [{ day: '2026-03-16', usd: 1 }] })],
    'week',
    { from: '2026-03-08', to: '2026-03-16' },
    TODAY,
  );
  assert.deepEqual(series.points.map((p) => [p.at, p.tokens, p.costUsd]), [
    ['2026-03-02', 1, null],
    ['2026-03-09', 6, null],
    ['2026-03-16', 8, 1],
  ]);
});

test('without a range the series runs from the first day with something to today', () => {
  const series = usageSeries([spend({ chatId: 'a', days: [tokens('2026-03-10', 'opus', 5)] })], 'day', {}, TODAY);
  assert.deepEqual(series.points.map((p) => p.at), ['2026-03-10', '2026-03-11', '2026-03-12']);
  assert.deepEqual(usageSeries([], 'day', {}, TODAY).points, [], 'nothing to span');
  assert.deepEqual(usageSeries([], 'day', { from: '2026-03-11', to: '2026-03-12' }, TODAY).points.length, 2, 'a range asked for is drawn even when empty');
});

test('a range too long to draw is refused, and a backwards one is empty', () => {
  assert.throws(() => usageSeries([], 'day', { from: '2020-01-01', to: '2026-01-01' }, TODAY), new RegExp(`more than ${String(SERIES_MAX_POINTS)}`));
  assert.equal(usageSeries([], 'week', { from: '2020-01-01', to: '2026-01-01' }, TODAY).points.length, 314, 'weeks make the same range fit');
  assert.deepEqual(usageSeries([], 'day', { from: '2026-03-12', to: '2026-03-10' }, TODAY).points, []);
});

// ---------- breakdown ----------

test('the breakdown cuts one range by project and by model, and a cost is the CLI\'s, never worked out from tokens', () => {
  const app = { id: 'app', name: 'App' };
  const breakdown = usageBreakdown([
    spend({
      chatId: 'a',
      project: app,
      days: [tokens('2026-03-10', 'opus', 1_000), tokens('2026-03-10', 'haiku', 100)],
      costs: [{ day: '2026-03-10', usd: 0.6 }],
      modelCosts: [
        { day: '2026-03-10', model: 'opus', usd: 0.5 },
        { day: '2026-03-10', model: 'haiku', usd: 0.1 },
      ],
    }),
    // A chat from a terminal: tokens, and nothing the CLI reported a cost for
    spend({ chatId: 'b', days: [tokens('2026-03-10', 'opus', 5_000), tokens('2026-03-10', null, 7)] }),
    spend({ chatId: 'c', project: app, days: [tokens('2026-03-01', 'opus', 999)], costs: [{ day: '2026-03-01', usd: 9 }], modelCosts: [{ day: '2026-03-01', model: 'opus', usd: 9 }] }),
  ], { from: '2026-03-05', to: '2026-03-31' });

  assert.deepEqual(breakdown.byProject, [
    { key: 'app', label: 'App', costUsd: 0.6, tokens: 1_100, chats: 1 },
    { key: 'loose', label: 'No project', costUsd: null, tokens: 5_007, chats: 1 },
  ]);
  assert.deepEqual(breakdown.byModel.map((m) => [m.key, m.costUsd, m.tokens, m.chats]), [
    ['opus', 0.5, 6_000, 2],
    ['haiku', 0.1, 100, 1],
    ['unknown', null, 7, 1],
  ]);
  assert.equal(breakdown.byModel.at(-1)?.label, 'Unknown model');
});

test('the CLI\'s per-model cost is kept on the execution, and the breakdown and the series read it through the service', async () => {
  const config = { ...tempConfig(), claudeBin: join(import.meta.dirname, 'fixtures', 'fake-claude-control.mjs') };
  const core = new Core(config);
  try {
    const started = core.runtime.start({ prompt: 'work', keepAlive: false });
    const until = Date.now() + 8_000;
    while (core.runtime.get(started.id)?.executions.every((e) => e.endedAt === null) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    // The fixture's result says the one model it used cost 0.01, and that is the split that is kept
    assert.deepEqual(core.runtime.get(started.id)?.executions[0]?.modelCosts, { 'claude-opus-5[1m]': 0.01 });

    const spent = await core.chats.usageBreakdown();
    assert.deepEqual(spent.byModel.map((m) => [m.key, m.costUsd]), [['claude-opus-5[1m]', 0.01]]);
    assert.equal(spent.byProject.reduce((sum, p) => sum + (p.costUsd ?? 0), 0), 0.01, 'the same money, cut the other way');
    assert.equal((await core.chats.usageSeries('day')).points.reduce((sum, p) => sum + (p.costUsd ?? 0), 0), 0.01);
  } finally {
    core.shutdown();
  }
});

test('a chat from a terminal shows up by tokens in the breakdown and the series, with no cost', async () => {
  const config = { ...tempConfig(), claudeBin: join(import.meta.dirname, 'fixtures', 'fake-claude-control.mjs') };
  const core = new Core(config);
  try {
    const cwd = join(config.workspaceDir, 'p');
    mkdirSync(cwd, { recursive: true });
    const dir = join(config.projectsDir, encodeProjectId(cwd));
    mkdirSync(dir, { recursive: true });
    const line = (id: string, at: string, model: string, text: string): string =>
      JSON.stringify({ type: 'assistant', uuid: id, timestamp: at, cwd, sessionId: 'svc-1', isSidechain: false, message: { id, role: 'assistant', model, content: [{ type: 'text', text }], usage: { input_tokens: 4, output_tokens: 6 } } });
    writeFileSync(join(dir, 'svc-1.jsonl'), `${line('m1', '2026-03-10T10:00:00Z', 'claude-opus-5', 'hi')}\n`);
    const breakdown = await core.chats.usageBreakdown({ from: '2026-03-10', to: '2026-03-10' });
    assert.deepEqual(breakdown.byModel.map((m) => [m.key, m.costUsd, m.tokens]), [['claude-opus-5', null, 10]]);
    const series = await core.chats.usageSeries('week', { from: '2026-03-10', to: '2026-03-10' });
    assert.deepEqual(series.points.map((p) => [p.at, p.tokens, p.chats]), [['2026-03-09', 10, 1]]);
  } finally {
    core.shutdown();
  }
});

// ---------- export ----------

const chatFor = (over: Partial<Chat> = {}): Chat =>
  ({
    id: '0123456789abcdef',
    title: 'Fix the login: "OAuth" bug',
    project: { id: 'p', name: 'App' },
    cwd: '/work/app',
    model: 'claude-opus-5',
    startedAt: '2026-03-10T10:00:00Z',
    updatedAt: '2026-03-10T10:05:00Z',
    cost: { usd: 0.1234, tokens: [{ model: 'claude-opus-5', input: 10, output: 20, cacheRead: 0, cacheCreation: 0, total: 30 }], total: { input: 10, output: 20, cacheRead: 0, cacheCreation: 0, total: 30 } },
    ...over,
  }) as Chat;

test('the Markdown export has a header with the cost the CLI reported, turns, and every tool call folded with its result', () => {
  const md = chatToMarkdown(chatFor(), [
    { uuid: 'u1', role: 'user', timestamp: '2026-03-10T10:00:00Z', model: null, isSidechain: false, parentToolUseId: null, blocks: [{ type: 'text', text: 'Run the tests' }] },
    { uuid: 'a1', role: 'assistant', timestamp: '2026-03-10T10:00:01Z', model: 'claude-opus-5', isSidechain: false, parentToolUseId: null, blocks: [{ type: 'thinking', text: 'I should run them' }] },
    { uuid: 'a2', role: 'assistant', timestamp: '2026-03-10T10:00:02Z', model: 'claude-opus-5', isSidechain: false, parentToolUseId: null, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test <fast>' } }] },
    { uuid: 'u2', role: 'user', timestamp: '2026-03-10T10:00:03Z', model: null, isSidechain: false, parentToolUseId: null, blocks: [{ type: 'tool_result', toolUseId: 't1', content: 'output with ``` inside', isError: true }] },
    { uuid: 'a3', role: 'assistant', timestamp: '2026-03-10T10:00:04Z', model: 'claude-opus-5', isSidechain: false, parentToolUseId: null, blocks: [{ type: 'text', text: 'One test fails.' }] },
    { uuid: 's1', role: 'assistant', timestamp: '2026-03-10T10:00:05Z', model: 'claude-haiku-4-5', isSidechain: true, parentToolUseId: 't1', blocks: [{ type: 'text', text: 'subagent chatter' }] },
  ]);
  assert.match(md, /^# Fix the login: "OAuth" bug\n/);
  assert.match(md, /\*\*Cost:\*\* \$0\.12 \(as reported by the CLI\)/);
  assert.match(md, /\*\*Model:\*\* `claude-opus-5`/);
  assert.match(md, /\*\*Project:\*\* App/);
  assert.match(md, /and 1 more from subagents/);
  assert.equal((md.match(/^## Assistant/gm) ?? []).length, 1, 'the blocks of one turn share a heading');
  assert.match(md, /^## User · 2026-03-10T10:00:00Z/m);
  assert.match(md, /<summary>Tool: <code>Bash<\/code> — pnpm test &lt;fast&gt; \(failed\)<\/summary>/);
  assert.ok(md.indexOf('**Result**') > md.indexOf('**Input**'), 'the result sits with its call');
  assert.match(md, /````\noutput with ``` inside\n````/, 'a fence longer than the backticks inside it');
  assert.doesNotMatch(md, /subagent chatter/);
  assert.equal((md.match(/One test fails\./g) ?? []).length, 1);
});

test('a chat with no reported cost says so instead of showing a made-up one, and a long result is cut', () => {
  const md = chatToMarkdown(chatFor({ cost: { usd: null, tokens: [], total: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 } } }), [
    { uuid: 'a1', role: 'assistant', timestamp: null, model: null, isSidechain: false, parentToolUseId: null, blocks: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/a' } }] },
    { uuid: 'u1', role: 'user', timestamp: null, model: null, isSidechain: false, parentToolUseId: null, blocks: [{ type: 'tool_result', toolUseId: 't', content: 'x'.repeat(5_000), isError: false }] },
  ]);
  assert.match(md, /\*\*Cost:\*\* not reported/);
  assert.match(md, /1,000 more characters, cut here/);
  assert.ok(!md.includes('$'), 'no figure appears');
});

test('the download is named after the chat and never carries a character a file system refuses', () => {
  assert.equal(exportFilename(chatFor(), 'markdown'), 'fix-the-login-oauth-bug-01234567.md');
  assert.equal(exportFilename(chatFor({ title: '../../etc/passwd' }), 'json'), 'etcpasswd-01234567.json');
  assert.equal(exportFilename(chatFor({ title: '¿¡?!' }), 'json'), 'chat-01234567.json');
});

test('a chat is exported whole through the service, subagents included, in more than one page', async () => {
  const config = { ...tempConfig(), claudeBin: join(import.meta.dirname, 'fixtures', 'fake-claude-control.mjs') };
  const core = new Core(config);
  try {
    const cwd = join(config.workspaceDir, 'p');
    mkdirSync(cwd, { recursive: true });
    const dir = join(config.projectsDir, encodeProjectId(cwd));
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    const total = 1_250;
    for (let i = 0; i < total; i++) {
      const sidechain = i % 5 === 0;
      lines.push(
        JSON.stringify({ type: 'user', uuid: `u${String(i)}`, timestamp: '2026-03-10T10:00:00Z', cwd, sessionId: 'exp-1', isSidechain: sidechain, message: { role: 'user', content: `message ${String(i)}` } }),
      );
    }
    writeFileSync(join(dir, 'exp-1.jsonl'), `${lines.join('\n')}\n`);
    const exported = await core.chats.export('exp-1');
    assert.equal(exported.entries.length, total);
    assert.deepEqual(exported.entries.map((e) => e.uuid).slice(0, 2), ['u0', 'u1'], 'oldest first');
    assert.equal(exported.entries.at(-1)?.uuid, `u${String(total - 1)}`);
    assert.equal(exported.entries.filter((e) => e.isSidechain).length, total / 5);
    assert.equal(exported.chat.id, 'exp-1');
    await assert.rejects(core.chats.export('nope'), /not found/);
  } finally {
    core.shutdown();
  }
});
