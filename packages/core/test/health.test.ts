import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatHealth, HUNG_COMMAND_MS, type HealthFacts } from '../src/chat-model.ts';
import { usualDuration } from '../src/commands.ts';
import {
  budget,
  loop,
  noProgress,
  NO_PROGRESS_BAD_MS,
  NO_PROGRESS_MS,
  repeatStall,
  weakenedTests,
  weakening,
  type ToolCall,
  type Trace,
} from '../src/health.ts';

// The signals of a worker that is busy and not getting anywhere. Each rule is tested twice over:
// that it fires on the case that prompted it, and — more of the tests, on purpose — that it stays
// quiet on the honest work that looks like it, because a false positive on every honest edit is
// noise a person learns to ignore.

const T0 = Date.parse('2026-01-01T10:00:00.000Z');
const at = (msAfter: number) => new Date(T0 + msAfter).toISOString();

let n = 0;
function call(name: string, input: Record<string, unknown>, over: Partial<ToolCall> = {}): ToolCall {
  return { id: `toolu_${String(++n)}`, name, input, at: at(0), endedAt: at(1000), isError: false, result: 'ok', ...over };
}
const bash = (command: string, startMs: number, endMs: number | null, over: Partial<ToolCall> = {}) =>
  call('Bash', { command }, { at: at(startMs), endedAt: endMs === null ? null : at(endMs), ...over });
const trace = (calls: ToolCall[]): Trace => ({ executionStartedAt: at(0), lastEventAt: at(0), calls, heartbeats: new Map() });
const edit = (file_path: string, old_string: string, new_string: string, over: Partial<ToolCall> = {}) => call('Edit', { file_path, old_string, new_string }, over);

// ---------- the same stall again ----------

const noHistory = { fallbackMs: HUNG_COMMAND_MS, usualOf: () => null };

test('the second e2e run in a row that hangs is named as the same stall again', () => {
  const runs = trace([bash('pnpm e2e', 0, 420_000), bash('pnpm e2e --slow', 430_000, 730_000)]);
  const signal = repeatStall(runs, noHistory, T0 + 740_000);
  assert.equal(signal?.kind, 'repeat-stall');
  assert.equal(signal?.level, 'warn');
  assert.match(signal?.reason ?? '', /`pnpm e2e` has hung 2 times in a row/);
  assert.equal(signal?.since, at(0));
  assert.match(signal?.hint ?? '', /Do not run it again as it is/);

  const three = trace([...runs.calls, bash('pnpm e2e', 740_000, 1_010_000)]);
  assert.equal(repeatStall(three, noHistory, T0 + 1_020_000)?.level, 'bad');
});

test('a run still going past its limit counts, and names the call that can be cancelled', () => {
  const running = bash('pnpm e2e', 430_000, null);
  const signal = repeatStall(trace([bash('pnpm e2e', 0, 300_000), running]), noHistory, T0 + 430_000 + 4 * 60_000);
  assert.equal(signal?.toolUseId, running.id);
});

test('commands that fail fast, or hang once and then work, are not the same stall again', () => {
  // A test that fails, is edited and fails again is what fixing looks like
  const fast = trace([bash('pnpm test', 0, 5000, { isError: true }), bash('pnpm test', 20_000, 26_000, { isError: true }), bash('pnpm test', 40_000, 47_000, { isError: true })]);
  assert.equal(repeatStall(fast, noHistory, T0 + 60_000), null);
  // It hung once and the next run finished: the worker mended it
  assert.equal(repeatStall(trace([bash('pnpm e2e', 0, 400_000), bash('pnpm e2e', 410_000, 490_000)]), noHistory, T0 + 500_000), null);
  // Two hangs of different kinds are two separate stalls, neither repeated
  assert.equal(repeatStall(trace([bash('pnpm e2e', 0, 400_000), bash('pnpm build', 410_000, 800_000)]), noHistory, T0 + 810_000), null);
});

test('the limit of a kind is its own history, not the fixed three minutes', () => {
  const usual = usualDuration([1_200_000, 1_150_000, 1_300_000, 1_250_000, 1_180_000]);
  const knownSlow = { fallbackMs: HUNG_COMMAND_MS, usualOf: () => usual };
  // Ten minutes is a hang for most commands and an ordinary run for this one
  assert.equal(repeatStall(trace([bash('pnpm build', 0, 600_000), bash('pnpm build', 610_000, 1_200_000)]), knownSlow, T0 + 1_210_000), null);
});

// ---------- a loop ----------

test('the same call getting the same answer over and over is a loop', () => {
  const same = Array.from({ length: 4 }, (_, i) => bash('pnpm build', i * 60_000, i * 60_000 + 1000, { isError: true, result: 'error TS2345: Argument of type string' }));
  const signal = loop(trace(same));
  assert.equal(signal?.kind, 'loop');
  assert.equal(signal?.level, 'warn');
  assert.match(signal?.reason ?? '', /`pnpm build` ran 4 times with the same result/);
  assert.equal(loop(trace([...same, ...same]))?.level, 'bad');
});

test('the same error text coming back from different calls is a loop too', () => {
  const calls = ['a', 'b', 'c', 'd'].map((f, i) => call('Read', { file_path: `/x/${f}` }, { at: at(i * 1000), isError: true, result: 'EACCES: permission denied, open /x/y' }));
  assert.match(loop(trace(calls))?.reason ?? '', /The same error came back 4 times/);
});

test('re-running the tests after an edit is work, not a loop: what comes back differs', () => {
  const calls = [
    bash('pnpm test', 0, 1000, { isError: true, result: '3 failing' }),
    bash('pnpm test', 10_000, 11_000, { isError: true, result: '2 failing' }),
    bash('pnpm test', 20_000, 21_000, { isError: true, result: '1 failing: chats.test.ts' }),
    bash('pnpm test', 30_000, 31_000, { result: 'all passing' }),
  ];
  assert.equal(loop(trace(calls)), null);
  // Reading four different files, and a worker keeping notes, say nothing either
  const reads = ['a', 'b', 'c', 'd', 'e'].map((f) => call('Read', { file_path: `/x/${f}` }));
  const notes = Array.from({ length: 6 }, () => call('TodoWrite', { todos: [] }));
  assert.equal(loop(trace([...reads, ...notes])), null);
});

test('three of the same is not yet a loop', () => {
  const three = Array.from({ length: 3 }, (_, i) => bash('git status', i * 1000, i * 1000 + 100, { result: 'nothing to commit' }));
  assert.equal(loop(trace(three)), null);
});

// ---------- tests bent to pass ----------

const SPEC = 'e2e/specs/pages.spec.mjs';

test('an existing test that no longer asserts anything is flagged, with the file and why', () => {
  const before = `test('shows the title', async () => {\n  const t = await page.title();\n  expect(t).toBe('Agentry');\n  expect(await page.$('h1')).toBeTruthy();\n});`;
  const after = `test('shows the title', async () => {\n  const t = await page.title();\n});`;
  const [signal] = weakenedTests(trace([edit(SPEC, before, after)]));
  assert.equal(signal?.kind, 'weakened-test');
  assert.equal(signal?.detail, SPEC);
  assert.match(signal?.reason ?? '', /`e2e\/specs\/pages\.spec\.mjs` was edited so that it asserts less: 2 assertions removed/);
  assert.match(signal?.hint ?? '', /update the assertion to the new behaviour instead of weakening it/);
});

test('skipping a test, adding an assertion that cannot fail, and swapping precise assertions for vague ones are flagged', () => {
  assert.equal(weakening("it('works', () => { assert.equal(a, 1); });", "it.skip('works', () => { assert.equal(a, 1); });"), 'a test is skipped');
  assert.equal(weakening("it('works', () => { assert.equal(a, 1); });", "it('works', () => { assert.equal(a, 1); expect(true).toBe(true); });"), 'an assertion that cannot fail was added');
  assert.match(
    weakening("expect(count).toBe(3);\nexpect(name).toBe('x');", 'expect(count).toBeTruthy();\nexpect(name).toBeDefined();') ?? '',
    /pass for almost anything/,
  );
  // A commented-out assertion asserts nothing
  assert.match(weakening("it('a', () => {\n  expect(x).toBe(1);\n});", "it('a', () => {\n  // expect(x).toBe(1);\n});") ?? '', /1 assertion removed/);
});

test('honest edits to a test are left alone', () => {
  // The expected value changed because the behaviour did
  assert.equal(weakening("expect(total).toBe(3);", "expect(total).toBe(4);"), null);
  // A precise assertion tightened, or one added
  assert.equal(weakening("expect(a).toBeTruthy();", "expect(a).toBe('x');"), null);
  assert.equal(weakening("expect(a).toBe(1);", "expect(a).toBe(1);\nexpect(b).toBe(2);"), null);
  // A whole test deleted with its assertions is a cleanup, not a test that stopped checking
  assert.equal(weakening("it('old behaviour', () => {\n  expect(a).toBe(1);\n});", ''), null);
  // A rename, a refactor of the setup, a new import
  assert.equal(weakening("const page = await open();", "const page = await open({ headless: true });"), null);
  assert.equal(weakening("import { a } from './a.ts';", "import { a, b } from './a.ts';"), null);
  // Assertions rewritten into a helper still assert
  assert.equal(weakening("expect(a).toBe(1);\nexpect(b).toBe(2);", "assertAll({ a: 1, b: 2 }); expect(done).toBe(true);"), null);
  // A comment saying a check was removed is not a removed check
  assert.equal(weakening("// TODO tighten\nexpect(a).toBe(1);", "expect(a).toBe(1);"), null);
});

test('only existing test files are watched: an edit to source, or a failed edit, is nothing', () => {
  const removed = `it('a', () => { expect(x).toBe(1); });`;
  const kept = `it('a', () => { doIt(); });`;
  assert.deepEqual(weakenedTests(trace([edit('src/orders.ts', removed, kept)])), []);
  assert.deepEqual(weakenedTests(trace([edit(SPEC, removed, kept, { isError: true })])), []);
  // A new file has no old text to compare with
  assert.deepEqual(weakenedTests(trace([call('Write', { file_path: SPEC, content: kept })])), []);
  // Every kind of test file is recognised
  for (const path of ['src/a.test.ts', 'src/a.spec.tsx', 'pkg/a_test.go', 'tests/test_a.py', 'apps/web/__tests__/a.ts']) {
    assert.equal(weakenedTests(trace([edit(path, removed, kept)])).length, 1, path);
  }
});

test('a file is reported once, however many times it was weakened', () => {
  const removed = `it('a', () => { expect(x).toBe(1); });`;
  const kept = `it('a', () => { doIt(); });`;
  assert.equal(weakenedTests(trace([edit(SPEC, removed, kept), edit(SPEC, removed, kept), edit('b.test.ts', removed, kept)])).length, 2);
});

// ---------- busy without progress ----------

test('a long stretch with no commit and no change to the files is a warning, and only late a problem', () => {
  assert.equal(noProgress(at(0), T0 + NO_PROGRESS_MS - 1), null);
  const signal = noProgress(at(0), T0 + NO_PROGRESS_MS + 1000);
  assert.equal(signal?.level, 'warn');
  assert.match(signal?.reason ?? '', /Working for 15 min with no commit/);
  assert.equal(noProgress(at(0), T0 + NO_PROGRESS_BAD_MS)?.level, 'bad');
});

// ---------- a limit coming close ----------

test('a task past most of its time is warned, and past all of it is a problem', () => {
  const limits = { maxMinutes: 20 };
  assert.equal(budget(limits, { elapsedMs: 15 * 60_000, costUsd: 0 }), null);
  const soon = budget(limits, { elapsedMs: 17 * 60_000, costUsd: 0 });
  assert.equal(soon?.level, 'warn');
  assert.equal(soon?.reason, '17 min of its 20 min used.');
  const over = budget(limits, { elapsedMs: 21 * 60_000, costUsd: 0 });
  assert.equal(over?.level, 'bad');
  assert.match(over?.reason ?? '', /Past its time limit/);
});

test('the cost limit is reported from what is known to have been spent, and no limit means no signal', () => {
  assert.equal(budget({ maxCostUsd: 5 }, { elapsedMs: 0, costUsd: 3 }), null);
  assert.equal(budget({ maxCostUsd: 5 }, { elapsedMs: 0, costUsd: 4.2 })?.reason, '$4.20 of its $5.00 spent.');
  assert.equal(budget(null, { elapsedMs: 10 ** 9, costUsd: 100 }), null);
  assert.equal(budget({}, { elapsedMs: 10 ** 9, costUsd: 100 }), null);
});

// ---------- how they reach a chat's health ----------

const facts = (over: Partial<HealthFacts> = {}): HealthFacts => ({ state: 'working', live: { lastEventAt: at(0), commands: [] }, lastEnded: null, context: null, failedBranches: 0, ...over });

test('a hung command names the call to cancel, what is usual for it and a text to send', () => {
  const usual = usualDuration([78_000, 80_000, 82_000, 79_000, 95_000, 81_000]);
  const health = chatHealth(
    facts({ live: { lastEventAt: at(0), commands: [{ command: 'pnpm e2e', startedAt: at(0), toolUseId: 'toolu_x', usual }] } }),
    T0 + 5 * 60_000,
  );
  const signal = health.signals[0];
  assert.equal(signal?.kind, 'hung-command');
  assert.equal(signal?.toolUseId, 'toolu_x');
  assert.equal(signal?.reason, '`pnpm e2e` has been running for 5 min; commands like it usually take 81 s.');
  assert.match(signal?.hint ?? '', /run long commands under `timeout`/);
  // Well inside what is usual for it, nothing to say — where the fixed limit would already have fired
  assert.deepEqual(chatHealth(facts({ live: { lastEventAt: at(0), commands: [{ command: 'pnpm e2e', startedAt: at(0), usual }] } }), T0 + 200_000).signals, []);
});

test('the CLI heartbeat says how long a command has run, without the time it waited to be allowed to', () => {
  // Called at 0, allowed at 4 min, and by 6 min the CLI says it has run 2 min: that is not hung
  const waited = { command: 'pnpm build', startedAt: at(0), heartbeat: { elapsedSeconds: 120, at: at(6 * 60_000) } };
  assert.deepEqual(chatHealth(facts({ live: { lastEventAt: at(0), commands: [waited] } }), T0 + 6 * 60_000).signals, []);
  // The same heartbeat, four minutes later, is a command that has run six
  assert.equal(chatHealth(facts({ live: { lastEventAt: at(0), commands: [waited] } }), T0 + 10 * 60_000).signals[0]?.kind, 'hung-command');
});

test('signals that mean something only while working are dropped for a chat that waits, and standing ones are not', () => {
  const extra = [{ kind: 'loop' as const, level: 'warn' as const, reason: 'loop' }];
  const standing = [{ kind: 'weakened-test' as const, level: 'warn' as const, reason: 'weak' }];
  const now = T0 + 1000;
  assert.deepEqual(chatHealth(facts({ extra, standing }), now).signals.map((s) => s.kind), ['loop', 'weakened-test']);
  assert.deepEqual(chatHealth(facts({ state: 'waiting', extra, standing }), now).signals.map((s) => s.kind).sort(), ['waiting', 'weakened-test']);
  assert.deepEqual(chatHealth(facts({ live: null, extra, standing }), now).signals, []);
});
