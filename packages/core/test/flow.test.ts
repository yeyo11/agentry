import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { flowRunStatus, type AgentryEvent, type AgentryLanguage, type FlowRunDocument, type FlowMemoryProposal, type ProjectModule, type ProjectSettings, type WorkItemStatus } from '@agentry/shared';
import { Db, FLOW_CAUSE_SCHEMA_VERSION, FLOW_SCHEMA_VERSION, migrate } from '../src/db.ts';
import { EventBus } from '../src/events.ts';
import { FlowError, flowResultSchema, flowTitle, FlowService, parseFlowRunQuery, parseResult, stageRules, testCommandRules, type FlowChatResult, type FlowLaunch, type FlowPullRequests } from '../src/flow.ts';
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

function setup(opts: { db?: Db; settings?: ProjectSettings; recover?: boolean; pullRequests?: FlowPullRequests } = {}) {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = opts.db ?? new Db(config);
  const bus = new EventBus();
  const events: AgentryEvent[] = [];
  bus.observe((e) => events.push(e));
  const state: { settings: ProjectSettings; language: AgentryLanguage } = { settings: opts.settings ?? settingsWith(), language: 'en' };
  const items = new WorkItemService({ db, project: (id) => (id === 'p1' ? { keyPrefix: 'AGN', columnLimits: {} } : null), emit: (e) => bus.emit(e) });
  const launches: FlowLaunch[] = [];
  const proposals: FlowMemoryProposal[] = [];
  const ties: FlowRunDocument[] = [];
  const stopped: string[] = [];
  const busy = new Set<string>();
  /** Chats whose account rotation is on its way, as the core would say */
  const rotating = new Set<string>();
  /** `resume`: only continuing a chat fails; `started`: the chat to continue is told of, then it fails */
  const failNext: { message: string | null; when?: 'resume' | 'started' } = { message: null };
  let chats = 0;
  const flow = new FlowService({
    db,
    items,
    project: (id) => (id === 'p1' ? { path: '/nowhere/p1', settings: state.settings } : null),
    handoff: () => '# Project journal',
    propose: (_id, proposal) => void proposals.push(proposal),
    tie: async (_item, doc) => void ties.push(doc),
    // As the core does: a chat to continue is told first, and one that cannot be continued fails
    // a run a restart cut off, or gives way to a chat of its own
    launch: async (launch, onStart) => {
      if (failNext.message && !failNext.when) throw new Error(failNext.message);
      launches.push(launch);
      if (launch.resumeChatId) {
        onStart(launch.resumeChatId);
        if (failNext.message && failNext.when === 'started') throw new Error(failNext.message);
        if (!failNext.message) return;
        if (launch.continuing) throw new Error(failNext.message);
      }
      onStart(`chat-${++chats}`);
    },
    chatBusy: (id) => busy.has(id),
    rotating: (id) => rotating.has(id),
    language: () => state.language,
    stop: (id) => void stopped.push(id),
    emit: (e) => bus.emit(e),
    ...(opts.pullRequests ? { pullRequests: opts.pullRequests } : {}),
  });
  bus.observe((e) => flow.observe(e));
  if (opts.recover !== false) flow.recover();
  const chatOf = (itemId: string): string => {
    const run = flow.runs('p1').find((r) => r.itemId === itemId && r.state === 'running');
    assert.ok(run?.chatId, 'a run is working on the item');
    return run.chatId;
  };
  /** Answers the item's running run with a structured result and lets the flow act on it. */
  const answer = async (itemId: string, output: Record<string, unknown>, isError = false, extra: Partial<FlowChatResult> = {}) => {
    await flow.settled();
    await flow.chatResult(chatOf(itemId), { isError, result: isError ? 'it broke' : '', structuredOutput: output, ...extra });
    await flow.settled();
  };
  const setModules = (modules: ProjectModule[]) => {
    state.settings = { ...state.settings, modules };
    bus.emit({ type: 'project.updated', title: '', projectId: 'p1', projectName: 'p', changes: ['modules'], modules });
  };
  return { db, file: join(config.dataDir, 'wrapper.db'), bus, events, state, items, flow, launches, proposals, ties, stopped, busy, rotating, failNext, answer, chatOf, setModules };
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
  assert.match(launch.prompt, /AGN-1 · Fix the cart/);
  // Refining reads, writes only in the documents folder, pushes nothing, and has no budget unless one is set
  assert.equal(launch.permissionMode, 'dontAsk');
  assert.ok(launch.allowedTools.includes('Write(docs/**)'));
  assert.ok(!launch.allowedTools.includes('Bash') && !launch.allowedTools.includes('WebFetch'));
  assert.ok(launch.disallowedTools.includes('Bash(git push *)'));
  assert.equal(launch.maxBudgetUsd, null);
  assert.equal(launch.inWorktree, false);
  assert.equal(launch.continuing, false);
  assert.equal(running(s)[0]?.itemId, it.id);
  assert.deepEqual(
    s.events.filter((e) => e.type === 'flow.run').map((e) => (e.type === 'flow.run' ? e.action : '')),
    ['queued', 'started'],
  );
});

test("a run's chat is titled in the person's language: the member's role, the item's key and its title", async () => {
  const s = setup();
  s.state.language = 'es';
  const cart = await item(s, 'backlog', 'Arreglar el carrito');
  const [first, ...rest] = s.launches[0]?.prompt.split('\n') ?? [];
  assert.equal(first, 'Product Owner · AGN-1 · Arreglar el carrito');
  // The instructions for Claude after it stay as they were
  assert.match(rest.join('\n'), /AGN-1 · Arreglar el carrito[^]*You are the Product Owner/);
  await item(s, 'in_progress', 'Guardar   las\nlíneas');
  assert.equal(s.launches.at(-1)?.prompt.split('\n')[0], 'Desarrollador · AGN-2 · Guardar las líneas');

  // Two runs at once by default: the third starts once the first ends, in the language it was queued in
  s.state.language = 'en';
  await item(s, 'in_review', 'Keep the lines');
  s.state.language = 'es';
  await s.answer(cart.id, ok('Refined'));
  assert.equal(s.launches.at(-1)?.prompt.split('\n')[0], 'QA · AGN-3 · Keep the lines');
  assert.equal(s.launches.at(-1)?.run.language, 'en');
  assert.equal(flowTitle({ key: 'AGN-4', title: 'x' }, 'developer', 'en'), 'Developer · AGN-4 · x');
  // A role of the person's own reads as they named it, in either language
  assert.equal(flowTitle({ key: 'AGN-5', title: 'y' }, 'data-steward', 'es'), 'Data Steward · AGN-5 · y');
  assert.equal(flowTitle({ key: 'AGN-6', title: 'z' }, 'architect', 'es'), 'Arquitecto · AGN-6 · z');
});

test('refining in backlog completes the item, comments, and moves it to todo, where it costs no second run', async () => {
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
  // The Product Owner has just refined it, and nothing changed since: the todo check would repeat it
  assert.equal(s.launches.length, 1);
  assert.equal(s.items.find(it.id)?.status, 'todo');
  assert.equal(running(s).length + queued(s).length, 0);
  assert.deepEqual(flowRuns(s).map((r) => [r.column, r.outcome]), [['backlog', 'passed']]);
});

/** Refining in backlog and todo only, so a card can be moved around without starting other roles */
function refineOnly(): ProjectSettings {
  const settings = settingsWith();
  return { ...settings, flow: { ...settings.flow!, columns: { backlog: 'product-owner', todo: 'product-owner' } } };
}

async function refined(s: Setup, title = 'Fix the cart') {
  const it = await item(s, 'backlog', title);
  await s.answer(it.id, ok('Refined', { description: 'Complete now' }));
  assert.equal(s.items.find(it.id)?.status, 'todo');
  assert.equal(s.launches.length, 1, 'the flow refined it once');
  return it;
}

/** A person takes the card out of todo and puts it back, which asks for the todo check */
async function backToTodo(s: Setup, itemId: string) {
  s.items.move(itemId, { status: 'in_progress' }, person);
  s.items.move(itemId, { status: 'todo' }, person);
  await s.flow.settled();
}

test('a refined card put back in todo with nothing changed starts no run; one changed since starts the check', async () => {
  const s = setup({ settings: refineOnly() });
  const it = await refined(s);
  await backToTodo(s, it.id);
  assert.equal(s.launches.length, 1, 'nothing changed, yet the check ran again');

  // A person's comment is something to check again
  s.items.comment(it.id, { body: 'It must also keep the coupon' }, person);
  await backToTodo(s, it.id);
  assert.equal(s.launches.length, 2);
  assert.equal(s.launches[1]?.run.column, 'todo');
  await s.answer(it.id, ok('Ready'));

  // That check passed: back in todo again, it has spoken for the item until something changes
  await backToTodo(s, it.id);
  assert.equal(s.launches.length, 2);
  s.items.update(it.id, { title: 'Fix the cart and the coupon' }, person);
  await backToTodo(s, it.id);
  assert.equal(s.launches.length, 3);
});

test("an edit a person makes while the Product Owner refines, or another member's comment, is something to check again", async () => {
  const s = setup({ settings: refineOnly() });
  const it = await item(s, 'backlog');
  s.items.update(it.id, { description: 'Mine, while it refines' }, person);
  await s.answer(it.id, ok('Refined', { description: 'Theirs' }));
  assert.equal(s.items.find(it.id)?.status, 'todo');
  assert.equal(s.launches.length, 2, 'the edit made while it refined was not checked');
  await s.answer(it.id, ok('Ready'));

  s.items.comment(it.id, { body: 'Blocked by the payment API' }, { actor: { kind: 'agent', role: 'developer' } });
  await backToTodo(s, it.id);
  assert.equal(s.launches.length, 3);
});

test('a card that goes to todo without a refine that passed is checked there', async () => {
  // Put straight into todo: nothing refined it
  const s = setup({ settings: refineOnly() });
  await item(s, 'todo');
  assert.equal(s.launches.length, 1);

  // A refine that failed spoke for nothing
  const failed = await item(s, 'backlog', 'Failed');
  await s.answer(failed.id, {}, true);
  s.items.move(failed.id, { status: 'todo' }, person);
  await s.flow.settled();
  assert.equal(s.launches.at(-1)?.run.column, 'todo');
  assert.equal(s.launches.at(-1)?.run.itemId, failed.id);

  // Another role checking todo is a second opinion the project asked for
  const settings = refineOnly();
  const other = setup({ settings: { ...settings, flow: { ...settings.flow!, columns: { backlog: 'product-owner', todo: 'qa' } } } });
  const it = await item(other, 'backlog');
  await other.answer(it.id, ok('Refined'));
  assert.deepEqual(other.launches.map((l) => [l.run.column, l.member.agent]), [
    ['backlog', 'product-owner'],
    ['todo', 'qa'],
  ]);
});

test('a todo check queued while the refine it would repeat was running is cancelled once that refine passes', async () => {
  const s = setup({ settings: refineOnly() });
  const it = await item(s, 'backlog');
  // A person drags it to todo mid-refine: the check waits for the refine, one run at a time
  s.items.move(it.id, { status: 'todo' }, person);
  await s.flow.settled();
  assert.equal(queued(s)[0]?.column, 'todo');
  await s.answer(it.id, ok('Refined', { acceptanceCriteria: ['Lines survive a reload'] }));
  assert.equal(s.launches.length, 1);
  assert.equal(queued(s).length + running(s).length, 0);
  const check = flowRuns(s).find((r) => r.column === 'todo');
  assert.deepEqual([check?.outcome, check?.error, check?.cause], ['cancelled', 'it was refined and has not changed since', 'refined']);
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
  // QA writes only in the documents folder: the rest is denied, not asked
  assert.equal(s.launches.at(-1)?.permissionMode, 'dontAsk');
  assert.ok(s.launches.at(-1)?.allowedTools.includes('Edit(docs/**)'));
  assert.ok(!s.launches.at(-1)?.allowedTools.includes('Edit'));
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
  assert.equal(flowRuns(s).find((r) => r.column === 'in_progress')?.cause, 'chat-busy');
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

test("a queued run keeps the person's language across a restart, so its chat is titled as it would have been", async () => {
  const first = setup({ settings: { ...settingsWith(), flow: { ...settingsWith().flow!, maxParallel: 1 } } });
  first.state.language = 'es';
  const a = await item(first, 'in_progress', 'A');
  const b = await item(first, 'in_progress', 'Guardar el carrito');
  assert.equal(queued(first)[0]?.language, 'es');

  // A restarted wrapper knows no language until the person's next request, so it would say English
  const second = setup({ db: first.db, settings: first.state.settings, recover: false });
  assert.equal(second.state.language, 'en');
  second.flow.recover();
  await second.answer(a.id, ok());
  const started = second.launches.find((l) => l.run.itemId === b.id);
  assert.equal(started?.prompt.split('\n')[0], 'Desarrollador · AGN-2 · Guardar el carrito');
  assert.equal(started?.run.language, 'es');
  assert.equal(second.flow.runs('p1').find((r) => r.itemId === b.id)?.language, 'es');
});

test('the work-links automation leaves a running flow chat to the flow', async () => {
  const s = setup();
  const it = await item(s, 'in_progress');
  assert.equal(s.flow.ownsChat(s.chatOf(it.id)), true);
  const chat = s.chatOf(it.id);
  await s.answer(it.id, ok());
  assert.equal(s.flow.ownsChat(chat), false);
});

test('each stage gets only its tools: refining and verifying write only documents, the web is for working, and git push never', () => {
  const extra = { documentsPath: 'docs', testCommands: ['Bash(pnpm run test)'] };
  const refine = stageRules('refine', undefined, extra);
  assert.equal(refine.permissionMode, 'dontAsk');
  assert.deepEqual(refine.allowedTools, ['Read', 'Glob', 'Grep', 'Edit(docs)', 'Write(docs)', 'NotebookEdit(docs)', 'Edit(docs/**)', 'Write(docs/**)', 'NotebookEdit(docs/**)']);

  const verify = stageRules('verify', ['src/'], extra);
  assert.equal(verify.permissionMode, 'dontAsk');
  for (const rule of ['Bash(git diff *)', 'Bash(pnpm run test)', 'Write(docs/**)']) assert.ok(verify.allowedTools.includes(rule), rule);
  // QA's writes are not a Developer's: it never edits the code it verifies
  assert.ok(!verify.allowedTools.some((r) => r.includes('src') || r === 'Bash' || r.startsWith('Web')));
  assert.ok(verify.disallowedTools.includes('Bash(git diff *--output*)'));

  const free = stageRules('work', undefined, extra);
  assert.equal(free.permissionMode, 'acceptEdits');
  for (const tool of ['Edit', 'Bash', 'WebFetch', 'WebSearch']) assert.ok(free.allowedTools.includes(tool), tool);

  const bounded = stageRules('work', ['docs/', './src/**/*.ts', 'a,b', '../up', 'x (y)'], { ...extra, documentsPath: 'notes' });
  assert.equal(bounded.permissionMode, 'dontAsk');
  assert.ok(!bounded.allowedTools.includes('Edit'));
  for (const rule of ['Edit(docs)', 'Edit(docs/**)', 'Write(docs/**)', 'Edit(src/**/*.ts)', 'Write(notes/**)']) assert.ok(bounded.allowedTools.includes(rule), rule);
  assert.ok(!bounded.allowedTools.some((r) => r.includes('a,b') || r.includes('..') || r.includes('(y)')));

  // A Product Owner who writes nothing still writes its specification, and nothing else
  const nothing = stageRules('work', [], extra);
  assert.deepEqual(nothing.allowedTools.filter((r) => r.startsWith('Edit')), ['Edit(docs)', 'Edit(docs/**)']);

  for (const rules of [refine, verify, free, bounded, nothing]) {
    assert.ok(rules.disallowedTools.includes('Bash(git push)') && rules.disallowedTools.includes('Bash(git push *)'));
  }
});

test("a member's commands bound the shell of the work stage: only those, none for an empty list, and the other stages keep theirs", () => {
  const extra = { documentsPath: 'docs', testCommands: ['Bash(pnpm run test)'] };
  const listed = stageRules('work', undefined, { ...extra, commands: ['pnpm test', 'pnpm *', 'a,b', 'x (y)'] });
  // Denied rather than asked: whatever is not on the list does not run
  assert.equal(listed.permissionMode, 'dontAsk');
  assert.ok(!listed.allowedTools.includes('Bash'));
  assert.deepEqual(listed.allowedTools.filter((r) => r.startsWith('Bash')), ['Bash(pnpm test)', 'Bash(pnpm *)']);
  // Edits stay as free as they were without writes, and the web as it was
  for (const tool of ['Edit', 'Write', 'WebFetch']) assert.ok(listed.allowedTools.includes(tool), tool);

  const none = stageRules('work', ['src/'], { ...extra, commands: [] });
  assert.equal(none.permissionMode, 'dontAsk');
  assert.ok(!none.allowedTools.some((r) => r.startsWith('Bash')));
  assert.ok(none.allowedTools.includes('Edit(src/**)'));

  // No list is the shell whole, as before
  assert.ok(stageRules('work', undefined, extra).allowedTools.includes('Bash'));
  // Refining and verifying never take the member's list: their own sets hold
  assert.ok(!stageRules('refine', undefined, { ...extra, commands: ['rm *'] }).allowedTools.some((r) => r.startsWith('Bash')));
  assert.ok(!stageRules('verify', undefined, { ...extra, commands: ['rm *'] }).allowedTools.includes('Bash(rm *)'));
  for (const rules of [listed, none]) assert.ok(rules.disallowedTools.includes('Bash(git push *)'));
});

test("a member's commands reach the work run it is launched with", async () => {
  const settings = settingsWith();
  settings.team = { members: settings.team!.members.map((m) => (m.agent === 'developer' ? { ...m, commands: ['npm test'] } : m)) };
  const s = setup({ settings });
  await item(s, 'in_progress');
  const launch = s.launches.at(-1);
  assert.equal(launch?.run.stage, 'work');
  assert.equal(launch?.permissionMode, 'dontAsk');
  assert.deepEqual(launch?.allowedTools.filter((r) => r.startsWith('Bash')), ['Bash(npm test)']);
});

test('the test commands a project declares are the only commands verifying may run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-flow-tests-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', 'test:unit': 'x', typecheck: 'tsc', deploy: 'rm -rf /', 'bad name': 'x', build: 'tsc' } }));
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  writeFileSync(join(dir, 'Makefile'), 'build:\n\ttrue\ntest:\n\ttrue\n');
  const rules = testCommandRules(dir);
  for (const rule of ['Bash(pnpm run test)', 'Bash(pnpm test)', 'Bash(pnpm run test:unit *)', 'Bash(pnpm run typecheck)', 'Bash(make test)']) assert.ok(rules.includes(rule), rule);
  assert.ok(!rules.some((r) => r.includes('deploy') || r.includes('build') || r.includes('bad')));
  assert.deepEqual(testCommandRules(join(dir, 'missing')), []);
});

test('every run is held to the budget the project sets, when it sets one', async () => {
  const s = setup({ settings: { ...settingsWith(), flow: { ...settingsWith().flow!, maxCostUsd: 0.5 } } });
  const it = await item(s, 'in_progress');
  assert.equal(s.launches[0]?.maxBudgetUsd, 0.5);
  assert.equal(s.launches[0]?.inWorktree, true);
  await s.answer(it.id, {}, true, { cause: 'budget', result: 'budget reached' });
  assert.match(flowRuns(s).at(-1)?.error ?? '', /budget of 0.5 USD/);
  assert.equal(flowRuns(s).at(-1)?.cause, 'budget');
});

test("a Developer's run never continues a person's own work chat, only the Developer's chat of an earlier round", async () => {
  const s = setup();
  const it = s.items.create('p1', { title: 'Mine', status: 'todo' });
  // The person's "Work on it" chat, idle now
  s.items.link(it.id, { kind: 'chat', role: 'work', chatId: 'person-chat' });
  s.items.move(it.id, { status: 'in_progress' }, person);
  await s.flow.settled();
  assert.equal(s.launches.at(-1)?.resumeChatId, null);
  const own = s.chatOf(it.id);
  assert.notEqual(own, 'person-chat');
  await s.answer(it.id, ok('Implemented'));
  await s.answer(it.id, ok('Missing a test', { verdict: 'fail' }));
  assert.equal(s.launches.at(-1)?.resumeChatId, own);
});

test('a failed run says why on its item, as its member', async () => {
  const s = setup();
  const it = await item(s, 'in_progress');
  await s.answer(it.id, {}, true);
  const comment = s.items.comments(it.id).at(-1);
  assert.deepEqual(comment?.author, { kind: 'agent', role: 'developer' });
  assert.match(comment?.body ?? '', /work run failed and moved nothing: it broke/);
  assert.equal(flowRuns(s).at(-1)?.error, 'it broke');
  // A cancelled run is a person's doing, not a failure: nothing is written
  s.items.move(it.id, { status: 'todo' }, person);
  await s.flow.settled();
  const before = s.items.comments(it.id).length;
  s.items.move(it.id, { status: 'in_review' }, person);
  s.items.move(it.id, { status: 'in_progress' }, person);
  await s.flow.settled();
  assert.equal(s.items.comments(it.id).length, before);
});

test('removing an item stops the run working on it', async () => {
  const s = setup();
  const it = await item(s, 'in_progress');
  const chat = s.chatOf(it.id);
  s.items.remove(it.id, person);
  await s.flow.settled();
  assert.deepEqual(s.stopped, [chat]);
  assert.equal(flowRuns(s).at(-1)?.outcome, 'cancelled');
});

test('QA judges each criterion: a met one is checked as QA, and one left unmet sends the item back whatever the verdict', async () => {
  const s = setup();
  const it = s.items.create('p1', { title: 'Cart', status: 'todo', acceptanceCriteria: [{ text: 'Lines survive a reload' }, { text: 'Totals in cents' }] });
  const [first, second] = it.acceptanceCriteria;
  assert.ok(first && second);
  s.items.move(it.id, { status: 'in_progress' }, person);
  await s.flow.settled();
  await s.answer(it.id, ok('Implemented'));
  const prompt = s.launches.at(-1)?.prompt ?? '';
  assert.match(prompt, new RegExp(`\`${first.id}\`: Lines survive a reload`));
  assert.deepEqual(s.launches.at(-1)?.jsonSchema, flowResultSchema('verify'));

  await s.answer(it.id, ok('All good', { verdict: 'pass', criteria: [{ id: first.id, met: true, note: 'reloaded twice' }] }));
  const back = s.items.find(it.id);
  assert.equal(back?.status, 'in_progress');
  assert.equal(flowRuns(s).filter((r) => r.stage === 'verify').at(-1)?.outcome, 'rejected');
  assert.deepEqual(back?.acceptanceCriteria.map((c) => [c.checked, c.checkedBy]), [
    [true, { kind: 'agent', role: 'qa' }],
    [false, null],
  ]);
  const comment = s.items.comments(it.id).find((c) => c.author.role === 'qa');
  assert.match(comment?.body ?? '', /- \[x\] Lines survive a reload — reloaded twice\n- \[ \] Totals in cents — not judged/);

  await s.answer(it.id, ok('Fixed'));
  await s.answer(it.id, ok('Both hold', { verdict: 'pass', criteria: [{ id: first.id, met: true, note: '' }, { id: second.id, met: true, note: 'checked' }] }));
  const passed = s.items.find(it.id);
  assert.equal(passed?.waiting, 'approval');
  assert.ok(passed?.acceptanceCriteria.every((c) => c.checked && c.checkedBy?.role === 'qa'));
});

test('a restart continues a cut-off run in its own chat at most twice, keeping when it started, and a chat that cannot be continued fails it', async () => {
  const first = setup();
  const it = await item(first, 'in_progress');
  const chat = first.chatOf(it.id);
  const startedAt = flowRuns(first)[0]?.startedAt;
  let db = first.db;
  for (const restart of [1, 2]) {
    const next = setup({ db, settings: first.state.settings, recover: false });
    await new Promise((r) => setTimeout(r, 5));
    next.flow.recover();
    await next.flow.settled();
    const run = flowRuns(next)[0];
    assert.equal(run?.restarts, restart);
    assert.equal(run?.startedAt, startedAt);
    assert.equal(next.launches[0]?.continuing, true);
    assert.equal(next.launches[0]?.resumeChatId, chat);
    db = next.db;
  }
  const third = setup({ db, settings: first.state.settings, recover: false });
  third.flow.recover();
  await third.flow.settled();
  assert.equal(third.launches.length, 0);
  assert.equal(flowRuns(third)[0]?.outcome, 'failed');
  assert.equal(flowRuns(third)[0]?.cause, 'restarts');
  assert.match(third.items.comments(it.id).at(-1)?.body ?? '', /restarted 3 times/);

  // Cut off once more, and its chat is gone: the run fails, and no chat without context starts
  const other = setup();
  const lost = await item(other, 'in_progress');
  const again = setup({ db: other.db, settings: other.state.settings, recover: false });
  again.failNext.message = 'chat not found';
  again.failNext.when = 'resume';
  again.flow.recover();
  await again.flow.settled();
  assert.equal(again.launches.length, 1);
  assert.equal(flowRuns(again)[0]?.outcome, 'failed');
  assert.match(flowRuns(again)[0]?.error ?? '', /could not be continued after a restart: chat not found/);
  assert.equal(flowRuns(again)[0]?.cause, 'not-continued');
  assert.match(again.items.comments(lost.id).at(-1)?.body ?? '', /could not be continued after a restart/);
});

test('a run held back by the runtime limit while continuing a chat keeps the chat it had', async () => {
  const s = setup();
  const it = await item(s, 'in_progress');
  await s.answer(it.id, ok('Implemented'));
  s.failNext.message = 'Concurrent run limit reached (8)';
  s.failNext.when = 'started';
  await s.answer(it.id, ok('No', { verdict: 'fail' }));
  // The Developer's resume hit the limit: queued again, with no chat, so it starts afresh later
  const waiting = queued(s)[0];
  assert.equal(waiting?.chatId, null);
  assert.equal(waiting?.startedAt, null);
  s.failNext.message = null;
  s.failNext.when = undefined;
  s.flow.dispatch();
  await s.flow.settled();
  assert.equal(s.launches.at(-1)?.continuing, false);
  assert.match(s.launches.at(-1)?.prompt ?? '', /Verification sent it back/);
});

test('the cap holds against another process claiming at the same moment', async () => {
  // Queued before the other process takes the lock, and dispatched while it holds it
  const s = setup({ settings: { ...settingsWith(), flow: { ...settingsWith().flow!, maxParallel: 1 } }, recover: false });
  await item(s, 'in_progress');
  const { file } = s;
  // Another process takes the last place: its claim is written, but not committed yet
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(
    `const { workerData } = require('node:worker_threads');
     const { DatabaseSync } = require('node:sqlite');
     const db = new DatabaseSync(workerData.file);
     db.exec('BEGIN IMMEDIATE');
     db.prepare("INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, queued_at, started_at) VALUES ('other', 'p1', 'elsewhere', 'developer', 'developer', 'sonnet', 'work', 'in_progress', 'running', '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z')").run();
     Atomics.store(workerData.signal, 0, 1);
     Atomics.notify(workerData.signal, 0);
     Atomics.wait(workerData.signal, 0, 1, 300);
     db.exec('COMMIT');
     db.close();`,
    { eval: true, workerData: { file, signal } },
  );
  Atomics.wait(signal, 0, 0, 5000);
  s.flow.recover();
  await s.flow.settled();
  await new Promise((r) => worker.once('exit', r));
  assert.equal(running(s).length, 1, 'two runs hold one place');
  assert.equal(queued(s).length, 1);
});

const RATE_LIMITED: Partial<FlowChatResult> = { cause: 'rate-limit' };

test('a run that hits the rate limit waits for the rotation and goes on in the same chat on the next account', async () => {
  const s = setup();
  const it = await item(s, 'in_progress');
  const chat = s.chatOf(it.id);
  s.rotating.add(chat);
  await s.answer(it.id, {}, true, RATE_LIMITED);
  // Neither the limit's result nor the process it took down ends the run
  s.flow.chatEnded(chat, 'exit code 1');
  assert.equal(running(s)[0]?.chatId, chat);
  assert.equal(s.flow.awaitsRotation(chat), true);
  assert.equal(s.items.comments(it.id).length, 0);
  s.rotating.delete(chat);
  s.flow.rotated(chat, { resumed: true });
  assert.equal(s.flow.awaitsRotation(chat), false);
  // The replayed turn answers in the same chat, and the run ends as any other: no second run, no second chat
  await s.answer(it.id, ok('Implemented'));
  assert.equal(s.items.find(it.id)?.status, 'in_review');
  assert.deepEqual(
    flowRuns(s)
      .filter((r) => r.stage === 'work')
      .map((r) => [r.chatId, r.outcome]),
    [[chat, 'passed']],
  );
  assert.equal(s.launches.filter((l) => l.run.stage === 'work').length, 1);
});

test('a rate limit fails the run when no account is left, when the rotation is off, and never waits for another error', async () => {
  // No account left to take it over: the rotation says so, and the run fails with the reason
  const s = setup();
  const a = await item(s, 'in_progress', 'A');
  const chat = s.chatOf(a.id);
  s.rotating.add(chat);
  await s.answer(a.id, {}, true, RATE_LIMITED);
  s.rotating.delete(chat);
  s.flow.rotated(chat, { resumed: false, reason: 'no account with quota left' });
  await s.flow.settled();
  const failed = flowRuns(s).find((r) => r.itemId === a.id);
  assert.equal(failed?.outcome, 'failed');
  assert.match(failed?.error ?? '', /rate limit and no other account could take the run over \(no account with quota left\)/);
  assert.equal(failed?.cause, 'no-account');
  assert.match(s.items.comments(a.id).at(-1)?.body ?? '', /failed and moved nothing/);
  assert.equal(s.items.find(a.id)?.status, 'in_progress');

  // The rotation off (or nothing left to try): it fails at once, as before
  const b = await item(s, 'in_progress', 'B');
  await s.answer(b.id, {}, true, RATE_LIMITED);
  assert.equal(flowRuns(s).find((r) => r.itemId === b.id)?.outcome, 'failed');
  assert.equal(flowRuns(s).find((r) => r.itemId === b.id)?.cause, 'rate-limit');

  // Any other error fails it at once, rotation or not
  const c = await item(s, 'in_progress', 'C');
  s.rotating.add(s.chatOf(c.id));
  await s.answer(c.id, {}, true);
  assert.equal(flowRuns(s).find((r) => r.itemId === c.id)?.outcome, 'failed');

  // A process the limit took down before any result waits the same way, then fails with the rotation
  const d = await item(s, 'in_progress', 'D');
  const dChat = s.chatOf(d.id);
  s.rotating.add(dChat);
  s.flow.chatEnded(dChat, 'rate limit');
  assert.equal(running(s).find((r) => r.itemId === d.id)?.chatId, dChat);
  s.rotating.delete(dChat);
  s.flow.rotated(dChat, { resumed: false });
  assert.equal(flowRuns(s).find((r) => r.itemId === d.id)?.outcome, 'failed');
  // A rotation heard for a chat nobody waits on changes nothing
  s.flow.rotated('chat-unknown', { resumed: false });
});

test('a run stopped while it waits for the rotation is not replayed afterwards', async () => {
  const s = setup();
  const it = await item(s, 'in_progress');
  const chat = s.chatOf(it.id);
  s.rotating.add(chat);
  await s.answer(it.id, {}, true, RATE_LIMITED);
  s.setModules(['board', 'memory']);
  await s.flow.settled();
  assert.equal(flowRuns(s)[0]?.outcome, 'cancelled');
  // The core asks before it replays the turn: nobody waits on this chat any more
  assert.equal(s.flow.awaitsRotation(chat), false);
  s.flow.rotated(chat, { resumed: true });
  assert.equal(flowRuns(s)[0]?.outcome, 'cancelled');
});

test("an item's runs are all served, newest first, so an older failed run still reads as failed", async () => {
  const s = setup();
  const it = await item(s, 'in_progress');
  await s.answer(it.id, {}, true);
  s.items.move(it.id, { status: 'in_review' }, person);
  await s.flow.settled();
  await s.answer(it.id, ok('Holds', { verdict: 'pass', criteria: [] }));
  const other = await item(s, 'backlog', 'Another');
  const runs = s.flow.itemRuns(it.id);
  assert.deepEqual(
    runs.map((r) => [r.stage, flowRunStatus(r)]),
    [
      ['verify', 'passed'],
      ['work', 'failed'],
    ],
  );
  assert.equal(runs.at(-1)?.error, 'it broke');
  assert.ok(runs.every((r) => r.itemId === it.id));
  assert.equal(s.flow.itemRuns(other.id).length, 1);
  assert.deepEqual(s.flow.itemRuns('nope'), []);
});

test("the team's activity pages every run of the project, newest first, by member, state and item", async () => {
  const s = setup();
  const a = await item(s, 'in_progress', 'A');
  await s.answer(a.id, {}, true);
  const b = await item(s, 'backlog', 'B');
  const c = await item(s, 'backlog', 'C');
  // a's work failed; b's refine runs; c's refine waits for a place (two at most by default)
  const all = s.flow.page('p1');
  assert.equal(all.total, s.flow.runs('p1').length);
  assert.deepEqual(all.runs.map((r) => r.queuedAt), [...all.runs.map((r) => r.queuedAt)].sort().reverse());
  assert.deepEqual(s.flow.page('p1', { status: ['failed'] }).runs.map((r) => [r.itemId, r.stage]), [[a.id, 'work']]);
  assert.deepEqual(s.flow.page('p1', { agent: ['product-owner'] }).runs.map((r) => r.itemId).sort(), [b.id, c.id].sort());
  assert.deepEqual(s.flow.page('p1', { itemId: c.id }).runs.length, 1);
  assert.equal(s.flow.page('p1', { status: ['running', 'queued'] }).total, s.flow.runs('p1').filter((r) => r.state !== 'ended').length);

  // Paged by a cursor that a run queued meanwhile does not shift
  const first = s.flow.page('p1', { limit: 2 });
  assert.equal(first.runs.length, 2);
  assert.ok(first.nextCursor);
  await item(s, 'backlog', 'D');
  const rest = s.flow.page('p1', { limit: 2, cursor: first.nextCursor });
  assert.deepEqual([...first.runs, ...rest.runs].map((r) => r.id), all.runs.map((r) => r.id));
  assert.equal(rest.nextCursor, null);
  assert.equal(s.flow.page('p2').total, 0);
});

test('the query of the activity is checked', () => {
  assert.deepEqual(parseFlowRunQuery({ agent: 'qa,developer, qa', status: 'failed,running', limit: '10', itemId: 'i1' }), {
    agent: ['qa', 'developer'],
    status: ['failed', 'running'],
    limit: 10,
    itemId: 'i1',
  });
  assert.deepEqual(parseFlowRunQuery({}), {});
  // The Team activity's names: members by role, `outcome` for `status`, and a moment to page back from
  assert.deepEqual(parseFlowRunQuery({ role: 'qa', outcome: 'failed', status: 'failed,passed', before: '2026-09-28T10:00:00Z', limit: '50' }), {
    role: ['qa'],
    status: ['failed', 'passed'],
    before: '2026-09-28T10:00:00.000Z',
    limit: 50,
  });
  for (const bad of [{ status: 'ended' }, { outcome: 'ended' }, { limit: '0' }, { limit: '2.5' }, { limit: '201' }, { cursor: 'abc' }, { before: 'yesterday' }]) {
    assert.throws(() => parseFlowRunQuery(bad), (err: unknown) => err instanceof FlowError && err.statusCode === 400, JSON.stringify(bad));
  }
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
    criteria: [],
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

test('a card is live while a Product Owner refines it or QA verifies it, as while a chat works on it; an origin chat or a document is not', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const working = new Set(['po', 'qa', 'origin', 'spec']);
  const items = new WorkItemService({
    db,
    project: () => ({ keyPrefix: 'AGN', columnLimits: {} }),
    linkState: (link) => ({ name: link.chatId, chatState: link.chatId && working.has(link.chatId) ? 'working' : 'idle' }),
  });
  const refined = items.create('p1', { title: 'Refined' });
  items.link(refined.id, { kind: 'chat', role: 'origin', chatId: 'origin' });
  items.link(refined.id, { kind: 'document', role: 'refine', chatId: 'spec', documentPath: 'docs/spec.md' });
  assert.equal(items.find(refined.id)?.activeLink, null, 'an origin chat or a document made the card live');
  items.link(refined.id, { kind: 'chat', role: 'refine', chatId: 'po' }, { actor: { kind: 'agent', role: 'product-owner' } });
  assert.equal(items.find(refined.id)?.activeLink?.chatId, 'po');
  assert.equal(items.find(refined.id)?.activeLink?.role, 'refine');

  const verified = items.create('p1', { title: 'Verified', status: 'in_review' });
  items.link(verified.id, { kind: 'chat', role: 'verify', chatId: 'qa' });
  assert.equal(items.find(verified.id)?.activeLink?.chatId, 'qa');
  // Once QA's chat is idle the card is still again
  working.delete('qa');
  assert.equal(items.find(verified.id)?.activeLink, null);
  db.close();
});

test('every failed run carries the cause the panel words, beside the raw error', async () => {
  const s = setup();
  const last = (itemId: string) => s.flow.itemRuns(itemId)[0];
  const a = await item(s, 'in_progress', 'A');
  await s.answer(a.id, {}, true);
  assert.deepEqual([last(a.id)?.cause, last(a.id)?.error], ['chat-failed', 'it broke']);
  const b = await item(s, 'in_progress', 'B');
  await s.answer(b.id, {}, true, { cause: 'stopped' });
  assert.deepEqual([last(b.id)?.cause, last(b.id)?.error], ['stopped', 'its chat was stopped']);
  const c = await item(s, 'in_progress', 'C');
  await s.answer(c.id, { nothing: true });
  assert.equal(last(c.id)?.cause, 'unreadable');
  const d = await item(s, 'in_review', 'D');
  await s.answer(d.id, ok('Looks fine'));
  assert.equal(last(d.id)?.cause, 'no-verdict');
  const e = await item(s, 'in_progress', 'E');
  s.flow.chatEnded(s.chatOf(e.id), null);
  assert.deepEqual([last(e.id)?.cause, last(e.id)?.error], ['chat-ended', 'the chat ended without a result']);
  const f = await item(s, 'in_progress', 'F');
  s.flow.chatEnded(s.chatOf(f.id), 'killed');
  assert.equal(last(f.id)?.cause, 'chat-failed');
  s.failNext.message = 'the agent file .claude/agents/developer.md is missing';
  const g = await item(s, 'in_progress', 'G');
  s.failNext.message = null;
  assert.deepEqual([last(g.id)?.outcome, last(g.id)?.cause], ['failed', 'not-started']);
  // A run still going or one that passed has no cause
  const h = await item(s, 'in_progress', 'H');
  assert.equal(last(h.id)?.cause, null);
  await s.answer(h.id, ok());
  assert.equal(s.flow.itemRuns(h.id).find((r) => r.stage === 'work')?.cause, null);
  // The feed carries it, so a client that keeps the run from the event can word it
  const ended = s.events.filter((ev) => ev.type === 'flow.run' && ev.action === 'ended' && ev.itemId === a.id).at(-1);
  assert.equal(ended?.type === 'flow.run' ? ended.cause : undefined, 'chat-failed');
});

test('every cancelled run carries why: the item moved on, was done or removed, or the flow went off', async () => {
  const s = setup({ settings: { ...settingsWith(), flow: { ...settingsWith().flow!, maxParallel: 1 } } });
  const cause = (itemId: string, column: WorkItemStatus) => s.flow.itemRuns(itemId).find((r) => r.column === column)?.cause;
  const a = await item(s, 'in_progress', 'A');
  const b = await item(s, 'in_progress', 'B');
  // b waits behind a; a person moving it to todo puts the todo check in its place
  s.items.move(b.id, { status: 'todo' }, person);
  await s.flow.settled();
  assert.equal(cause(b.id, 'in_progress'), 'replaced');
  s.items.move(b.id, { status: 'done' }, person);
  await s.flow.settled();
  assert.equal(cause(b.id, 'todo'), 'item-done');
  const c = await item(s, 'in_progress', 'C');
  s.items.remove(c.id, person);
  await s.flow.settled();
  assert.equal(cause(c.id, 'in_progress'), 'item-removed');
  const d = await item(s, 'in_progress', 'D');
  // A column nobody answers for: the queued run is moot
  const { backlog: _backlog, ...columns } = s.state.settings.flow!.columns;
  s.state.settings = { ...s.state.settings, flow: { ...s.state.settings.flow!, columns } };
  s.items.move(d.id, { status: 'backlog' }, person);
  await s.flow.settled();
  assert.equal(cause(d.id, 'in_progress'), 'item-moved');
  const e = await item(s, 'in_progress', 'E');
  s.setModules(['board']);
  await s.flow.settled();
  assert.deepEqual([cause(a.id, 'in_progress'), cause(e.id, 'in_progress')], ['flow-off', 'flow-off']);
});

test("the Product Owner's refine is named by its column: refining in backlog, checking in todo", async () => {
  const s = setup();
  const refining = await item(s, 'backlog', 'Refine me');
  const checking = await item(s, 'todo', 'Check me');
  assert.deepEqual(
    [s.flow.itemRuns(refining.id)[0]?.step, s.flow.itemRuns(checking.id)[0]?.step],
    ['refine', 'check'],
  );
  assert.deepEqual(s.flow.itemRuns(checking.id).map((r) => r.stage), ['refine']);
  await s.answer(checking.id, {}, true);
  assert.match(s.items.comments(checking.id).at(-1)?.body ?? '', /^This check run failed and moved nothing/);
  const work = await item(s, 'in_progress', 'Work');
  const verify = await item(s, 'in_review', 'Verify');
  assert.equal(s.flow.itemRuns(work.id)[0]?.step, 'work');
  assert.equal(s.flow.itemRuns(verify.id)[0]?.step, 'verify');
  const queuedEvent = s.events.find((ev) => ev.type === 'flow.run' && ev.itemId === checking.id);
  assert.equal(queuedEvent?.type === 'flow.run' ? queuedEvent.step : undefined, 'check');
});

test("a person's retry queues the failed step again, once, while the item is still in the run's column", async () => {
  const s = setup({ settings: { ...settingsWith(), flow: { ...settingsWith().flow!, maxBounces: 1 } } });
  const it = await item(s, 'in_review');
  // QA's first verification sends it back once; the Developer's rework passes; QA's second fails
  await s.answer(it.id, ok('No', { verdict: 'fail' }));
  await s.answer(it.id, ok('Fixed'));
  assert.equal(s.items.find(it.id)?.bounces, 1);
  await s.answer(it.id, {}, true);
  const failed = s.flow.itemRuns(it.id)[0];
  assert.ok(failed);
  assert.deepEqual([failed.stage, failed.outcome, failed.retryable, failed.retriedBy], ['verify', 'failed', true, null]);
  // Only a failed run: a passed or rejected one is not retried
  const rejected = s.flow.itemRuns(it.id).find((r) => r.outcome === 'rejected');
  assert.ok(rejected);
  assert.equal(rejected.retryable, false);
  assert.throws(() => s.flow.retry(rejected.id), (err: unknown) => err instanceof FlowError && err.statusCode === 409);
  assert.throws(() => s.flow.retry('nope'), (err: unknown) => err instanceof FlowError && err.statusCode === 404);

  const retry = s.flow.retry(failed.id);
  await s.flow.settled();
  assert.equal(retry.retryOf, failed.id);
  assert.deepEqual([retry.stage, retry.column, retry.agent], ['verify', 'in_review', 'qa']);
  assert.equal(running(s)[0]?.id, retry.id, 'the retry started');
  // It counts as a person's move: a new round, with the bounces of the old one forgotten
  assert.equal(s.items.find(it.id)?.bounces, 0);
  const after = s.flow.run(failed.id);
  assert.deepEqual([after?.retriedBy?.id, after?.retriedBy?.state, after?.retryable], [retry.id, 'running', false]);
  // Once: the step has run again
  assert.throws(() => s.flow.retry(failed.id), (err: unknown) => err instanceof FlowError && err.statusCode === 409 && /retried already/.test(err.message));
  const queuedEvent = s.events.find((ev) => ev.type === 'flow.run' && ev.runId === retry.id && ev.action === 'queued');
  assert.equal(queuedEvent?.type === 'flow.run' ? queuedEvent.retryOf : undefined, failed.id);

  // The retry passes: the failed run now says what the step did next, and links its chat
  await s.answer(it.id, ok('Holds', { verdict: 'pass', criteria: [] }));
  const done = s.flow.run(failed.id)?.retriedBy;
  assert.deepEqual([done?.outcome, done?.chatId], ['passed', s.flow.run(retry.id)?.chatId]);
});

test('a retry is refused once the item left the column, with the flow off, or on a run the step ran again after', async () => {
  const s = setup();
  const it = await item(s, 'in_progress');
  await s.answer(it.id, {}, true);
  const failed = s.flow.itemRuns(it.id)[0];
  assert.ok(failed?.retryable);
  s.setModules(['board']);
  assert.equal(s.flow.run(failed.id)?.retryable, false);
  assert.throws(() => s.flow.retry(failed.id), (err: unknown) => err instanceof FlowError && err.statusCode === 409 && /flow is off/.test(err.message));
  s.setModules(['board', 'team', 'memory', 'documents']);
  s.items.move(it.id, { status: 'todo' }, person);
  await s.flow.settled();
  assert.equal(s.flow.run(failed.id)?.retryable, false);
  assert.throws(() => s.flow.retry(failed.id), (err: unknown) => err instanceof FlowError && err.statusCode === 409 && /left in_progress/.test(err.message));

  // A card that entered the column again ran the step anew: the failed run points at that run
  const other = await item(s, 'in_progress', 'Other');
  await s.answer(other.id, {}, true);
  const first = s.flow.itemRuns(other.id)[0];
  s.items.move(other.id, { status: 'todo' }, person);
  s.items.move(other.id, { status: 'in_progress' }, person);
  await s.flow.settled();
  const next = s.flow.run(first?.id ?? '');
  assert.equal(next?.retriedBy?.id, s.flow.itemRuns(other.id)[0]?.id);
  assert.equal(next?.retryable, false);
  assert.equal(s.flow.itemRuns(other.id)[0]?.retryOf, null);
});

test('a failed todo check is retried as a check, by the Product Owner', async () => {
  const s = setup({ settings: refineOnly() });
  const it = await item(s, 'todo');
  await s.answer(it.id, {}, true);
  const failed = s.flow.itemRuns(it.id)[0];
  assert.equal(failed?.step, 'check');
  s.flow.retry(failed?.id ?? '');
  await s.flow.settled();
  assert.deepEqual([running(s)[0]?.retryOf, running(s)[0]?.step, running(s)[0]?.agent], [failed?.id, 'check', 'product-owner']);
  assert.equal(s.launches.length, 2);
});

test("the team's activity filters by role and pages back from a moment", async () => {
  const s = setup();
  const a = await item(s, 'in_progress', 'A');
  await s.answer(a.id, {}, true);
  await new Promise((r) => setTimeout(r, 5));
  const cut = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  const b = await item(s, 'backlog', 'B');
  assert.deepEqual(s.flow.page('p1', { role: ['developer'] }).runs.map((r) => r.itemId), [a.id]);
  assert.deepEqual(s.flow.page('p1', { role: ['product-owner', 'developer'] }).total, 2);
  assert.deepEqual(s.flow.page('p1', { before: cut }).runs.map((r) => r.itemId), [a.id]);
  assert.deepEqual(s.flow.page('p1', { role: ['product-owner'], before: cut }).total, 0);
  assert.ok(s.flow.page('p1').runs.some((r) => r.itemId === b.id));
});

test('a run ended before causes were kept reads its cause from its error, after the migration', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(raw, FLOW_CAUSE_SCHEMA_VERSION - 1);
  const insert = raw.prepare(
    `INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, outcome, error, queued_at)
     VALUES (?, 'p1', ?, 'qa', 'qa', 'sonnet', 'verify', 'in_review', 'ended', ?, ?, ?)`,
  );
  const rows: Array<[string, string, string | null]> = [
    ['budget', 'failed', 'it reached its budget of 1 USD (flow.maxCostUsd)'],
    ['account', 'failed', 'the account hit its rate limit and no other account could take the run over'],
    ['restarts', 'failed', 'Agentry restarted 3 times while this run worked; move the item again to start it over'],
    ['unreadable', 'failed', 'the run ended without a readable structured result'],
    ['cli', 'failed', 'Error: something the CLI said'],
    ['removed', 'cancelled', 'the item was removed'],
    ['other', 'cancelled', 'something else'],
    ['passed', 'passed', null],
  ];
  rows.forEach(([id, outcome, error], i) => insert.run(id, `i-${id}`, outcome, error, `2026-09-01T00:00:0${i}.000Z`));
  raw.close();
  const s = setup({ db: new Db(config) });
  const causes = Object.fromEntries(rows.map(([id]) => [id, s.flow.run(id)?.cause]));
  assert.deepEqual(causes, {
    budget: 'budget',
    account: 'no-account',
    restarts: 'restarts',
    unreadable: 'unreadable',
    cli: 'chat-failed',
    removed: 'item-removed',
    other: null,
    passed: null,
  });
  assert.equal(s.flow.run('budget')?.retryOf, null);
});

// ---------- the cards waiting when the flow is switched on ----------

/** The flow's settings changed as a save does: the flow hears `project.updated` with `settings`. */
function setFlow(s: Setup, flow: Partial<NonNullable<ProjectSettings['flow']>>) {
  s.state.settings = { ...s.state.settings, flow: { ...s.state.settings.flow!, ...flow } };
  s.bus.emit({ type: 'project.updated', title: '', projectId: 'p1', projectName: 'p', changes: ['settings'], modules: s.state.settings.modules });
}

function flowOff(flow: Partial<NonNullable<ProjectSettings['flow']>> = {}): ProjectSettings {
  const settings = settingsWith();
  return { ...settings, flow: { ...settings.flow!, enabled: false, ...flow } };
}

async function card(s: Setup, status: WorkItemStatus, title: string, type: 'task' | 'epic' = 'task') {
  const created = s.items.create('p1', { title, status, type });
  await s.flow.settled();
  return created;
}

test('switching the flow on starts nothing, and counts the waiting cards per column, leaving out epics, done and columns nobody answers for', async () => {
  const s = setup({ settings: flowOff({ columns: { backlog: 'product-owner', todo: 'product-owner', in_progress: 'developer', in_review: 'architect' } }) });
  await card(s, 'backlog', 'One');
  await card(s, 'backlog', 'Two');
  await card(s, 'backlog', 'The epic', 'epic');
  await card(s, 'in_progress', 'Three');
  // No member plays the architect: in review waits for nobody
  await card(s, 'in_review', 'Four');
  await card(s, 'done', 'Five');
  assert.deepEqual(s.flow.waiting('p1'), { total: 0, columns: [] }, 'nothing waits for a flow that is off');

  setFlow(s, { enabled: true });
  await s.flow.settled();
  assert.equal(s.launches.length, 0, 'switching it on is not a card entering a column');
  assert.deepEqual(s.flow.waiting('p1'), {
    total: 3,
    columns: [
      { column: 'backlog', role: 'product-owner', count: 2 },
      { column: 'in_progress', role: 'developer', count: 1 },
    ],
  });

  s.setModules(['board', 'memory']);
  assert.deepEqual(s.flow.waiting('p1'), { total: 0, columns: [] }, 'nothing waits with the Team module off');
  assert.equal(s.flow.waiting('p2').total, 0, 'nor in a project the flow does not know');
});

test('starting the waiting cards queues one run each as a person, in board order then rank, and says how many start now', async () => {
  const s = setup({ settings: flowOff({ maxParallel: 2 }) });
  const working = await card(s, 'in_progress', 'Working');
  const first = await card(s, 'backlog', 'First');
  const second = await card(s, 'backlog', 'Second');
  const ready = await card(s, 'todo', 'Ready');
  // The person put Second above First on the board
  s.items.move(second.id, { status: 'backlog', afterId: null }, person);
  await card(s, 'backlog', 'The epic', 'epic');
  setFlow(s, { enabled: true });
  await s.flow.settled();

  assert.deepEqual(s.flow.startWaiting('p1'), { queued: 4, startingNow: 2, waiting: 2 });
  await s.flow.settled();
  assert.deepEqual(running(s).map((r) => r.itemId), [second.id, first.id]);
  assert.deepEqual(queued(s).map((r) => r.itemId), [ready.id, working.id]);
  assert.ok(flowRuns(s).every((r) => r.queuedBy === 'person'));
  assert.deepEqual(running(s).map((r) => r.stage), ['refine', 'refine']);
  const announced = s.events.filter((e) => e.type === 'flow.run' && e.action === 'queued');
  assert.equal(announced.length, 4);
  assert.ok(announced.every((e) => e.type === 'flow.run' && e.queuedBy === 'person'));

  // A second click, or a second tab, finds nothing left to start
  assert.deepEqual(s.flow.startWaiting('p1'), { queued: 0, startingNow: 0, waiting: 0 });
  assert.equal(flowRuns(s).length, 4);
  assert.equal(s.flow.waiting('p1').total, 0);
});

test('a card with a run going and a todo card refined and unchanged since do not wait; the runs going hold places back', async () => {
  const s = setup({ settings: refineOnly() });
  const done = await refined(s, 'Refined');
  const busy = await card(s, 'backlog', 'Busy');
  const idle = await card(s, 'in_progress', 'Idle');
  assert.equal(running(s).length, 1);
  // The developer joins the flow: the card already in progress waits, the others do not
  setFlow(s, { columns: { ...refineOnly().flow!.columns, in_progress: 'developer' } });
  await s.flow.settled();
  assert.deepEqual(s.flow.waiting('p1').columns, [{ column: 'in_progress', role: 'developer', count: 1 }]);

  // A person commenting on the refined card is something to check again
  s.items.comment(done.id, { body: 'Also keep the coupon' }, person);
  assert.deepEqual(s.flow.waiting('p1').columns.map((c) => [c.column, c.count]), [['todo', 1], ['in_progress', 1]]);

  assert.deepEqual(s.flow.startWaiting('p1'), { queued: 2, startingNow: 1, waiting: 1 }, 'one of the two places is taken');
  await s.flow.settled();
  assert.deepEqual(running(s).map((r) => r.itemId).sort(), [busy.id, done.id].sort());
  assert.deepEqual(queued(s).map((r) => r.itemId), [idle.id]);
  assert.equal(flowRuns(s).find((r) => r.itemId === busy.id)?.queuedBy, null, "a card's entry is not a person's start");
});

test('starting the waiting cards is refused while the flow is off', async () => {
  const s = setup({ settings: flowOff() });
  await card(s, 'backlog', 'One');
  assert.throws(() => s.flow.startWaiting('p1'), (err: unknown) => err instanceof FlowError && err.statusCode === 409);
  assert.equal(flowRuns(s).length, 0);
});

// ---------- the item's pull request ----------

/** What a merge conflict looks like to the flow: the paths, what the run left, and QA's passes. */
function conflictHooks(paths: string[]) {
  const state = { conflict: { base: 'main', paths } as { base: string; paths: string[] } | null, left: paths as string[] | null, verified: [] as string[] };
  const hooks: FlowPullRequests = {
    conflictOf: () => state.conflict,
    settleConflict: () => {
      const left = state.left;
      if (!left?.length) state.conflict = null;
      return left;
    },
    verified: (itemId) => void state.verified.push(itemId),
  };
  return { state, hooks };
}

test("the Developer's run on a conflicted merge is told every conflicting path and fails with conflict-unresolved when some are left", async () => {
  const { state, hooks } = conflictHooks(['src/cart.ts', 'docs/cart.md']);
  const s = setup({ pullRequests: hooks });
  // Where no role answers, so nothing runs before the conflict sends it back to work
  const it = await item(s, 'done');
  s.items.move(it.id, { status: 'in_progress' }, { actor: { kind: 'person' }, cause: { kind: 'chat', chatId: null, orchestrationId: null, taskId: null, event: 'pr.conflict' } });
  await s.flow.settled();
  const launch = s.launches.at(-1);
  assert.equal(launch?.run.stage, 'work');
  assert.match(launch?.prompt ?? '', /Resolve the merge of `main` into this branch/);
  assert.match(launch?.prompt ?? '', /- `src\/cart\.ts`\n- `docs\/cart\.md`/);
  // The run that resolves a conflict may no more push than any other
  assert.ok(launch?.disallowedTools.includes('Bash(git push)'));
  assert.ok(launch?.disallowedTools.includes('Bash(git push *)'));

  state.left = ['src/cart.ts'];
  await s.answer(it.id, ok('Merged'));
  const run = flowRuns(s).filter((r) => r.stage === 'work').at(-1);
  assert.equal(run?.outcome, 'failed');
  assert.equal(run?.cause, 'conflict-unresolved');
  assert.match(run?.error ?? '', /src\/cart\.ts/);
  assert.equal(s.items.find(it.id)?.status, 'in_progress');
});

test("QA passing the round after a resolved conflict completes the person's remembered approval, and keeps its notes for the PR", async () => {
  const { state, hooks } = conflictHooks(['src/cart.ts']);
  const s = setup({ pullRequests: hooks });
  const it = s.items.create('p1', { title: 'Fix the cart', status: 'done', type: 'task', acceptanceCriteria: [{ text: 'The total adds up' }] });
  await s.flow.settled();
  const [criterion] = it.acceptanceCriteria;
  assert.ok(criterion);
  s.items.move(it.id, { status: 'in_progress' }, person);
  await s.flow.settled();
  state.left = [];
  await s.answer(it.id, ok('Resolved and committed'));
  assert.equal(flowRuns(s).filter((r) => r.stage === 'work').at(-1)?.outcome, 'passed');
  assert.equal(s.items.find(it.id)?.status, 'in_review');

  await s.answer(it.id, ok('All criteria met', { verdict: 'pass', criteria: [{ id: criterion.id, met: true, note: 'the cart test passes' }] }));
  assert.deepEqual(state.verified, [it.id]);
  assert.deepEqual(s.flow.verdicts(it.id), [{ id: criterion.id, met: true, note: 'the cart test passes' }]);
});
