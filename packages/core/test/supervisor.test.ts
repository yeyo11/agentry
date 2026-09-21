import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentryEvent, HealthSignal, SupervisorProposal, TranscriptEntry } from '@agentry/shared';
import type { ChatRuntime } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import type { AgentryEventInput } from '../src/events.ts';
import { HealthMonitor, type TaskContext } from '../src/health-service.ts';
import { Core } from '../src/index.ts';
import {
  DEFAULT_SUPERVISOR,
  hintFrom,
  lastSteps,
  parseSupervisorConfig,
  Supervisor,
  SupervisorConflictError,
  SupervisorSettings,
  type SupervisorAnswer,
  type SupervisorQuestion,
} from '../src/supervisor.ts';
import { tempConfig } from './helpers.ts';

// The supervisor wakes on a bad signal, asks a housekeeping chat once per signal per chat, and keeps
// what it proposed as a row. Every test answers with a fake: the CLI stand-in of the fixtures, or a
// function. Never a real model.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

const hung: HealthSignal = {
  kind: 'hung-command',
  level: 'bad',
  reason: '`pnpm e2e` has been running for 12 min.',
  detail: 'pnpm e2e',
  hint: 'Run long commands under `timeout`.',
};
const slow: HealthSignal = { kind: 'no-progress', level: 'warn', reason: 'No change in 20 min.' };
const looping: HealthSignal = { kind: 'loop', level: 'bad', reason: 'The same call four times.' };

const chatOf = (id: string, over: Partial<ChatRuntime> = {}): ChatRuntime =>
  ({ id, name: `chat ${id}`, cwd: '/work', workingDir: '/work/tree', origin: 'agentry', orchestrationId: null, ...over }) as ChatRuntime;

const task: TaskContext = { orchestrationId: 'orch-1', taskId: 'build', taskName: 'Build it', limits: null, elapsedMs: 0, spentUsd: 0 };

const entry = (role: 'user' | 'assistant', blocks: TranscriptEntry['blocks'], isSidechain = false): TranscriptEntry => ({
  uuid: Math.random().toString(36),
  role,
  timestamp: null,
  model: null,
  isSidechain,
  parentToolUseId: null,
  blocks,
});

function harness(answer: (q: SupervisorQuestion) => SupervisorAnswer | Promise<SupervisorAnswer> = () => ({ text: 'Check the open socket.', costUsd: 0.002, isError: false })) {
  const config = tempConfig();
  const db = new Db(config);
  const settings = new SupervisorSettings(config);
  const asked: SupervisorQuestion[] = [];
  const events: AgentryEventInput[] = [];
  const hints: SupervisorProposal[] = [];
  const charged: Array<[string, number]> = [];
  let steps: TranscriptEntry[] = [];
  const supervisor = new Supervisor({
    settings,
    db,
    ask: async (q) => {
      asked.push(q);
      return answer(q);
    },
    steps: () => Promise.resolve(steps),
    hint: (p) => {
      hints.push(p);
      return Promise.resolve();
    },
    emit: (e) => events.push(e),
    charge: (id, usd) => charged.push([id, usd]),
  });
  const enable = (over: Partial<typeof DEFAULT_SUPERVISOR> = {}) => settings.set({ ...DEFAULT_SUPERVISOR, enabled: true, ...over });
  return { db, settings, supervisor, asked, events, hints, charged, enable, setSteps: (s: TranscriptEntry[]) => (steps = s) };
}

test('the settings are off by default, validated whole, and a field broken by hand falls back on its own', async () => {
  const config = tempConfig();
  const settings = new SupervisorSettings(config);
  assert.deepEqual(settings.get(), { enabled: false, model: 'haiku', autoSend: false, maxCostUsd: 0.05 });

  const saved = await settings.set({ enabled: true, model: ' claude-haiku-4-5 ', autoSend: true, maxCostUsd: 0.1 });
  assert.deepEqual(saved, { enabled: true, model: 'claude-haiku-4-5', autoSend: true, maxCostUsd: 0.1 });
  assert.deepEqual(settings.get(), saved);

  assert.throws(() => parseSupervisorConfig({ ...DEFAULT_SUPERVISOR, maxCostUsd: 0 }), /maxCostUsd/);
  assert.throws(() => parseSupervisorConfig({ ...DEFAULT_SUPERVISOR, maxCostUsd: 50 }), /maxCostUsd/);
  assert.throws(() => parseSupervisorConfig({ ...DEFAULT_SUPERVISOR, model: '--dangerously-skip-permissions' }), /model/);
  assert.throws(() => parseSupervisorConfig({ ...DEFAULT_SUPERVISOR, enabled: 'yes' }), /enabled/);
  assert.throws(() => parseSupervisorConfig({ enabled: true }), /autoSend/);
  assert.throws(() => parseSupervisorConfig([]), /JSON object/);

  writeFileSync(join(config.dataDir, 'supervisor.json'), JSON.stringify({ enabled: true, model: 'sonnet', autoSend: 'sure', maxCostUsd: -1 }));
  assert.deepEqual(settings.get(), { enabled: true, model: 'sonnet', autoSend: false, maxCostUsd: 0.05 });
  writeFileSync(join(config.dataDir, 'supervisor.json'), '{ not json');
  assert.deepEqual(settings.get(), DEFAULT_SUPERVISOR);
});

test('off, it asks nothing; on, a bad signal wakes it once per signal per chat', async () => {
  const h = harness();
  const chat = chatOf('c1');
  assert.equal(await h.supervisor.wake(chat, null, [hung]), null);
  assert.equal(h.asked.length, 0, 'off by default');

  await h.enable();
  assert.equal(await h.supervisor.wake(chat, null, [slow]), null);
  assert.equal(h.asked.length, 0, 'a warning is not what wakes it');

  const proposal = await h.supervisor.wake(chat, null, [hung, slow]);
  assert.equal(h.asked.length, 1);
  assert.equal(proposal?.signal, 'hung-command');
  assert.equal(proposal?.hint, 'Check the open socket.');
  assert.equal(proposal?.status, 'proposed');
  assert.equal(proposal?.costUsd, 0.002);
  assert.equal(proposal?.taskId, undefined);
  assert.deepEqual(h.db.proposalsOf('c1'), [proposal]);

  // The same signal again, however many times the badge changes, is not asked about again
  assert.equal(await h.supervisor.wake(chat, null, [hung]), null);
  assert.equal(h.asked.length, 1);
  // A second bad signal of the same chat is its own question, and so is the same signal on another chat
  assert.equal((await h.supervisor.wake(chat, null, [hung, looping]))?.signal, 'loop');
  assert.equal((await h.supervisor.wake(chatOf('c2'), null, [hung]))?.chatId, 'c2');
  assert.equal(h.asked.length, 3);
  assert.equal(h.charged.length, 0, 'a chat of no graph charges no graph');

  // Housekeeping is never supervised
  assert.equal(await h.supervisor.wake(chatOf('c3', { origin: 'internal' }), null, [hung]), null);
  assert.equal(h.asked.length, 3);
});

test('two announcements before the answer arrives ask once', async () => {
  let release: (a: SupervisorAnswer) => void = () => undefined;
  const h = harness(() => new Promise((r) => (release = r)));
  await h.enable();
  const first = h.supervisor.wake(chatOf('c1'), null, [hung]);
  const second = await h.supervisor.wake(chatOf('c1'), null, [hung]);
  assert.equal(second, null);
  await new Promise((r) => setImmediate(r));
  release({ text: 'Look at the port.', costUsd: 0.001, isError: false });
  assert.equal((await first)?.hint, 'Look at the port.');
  assert.equal(h.asked.length, 1);
});

test('the question carries the signal, the settings and the worker\'s last steps; the event names the task', async () => {
  const h = harness();
  await h.enable({ model: 'claude-haiku-4-5', maxCostUsd: 0.02 });
  const long = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n');
  h.setSteps([
    entry('assistant', [{ type: 'text', text: 'Running the suite.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm e2e' } }]),
    entry('user', [{ type: 'tool_result', toolUseId: 't1', content: long, isError: true }]),
    entry('assistant', [{ type: 'tool_use', id: 's1', name: 'Grep', input: { pattern: 'secret-of-a-subagent' } }], true),
    entry('assistant', [{ type: 'text', text: 'Trying again with more time.' }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pnpm e2e --slow' } }]),
  ]);
  const chat = chatOf('w1', { orchestrationId: 'orch-1' });
  const proposal = await h.supervisor.wake(chat, task, [hung]);

  const [q] = h.asked;
  assert.equal(q?.model, 'claude-haiku-4-5');
  assert.equal(q?.maxCostUsd, 0.02);
  assert.equal(q?.cwd, '/work/tree');
  assert.match(q?.prompt ?? '', /working on the task "Build it"/);
  assert.match(q?.prompt ?? '', /hung-command: `pnpm e2e` has been running for 12 min\./);
  assert.match(q?.prompt ?? '', /Agentry's generic suggestion: Run long commands/);
  assert.match(q?.prompt ?? '', /- Bash \{"command":"pnpm e2e"\}\n {2}failed: line 0\n/);
  assert.match(q?.prompt ?? '', /line 5\n {2}… \(14 more lines\)/);
  assert.doesNotMatch(q?.prompt ?? '', /line 6/, 'a result is cut to a few lines');
  assert.match(q?.prompt ?? '', /- Bash \{"command":"pnpm e2e --slow"\}\n {2}\(still running\)/);
  assert.match(q?.prompt ?? '', /Its last message:\nTrying again with more time\./);
  assert.doesNotMatch(q?.prompt ?? '', /secret-of-a-subagent/, 'subagents are not the worker');

  assert.equal(proposal?.taskId, 'build');
  assert.equal(proposal?.orchestrationId, 'orch-1');
  assert.deepEqual(h.charged, [['orch-1', 0.002]], 'its cost goes on the graph');
  const [event] = h.events;
  assert.equal(event?.type, 'supervisor.proposed');
  if (event?.type !== 'supervisor.proposed') return;
  assert.equal(event.taskId, 'build');
  assert.equal(event.taskName, 'Build it');
  assert.equal(event.runId, 'w1');
  assert.equal(event.orchestrationId, 'orch-1');
  assert.deepEqual(event.proposal, proposal);
  assert.match(event.title, /^Build it: /);
});

test('an answer that is no use records nothing, is not asked again, and still costs what it cost', async () => {
  let call = 0;
  const h = harness(() => (++call === 1 ? { text: 'budget exceeded', costUsd: 0.05, isError: true } : { text: '  \n ', costUsd: 0.01, isError: false }));
  await h.enable();
  assert.equal(await h.supervisor.wake(chatOf('w1'), task, [hung]), null);
  assert.equal(await h.supervisor.wake(chatOf('w1'), task, [hung]), null);
  assert.equal(h.asked.length, 1);
  assert.equal(await h.supervisor.wake(chatOf('w2'), task, [hung]), null, 'an empty answer is no hint');
  assert.deepEqual(h.charged, [['orch-1', 0.05], ['orch-1', 0.01]]);
  assert.deepEqual(h.db.proposalsOf('w1'), []);
  assert.equal(h.events.length, 0);

  // A question that throws is the same: no row, not asked again
  const broken = harness(() => {
    throw new Error('the CLI is not installed');
  });
  await broken.enable();
  assert.equal(await broken.supervisor.wake(chatOf('w1'), null, [hung]), null);
  assert.equal(await broken.supervisor.wake(chatOf('w1'), null, [hung]), null);
  assert.equal(broken.asked.length, 1);
});

test('a long answer is cut to the two lines a hint is', () => {
  assert.equal(hintFrom('\n  First line.  \n\nSecond line.\nThird line.'), 'First line.\nSecond line.');
  assert.equal(hintFrom('x'.repeat(1000)).length, 400);
  assert.equal(lastSteps([]), '(nothing recorded yet)');
});

test('send delivers the hint and marks it sent; dismiss marks it dismissed; each once, and only from its own chat or task', async () => {
  const h = harness();
  await h.enable();
  const chatProposal = await h.supervisor.wake(chatOf('c1'), null, [hung]);
  const taskProposal = await h.supervisor.wake(chatOf('w1'), task, [hung]);
  assert.ok(chatProposal && taskProposal);

  assert.throws(() => h.supervisor.dismiss(chatProposal.id, { chatId: 'other' }), /proposal not found/);
  await assert.rejects(h.supervisor.send(taskProposal.id, { orchestrationId: 'orch-1', taskId: 'other' }), /proposal not found/);
  await assert.rejects(h.supervisor.send('nope', { chatId: 'c1' }), /proposal not found/);

  const sent = await h.supervisor.send(chatProposal.id, { chatId: 'c1' });
  assert.equal(sent.status, 'sent');
  assert.deepEqual(h.hints.map((p) => p.id), [chatProposal.id]);
  assert.equal(h.db.proposal(chatProposal.id)?.status, 'sent');
  await assert.rejects(h.supervisor.send(chatProposal.id, { chatId: 'c1' }), (err) => err instanceof SupervisorConflictError && /already sent/.test(err.message));
  assert.throws(() => h.supervisor.dismiss(chatProposal.id, { chatId: 'c1' }), SupervisorConflictError);

  // A task's proposal is reachable from the board and from its worker's chat
  const dismissed = h.supervisor.dismiss(taskProposal.id, { orchestrationId: 'orch-1', taskId: 'build' });
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(h.db.proposal(taskProposal.id)?.status, 'dismissed');
  assert.equal(h.hints.length, 1, 'a dismissed proposal reaches nobody');
  await assert.rejects(h.supervisor.send(taskProposal.id, { chatId: 'w1' }), /already dismissed/);

  // A hint that does not arrive leaves the proposal as it was
  const failing = harness();
  await failing.enable();
  const p = await failing.supervisor.wake(chatOf('c9'), null, [hung]);
  assert.ok(p);
  const refusing = new Supervisor({
    settings: failing.settings,
    db: failing.db,
    ask: () => Promise.reject(new Error('unused')),
    steps: () => Promise.resolve([]),
    hint: () => Promise.reject(new Error('The chat has no live process to nudge.')),
    emit: () => undefined,
    charge: () => undefined,
  });
  await assert.rejects(refusing.send(p.id, { chatId: 'c9' }), /no live process/);
  assert.equal(failing.db.proposal(p.id)?.status, 'proposed');
});

test('with autoSend the proposal goes to the worker on its own', async () => {
  const h = harness();
  await h.enable({ autoSend: true });
  const proposal = await h.supervisor.wake(chatOf('c1'), null, [hung]);
  assert.equal(proposal?.status, 'sent');
  assert.equal(h.hints.length, 1);
  assert.equal(h.db.proposal(proposal?.id ?? '')?.status, 'sent');
  // The event said what was proposed, before it was sent
  assert.equal(h.events[0]?.type === 'supervisor.proposed' && h.events[0].proposal.status, 'proposed');
});

// ---------- through Core, with the fake CLI as both the worker and the supervisor ----------

async function until<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a worker that turns bad gets a proposal from a read-only housekeeping chat, shown on its health and sent through the hint route', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const log = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = log;
  const core = new Core(config);
  const events: AgentryEvent[] = [];
  core.events.subscribe((e) => events.push(e));
  const monitor = new HealthMonitor(
    {
      runtime: core.runtime,
      health: core.health,
      emit: (event) => core.events.emit(event),
      taskOf: () => null,
      onBad: (chat, t, signals) => void core.supervisor.wake(chat, t, signals),
    },
    0,
  );
  try {
    await core.supervisor.configure({ enabled: true, model: 'haiku', autoSend: false, maxCostUsd: 0.03 });
    const chat = core.runtime.start({ prompt: 'SLEEP 60' });
    await until(() => core.runtime.pulse(chat.id)?.commands[0], 'the command to start');

    monitor.check(Date.now() + 12 * 60_000);
    const proposed = await until(() => events.find((e) => e.type === 'supervisor.proposed'), 'the proposal', 15_000);
    assert.equal(proposed.type === 'supervisor.proposed' && proposed.runId, chat.id);
    monitor.check(Date.now() + 12 * 60_000 + 1000);
    monitor.check(Date.now() + 13 * 60_000);

    // The housekeeping chat: its own process, no transcript, the read-only preset, the ceiling as a flag
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const housekeeping = lines.filter((l) => l.includes('--no-session-persistence'));
    assert.equal(housekeeping.length, 1, 'asked once however many times the monitor looks');
    const argv = housekeeping[0]?.split(' ') ?? [];
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    assert.equal(flag('--model'), 'haiku');
    assert.equal(flag('--max-budget-usd'), '0.03');
    assert.ok(argv.some((a) => a.startsWith('--allowedTools=Read,Glob,Grep,')), argv.join(' '));
    assert.ok(argv.includes('--disallowedTools=Edit,Write,NotebookEdit'), argv.join(' '));
    // It is gone once it answered: the proposal is its record
    await until(() => !core.runtime.list().some((r) => r.origin === 'internal'), 'the housekeeping chat to be removed');

    const [row] = core.db.proposalsOf(chat.id);
    assert.ok(row);
    assert.equal(row.costUsd, 0.01, 'the cost the CLI reported in its result');
    assert.match(row.hint, /^args=/, 'the fake answers with its own argv');

    // The chat's health carries it while the signal stands
    const health = core.health.read(chat.id, { state: 'working', lastEnded: null, context: null, failedBranches: 0 }, Date.now() + 12 * 60_000);
    assert.equal(health.level, 'bad');
    assert.equal(health.proposal?.id, row.id);
    const well = core.health.read(chat.id, { state: 'working', lastEnded: null, context: null, failedBranches: 0 });
    assert.equal(well.proposal, null, 'a chat that looks well shows no proposal');

    const sent = await core.supervisor.send(row.id, { chatId: chat.id });
    assert.equal(sent.status, 'sent');
    const said = core.runtime.events(chat.id).flatMap((e) => e.entry?.blocks ?? []).flatMap((b) => (b.type === 'text' ? [b.text] : []));
    assert.ok(said.some((t) => t.startsWith('A hint from the person following this chat') && t.includes(row.hint.slice(0, 40))));
  } finally {
    monitor.stop();
    core.shutdown();
    delete process.env.FAKE_CLAUDE_SPAWNS;
    if (existsSync(log)) writeFileSync(log, '');
  }
});

test('what the supervisor spends on a worker of a graph is added to the graph', () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  try {
    const orch = core.orchestrator.create({ name: 'g', cwd: config.workspaceDir, tasks: [{ id: 'a', name: 'A', prompt: 'hello' }] });
    const before = core.orchestrator.get(orch.id)?.costUsd ?? 0;
    core.orchestrator.chargeSupervisor(orch.id, 0.004);
    core.orchestrator.chargeSupervisor(orch.id, 0);
    core.orchestrator.chargeSupervisor('no-such-graph', 1);
    assert.equal(Math.round(((core.orchestrator.get(orch.id)?.costUsd ?? 0) - before) * 1000) / 1000, 0.004);
  } finally {
    core.shutdown();
  }
});
