import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { AgentryEvent, FlowRunDocument, FlowMemoryProposal, ProjectModule, ProjectSettings, WorkItemStatus } from '@agentry/shared';
import { Db, FLOW_SCHEMA_VERSION, migrate } from '../src/db.ts';
import { EventBus } from '../src/events.ts';
import { flowResultSchema, FlowService, parseResult, writeRules, type FlowLaunch } from '../src/flow.ts';
import { WorkItemService } from '../src/work-items.ts';
import { tempConfig } from './helpers.ts';

// The flow starts paid agent runs on its own, so these tests are as much about what must not start
// as about what must. It runs over a real store and a real event bus; only the chats are scripted:
// `launch` records what it was asked and hands out a chat id, and a test answers with a result.

const MEMBERS = [
  { agent: 'product-owner', role: 'product-owner', model: 'opus', responsibility: 'Refines the backlog' },
  { agent: 'developer', role: 'developer', model: 'sonnet', responsibility: 'Implements' },
  { agent: 'qa', role: 'qa', model: 'sonnet', responsibility: 'Verifies', writes: ['docs/reports'] },
];

function settingsWith(modules: ProjectModule[] = ['board', 'team', 'memory', 'documents']): ProjectSettings {
  return {
    modules,
    template: 'software',
    keyPrefix: 'AGN',
    board: { types: ['epic', 'story', 'task', 'bug'], columnLimits: {} },
    team: { members: MEMBERS.map((m) => ({ ...m })) },
    flow: { enabled: true, columns: { backlog: 'product-owner', todo: 'product-owner', in_progress: 'developer', in_review: 'qa' }, maxBounces: 2 },
  };
}

function setup(opts: { db?: Db; settings?: ProjectSettings; recover?: boolean } = {}) {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = opts.db ?? new Db(config);
  const bus = new EventBus();
  const events: AgentryEvent[] = [];
  bus.observe((e) => events.push(e));
  const state = { settings: opts.settings ?? settingsWith() };
  const items = new WorkItemService({ db, project: (id) => (id === 'p1' ? { keyPrefix: 'AGN', columnLimits: {} } : null), emit: (e) => bus.emit(e) });
  const launches: FlowLaunch[] = [];
  const proposals: FlowMemoryProposal[] = [];
  const ties: FlowRunDocument[] = [];
  const stopped: string[] = [];
  const busy = new Set<string>();
  const failNext: { message: string | null } = { message: null };
  let chats = 0;
  const flow = new FlowService({
    db,
    items,
    project: (id) => (id === 'p1' ? { path: '/nowhere/p1', settings: state.settings } : null),
    handoff: () => '# Project journal',
    propose: (_id, proposal) => void proposals.push(proposal),
    tie: async (_item, doc) => void ties.push(doc),
    launch: async (launch, onStart) => {
      if (failNext.message) throw new Error(failNext.message);
      launches.push(launch);
      onStart(launch.resumeChatId ?? `chat-${++chats}`);
    },
    chatBusy: (id) => busy.has(id),
    stop: (id) => void stopped.push(id),
    emit: (e) => bus.emit(e),
  });
  bus.observe((e) => flow.observe(e));
  if (opts.recover !== false) flow.recover();
  const chatOf = (itemId: string): string => {
    const run = flow.runs('p1').find((r) => r.itemId === itemId && r.state === 'running');
    assert.ok(run?.chatId, 'a run is working on the item');
    return run.chatId;
  };
  /** Answers the item's running run with a structured result and lets the flow act on it. */
  const answer = async (itemId: string, output: Record<string, unknown>, isError = false) => {
    await flow.settled();
    await flow.chatResult(chatOf(itemId), { isError, result: isError ? 'it broke' : '', structuredOutput: output });
    await flow.settled();
  };
  const setModules = (modules: ProjectModule[]) => {
    state.settings = { ...state.settings, modules };
    bus.emit({ type: 'project.updated', title: '', projectId: 'p1', projectName: 'p', changes: ['modules'], modules });
  };
  return { db, bus, events, state, items, flow, launches, proposals, ties, stopped, busy, failNext, answer, chatOf, setModules };
}

type Setup = ReturnType<typeof setup>;

const ok = (summary = 'done', extra: Record<string, unknown> = {}) => ({ summary, memoryProposals: [], documents: [], ...extra });
const person = { actor: { kind: 'person' as const } };
const flowRuns = (s: Setup) => s.flow.runs('p1');
const running = (s: Setup) => flowRuns(s).filter((r) => r.state === 'running');
const queued = (s: Setup) => flowRuns(s).filter((r) => r.state === 'queued');

async function item(s: Setup, status: WorkItemStatus, title = 'Fix the cart') {
  const created = s.items.create('p1', { title, status, type: 'task' });
  await s.flow.settled();
  return created;
}

test('a card a person puts on the board starts the role of its column, with the member, the journal and the schema', async () => {
  const s = setup();
  const it = await item(s, 'backlog');
  assert.equal(s.launches.length, 1);
  const launch = s.launches[0];
  assert.ok(launch);
  assert.equal(launch.member.agent, 'product-owner');
  assert.equal(launch.member.model, 'opus');
  assert.equal(launch.run.stage, 'refine');
  assert.equal(launch.appendSystemPrompt, '# Project journal');
  assert.deepEqual(launch.jsonSchema, flowResultSchema('refine'));
  assert.match(launch.prompt, /AGN-1: Fix the cart/);
  assert.equal(launch.permissionMode, 'acceptEdits');
  assert.equal(running(s)[0]?.itemId, it.id);
  assert.deepEqual(
    s.events.filter((e) => e.type === 'flow.run').map((e) => (e.type === 'flow.run' ? e.action : '')),
    ['queued', 'started'],
  );
});

test('refining in backlog completes the item, comments, and moves it to todo, where the Product Owner checks it and leaves it', async () => {
  const s = setup();
  const it = await item(s, 'backlog');
  await s.answer(it.id, ok('Refined', { description: 'The cart keeps its lines', acceptanceCriteria: ['Lines survive a reload', 'Lines survive a reload'] }));
  const after = s.items.find(it.id);
  assert.equal(after?.status, 'todo');
  assert.equal(after?.description, 'The cart keeps its lines');
  assert.deepEqual(after?.acceptanceCriteria.map((c) => c.text), ['Lines survive a reload']);
  const comment = s.items.comments(it.id).at(-1);
  assert.equal(comment?.body, 'Refined');
  assert.deepEqual(comment?.author, { kind: 'agent', role: 'product-owner' });
  const move = s.items.history(it.id).find((e) => e.change === 'status');
  assert.equal(move?.actor.kind, 'agent');
  assert.equal(move?.cause?.event, 'flow.refined');
  // The move into todo is the flow's own, so it starts the todo check, which moves nothing
  assert.equal(s.launches.length, 2);
  assert.equal(s.launches[1]?.run.column, 'todo');
  await s.answer(it.id, ok('Ready'));
  assert.equal(s.items.find(it.id)?.status, 'todo');
  assert.equal(running(s).length + queued(s).length, 0);
  assert.equal(flowRuns(s).filter((r) => r.outcome === 'passed').length, 2);
});

test('a developer run that ends well moves the item to review, and QA passing leaves it waiting for approval', async () => {
  const s = setup();
  const it = await item(s, 'todo');
  await s.answer(it.id, ok('Ready'));
  s.items.move(it.id, { status: 'in_progress' }, person);
  await s.flow.settled();
  assert.equal(s.launches.at(-1)?.run.stage, 'work');
  await s.answer(it.id, ok('Implemented'));
  assert.equal(s.items.find(it.id)?.status, 'in_review');
  assert.equal(s.launches.at(-1)?.run.stage, 'verify');
  // QA writes only its reports: the rest is denied, not asked
  assert.equal(s.launches.at(-1)?.permissionMode, 'dontAsk');
  assert.ok(s.launches.at(-1)?.allowedTools.includes('Edit(docs/reports/**)'));
  await s.answer(it.id, ok('All criteria met', { verdict: 'pass' }));
  const waiting = s.items.find(it.id);
  assert.equal(waiting?.status, 'in_review');
  assert.equal(waiting?.waiting, 'approval');
  assert.equal(s.items.history(it.id).at(-1)?.change, 'waiting');
  // Only a person moves it to done, which answers the wait and starts nothing
  const before = s.launches.length;
  s.items.move(it.id, { status: 'done' }, person);
  await s.flow.settled();
  assert.equal(s.items.find(it.id)?.waiting, null);
  assert.equal(s.launches.length, before);
});

test('QA failing sends the item back and resumes the work chat with its comment, until the bounces run out', async () => {
  const s = setup();
  const it = await item(s, 'in_progress');
  const workChat = s.chatOf(it.id);
  s.items.link(it.id, { kind: 'chat', role: 'work', chatId: workChat });
  await s.answer(it.id, ok('Implemented'));
  for (let round = 1; round <= 2; round++) {
    await s.answer(it.id, ok(`Criterion ${round} is not met`, { verdict: 'fail' }));
    const back = s.items.find(it.id);
    assert.equal(back?.status, 'in_progress');
    assert.equal(back?.bounces, round);
    const resumed = s.launches.at(-1);
    assert.equal(resumed?.run.stage, 'work');
    assert.equal(resumed?.resumeChatId, workChat);
    assert.match(resumed?.prompt ?? '', new RegExp(`Criterion ${round} is not met`));
    await s.answer(it.id, ok('Fixed'));
  }
  assert.equal(flowRuns(s).filter((r) => r.outcome === 'rejected').length, 2);
  // maxBounces is 2: the third failure waits for the person instead of bouncing again
  const launched = s.launches.length;
  await s.answer(it.id, ok('Still broken', { verdict: 'fail' }));
  const stuck = s.items.find(it.id);
  assert.equal(stuck?.status, 'in_review');
  assert.equal(stuck?.waiting, 'bounces');
  assert.equal(stuck?.bounces, 2);
  assert.equal(s.launches.length, launched);
  // A person moving it starts a new round
  s.items.move(it.id, { status: 'in_progress' }, person);
  await s.flow.settled();
  assert.equal(s.items.find(it.id)?.bounces, 0);
  assert.equal(s.items.find(it.id)?.waiting, null);
  assert.equal(s.launches.length, launched + 1);
});

test('nothing starts with the flow off, a module off, an epic, or an unanswered column', async () => {
  const off = setup({ settings: { ...settingsWith(), flow: { ...settingsWith().flow!, enabled: false } } });
  await item(off, 'backlog');
  assert.equal(off.launches.length + flowRuns(off).length, 0);

  for (const modules of [['board', 'memory'], ['team', 'memory']] as ProjectModule[][]) {
    const s = setup({ settings: settingsWith(modules) });
    const it = await item(s, 'backlog').catch(() => null);
    if (it) s.items.move(it.id, { status: 'todo' }, person);
    await s.flow.settled();
    assert.equal(s.launches.length, 0, `modules ${modules.join(',')}`);
  }

  const s = setup({ settings: { ...settingsWith(), flow: { enabled: true, columns: { in_review: 'qa' }, maxBounces: 1 } } });
  await item(s, 'backlog');
  s.items.create('p1', { title: 'Epic', status: 'in_review', type: 'epic' });
  await s.flow.settled();
  assert.equal(s.launches.length, 0);

});

test('a card made from a chat message enters backlog like any other, and is refined', async () => {
  const s = setup();
  s.items.create('p1', { title: 'From a message', status: 'backlog' }, { cause: { kind: 'chat', chatId: 'c1', orchestrationId: null, taskId: null, event: 'chat.message' } });
  await s.flow.settled();
  assert.equal(s.launches[0]?.run.stage, 'refine');
});

test('a move a chat or an orchestration made while working on the item starts nothing', async () => {
  const s = setup({ settings: { ...settingsWith(), flow: { enabled: true, columns: { in_progress: 'developer', in_review: 'qa' }, maxBounces: 1 } } });
  const it = await item(s, 'todo');
  s.items.move(it.id, { status: 'in_progress' }, { actor: { kind: 'system', role: null }, cause: { kind: 'chat', chatId: 'c1', orchestrationId: null, taskId: null, event: 'chat.started' } });
  s.items.move(it.id, { status: 'in_review' }, { actor: { kind: 'system', role: null }, cause: { kind: 'chat', chatId: 'c1', orchestrationId: null, taskId: null, event: 'chat.turn-completed' } });
  await s.flow.settled();
  assert.equal(s.launches.length, 0);
  assert.equal(flowRuns(s).length, 0);
});

test('never more than maxParallel runs of a project; the rest start in order as places free', async () => {
  const s = setup({ settings: { ...settingsWith(), flow: { ...settingsWith().flow!, maxParallel: 1 } } });
  const a = await item(s, 'in_progress', 'A');
  const b = await item(s, 'in_progress', 'B');
  const c = await item(s, 'in_progress', 'C');
  assert.equal(running(s).length, 1);
  assert.deepEqual(queued(s).map((r) => r.itemId), [b.id, c.id]);
  assert.deepEqual(s.flow.projectFlow('p1').queued.map((r) => r.itemId), [b.id, c.id]);
  await s.answer(a.id, ok());
  // A's move to review queues QA behind B and C
  assert.equal(running(s)[0]?.itemId, b.id);
  assert.deepEqual(queued(s).map((r) => r.itemId), [c.id, a.id]);
  assert.equal(s.flow.projectFlow('p1').maxParallel, 1);
});

test("a person's move cancels the run still queued for the old column, and one queued run per item", async () => {
  const s = setup({ settings: { ...settingsWith(), flow: { ...settingsWith().flow!, maxParallel: 1 } } });
  await item(s, 'in_progress', 'Busy');
  const it = await item(s, 'backlog');
  assert.equal(queued(s).length, 1);
  s.items.move(it.id, { status: 'in_progress' }, person);
  s.items.move(it.id, { status: 'in_review' }, person);
  await s.flow.settled();
  const mine = flowRuns(s).filter((r) => r.itemId === it.id);
  assert.deepEqual(mine.map((r) => [r.column, r.state, r.outcome]), [
    ['backlog', 'ended', 'cancelled'],
    ['in_progress', 'ended', 'cancelled'],
    ['in_review', 'queued', null],
  ]);
  s.items.move(it.id, { status: 'done' }, person);
  await s.flow.settled();
  assert.equal(queued(s).length, 0);
});

test("a run that ends after a person moved the item writes its comment and moves nothing", async () => {
  const s = setup();
  const it = await item(s, 'in_progress');
  s.items.move(it.id, { status: 'todo' }, person);
  await s.flow.settled();
  // The todo check waits: one run at a time on an item, and a person's move cancels nothing running
  assert.equal(running(s).length, 1);
  assert.equal(queued(s)[0]?.column, 'todo');
  await s.answer(it.id, ok('Implemented anyway'));
  assert.equal(s.items.find(it.id)?.status, 'todo');
  assert.equal(s.items.comments(it.id).at(-1)?.body, 'Implemented anyway');
  // …and then the todo check starts
  assert.equal(running(s)[0]?.column, 'todo');
});

test('switching the flow or a module off cancels the queue and stops what runs; a late result changes nothing', async () => {
  const s = setup({ settings: { ...settingsWith(), flow: { ...settingsWith().flow!, maxParallel: 1 } } });
  const a = await item(s, 'in_progress', 'A');
  await item(s, 'in_progress', 'B');
  const chat = s.chatOf(a.id);
  s.setModules(['board', 'memory']);
  await s.flow.settled();
  assert.deepEqual(s.stopped, [chat]);
  assert.ok(flowRuns(s).every((r) => r.state === 'ended' && r.outcome === 'cancelled'));
  await s.flow.chatResult(chat, { isError: false, result: '', structuredOutput: ok('late') });
  await s.flow.settled();
  assert.equal(s.items.find(a.id)?.status, 'in_progress');
  assert.equal(s.items.comments(a.id).length, 0);
  // Switched on again, nothing restarts on its own: only a card entering a column does
  s.setModules(['board', 'team']);
  await s.flow.settled();
  assert.equal(s.launches.length, 1);
});

test('a failed chat, an unreadable result or a verdict left out fail the run and move nothing', async () => {
  const s = setup();
  const it = await item(s, 'in_progress');
  await s.answer(it.id, {}, true);
  assert.equal(s.items.find(it.id)?.status, 'in_progress');
  assert.equal(flowRuns(s).at(-1)?.outcome, 'failed');

  s.items.move(it.id, { status: 'in_review' }, person);
  await s.flow.settled();
  await s.answer(it.id, { nothing: true });
  assert.equal(flowRuns(s).at(-1)?.outcome, 'failed');
  s.items.move(it.id, { status: 'todo' }, person);
  s.items.move(it.id, { status: 'in_review' }, person);
  await s.flow.settled();
  await s.answer(it.id, ok('Looks fine'));
  const after = s.items.find(it.id);
  assert.equal(flowRuns(s).at(-1)?.outcome, 'failed');
  assert.equal(after?.status, 'in_review');
  assert.equal(after?.waiting, null);
});

test("a chat that ends without a result fails its run, and the next one starts", async () => {
  const s = setup({ settings: { ...settingsWith(), flow: { ...settingsWith().flow!, maxParallel: 1 } } });
  const a = await item(s, 'in_progress', 'A');
  const b = await item(s, 'in_progress', 'B');
  s.flow.chatEnded(s.chatOf(a.id), 'killed');
  await s.flow.settled();
  assert.equal(flowRuns(s).find((r) => r.itemId === a.id)?.outcome, 'failed');
  assert.equal(running(s)[0]?.itemId, b.id);
});

test('a runtime at its limit keeps the run queued; any other launch failure fails it', async () => {
  const s = setup();
  s.failNext.message = 'Concurrent run limit reached (8)';
  const it = await item(s, 'in_progress');
  assert.equal(queued(s)[0]?.itemId, it.id);
  s.failNext.message = null;
  s.flow.dispatch();
  await s.flow.settled();
  assert.equal(running(s)[0]?.itemId, it.id);

  s.failNext.message = 'the agent file .claude/agents/qa.md is missing';
  await s.answer(it.id, ok());
  s.failNext.message = null;
  assert.equal(flowRuns(s).at(-1)?.outcome, 'failed');
  assert.equal(s.items.find(it.id)?.status, 'in_review');
});

test('a person working in the item\'s chat makes the run moot', async () => {
  const s = setup();
  const it = s.items.create('p1', { title: 'Mine', status: 'todo' });
  s.items.link(it.id, { kind: 'chat', role: 'work', chatId: 'mine' });
  s.busy.add('mine');
  s.items.move(it.id, { status: 'in_progress' }, person);
  await s.flow.settled();
  assert.equal(s.launches.length, 0);
  assert.equal(flowRuns(s)[0]?.outcome, 'cancelled');
});

test('memory proposals and documents go through only with their modules on', async () => {
  const withBoth = setup();
  const it = await item(withBoth, 'in_progress');
  const result = ok('done', {
    memoryProposals: [{ target: { kind: 'journal', file: null, section: null }, text: 'Carts are per user', reason: 'decided' }],
    documents: [{ path: 'docs/adr/0001-cart.md', kind: 'adr' }],
  });
  await withBoth.answer(it.id, result);
  assert.equal(withBoth.proposals.length, 1);
  assert.deepEqual(withBoth.ties, [{ path: 'docs/adr/0001-cart.md', kind: 'adr' }]);

  const without = setup({ settings: settingsWith(['board', 'team']) });
  const other = await item(without, 'in_progress');
  await without.answer(other.id, result);
  assert.equal(without.proposals.length + without.ties.length, 0);
  assert.equal(without.items.find(other.id)?.status, 'in_review');
});

test('a restart puts cut-off runs back in the queue on their chat, and starts nothing before the runtime is back', async () => {
  const first = setup({ settings: { ...settingsWith(), flow: { ...settingsWith().flow!, maxParallel: 1 } } });
  const a = await item(first, 'in_progress', 'A');
  const b = await item(first, 'in_progress', 'B');
  const chat = first.chatOf(a.id);

  const second = setup({ db: first.db, settings: first.state.settings, recover: false });
  second.flow.dispatch();
  await second.flow.settled();
  assert.equal(second.launches.length, 0);
  second.flow.recover();
  await second.flow.settled();
  assert.equal(second.launches.length, 1);
  const resumed = second.launches[0];
  assert.equal(resumed?.run.itemId, a.id);
  assert.equal(resumed?.resumeChatId, chat);
  assert.match(resumed?.prompt ?? '', /Agentry restarted/);
  assert.deepEqual(queued(second).map((r) => r.itemId), [b.id]);
  await second.answer(a.id, ok());
  assert.equal(second.items.find(a.id)?.status, 'in_review');
  assert.equal(running(second)[0]?.itemId, b.id);
});

test('the work-links automation leaves a running flow chat to the flow', async () => {
  const s = setup();
  const it = await item(s, 'in_progress');
  assert.equal(s.flow.ownsChat(s.chatOf(it.id)), true);
  const chat = s.chatOf(it.id);
  await s.answer(it.id, ok());
  assert.equal(s.flow.ownsChat(chat), false);
});

test('write rules: no writes accepts edits; writes allow only their paths, and a path that cannot be a rule is left out', () => {
  assert.deepEqual(writeRules(undefined).permissionMode, 'acceptEdits');
  assert.ok(writeRules(undefined).allowedTools.includes('Edit'));
  const rules = writeRules(['docs/', './src/**/*.ts', 'a,b', '../up', 'x (y)']);
  assert.equal(rules.permissionMode, 'dontAsk');
  assert.ok(!rules.allowedTools.includes('Edit'));
  for (const rule of ['Edit(docs)', 'Edit(docs/**)', 'Write(docs/**)', 'Edit(src/**/*.ts)']) assert.ok(rules.allowedTools.includes(rule), rule);
  assert.ok(!rules.allowedTools.some((r) => r.includes('a,b') || r.includes('..') || r.includes('(y)')));
});

test('a result is read defensively', () => {
  assert.equal(parseResult(null, 'work'), null);
  assert.equal(parseResult({ verdict: 'pass' }, 'verify'), null);
  const parsed = parseResult(
    JSON.stringify({
      summary: ' ok ',
      verdict: 'maybe',
      memoryProposals: [{ target: { kind: 'nowhere' }, text: 'x' }, { target: { kind: 'memory', file: 'a.md' }, text: 'y', reason: 1 }],
      documents: [{ path: 'docs/a.md', kind: 'weird' }, { kind: 'spec' }],
      description: 'ignored outside refine',
    }),
    'work',
  );
  assert.deepEqual(parsed, {
    summary: 'ok',
    verdict: null,
    memoryProposals: [{ target: { kind: 'memory', file: 'a.md', section: null }, text: 'y', reason: '' }],
    documents: [{ path: 'docs/a.md', kind: 'doc' }],
    description: null,
    acceptanceCriteria: [],
  });
});

test('the flow migration applies on top of the version before it, and an old item reads with no bounces and no wait', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(raw, FLOW_SCHEMA_VERSION - 1);
  raw.exec(`INSERT INTO work_item_counters (project_id, last_number) VALUES ('p1', 1)`);
  raw.exec(
    `INSERT INTO work_items (id, project_id, number, type, title, description, status, priority, rank, created_at, updated_at)
     VALUES ('i1', 'p1', 1, 'task', 'Old', '', 'in_review', 'medium', 'm', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
  );
  raw.close();
  const db = new Db(config);
  const items = new WorkItemService({ db, project: () => ({ keyPrefix: 'AGN', columnLimits: {} }) });
  const old = items.find('i1');
  assert.deepEqual([old?.bounces, old?.waiting], [0, null]);
  items.setFlowState('i1', { waiting: 'approval' }, { actor: { kind: 'agent', role: 'qa' } });
  assert.equal(items.find('i1')?.waiting, 'approval');
  db.close();
});
