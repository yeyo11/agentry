import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { FlowRun, FlowRunPage, FlowStartWaitingResult, FlowWaiting, MemoryProposal, Project, ProjectFlow, ProjectSettings, Team, WorkItem, WorkItemDetail } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// The flow by column over HTTP and a real core, with the fake CLI standing in for Claude: it answers
// each run with the structured result the item's description scripts for its stage, and logs the
// arguments it was started with, which is how the flags the flow passes are checked. Nothing here
// reads the real ~/.claude.
process.env.FAKE_CLAUDE_LOGGED_IN = '1';
const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude.mjs', import.meta.url));

let app: FastifyInstance;
let core: Core;
let project: Project;
let spawns: string;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (done(value)) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function repoWithCommit(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-api-flow-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(dir, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}

const item = async (id: string): Promise<WorkItemDetail> => (await app.inject(`/api/work-items/${id}`)).json<WorkItemDetail>();
const flowOf = async (): Promise<ProjectFlow> => (await app.inject(`/api/projects/${project.id}/flow`)).json<ProjectFlow>();
/** Each run's argv as the fake logged it; an argument can hold newlines, so entries split on the next `<pid> -p` */
const argvs = (): string[] =>
  existsSync(spawns)
    ? readFileSync(spawns, 'utf8')
        .split(/\n(?=\d+ )/)
        .filter((l) => l.includes('--json-schema'))
    : [];

async function settings(change: (s: ProjectSettings) => ProjectSettings): Promise<void> {
  const current = (await app.inject(`/api/projects/${project.id}/settings`)).json<ProjectSettings>();
  const res = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/settings`, ...json(change(current)) });
  assert.equal(res.statusCode, 200, res.body);
}

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-flow-data-'));
  spawns = join(root, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects/import',
    ...json({ path: repoWithCommit(), name: 'Shop', template: 'software', modules: ['board', 'team', 'memory', 'documents'] }),
  });
  assert.equal(res.statusCode, 201, res.body);
  project = res.json<Project>();
  const team = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/team/from-template`, ...json({ roles: ['developer', 'qa'] }) });
  assert.equal(team.statusCode, 201, team.body);
  const qa = await app.inject({
    method: 'PUT',
    url: `/api/projects/${project.id}/team/qa`,
    ...json({ role: 'qa', model: 'sonnet', responsibility: 'Verifies each item', writes: ['docs/reports'] }),
  });
  assert.equal(qa.statusCode, 200, qa.body);
});

after(async () => {
  await app.close();
  core.shutdown();
  delete process.env.FAKE_CLAUDE_SPAWNS;
});

test('the flow is read with the flow off, and its cap comes from the settings', async () => {
  const off = await flowOf();
  assert.deepEqual([off.enabled, off.maxParallel, off.running, off.queued], [false, 2, [], []]);
  assert.equal((await app.inject('/api/projects/nope/flow')).statusCode, 404);
  await settings((s) => ({ ...s, flow: { ...s.flow!, enabled: true, maxParallel: 1 } }));
  const on = await flowOf();
  assert.deepEqual([on.enabled, on.maxParallel], [true, 1]);
  const bad = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/settings`, ...json({ ...(await app.inject(`/api/projects/${project.id}/settings`)).json<ProjectSettings>(), flow: { enabled: true, columns: {}, maxBounces: 1, maxParallel: 0 } }) });
  assert.equal(bad.statusCode, 400);
  // A run has no budget unless the person sets one, and one that is set must be a real amount
  const current = (await app.inject(`/api/projects/${project.id}/settings`)).json<ProjectSettings>();
  assert.equal(current.flow?.maxCostUsd, undefined);
  for (const maxCostUsd of [0, -1, 'two', 1000]) {
    const refused = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/settings`, ...json({ ...current, flow: { ...current.flow!, maxCostUsd } }) });
    assert.equal(refused.statusCode, 400, `${String(maxCostUsd)}: ${refused.body}`);
  }
  await settings((s) => ({ ...s, flow: { ...s.flow!, maxCostUsd: 1.5 } }));
  assert.equal((await app.inject(`/api/projects/${project.id}/settings`)).json<ProjectSettings>().flow?.maxCostUsd, 1.5);
  await settings((s) => ({ ...s, flow: { ...s.flow!, maxCostUsd: null as unknown as number } }));
  assert.equal((await app.inject(`/api/projects/${project.id}/settings`)).json<ProjectSettings>().flow?.maxCostUsd, undefined);
});

test('a card entering in_progress is implemented by the developer, verified by QA, and waits for the person', async () => {
  await settings((s) => ({ ...s, flow: { ...s.flow!, enabled: true, maxParallel: 1 } }));
  const noted = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/journal`, ...json({ kind: 'decision', text: 'Prices are in cents' }) });
  assert.equal(noted.statusCode, 201, noted.body);
  const work = { summary: 'Implemented the cart', memoryProposals: [], documents: [] };
  const verify = {
    summary: 'Every criterion holds',
    verdict: 'pass',
    memoryProposals: [{ target: { kind: 'journal', file: null, section: null }, text: 'Carts are kept per user', reason: 'decided while verifying' }],
    documents: [{ path: 'docs/reports/agn-1.md', kind: 'report' }],
  };
  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/work-items`,
    ...json({ title: 'Keep the cart', status: 'in_progress', description: `FAKE-RESULT-WORK ${JSON.stringify(work)}\nFAKE-RESULT-VERIFY ${JSON.stringify(verify)}` }),
  });
  assert.equal(res.statusCode, 201, res.body);
  const created = res.json<WorkItem>();

  const done = await until(() => item(created.id), (i) => i.waiting === 'approval', 'QA to pass the item');
  assert.equal(done.status, 'in_review');
  assert.deepEqual(
    done.comments.map((c) => [c.author.role, c.body]),
    [
      ['developer', 'Implemented the cart'],
      ['qa', 'Every criterion holds'],
    ],
  );
  assert.ok(done.worktree, 'the runs worked in the item worktree');
  const chats = done.links.filter((l) => l.kind === 'chat');
  assert.deepEqual(chats.map((l) => [l.role, l.teamRole]), [
    ['work', 'developer'],
    ['verify', 'qa'],
  ]);
  const report = done.links.find((l) => l.kind === 'document');
  assert.deepEqual([report?.documentPath, report?.role, report?.teamRole], ['docs/reports/agn-1.md', 'verify', 'qa']);

  // The flags each run was started with: the member's agent and model, the journal, the schema
  const [dev, qa] = argvs();
  assert.ok(dev && qa, 'two runs started');
  for (const [argv, agent] of [
    [dev, 'developer'],
    [qa, 'qa'],
  ] as const) {
    assert.match(argv, new RegExp(`--agent ${agent}( |$)`));
    assert.match(argv, /--model sonnet/);
    assert.match(argv, /--agents \S+\.json/);
    assert.match(argv, /--append-system-prompt # Project journal[\s\S]*Prices are in cents/);
    assert.match(argv, /--permission-prompts none/);
  }
  assert.match(dev, /--permission-mode acceptEdits/);
  assert.match(qa, /--permission-mode dontAsk/);
  // QA writes only in the documents folder and pushes nothing; with no budget set, none is passed
  assert.match(qa, /Edit\(docs\/\*\*\)/);
  assert.match(qa, /--disallowedTools=Bash\(git push\)/);
  assert.doesNotMatch(qa, /--max-budget-usd/);
  assert.doesNotMatch(qa, /--allowedTools=[^ ]*(^|,)Edit(,|$| )/);

  const proposals = (await app.inject(`/api/projects/${project.id}/memory/proposals?status=pending`)).json<MemoryProposal[]>();
  assert.deepEqual(proposals.map((p) => [p.text, p.proposedBy.role, p.itemId]), [['Carts are kept per user', 'qa', created.id]]);

  const team = (await app.inject(`/api/projects/${project.id}/team`)).json<Team>();
  assert.equal(team.members.find((m) => m.agent === 'qa')?.lastRun?.outcome, 'passed');
  const flow = await until(flowOf, (f) => !f.running.length && !f.queued.length, 'the flow to go quiet');
  assert.equal(flow.enabled, true);

  // The item's own runs, newest first, each with its stage, member, outcome and chat
  const itemRuns = await app.inject(`/api/work-items/${created.id}/runs`);
  assert.equal(itemRuns.statusCode, 200, itemRuns.body);
  const runs = itemRuns.json<FlowRun[]>();
  assert.deepEqual(runs.map((r) => [r.stage, r.agent, r.outcome, r.item?.key]), [
    ['verify', 'qa', 'passed', created.key],
    ['work', 'developer', 'passed', created.key],
  ]);
  assert.ok(runs.every((r) => r.chatId && chats.some((l) => l.chatId === r.chatId)));
  assert.equal((await app.inject('/api/work-items/nope/runs')).statusCode, 404);

  // The team's activity: every run of the project, newest first, filtered and paged
  const activity = (query = '') => app.inject(`/api/projects/${project.id}/flow/runs${query}`);
  const all = (await activity()).json<FlowRunPage>();
  assert.deepEqual([all.total, all.nextCursor, all.runs.map((r) => r.stage)], [2, null, ['verify', 'work']]);
  const first = (await activity('?limit=1')).json<FlowRunPage>();
  assert.deepEqual([first.total, first.runs.map((r) => r.agent)], [2, ['qa']]);
  assert.ok(first.nextCursor);
  const second = (await activity(`?limit=1&cursor=${first.nextCursor}`)).json<FlowRunPage>();
  assert.deepEqual([second.runs.map((r) => r.agent), second.nextCursor], [['developer'], null]);
  assert.deepEqual((await activity('?agent=developer')).json<FlowRunPage>().runs.map((r) => r.agent), ['developer']);
  assert.equal((await activity('?status=running,failed')).json<FlowRunPage>().total, 0);
  assert.equal((await activity(`?status=passed&itemId=${created.id}`)).json<FlowRunPage>().total, 2);
  for (const bad of ['?status=lost', '?limit=0', '?limit=201', '?cursor=nonsense']) assert.equal((await activity(bad)).statusCode, 400, bad);
  assert.equal((await app.inject('/api/projects/nope/flow/runs')).statusCode, 404);

  // The person approves: done, the wait cleared, nothing new started
  const before = argvs().length;
  const moved = await app.inject({ method: 'POST', url: `/api/work-items/${created.id}/move`, ...json({ status: 'done' }) });
  assert.equal(moved.statusCode, 200, moved.body);
  await sleep(300);
  assert.equal((await item(created.id)).waiting, null);
  assert.equal(argvs().length, before);
});

test('a failed run says why as a code, and a person retries it once while the item is in its column', async () => {
  await settings((s) => ({ ...s, flow: { ...s.flow!, enabled: true, maxParallel: 1 } }));
  const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items`, ...json({ title: 'Check the totals', status: 'in_review', description: 'FAKE-FAIL QA could not run the tests' }) });
  assert.equal(res.statusCode, 201, res.body);
  const created = res.json<WorkItem>();
  const runsOf = async () => (await app.inject(`/api/work-items/${created.id}/runs`)).json<FlowRun[]>();
  const [failed] = await until(runsOf, (r) => r[0]?.state === 'ended', 'QA to fail');
  assert.ok(failed);
  assert.deepEqual([failed.outcome, failed.cause, failed.error, failed.step, failed.retryable, failed.retriedBy], ['failed', 'chat-failed', 'QA could not run the tests', 'verify', true, null]);
  const activity = (query: string) => app.inject(`/api/projects/${project.id}/flow/runs${query}`);
  assert.deepEqual((await activity(`?role=qa&outcome=failed&itemId=${created.id}`)).json<FlowRunPage>().runs.map((r) => r.id), [failed.id]);
  assert.equal((await activity(`?itemId=${created.id}&before=2000-01-01T00:00:00Z`)).json<FlowRunPage>().total, 0);
  assert.equal((await activity('?before=never')).statusCode, 400);

  // The retry passes this time
  const verify = { summary: 'Totals hold', verdict: 'pass', criteria: [], memoryProposals: [], documents: [] };
  const edited = await app.inject({ method: 'PATCH', url: `/api/work-items/${created.id}`, ...json({ description: `FAKE-RESULT-VERIFY ${JSON.stringify(verify)}` }) });
  assert.equal(edited.statusCode, 200, edited.body);
  const retried = await app.inject({ method: 'POST', url: `/api/flow-runs/${failed.id}/retry` });
  assert.equal(retried.statusCode, 201, retried.body);
  const retry = retried.json<FlowRun>();
  assert.deepEqual([retry.retryOf, retry.stage, retry.column, retry.agent], [failed.id, 'verify', 'in_review', 'qa']);
  assert.equal((await app.inject({ method: 'POST', url: `/api/flow-runs/${failed.id}/retry` })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/flow-runs/nope/retry' })).statusCode, 404);
  const done = await until(() => item(created.id), (i) => i.waiting === 'approval', 'the retry to pass');
  assert.equal(done.status, 'in_review');
  const after = (await runsOf()).find((r) => r.id === failed.id);
  assert.deepEqual([after?.retriedBy?.id, after?.retriedBy?.outcome, after?.retryable], [retry.id, 'passed', false]);

  // Once the item left the run's column, a failed run there is not retried
  const other = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items`, ...json({ title: 'Round the totals', status: 'in_review', description: 'FAKE-FAIL no' }) });
  const otherItem = other.json<WorkItem>();
  const [otherFailed] = await until(async () => (await app.inject(`/api/work-items/${otherItem.id}/runs`)).json<FlowRun[]>(), (r) => r[0]?.state === 'ended', 'QA to fail again');
  const moved = await app.inject({ method: 'POST', url: `/api/work-items/${otherItem.id}/move`, ...json({ status: 'done' }) });
  assert.equal(moved.statusCode, 200, moved.body);
  const refused = await app.inject({ method: 'POST', url: `/api/flow-runs/${otherFailed?.id}/retry` });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.match(refused.body, /left in_review/);
  await until(flowOf, (f) => !f.running.length && !f.queued.length, 'the flow to go quiet');
});

test("the person's language is the one the panel last named, and a request naming none leaves it", async () => {
  const say = (language: string) => app.inject({ url: '/api/projects', headers: { 'accept-language': language } });
  await say('es-ES,es;q=0.9,en;q=0.8');
  assert.equal(core.personLanguage(), 'es');
  // What a script's fetch sends, and a language Agentry does not speak
  await say('*');
  await say('fr-FR');
  await app.inject('/api/projects');
  assert.equal(core.personLanguage(), 'es');
  await say('en-GB,en;q=0.9');
  assert.equal(core.personLanguage(), 'en');
});

test('a chat started over the API cannot name an agents file of its own', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi', agentsFile: '/etc/passwd' }) });
  assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${res.statusCode} ${res.body}`);
  assert.match(res.body, /agentsFile/);
});

test('with the flow switched off, a card entering a column starts nothing', async () => {
  await settings((s) => ({ ...s, flow: { ...s.flow!, enabled: false } }));
  const before = argvs().length;
  const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items`, ...json({ title: 'Idle', status: 'in_progress' }) });
  assert.equal(res.statusCode, 201, res.body);
  await sleep(300);
  assert.equal(argvs().length, before);
  assert.deepEqual((await flowOf()).queued, []);
});

test('switching the flow on starts nothing until a person starts the waiting cards, once each, as a person', async () => {
  await settings((s) => ({ ...s, flow: { ...s.flow!, enabled: false } }));
  const waitingOf = async () => (await app.inject(`/api/projects/${project.id}/flow/waiting`)).json<FlowWaiting>();
  const start = () => app.inject({ method: 'POST', url: `/api/projects/${project.id}/flow/start-waiting` });
  assert.equal((await app.inject('/api/projects/nope/flow/waiting')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects/nope/flow/start-waiting' })).statusCode, 404);
  assert.deepEqual(await waitingOf(), { total: 0, columns: [] }, 'nothing waits for a flow that is off');
  assert.equal((await start()).statusCode, 409);

  // Earlier tests' cards go to done, so only this test's cards wait
  for (const card of (await app.inject(`/api/projects/${project.id}/work-items`)).json<WorkItem[]>()) {
    const moved = await app.inject({ method: 'POST', url: `/api/work-items/${card.id}/move`, ...json({ status: 'done' }) });
    assert.equal(moved.statusCode, 200, moved.body);
  }
  for (const title of ['First', 'Second']) {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items`, ...json({ title, status: 'in_progress', description: 'FAKE-HANG' }) });
    assert.equal(res.statusCode, 201, res.body);
  }
  await settings((s) => ({ ...s, flow: { ...s.flow!, enabled: true, maxParallel: 1 } }));
  await sleep(200);
  assert.deepEqual([(await flowOf()).running, (await flowOf()).queued], [[], []], 'switching it on alone starts nothing');
  assert.deepEqual(await waitingOf(), { total: 2, columns: [{ column: 'in_progress', role: 'developer', count: 2 }] });

  const first = await start();
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json<FlowStartWaitingResult>(), { queued: 2, startingNow: 1, waiting: 1 });
  assert.deepEqual((await start()).json<FlowStartWaitingResult>(), { queued: 0, startingNow: 0, waiting: 0 }, 'a second click queues nothing');
  const flow = await until(flowOf, (f) => f.running.length === 1, 'the first card to start');
  assert.deepEqual(flow.running.map((r) => [r.item?.title, r.queuedBy]), [['First', 'person']]);
  assert.deepEqual(flow.queued.map((r) => [r.item?.title, r.queuedBy]), [['Second', 'person']]);
  assert.equal((await waitingOf()).total, 0);

  // Both cards run a fake CLI that never answers (FAKE-HANG). Removing a card stops its run; the
  // test waits for the flow to go quiet, as the others do, so no hung process outlives the file and
  // keeps the test runner from exiting (it did on slower CI runners)
  for (const card of [...flow.running, ...flow.queued]) {
    const removed = await app.inject({ method: 'DELETE', url: `/api/work-items/${card.item!.id}` });
    assert.ok(removed.statusCode < 300, removed.body);
  }
  await until(flowOf, (f) => !f.running.length && !f.queued.length, 'the flow to go quiet');
  await settings((s) => ({ ...s, flow: { ...s.flow!, enabled: false } }));
});
