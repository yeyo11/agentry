import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { MemoryProposal, Project, ProjectFlow, ProjectSettings, Team, WorkItem, WorkItemDetail } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// The flow by column over HTTP and a real core, with the fake CLI standing in for Claude: it answers
// each run with the structured result the item's description scripts for its stage, and logs the
// arguments it was started with, which is how the flags the flow passes are checked. Nothing here
// reads the real ~/.claude.
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

  // The person approves: done, the wait cleared, nothing new started
  const before = argvs().length;
  const moved = await app.inject({ method: 'POST', url: `/api/work-items/${created.id}/move`, ...json({ status: 'done' }) });
  assert.equal(moved.statusCode, 200, moved.body);
  await sleep(300);
  assert.equal((await item(created.id)).waiting, null);
  assert.equal(argvs().length, before);
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
