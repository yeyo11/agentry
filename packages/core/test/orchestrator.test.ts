import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const repo = mkdtempSync(join(tmpdir(), 'agentry-repo-'));
  execFileSync('git', ['init', '-q', repo]);
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
