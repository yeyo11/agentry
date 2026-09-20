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
import { RunManager } from '../src/runner.ts';
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

  const orchestrator = new Orchestrator(config, new RunManager(config, db), db);
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
  const orchestrator = new Orchestrator(config, new RunManager(config, db), db);
  assert.throws(() => orchestrator.resume('graph-1', { worktree: true }), /need a git repository/);
  // Refused before anything changed
  assert.equal(orchestrator.get('graph-1')?.status, 'stopped');
  db.close();
});

test('a graph that is not running can be deleted, and stays deleted', () => {
  const config = offlineConfig();
  const db = new Db(config);
  db.saveOrchestrations([stoppedGraph(tmpdir()), stoppedGraph(tmpdir(), { id: 'graph-2', status: 'running' })]);
  const orchestrator = new Orchestrator(config, new RunManager(config, db), db);

  assert.throws(() => orchestrator.remove('nope'), /not found/);
  orchestrator.remove('graph-1');
  assert.equal(orchestrator.get('graph-1'), null);
  // A fresh process reads the store, not memory: deleting has to reach it
  assert.equal(new Orchestrator(config, new RunManager(config, db), db).get('graph-1'), null);
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
  const orchestrator = new Orchestrator(config, new RunManager(config, db), db);

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
  const orchestrator = new Orchestrator(config, new RunManager(config, db), db);

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
  const orchestrator = new Orchestrator(config, new RunManager(config, db), db);

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
  const orchestrator = new Orchestrator(config, new RunManager(config, db), db);

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
  const orchestrator = new Orchestrator(config, new RunManager(config, db), db);

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
  const orchestrator = new Orchestrator(config, new RunManager(config, db), db);

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
  const orchestrator = new Orchestrator(config, new RunManager(config, db), db);

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
  const runs = new RunManager(config, db);
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
  assert.equal(orch.status, 'failed');
  assert.equal(slow()?.status, 'failed');
  assert.deepEqual(orch.integration?.merged, ['quick']);

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
    (o) => o.integration?.status === 'merged' && o.integration.merged.includes('slow'),
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
