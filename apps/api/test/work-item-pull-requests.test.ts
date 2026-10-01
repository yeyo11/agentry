import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Board, Project, WorkItem, WorkItemDetail, WorkItemPullRequestResult } from '@agentry/shared';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

// The pull request routes over a real core, a real git project with a bare repository as its
// origin, and core's fake gh first on the PATH. Nothing here reaches GitHub or spawns Claude.

const FAKE_GH = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-gh.sh', import.meta.url));
const GIT_SHIM = fileURLToPath(new URL('../../../packages/core/test/fixtures/git-shim.sh', import.meta.url));

let app: FastifyInstance;
let core: Core;
let root: string;
let state: string;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** A git project whose `origin` is a bare repository beside it, imported with its Board module on. */
async function gitProject(name: string): Promise<{ project: Project; path: string; remote: string }> {
  const dir = mkdtempSync(join(root, `${name}-`));
  const remote = join(dir, 'remote.git');
  const path = join(dir, 'project');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  writeFileSync(join(path, 'cart.ts'), 'export const total = 1;\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'first');
  git(path, 'remote', 'add', 'origin', remote);
  git(path, 'push', '-q', '-u', 'origin', 'main');
  git(path, 'remote', 'set-head', 'origin', 'main');
  const res = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path, name, modules: ['board'] }) });
  assert.equal(res.statusCode, 201, res.body);
  return { project: res.json<Project>(), path, remote };
}

async function createItem(projectId: string, body: Record<string, unknown>): Promise<WorkItem> {
  const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/work-items`, ...json(body) });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<WorkItem>();
}

/** An item in review with one commit of work on its own branch and worktree, as "Work on it" leaves it. */
async function reviewed(projectId: string, path: string): Promise<WorkItem> {
  const item = await createItem(projectId, { title: 'Fix the cart total', description: 'Off by one.', acceptanceCriteria: [{ text: 'The total adds up' }] });
  const branch = `task/${item.key.toLowerCase()}`;
  const worktree = join(path, '.claude', 'worktrees', `task-${item.key.toLowerCase()}`);
  git(path, 'worktree', 'add', '-q', '-b', branch, worktree, 'HEAD');
  writeFileSync(join(worktree, 'cart.ts'), 'export const total = 2;\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'fix the total');
  core.workItems.setWorktree(item.id, { worktree, branch });
  const moved = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/move`, ...json({ status: 'in_review' }) });
  assert.equal(moved.statusCode, 200, moved.body);
  return moved.json<{ item: WorkItem }>().item;
}

const approve = (itemId: string) => app.inject({ method: 'POST', url: `/api/work-items/${itemId}/pull-request` });

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-pr-'));
  state = join(root, 'gh-state');
  const bin = join(root, 'bin');
  mkdirSync(state);
  mkdirSync(bin);
  copyFileSync(FAKE_GH, join(bin, 'gh'));
  chmodSync(join(bin, 'gh'), 0o755);
  // The bare origin has no host, and a project with none is not ready: the shim has `origin` say github.com
  symlinkSync(GIT_SHIM, join(bin, 'git'));
  process.env.AGENTRY_REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  process.env.AGENTRY_ORIGIN_URL = 'https://github.com/acme/shop.git';
  // Read by core whenever it runs gh: this test file runs in its own process
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.FAKE_GH_STATE = state;
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(() => app.close());

test('approving an item in review answers 202, opens one PR, and a second call answers 200 with the same PR', async () => {
  const { project, path, remote } = await gitProject('Shop');
  const item = await reviewed(project.id, path);

  const first = await approve(item.id);
  assert.equal(first.statusCode, 202, first.body);
  const started = first.json<WorkItemPullRequestResult>();
  assert.equal(started.pullRequest.phase, 'preparing');
  assert.equal(started.item.id, item.id);
  await core.pullRequests.settled();

  const detail = (await app.inject({ method: 'GET', url: `/api/work-items/${item.id}` })).json<WorkItemDetail>();
  assert.equal(detail.status, 'in_review');
  assert.equal(detail.waiting, 'merge');
  assert.equal(detail.pullRequest?.phase, 'open');
  assert.equal(detail.pullRequest?.number, 7);
  assert.equal(detail.pullRequest?.url, 'https://github.com/acme/shop/pull/7');
  assert.deepEqual(detail.pullRequestReadiness, { status: 'ready', detail: null, defaultBranch: 'main', host: 'github', hostname: 'github.com', remedy: null });
  assert.equal(git(remote, 'rev-parse', `task/${item.key.toLowerCase()}`).length, 40, 'the branch was pushed');

  const second = await approve(item.id);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json<WorkItemPullRequestResult>().pullRequest.number, 7);

  // The board says a PR is offered here, and where the checkout stands
  const board = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/work-items/board` })).json<Board>();
  assert.equal(board.pullRequestReadiness?.status, 'ready');
  assert.deepEqual(board.checkout, { defaultBranch: 'main', branch: 'main', behind: 0, reason: null });
  const card = board.columns.find((c) => c.status === 'in_review')?.items.find((i) => i.id === item.id);
  assert.equal(card?.pullRequest?.number, 7);
});

test('the refresh route asks gh now: a merged PR moves the item to Done', async () => {
  const { project, path } = await gitProject('Merge');
  const item = await reviewed(project.id, path);
  assert.equal((await approve(item.id)).statusCode, 202);
  await core.pullRequests.settled();
  const number = core.pullRequests.newest(item.id)?.number;
  assert.ok(number);

  writeFileSync(join(state, 'view.json'), JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-29T10:00:00Z', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], url: `https://github.com/acme/shop/pull/${number}` }));
  try {
    const res = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/pull-request/refresh` });
    assert.equal(res.statusCode, 200, res.body);
    const refreshed = res.json<WorkItem>();
    assert.equal(refreshed.status, 'done');
    assert.equal(refreshed.pullRequest?.phase, 'merged');
    assert.equal(refreshed.pullRequest?.ci, 'passing');
  } finally {
    writeFileSync(join(state, 'view.json'), JSON.stringify({ state: 'OPEN', mergedAt: null, statusCheckRollup: [], url: '' }));
  }
});

test('approving refuses an epic with 400, and with 409 and a code an item not in review, nothing to propose or a project that is not ready', async () => {
  const { project, path } = await gitProject('Refusals');
  const epic = await createItem(project.id, { title: 'Checkout', type: 'epic', status: 'in_review' });
  assert.equal((await approve(epic.id)).statusCode, 400);

  const todo = await createItem(project.id, { title: 'Later', status: 'todo' });
  const notInReview = await approve(todo.id);
  assert.equal(notInReview.statusCode, 409);
  assert.equal(notInReview.json().code, 'not-in-review');

  // In review, but nothing has worked on it
  const untouched = await createItem(project.id, { title: 'Nothing yet', status: 'in_review' });
  const nothing = await approve(untouched.id);
  assert.equal(nothing.statusCode, 409);
  assert.equal(nothing.json().code, 'nothing-to-propose');

  // A project that is no git repository cannot open a PR, and says why
  const plain = mkdtempSync(join(root, 'plain-'));
  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: plain, name: 'Plain', modules: ['board'] }) });
  const plainProject = imported.json<Project>();
  const loose = await createItem(plainProject.id, { title: 'Loose', status: 'in_review' });
  const notGit = await approve(loose.id);
  assert.equal(notGit.statusCode, 409);
  assert.equal(notGit.json().code, 'not-git');
  const board = (await app.inject({ method: 'GET', url: `/api/projects/${plainProject.id}/work-items/board` })).json<Board>();
  assert.equal(board.pullRequestReadiness?.status, 'not-git');
  assert.equal(board.checkout, null);
  // Moving it to Done by hand still works where no PR is offered
  const done = await app.inject({ method: 'POST', url: `/api/work-items/${loose.id}/move`, ...json({ status: 'done' }) });
  assert.equal(done.statusCode, 200);

  assert.equal((await approve('no-such-item')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/work-items/no-such-item/pull-request/refresh' })).statusCode, 404);
  void path;
});

/** A commit on the remote's main that touches `cart.ts`, as another PR merged on GitHub would. */
function landOnMain(remote: string, content: string): void {
  const clone = mkdtempSync(join(root, 'clone-'));
  execFileSync('git', ['clone', '-q', remote, clone]);
  writeFileSync(join(clone, 'cart.ts'), content);
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'land cart');
  git(clone, 'push', '-q', 'origin', 'main');
}

test('an approval whose update conflicts answers 202, pushes nothing and sends the item back to work with the paths', async () => {
  const { project, path, remote } = await gitProject('Conflict');
  const item = await reviewed(project.id, path);
  landOnMain(remote, 'export const total = 3;\n');

  assert.equal((await approve(item.id)).statusCode, 202);
  await core.pullRequests.settled();

  const detail = (await app.inject({ method: 'GET', url: `/api/work-items/${item.id}` })).json<WorkItemDetail>();
  assert.equal(detail.status, 'in_progress');
  assert.equal(detail.pullRequest?.phase, 'conflict');
  assert.deepEqual(detail.pullRequest?.conflicts, ['cart.ts']);
  const moved = detail.history.filter((e) => e.change === 'status').pop();
  assert.equal(moved?.actor.kind, 'person');
  assert.equal(moved?.cause?.event, 'pr.conflict');
  const branches = execFileSync('git', ['-C', remote, 'branch', '--list', `task/${item.key.toLowerCase()}`], { encoding: 'utf8' }).trim();
  assert.equal(branches, '', 'nothing was pushed');

  // Out of review now: a second approval is refused until it comes back
  const again = await approve(item.id);
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, 'not-in-review');
});

test('a PR closed unmerged, seen through the refresh route, leaves the item in review waiting for approval, and approving again opens a new one', async () => {
  const { project, path } = await gitProject('Closed');
  const item = await reviewed(project.id, path);
  assert.equal((await approve(item.id)).statusCode, 202);
  await core.pullRequests.settled();
  const number = core.pullRequests.newest(item.id)?.number;
  assert.ok(number);

  writeFileSync(join(state, 'view.json'), JSON.stringify({ state: 'CLOSED', mergedAt: null, statusCheckRollup: [], url: `https://github.com/acme/shop/pull/${number}` }));
  try {
    const refreshed = (await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/pull-request/refresh` })).json<WorkItem>();
    assert.equal(refreshed.status, 'in_review');
    assert.equal(refreshed.waiting, 'approval');
    assert.equal(refreshed.pullRequest?.phase, 'closed');
  } finally {
    writeFileSync(join(state, 'view.json'), JSON.stringify({ state: 'OPEN', mergedAt: null, statusCheckRollup: [], url: '' }));
  }
  writeFileSync(join(state, 'next'), String(number + 1));
  try {
    assert.equal((await approve(item.id)).statusCode, 202);
    await core.pullRequests.settled();
    assert.equal(core.pullRequests.newest(item.id)?.number, number + 1);
    assert.deepEqual(core.pullRequests.all(item.id).map((p) => p.phase), ['closed', 'open']);
  } finally {
    writeFileSync(join(state, 'next'), '7');
  }
});

test('approving an item a flow run is working on answers 409 busy', async () => {
  const { project, path } = await gitProject('Busy');
  const item = await reviewed(project.id, path);
  const now = new Date().toISOString();
  core.db.connection
    .prepare("INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, queued_at, started_at) VALUES (?, ?, ?, 'qa', 'qa', 'sonnet', 'verify', 'in_review', 'running', ?, ?)")
    .run('api-busy-run', project.id, item.id, now, now);
  try {
    const busy = await approve(item.id);
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().code, 'busy');
  } finally {
    core.db.connection.prepare("UPDATE flow_runs SET state = 'ended', outcome = 'cancelled', ended_at = ? WHERE id = 'api-busy-run'").run(now);
  }
});

test('both pull request routes are documented with a summary and the Work items tag', async () => {
  const spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{ paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> }>();
  for (const path of ['/api/work-items/{itemId}/pull-request', '/api/work-items/{itemId}/pull-request/refresh']) {
    const op = spec.paths[path]?.post;
    assert.ok(op?.summary, `${path} has a summary`);
    assert.deepEqual(op?.tags, ['Work items']);
  }
});
