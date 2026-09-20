import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Orchestration, OrchestrationTaskState } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { Orchestrator, validateTasks } from '../src/orchestrator.ts';
import { ChatManager } from '../src/chats.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

const task = (id: string, dependsOn: string[] = []) => ({ id, name: id, prompt: 'do it', dependsOn });

test('accepts a valid DAG', () => {
  assert.doesNotThrow(() => validateTasks([task('a'), task('b'), task('c', ['a', 'b']), task('d', ['c'])]));
});

test('rejects invalid task lists', () => {
  assert.throws(() => validateTasks([]), /at least one task/);
  assert.throws(() => validateTasks([task('a'), task('a')]), /duplicate/);
  assert.throws(() => validateTasks([task('bad id')]), /invalid task id/);
  assert.throws(() => validateTasks([{ id: 'a', name: 'a', prompt: '  ' }]), /empty prompt/);
  assert.throws(() => validateTasks([task('a', ['ghost'])]), /unknown task/);
  assert.throws(() => validateTasks([task('a', ['a'])]), /depends on itself/);
});

test('detects cycles', () => {
  assert.throws(() => validateTasks([task('a', ['c']), task('b', ['a']), task('c', ['b']), task('ok')]), /cycle between: a, b, c/);
});

// ---------- resuming and deleting ----------

/** A stopped graph as it sits on disk after a restart: two tasks done, one interrupted. */
function stoppedGraph(cwd: string, overrides: Partial<Orchestration> = {}): Orchestration {
  const task = (id: string, status: OrchestrationTaskState['status']): OrchestrationTaskState => ({
    id,
    name: id,
    prompt: `do ${id}`,
    dependsOn: [],
    status,
    attempts: 0,
    runId: null,
    sessionId: null,
    result: status === 'completed' ? `${id} done` : null,
    error: null,
    startedAt: null,
    endedAt: null,
    costUsd: status === 'completed' ? 0.5 : 0,
  });
  return {
    id: 'graph-1',
    name: 'desktop',
    objective: null,
    status: 'stopped',
    cwd,
    model: null,
    permissionMode: 'acceptEdits',
    concurrency: 1,
    synthesize: false,
    worktree: false,
    maxAttempts: 2,
    allowedTools: [],
    permissionPrompts: 'none',
    createdAt: '2026-01-01T10:00:00Z',
    endedAt: '2026-01-01T10:30:00Z',
    finalResult: null,
    costUsd: 1,
    tasks: [task('api', 'completed'), task('assets', 'completed'), task('shell', 'stopped')],
    ...overrides,
  };
}

/** A config whose CLI does not exist, so resuming schedules without launching real agents. */
function offlineConfig() {
  return { ...tempConfig(), claudeBin: '/nonexistent/claude' };
}

test('resuming corrects the settings that stopped a graph and keeps the finished work', () => {
  const config = offlineConfig();
  const repo = repoWithCommit();
  const db = new Db(config);
  db.saveOrchestrations([stoppedGraph(repo)]);

  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);
  const next = orchestrator.resume('graph-1', { worktree: true, permissionPrompts: 'host', allowedTools: ['Bash', 'Edit'] });

  // Started without worktrees and with nobody to ask: resuming like that would stop the same way
  assert.equal(next.worktree, true);
  assert.equal(next.permissionPrompts, 'host');
  assert.deepEqual(next.allowedTools, ['Bash', 'Edit']);
  assert.equal(next.status, 'running');
  // Completed tasks and their results are not redone
  assert.equal(next.tasks.find((t) => t.id === 'api')?.status, 'completed');
  assert.equal(next.tasks.find((t) => t.id === 'api')?.result, 'api done');
  assert.notEqual(next.tasks.find((t) => t.id === 'shell')?.status, 'stopped');
  db.close();
});

test('resuming with worktrees refuses a directory that is not a git repository', () => {
  const config = offlineConfig();
  const plain = mkdtempSync(join(tmpdir(), 'agentry-plain-'));
  const db = new Db(config);
  db.saveOrchestrations([stoppedGraph(plain)]);
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);
  assert.throws(() => orchestrator.resume('graph-1', { worktree: true }), /need a git repository/);
  // Refused before anything changed
  assert.equal(orchestrator.get('graph-1')?.status, 'stopped');
  db.close();
});

test('a graph that is not running can be deleted, and stays deleted', () => {
  const config = offlineConfig();
  const db = new Db(config);
  db.saveOrchestrations([stoppedGraph(tmpdir()), stoppedGraph(tmpdir(), { id: 'graph-2', status: 'running' })]);
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);

  assert.throws(() => orchestrator.remove('nope'), /not found/);
  orchestrator.remove('graph-1');
  assert.equal(orchestrator.get('graph-1'), null);
  // A fresh process reads the store, not memory: deleting has to reach it
  assert.equal(new Orchestrator(config, new ChatManager(config, db), db).get('graph-1'), null);
  db.close();
});

// ---------- delivering one branch ----------

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

/** A repository with one commit and an identity, as a user's project would have. */
function repoWithCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), 'agentry-graph-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return repo;
}

async function settle(orchestrator: Orchestrator, id: string): Promise<Orchestration> {
  for (let i = 0; i < 300; i++) {
    const orch = orchestrator.get(id);
    if (orch && orch.status !== 'running') return orch;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the orchestration never finished');
}

const show = (repo: string, ref: string) => execFileSync('git', ['-C', repo, 'show', ref], { encoding: 'utf8' }).trim();

test('dependent tasks build on their dependencies and the graph ends on one branch', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const repo = repoWithCommit();
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);

  const started = orchestrator.create({
    name: 'Linux app',
    cwd: repo,
    worktree: true,
    synthesize: true,
    tasks: [
      { id: 'api', name: 'API', prompt: 'FAKE-WRITE api.txt server' },
      { id: 'assets', name: 'Assets', prompt: 'FAKE-WRITE icon.txt png' },
      { id: 'shell', name: 'Shell', prompt: 'FAKE-WRITE shell.txt electron', dependsOn: ['api', 'assets'] },
    ],
  });
  const orch = await settle(orchestrator, started.id);

  assert.equal(orch.status, 'completed');
  // Started from both dependencies' work instead of from main
  const shell = orch.tasks.find((t) => t.id === 'shell');
  assert.match(shell?.result ?? '', /files=README\.md,api\.txt,icon\.txt,shell\.txt/);
  // Nobody committed; the wrapper did, so nothing was stranded in a worktree
  for (const t of orch.tasks) assert.ok(t.commit, `${t.id} was not committed`);

  const integration = orch.integration;
  assert.equal(integration?.status, 'merged');
  assert.equal(integration?.branch, `agentry/linux-app-${orch.id.slice(0, 8)}`);
  assert.deepEqual(integration?.merged.sort(), ['api', 'assets', 'shell']);
  assert.equal(show(repo, `${integration?.branch}:api.txt`), 'server');
  assert.equal(show(repo, `${integration?.branch}:icon.txt`), 'png');
  assert.equal(show(repo, `${integration?.branch}:shell.txt`), 'electron');
  // The user's checkout was never touched
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).replace(/^\?\? \.claude\/\n?/m, ''), '');

  // The synthesis ran on the integrated branch and can be answered
  assert.ok(orch.synthesisRunId);
  assert.match(orch.finalResult ?? '', new RegExp(`cwd=${integration?.worktree}`));
  db.close();
});

test('a graph in a subdirectory gets its worktrees where the CLI looks, and works in that subdirectory', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const repo = repoWithCommit();
  mkdirSync(join(repo, 'app'));
  writeFileSync(join(repo, 'app', 'main.txt'), 'main\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'app']);
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);

  const started = orchestrator.create({
    name: 'in app',
    cwd: join(repo, 'app'),
    worktree: true,
    synthesize: true,
    tasks: [
      { id: 'api', name: 'API', prompt: 'FAKE-WRITE api.txt server' },
      { id: 'shell', name: 'Shell', prompt: 'FAKE-WRITE shell.txt electron', dependsOn: ['api'] },
    ],
  });
  const orch = await settle(orchestrator, started.id);

  assert.equal(orch.status, 'completed', orch.tasks.map((t) => t.error).join('; '));
  for (const t of orch.tasks) {
    assert.equal(t.worktree, join(repo, '.claude', 'worktrees', `${orch.id.slice(0, 8)}-${t.id}`));
    // In the same subdirectory it would have had in the checkout, with its dependency's work
    assert.match(t.result ?? '', new RegExp(`^cwd=${join(t.worktree ?? '', 'app')} `));
  }
  assert.match(orch.tasks.find((t) => t.id === 'shell')?.result ?? '', /files=api\.txt,main\.txt,shell\.txt/);
  const integration = orch.integration;
  assert.equal(integration?.status, 'merged', String(integration?.error));
  assert.equal(integration?.worktree, join(repo, '.claude', 'worktrees', `${orch.id.slice(0, 8)}-integration`));
  assert.equal(show(repo, `${integration?.branch}:app/api.txt`), 'server');
  assert.equal(show(repo, `${integration?.branch}:app/shell.txt`), 'electron');
  assert.match(orch.finalResult ?? '', new RegExp(`cwd=${join(integration?.worktree ?? '', 'app')} `));
  // Nothing was created under the subdirectory itself
  assert.equal(existsSync(join(repo, 'app', '.claude')), false);
  db.close();
});

test('a graph started from a linked worktree builds on that worktree, with its worktrees where the CLI looks', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const repo = repoWithCommit();
  // The graph runs from a linked worktree whose branch is ahead of the main checkout
  const linked = `${repo}-linked`;
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'feature', linked]);
  writeFileSync(join(linked, 'feature.txt'), 'feature\n');
  execFileSync('git', ['-C', linked, 'add', '-A']);
  execFileSync('git', ['-C', linked, 'commit', '-q', '-m', 'feature']);
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);

  const started = orchestrator.create({
    name: 'from linked',
    cwd: linked,
    worktree: true,
    tasks: [{ id: 'docs', name: 'Docs', prompt: 'FAKE-WRITE docs.txt written' }],
  });
  const orch = await settle(orchestrator, started.id);

  assert.equal(orch.status, 'completed', orch.tasks.map((t) => t.error).join('; '));
  // The CLI keeps --worktree checkouts under the main checkout, not under the linked one
  const task = orch.tasks[0];
  assert.equal(task?.worktree, join(repo, '.claude', 'worktrees', `${orch.id.slice(0, 8)}-docs`));
  assert.equal(existsSync(join(linked, '.claude')), false);
  // It starts from what the linked worktree has, not from the main checkout's branch
  assert.match(task?.result ?? '', /files=.*feature\.txt/);
  const integration = orch.integration;
  assert.equal(integration?.status, 'merged', String(integration?.error));
  assert.equal(show(repo, `${integration?.branch}:feature.txt`), 'feature');
  assert.equal(show(repo, `${integration?.branch}:docs.txt`), 'written');
  db.close();
});

test('a graph in an ignored subdirectory works at the top of its worktrees, where its work is kept', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const repo = repoWithCommit();
  // Like the wrapper's own workspace/, the default cwd, inside this repository
  writeFileSync(join(repo, '.gitignore'), 'workspace/\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'ignore']);
  mkdirSync(join(repo, 'workspace'));
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);

  const started = orchestrator.create({
    name: 'in workspace',
    cwd: join(repo, 'workspace'),
    worktree: true,
    tasks: [{ id: 'api', name: 'API', prompt: 'FAKE-WRITE api.txt server' }],
  });
  const orch = await settle(orchestrator, started.id);

  assert.equal(orch.status, 'completed', orch.tasks.map((t) => t.error).join('; '));
  const api = orch.tasks[0];
  assert.equal(api?.worktree, join(repo, '.claude', 'worktrees', `${orch.id.slice(0, 8)}-api`));
  assert.match(api?.result ?? '', new RegExp(`^cwd=${api?.worktree} `));
  assert.equal(show(repo, `${orch.integration?.branch}:api.txt`), 'server');
  db.close();
});

test('resuming a graph whose worktrees were put in its subdirectory moves them where the CLI looks', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const repo = repoWithCommit();
  mkdirSync(join(repo, 'app'));
  writeFileSync(join(repo, 'app', 'main.txt'), 'main\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'app']);
  // What the bug left: the worktree under the subdirectory, and a worker that failed before starting
  const stale = join(repo, 'app', '.claude', 'worktrees', 'graph-1-api');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'worktree-graph-1-api', stale]);
  const failed = stoppedGraph(join(repo, 'app')).tasks[0] as OrchestrationTaskState;
  db.saveOrchestrations([
    stoppedGraph(join(repo, 'app'), {
      status: 'failed',
      worktree: true,
      baseCommit: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      tasks: [{ ...failed, prompt: 'FAKE-WRITE api.txt server', status: 'failed', worktree: stale, branch: 'worktree-graph-1-api' }],
    }),
  ]);
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);

  orchestrator.resume('graph-1', {});
  const orch = await settle(orchestrator, 'graph-1');

  assert.equal(orch.status, 'completed', orch.tasks.map((t) => t.error).join('; '));
  assert.equal(orch.tasks[0]?.worktree, join(repo, '.claude', 'worktrees', 'graph-1-api'));
  assert.equal(existsSync(stale), false);
  assert.equal(show(repo, `${orch.integration?.branch}:app/api.txt`), 'server');
  db.close();
});

test('branches that conflict are merged by an integrator agent', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const repo = repoWithCommit();
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);

  const started = orchestrator.create({
    name: 'clash',
    cwd: repo,
    worktree: true,
    tasks: [
      { id: 'left', name: 'Left', prompt: 'FAKE-WRITE same.txt from left' },
      { id: 'right', name: 'Right', prompt: 'FAKE-WRITE same.txt from right' },
    ],
  });
  const orch = await settle(orchestrator, started.id);

  const integration = orch.integration;
  assert.equal(integration?.status, 'merged', String(integration?.error));
  assert.deepEqual(integration?.conflicts, [{ taskId: 'right', paths: ['same.txt'] }]);
  assert.ok(integration?.integratorRunId);
  assert.equal(show(repo, `${integration?.branch}:same.txt`), 'from right');
  db.close();
});

test('a finished graph from before integration existed can be integrated afterwards', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const repo = repoWithCommit();
  // What orchestration fdd1b816 left: worktrees with their work uncommitted and no integration
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  const tasks = ['one', 'two'].map((id) => {
    const path = join(repo, '.claude', 'worktrees', `graph-1-${id}`);
    git('worktree', 'add', '-q', '-b', `worktree-graph-1-${id}`, path);
    writeFileSync(join(path, `${id}.txt`), `${id}\n`);
    return { id, path };
  });
  db.saveOrchestrations([
    stoppedGraph(repo, {
      status: 'completed',
      worktree: true,
      tasks: tasks.map(({ id, path }) => ({
        ...stoppedGraph(repo).tasks[0],
        id,
        name: id,
        status: 'completed',
        worktree: path,
        branch: `worktree-graph-1-${id}`,
      })) as OrchestrationTaskState[],
    }),
  ]);
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);

  orchestrator.retryIntegration('graph-1');
  let orch = orchestrator.get('graph-1');
  for (let i = 0; i < 100 && orch?.integration?.status !== 'merged'; i++) await new Promise((r) => setTimeout(r, 20));
  orch = orchestrator.get('graph-1');
  assert.equal(orch?.integration?.status, 'merged', String(orch?.integration?.error));
  assert.equal(show(repo, `${orch?.integration?.branch}:one.txt`), 'one');
  assert.equal(show(repo, `${orch?.integration?.branch}:two.txt`), 'two');
  db.close();
});

// ---------- following a task's run after its first result ----------

async function until<T>(read: () => T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('a task whose run was stopped and then continued to a result delivers that work', async () => {
  // Seen on 2026-09-19: a stopped worker was continued by hand, finished and committed on its
  // branch, and the graph never noticed. The task stayed failed, its cost went uncounted, its
  // branch was left out of the integration, and the synthesis reported the work as missing.
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const repo = repoWithCommit();
  const runs = new ChatManager(config, db);
  const orchestrator = new Orchestrator(config, runs, db);

  const started = orchestrator.create({
    name: 'late',
    cwd: repo,
    worktree: true,
    tasks: [
      { id: 'quick', name: 'Quick', prompt: 'FAKE-WRITE quick.txt fast' },
      { id: 'slow', name: 'Slow', prompt: 'FAKE-HANG' },
    ],
  });
  const slowRun = await until(() => orchestrator.get(started.id)?.tasks.find((t) => t.id === 'slow')?.runId, Boolean, 'the slow worker');
  assert.ok(slowRun);
  await until(() => runs.get(slowRun)?.pid, Boolean, 'the slow worker to spawn');
  runs.stop(slowRun);

  let orch = await settle(orchestrator, started.id);
  const slow = () => orchestrator.get(started.id)?.tasks.find((t) => t.id === 'slow');
  // Stopped on purpose, so not tried again; the graph waits for a person, and integrates nothing yet
  assert.equal(orch.status, 'waiting');
  assert.equal(slow()?.status, 'failed');
  assert.equal(slow()?.attempts, 1);
  assert.equal(orch.integration, null);

  // A turn that fails keeps the task failed, with that turn's error rather than the stop's
  await runs.exited(slowRun);
  runs.send(slowRun, 'FAKE-FAIL the tests do not pass');
  await until(slow, (t) => t?.error === 'the tests do not pass', 'the failed turn to reach the task');
  assert.equal(slow()?.status, 'failed');

  await runs.exited(slowRun);
  runs.send(slowRun, 'FAKE-WRITE slow.txt finally');
  await until(slow, (t) => t?.status === 'completed', 'the task to complete');
  orch = await until(
    () => orchestrator.get(started.id) ?? orch,
    (o) => o.status === 'completed' && o.integration?.status === 'merged' && o.integration.merged.includes('slow'),
    'the late branch to be integrated',
  );

  const done = slow();
  assert.equal(done?.error, null);
  assert.match(done?.result ?? '', /slow\.txt/);
  assert.ok(done?.commit, 'the late work was not committed');
  // The run's whole cost, and the graph's with it
  assert.equal(done?.costUsd, runs.get(slowRun)?.costUsd);
  assert.ok((done?.costUsd ?? 0) > 0);
  assert.equal(orch.costUsd, orch.tasks.reduce((sum, t) => sum + t.costUsd, 0));
  assert.equal(orch.status, 'completed');
  assert.deepEqual([...(orch.integration?.merged ?? [])].sort(), ['quick', 'slow']);
  assert.equal(show(repo, `${orch.integration?.branch}:slow.txt`), 'finally');
  assert.equal(show(repo, `${orch.integration?.branch}:quick.txt`), 'fast');
  db.close();
});

// ---------- retrying, blocking and deciding ----------

/** A worktree graph over the fake CLI, which is what the tests below are about. */
function retryGraph() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const repo = repoWithCommit();
  const runs = new ChatManager(config, db);
  const orchestrator = new Orchestrator(config, runs, db);
  const taskOf = (id: string, task: string) => orchestrator.get(id)?.tasks.find((t) => t.id === task);
  return { db, repo, runs, orchestrator, taskOf };
}

const graphOf = (repo: string, tasks: Array<{ id: string; prompt: string; dependsOn?: string[] }>, extra = {}) => ({
  name: 'retries',
  cwd: repo,
  worktree: true,
  synthesize: true,
  tasks: tasks.map((t) => ({ name: t.id, ...t })),
  ...extra,
});

test('a failed task is tried again in the same chat, told what went wrong, and keeps what it cost', async () => {
  const { db, repo, runs, orchestrator } = retryGraph();
  const started = orchestrator.create(graphOf(repo, [{ id: 'flaky', prompt: 'FAKE-FAIL-ONCE the tests do not pass' }]));
  const orch = await settle(orchestrator, started.id);

  const flaky = orch.tasks[0] as OrchestrationTaskState;
  assert.equal(orch.status, 'completed');
  assert.equal(flaky.status, 'completed');
  assert.equal(flaky.attempts, 2);
  assert.equal(flaky.error, null);
  // The retry is Agentry's own words, from the error: the objective and the original prompt are not in it
  assert.match(flaky.result ?? '', /^retried: Your previous attempt at this task ended with an error:\n\nthe tests do not pass\n/);
  assert.doesNotMatch(flaky.result ?? '', /FAKE-FAIL-ONCE/);

  // One chat with two executions, not two chats; every attempt's cost is on the task and on the graph
  const chats = runs.list().filter((c) => c.orchestrationId === orch.id && c.orchestrationTaskId === 'flaky');
  assert.equal(chats.length, 1);
  assert.equal(flaky.runId, chats[0]?.id);
  assert.equal(chats[0]?.executions.length, 2);
  assert.equal(flaky.costUsd, runs.get(flaky.runId as string)?.costUsd);
  assert.ok(flaky.costUsd >= 0.02);
  assert.equal(orch.costUsd, flaky.costUsd + (runs.get(orch.synthesisRunId as string)?.costUsd ?? 0));
  db.close();
});

test('the attempts are configured per graph, and a task that uses them all is failed, not retried for ever', async () => {
  const { db, repo, orchestrator, runs } = retryGraph();
  const started = orchestrator.create(graphOf(repo, [{ id: 'broken', prompt: 'FAKE-FAIL-ALWAYS boom' }], { maxAttempts: 3 }));
  assert.equal(started.maxAttempts, 3);
  const orch = await settle(orchestrator, started.id);

  const broken = orch.tasks[0] as OrchestrationTaskState;
  assert.equal(broken.status, 'failed');
  assert.equal(broken.attempts, 3);
  assert.equal(runs.get(broken.runId as string)?.executions.length, 3);
  assert.equal(broken.error, 'boom');

  const other = { ...graphOf(repo, [{ id: 'x', prompt: 'FAKE-HANG' }]), worktree: false };
  const defaulted = orchestrator.create(other);
  assert.equal(defaulted.maxAttempts, 2);
  assert.equal(orchestrator.create({ ...other, maxAttempts: 0 }).maxAttempts, 1);
  for (const o of orchestrator.list()) orchestrator.stop(o.id);
  db.close();
});

test('a budget that ran out is not retried: the retry would meet the same ceiling', async () => {
  const { db, repo, orchestrator } = retryGraph();
  const started = orchestrator.create(graphOf(repo, [{ id: 'costly', prompt: 'FAKE-BUDGET' }], { maxAttempts: 5 }));
  const orch = await settle(orchestrator, started.id);
  assert.equal(orch.tasks[0]?.status, 'failed');
  assert.equal(orch.tasks[0]?.attempts, 1);
  assert.equal(orch.status, 'waiting');
  db.close();
});

test('what waits behind a failed task is blocked, not skipped, and the graph holds its integration and synthesis', async () => {
  const { db, repo, orchestrator, taskOf } = retryGraph();
  const started = orchestrator.create(
    graphOf(repo, [
      { id: 'good', prompt: 'FAKE-WRITE good.txt fine' },
      { id: 'broken', prompt: 'FAKE-FAIL-ALWAYS boom' },
      { id: 'after', prompt: 'FAKE-WRITE after.txt never', dependsOn: ['broken'] },
      { id: 'later', prompt: 'FAKE-WRITE later.txt never', dependsOn: ['after'] },
    ]),
  );
  const orch = await settle(orchestrator, started.id);

  assert.equal(orch.status, 'waiting');
  assert.equal(orch.endedAt, null);
  assert.equal(taskOf(orch.id, 'good')?.status, 'completed');
  assert.equal(taskOf(orch.id, 'broken')?.status, 'failed');
  assert.equal(taskOf(orch.id, 'after')?.status, 'blocked');
  assert.equal(taskOf(orch.id, 'later')?.status, 'blocked');
  // Neither a half integration nor a synthesis over a graph with a hole in it
  assert.equal(orch.integration, null);
  assert.equal(orch.synthesisRunId, null);
  assert.equal(orch.finalResult, null);
  assert.throws(() => orchestrator.retryIntegration(orch.id), /waiting for a decision/);
  assert.throws(() => orchestrator.resume(orch.id), /waiting for a decision/);
  assert.throws(() => orchestrator.remove(orch.id), /stop the orchestration/);
  db.close();
});

test('giving a branch up lets the graph finish without it, and only then does it integrate and synthesise', async () => {
  const { db, repo, orchestrator, taskOf } = retryGraph();
  const started = orchestrator.create(
    graphOf(repo, [
      { id: 'good', prompt: 'FAKE-WRITE good.txt fine' },
      { id: 'broken', prompt: 'FAKE-FAIL-ALWAYS boom' },
      { id: 'after', prompt: 'FAKE-WRITE after.txt never', dependsOn: ['broken'] },
    ]),
  );
  await settle(orchestrator, started.id);

  assert.throws(() => orchestrator.skipTask(started.id, 'good'), /nothing to decide/);
  assert.throws(() => orchestrator.skipTask(started.id, 'ghost'), /task not found/);
  orchestrator.skipTask(started.id, 'broken');
  const orch = await until(() => orchestrator.get(started.id) as Orchestration, (o) => o.status !== 'running' && o.status !== 'waiting', 'the graph to finish');

  // A decision, not a failure: the graph is complete without that branch
  assert.equal(orch.status, 'completed');
  assert.equal(taskOf(orch.id, 'broken')?.status, 'skipped');
  assert.equal(taskOf(orch.id, 'after')?.status, 'skipped');
  assert.deepEqual(orch.integration?.merged, ['good']);
  assert.ok(orch.synthesisRunId);
  assert.match(orch.finalResult ?? '', /cwd=/);
  db.close();
});

test('a task retried by a person continues its chat and releases what waited behind it', async () => {
  const { db, repo, runs, orchestrator, taskOf } = retryGraph();
  const started = orchestrator.create(
    graphOf(
      repo,
      [
        { id: 'flaky', prompt: 'FAKE-FAIL-ONCE the disk was full' },
        { id: 'after', prompt: 'FAKE-WRITE after.txt done', dependsOn: ['flaky'] },
      ],
      { maxAttempts: 1 },
    ),
  );
  await settle(orchestrator, started.id);
  const flaky = taskOf(started.id, 'flaky') as OrchestrationTaskState;
  assert.equal(flaky.status, 'failed');
  assert.equal(taskOf(started.id, 'after')?.status, 'blocked');
  const chat = flaky.runId;

  orchestrator.retryTask(started.id, 'flaky');
  const orch = await until(() => orchestrator.get(started.id) as Orchestration, (o) => o.status === 'completed', 'the graph to complete');

  const again = taskOf(orch.id, 'flaky') as OrchestrationTaskState;
  assert.equal(again.runId, chat, 'a retry is a new execution of the same chat');
  assert.equal(again.attempts, 2);
  assert.match(again.result ?? '', /the disk was full/);
  assert.equal(runs.get(chat as string)?.executions.length, 2);
  assert.equal(taskOf(orch.id, 'after')?.status, 'completed');
  assert.deepEqual([...(orch.integration?.merged ?? [])].sort(), ['after', 'flaky']);
  assert.ok(orch.synthesisRunId);
  // The graph is over, so there is nothing left to decide
  assert.throws(() => orchestrator.retryTask(started.id, 'flaky'), /resume it instead/);
  db.close();
});

test('starting a task clean gives it a new chat and a worktree rebuilt from the base', async () => {
  const { db, runs, repo, orchestrator, taskOf } = retryGraph();
  const started = orchestrator.create(graphOf(repo, [{ id: 'broken', prompt: 'FAKE-FAIL-ALWAYS boom' }], { maxAttempts: 1 }));
  await settle(orchestrator, started.id);
  const before = taskOf(started.id, 'broken') as OrchestrationTaskState;
  const { runId, worktree, branch } = before;
  assert.ok(runId && worktree && branch);
  writeFileSync(join(worktree, 'stale.txt'), 'left over by the failed attempt\n');
  // The result arrives before the process has finished exiting, and starting clean refuses while one is up
  await runs.exited(runId);

  orchestrator.retryTaskClean(started.id, 'broken');
  const orch = await until(
    () => orchestrator.get(started.id) as Orchestration,
    (o) => o.status === 'waiting' && o.tasks[0]?.runId !== runId,
    'the new chat to fail as well',
  );
  const after = orch.tasks[0] as OrchestrationTaskState;

  assert.notEqual(after.runId, runId);
  assert.equal(after.attempts, 1, 'the new chat starts counting again');
  assert.equal(after.worktree, worktree);
  assert.equal(existsSync(join(worktree, 'stale.txt')), false, 'the worktree was rebuilt, not reused');
  // What was tried stays listed, with its own history
  assert.equal(runs.get(runId)?.executions.length, 1);
  assert.equal(runs.get(after.runId as string)?.executions.length, 1);
  db.close();
});

test('a hint reaches a task that is running and none that has finished', async () => {
  const { db, repo, runs, orchestrator, taskOf } = retryGraph();
  const started = orchestrator.create(
    graphOf(repo, [
      { id: 'done', prompt: 'FAKE-WRITE done.txt yes' },
      { id: 'slow', prompt: 'FAKE-HANG' },
    ]),
  );
  const slowChat = await until(() => taskOf(started.id, 'slow')?.runId, Boolean, 'the slow worker');
  await until(() => runs.get(slowChat as string)?.pid, Boolean, 'the slow worker to spawn');
  await until(() => taskOf(started.id, 'done')?.status, (s) => s === 'completed', 'the quick worker');

  assert.throws(() => orchestrator.hintTask(started.id, 'done', 'try harder'), /a fork of its chat/);
  assert.throws(() => orchestrator.hintTask(started.id, 'slow', '  '), /text is required/);
  orchestrator.hintTask(started.id, 'slow', 'look at the config first');
  const said = runs
    .events(slowChat as string)
    .flatMap((e) => e.entry?.blocks ?? [])
    .map((b) => (b.type === 'text' ? b.text : ''));
  assert.ok(said.some((text) => text.startsWith('A hint from the person') && text.includes('look at the config first')), said.join('|'));

  orchestrator.stop(started.id);
  db.close();
});

test('resuming a graph continues the chats of its unfinished tasks instead of starting new ones', async () => {
  const { db, repo, runs, orchestrator, taskOf } = retryGraph();
  const started = orchestrator.create(graphOf(repo, [{ id: 'slow', prompt: 'FAKE-HANG' }], { synthesize: false }));
  const chat = await until(() => taskOf(started.id, 'slow')?.runId, Boolean, 'the worker');
  await until(() => runs.get(chat as string)?.pid, Boolean, 'the worker to spawn');
  orchestrator.stop(started.id);
  await runs.exited(chat as string);
  const stoppedCost = taskOf(started.id, 'slow')?.costUsd;

  orchestrator.resume(started.id);
  const orch = await until(() => orchestrator.get(started.id) as Orchestration, (o) => o.status === 'completed', 'the resumed graph');
  const slow = orch.tasks[0] as OrchestrationTaskState;
  assert.equal(slow.runId, chat);
  assert.equal(slow.attempts, 2);
  assert.equal(runs.get(chat as string)?.executions.length, 2);
  assert.ok(slow.costUsd >= (stoppedCost ?? 0));
  assert.match(slow.result ?? '', /files=/);
  db.close();
});

// ---------- a restart is not a decision to stop ----------

const HEARD = '2026-01-01T10:20:00.000Z';

/**
 * What a wrapper that went away mid-graph leaves in the store: a chat per task, the executions of
 * the ones that were running still open, and the graph itself still `running`.
 */
function seedRestart(cwd: string, tasks: Array<{ id: string; status: OrchestrationTaskState['status']; attempts: number; dependsOn?: string[]; stoppedByPerson?: boolean }>, maxAttempts = 2) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const execution = (chat: string, live: boolean, outcome: 'stopped' | null) => ({
    id: `${chat}-x1`,
    startedAt: '2026-01-01T10:00:00.000Z',
    endedAt: live ? null : HEARD,
    outcome,
    error: null,
    permissionMode: 'acceptEdits' as const,
    model: null,
    account: null,
    maxBudgetUsd: null,
    costUsd: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
    turns: 1,
  });
  const chats = tasks
    .filter((t) => t.status === 'running' || t.status === 'stopped')
    .map((t) => ({
      record: {
        id: `chat-${t.id}`,
        name: `restart:${t.id}`,
        cwd,
        workingDir: cwd,
        origin: 'orchestration' as const,
        orchestrationId: 'graph-r',
        orchestrationTaskId: t.id,
        derivedFrom: null,
        prompt: 'work',
        lastText: null,
        model: null,
        permissionMode: 'acceptEdits' as const,
        account: null,
        permissionPrompts: 'none' as const,
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: HEARD,
      },
      executions: [t.status === 'running' ? execution(`chat-${t.id}`, true, null) : execution(`chat-${t.id}`, false, 'stopped')],
    }));
  db.saveChats(chats, 100);
  const graph = stoppedGraph(cwd, {
    id: 'graph-r',
    status: 'running',
    endedAt: null,
    maxAttempts,
    synthesize: false,
    tasks: tasks.map((t) => ({
      id: t.id,
      name: t.id,
      prompt: `do ${t.id}`,
      dependsOn: t.dependsOn ?? [],
      status: t.status,
      attempts: t.attempts,
      runId: t.status === 'running' || t.status === 'stopped' ? `chat-${t.id}` : null,
      sessionId: t.status === 'running' || t.status === 'stopped' ? `chat-${t.id}` : null,
      result: t.status === 'completed' ? `${t.id} done` : null,
      error: null,
      startedAt: '2026-01-01T10:00:00.000Z',
      endedAt: t.status === 'stopped' ? HEARD : null,
      costUsd: 0,
    })),
  });
  db.saveOrchestrations([graph]);
  return { config, db };
}

test('a task a restart cut off is interrupted when its chat was last heard from and goes on in its chat; one someone stopped stays stopped', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agentry-restart-'));
  const { config, db } = seedRestart(cwd, [
    { id: 'cut', status: 'running', attempts: 1 },
    { id: 'after', status: 'pending', attempts: 0, dependsOn: ['cut'] },
    { id: 'mine', status: 'stopped', attempts: 1 },
    { id: 'behind', status: 'pending', attempts: 0, dependsOn: ['mine'] },
  ]);
  const runs = new ChatManager(config, db);
  const orchestrator = new Orchestrator(config, runs, db);
  const taskOf = (id: string) => orchestrator.get('graph-r')?.tasks.find((t) => t.id === id) as OrchestrationTaskState;

  // Not the moment the wrapper came back: the moment the chat last did anything
  assert.equal(taskOf('cut').status, 'interrupted');
  assert.equal(taskOf('cut').endedAt, HEARD);
  assert.equal(taskOf('mine').status, 'stopped');
  assert.equal(orchestrator.get('graph-r')?.status, 'running');

  await runs.restore(new SessionStore(config));
  orchestrator.recover();
  const orch = await until(() => orchestrator.get('graph-r') as Orchestration, (o) => o.status !== 'running', 'the graph to settle');

  // The chat continued in a new execution, and the one the restart cut is on record as such
  const cut = taskOf('cut');
  assert.equal(cut.status, 'completed', cut.error ?? '');
  assert.equal(cut.runId, 'chat-cut');
  assert.equal(cut.attempts, 2);
  const executions = runs.get('chat-cut')?.executions ?? [];
  assert.equal(executions.length, 2);
  assert.equal(executions[0]?.outcome, 'interrupted');
  assert.equal(executions[0]?.endedAt, HEARD);
  assert.equal(runs.list().filter((c) => c.orchestrationTaskId === 'cut').length, 1);
  assert.equal(taskOf('after').status, 'completed');
  // Nobody continued what a person stopped, and what waits behind it waits for a decision
  assert.equal(taskOf('mine').status, 'stopped');
  assert.equal(runs.get('chat-mine')?.executions.length, 1);
  assert.equal(taskOf('behind').status, 'blocked');
  assert.equal(orch.status, 'waiting');
  runs.stopAll();
  db.close();
});

test('an interrupted task that has used its attempts is failed for a person to decide, not retried again', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agentry-restart-'));
  const { config, db } = seedRestart(cwd, [
    { id: 'cut', status: 'running', attempts: 2 },
    { id: 'after', status: 'pending', attempts: 0, dependsOn: ['cut'] },
  ]);
  const runs = new ChatManager(config, db);
  const orchestrator = new Orchestrator(config, runs, db);
  await runs.restore(new SessionStore(config));
  orchestrator.recover();

  const orch = orchestrator.get('graph-r') as Orchestration;
  const cut = orch.tasks.find((t) => t.id === 'cut') as OrchestrationTaskState;
  assert.equal(cut.status, 'failed');
  assert.match(cut.error ?? '', /interrupted by a restart, with no attempts left/);
  assert.equal(cut.endedAt, HEARD);
  assert.equal(runs.get('chat-cut')?.executions.length, 1);
  assert.equal(orch.tasks.find((t) => t.id === 'after')?.status, 'blocked');
  assert.equal(orch.status, 'waiting');
  db.close();
});

test('stopping a graph in the moment after a restart is a decision: the interrupted task is stopped and stays so', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agentry-restart-'));
  const { config, db } = seedRestart(cwd, [{ id: 'cut', status: 'running', attempts: 1 }]);
  const runs = new ChatManager(config, db);
  const orchestrator = new Orchestrator(config, runs, db);
  orchestrator.stop('graph-r');
  await runs.restore(new SessionStore(config));
  orchestrator.recover();
  assert.equal(orchestrator.get('graph-r')?.tasks[0]?.status, 'stopped');
  assert.equal(orchestrator.get('graph-r')?.status, 'stopped');
  assert.equal(runs.get('chat-cut')?.executions.length, 1);
  db.close();
});

test('a graph that had finished its tasks when the wrapper went away waits for a person instead of starting over', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agentry-restart-'));
  const { config, db } = seedRestart(cwd, [{ id: 'done', status: 'completed', attempts: 1 }]);
  const finishing = { ...(db.loadOrchestrations()[0] as Orchestration), endedAt: '2026-01-01T10:25:00.000Z' };
  db.saveOrchestrations([finishing]);
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);
  assert.equal(orchestrator.get('graph-r')?.status, 'stopped');
  assert.equal(orchestrator.get('graph-r')?.endedAt, '2026-01-01T10:25:00.000Z');
  db.close();
});
