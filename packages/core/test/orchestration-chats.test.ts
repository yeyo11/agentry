import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Orchestration } from '@agentry/shared';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');

function repoWithCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), 'agentry-roles-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return repo;
}

async function until<T>(read: () => T, done: (value: T) => boolean, what: string, ms = 20_000): Promise<T> {
  for (let waited = 0; waited < ms; waited += 50) {
    const value = read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function over(core: Core, id: string): Promise<Orchestration> {
  const orch = await until(() => core.orchestrator.get(id), (o) => !!o && o.status !== 'running' && o.status !== 'waiting' && o.verification?.status !== 'running', 'the graph to finish');
  assert.ok(orch);
  return orch;
}

test('every chat of a graph is linked to it with its role, and the integrator and fixer costs count in its usage row', async () => {
  const core = new Core({ ...tempConfig(), claudeBin: FAKE_CLAUDE });
  try {
    const repo = repoWithCommit();
    const command = "echo 'FAKE-WRITE marker.txt repaired'; test -f marker.txt";
    const started = core.orchestrator.create({
      name: 'roles',
      cwd: repo,
      worktree: true,
      synthesize: true,
      verification: { commands: [command], fixer: true, maxAttempts: 1 },
      tasks: [{ id: 'api', name: 'API', prompt: 'FAKE-WRITE api.txt server' }],
    });
    const orch = await over(core, started.id);
    assert.equal(orch.verification?.status, 'fixed', orch.verification?.report ?? '');
    const fixer = orch.verification?.fixes?.[0]?.runId;
    assert.ok(fixer);
    // An integrator only runs on a conflict: one started the way the orchestrator starts it stands in
    const integrator = core.runtime.start({ prompt: 'merge', cwd: repo, keepAlive: false }, { orchestrationId: orch.id, orchestrationTaskId: '__integration__' });
    await core.runtime.waitForResult(integrator.id);

    const chats = await core.chats.list({ origins: ['orchestration'] });
    const link = (id: string | null | undefined) => chats.find((c) => c.id === id)?.orchestration;
    assert.deepEqual(link(orch.tasks[0]?.sessionId), { id: orch.id, name: 'roles', role: 'task', taskId: 'api', taskName: 'API' });
    assert.deepEqual(link(integrator.id), { id: orch.id, name: 'roles', role: 'integration', taskId: null, taskName: null });
    assert.deepEqual(link(fixer), { id: orch.id, name: 'roles', role: 'verification', taskId: null, taskName: null });
    assert.deepEqual(link(orch.synthesisRunId), { id: orch.id, name: 'roles', role: 'synthesis', taskId: null, taskName: null });
    // Only the synthesis is the deliverable; the integrator and the fixer are workers, hidden with them
    const deliverables = await core.chats.list({ origins: ['orchestration'], workers: false });
    assert.deepEqual(deliverables.map((c) => c.id), [orch.synthesisRunId]);

    const row = (await core.chats.usage()).orchestrations.find((o) => o.orchestration.id === orch.id);
    const spent = (id: string | null | undefined) => core.runtime.get(id as string)?.executions.reduce((sum, e) => sum + (e.costUsd ?? 0), 0) ?? 0;
    const expected = [orch.tasks[0]?.sessionId, integrator.id, fixer, orch.synthesisRunId].reduce((sum, id) => sum + spent(id), 0);
    assert.ok(spent(fixer) > 0 && spent(integrator.id) > 0);
    assert.equal(Math.round((row?.costUsd ?? 0) * 1e6), Math.round(expected * 1e6));
  } finally {
    core.shutdown();
  }
});

test("a task's earlier chat that a clean retry replaced stays linked to the task", async () => {
  const core = new Core({ ...tempConfig(), claudeBin: FAKE_CLAUDE });
  try {
    const repo = repoWithCommit();
    const started = core.orchestrator.create({
      name: 'clean',
      cwd: repo,
      worktree: true,
      maxAttempts: 1,
      tasks: [{ id: 'flaky', name: 'Flaky', prompt: 'FAKE-FAIL-ALWAYS nope' }],
    });
    const failed = await until(() => core.orchestrator.get(started.id), (o) => o?.tasks[0]?.status === 'failed', 'the task to fail');
    const first = failed?.tasks[0]?.sessionId;
    assert.ok(first);
    await core.runtime.exited(first);
    core.orchestrator.retryTaskClean(started.id, 'flaky');
    const retried = await until(() => core.orchestrator.get(started.id), (o) => !!o?.tasks[0]?.sessionId && o.tasks[0].sessionId !== first && o.tasks[0].status !== 'running', 'the clean retry');
    const chats = await core.chats.list({ origins: ['orchestration'] });
    for (const id of [first, retried?.tasks[0]?.sessionId]) {
      assert.deepEqual(chats.find((c) => c.id === id)?.orchestration, { id: started.id, name: 'clean', role: 'task', taskId: 'flaky', taskName: 'Flaky' }, id ?? '');
    }
  } finally {
    core.shutdown();
  }
});
