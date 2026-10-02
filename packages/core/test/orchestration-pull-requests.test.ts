import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentryEvent, Orchestration } from '@agentry/shared';
import { runHostCall } from '../src/hosts/exec.ts';
import { OrchestrationPullRequestService } from '../src/orchestration-pull-requests.ts';
import { HostRateLimiter } from '../src/hosts/rate-limit.ts';
import { PullRequestWatcher } from '../src/pull-requests.ts';
import { cleanup, setup, sh, view, viewMr, write, type HostKind, type Setup } from './fixtures/pr-harness.ts';

// The orchestration's change request against both fakes (fake-gh and fake-glab, which replay the
// recordings): readiness before any push, one row for two calls, an empty branch refused, and a
// merge or a close read back by the watcher source.

const BRANCH = 'agentry/graph-integration';

function orchestration(s: Setup, opts: { commits: boolean }): Orchestration {
  sh(s.r.project, 'branch', '-f', BRANCH, 'main');
  if (opts.commits) {
    sh(s.r.project, 'checkout', '-q', BRANCH);
    write(s.r.project, 'graph.ts', 'export const graph = 1;\n');
    sh(s.r.project, 'add', '-A');
    sh(s.r.project, 'commit', '-q', '-m', 'integrate the graph');
    sh(s.r.project, 'checkout', '-q', 'main');
  }
  const orch = {
    id: 'o1',
    createdAt: '2026-10-01T00:00:00.000Z',
    name: 'Rework the cart',
    objective: 'Make the cart total right',
    cwd: s.r.project,
    finalResult: 'All tasks done',
    verification: { status: 'passed', report: 'checks green' },
    integration: { branch: BRANCH, worktree: null, status: 'merged', merged: [], conflicts: [], commit: null, error: null, integratorRunId: null, pullRequestUrl: null },
  } as unknown as Orchestration;
  s.db.saveOrchestrations([orch]);
  return orch;
}

function serviceOf(s: Setup, noGh = false): { service: OrchestrationPullRequestService; events: AgentryEvent[] } {
  const events: AgentryEvent[] = [];
  const path = noGh ? s.r.binNoGh : `${s.r.bin}:${process.env.PATH ?? ''}`;
  const service = new OrchestrationPullRequestService({
    db: s.db,
    codeHost: (p) => s.service.codeHost(p),
    emit: (e) => events.push({ ...e, id: events.length + 1, at: new Date().toISOString() } as AgentryEvent),
    env: { PATH: path, FAKE_GH_STATE: s.r.state, FAKE_GLAB_STATE: s.r.glabState },
    searchPath: async () => path,
    run: (call, where) => runHostCall(call, { binaryPath: where.binaryPath, cwd: where.cwd, baseEnv: where.env, retry: { sleep: async () => undefined, ...(call.class === 'probe' ? { delaysMs: [] } : {}) } }),
  });
  return { service, events };
}

const rowOf = (s: Setup): { id: string; hostname: string | null } => s.db.connection.prepare('SELECT id, hostname FROM orchestration_pull_requests ORDER BY created_at DESC LIMIT 1').get() as { id: string; hostname: string | null };
const idOf = (s: Setup): string => rowOf(s).id;
const pushed = (s: Setup): boolean => execFileSync('git', ['-C', s.r.remote, 'branch', '--list', BRANCH], { encoding: 'utf8' }).trim() !== '';
const rows = (s: Setup): number => Number((s.db.connection.prepare('SELECT COUNT(*) AS n FROM orchestration_pull_requests').get() as { n: number }).n);

async function scenario(host: HostKind, run: (s: Setup) => Promise<void>, opts: { noGh?: boolean } = {}): Promise<void> {
  const s = setup({ host, ...opts });
  try {
    await run(s);
  } finally {
    cleanup(s);
  }
}

for (const host of ['github', 'gitlab'] as const) {
  const number = host === 'github' ? 7 : 4;
  const tag = (name: string): string => `${host}: ${name}`;

  test(tag('a project that is not ready is refused before anything is pushed'), () =>
    scenario(
      host,
      async (s) => {
        const orch = orchestration(s, { commits: true });
        const { service } = serviceOf(s, true);
        await assert.rejects(service.open(orch), /cannot open pull requests \(cli-missing\)/);
        assert.equal(pushed(s), false);
        assert.equal(rows(s), 0);
      },
      { noGh: true },
    ));

  test(tag('an integration branch with nothing ahead of the default branch is refused'), () =>
    scenario(host, async (s) => {
      const orch = orchestration(s, { commits: false });
      const { service } = serviceOf(s);
      await assert.rejects(service.open(orch), /nothing to propose/);
      assert.equal(pushed(s), false);
      assert.equal(rows(s), 0);
    }));

  test(tag('opens the change request, with the body on stdin, and finds it'), () =>
    scenario(host, async (s) => {
      const orch = orchestration(s, { commits: true });
      const { service, events } = serviceOf(s);
      const opened = await service.open(orch);
      assert.equal(opened.detail, 'pull request opened');
      assert.equal(opened.pullRequest?.phase, 'open');
      assert.equal(opened.pullRequest?.number, number);
      assert.equal(opened.pullRequest?.host, host);
      assert.equal(opened.pullRequest?.base, 'main');
      assert.equal(opened.url, opened.pullRequest?.url);
      assert.equal(pushed(s), true);
      assert.deepEqual(events.map((e) => e.type), ['orchestration.pull-request', 'orchestration.pull-request']);
      assert.equal(service.newest('o1')?.number, number);
      if (host === 'github') assert.match(readFileSync(join(s.r.state, `body-${number}`), 'utf8'), /Make the cart total right[\s\S]*Verification: passed\. checks green[\s\S]*All tasks done/);
    }));

  test(tag('two concurrent calls leave one row and one create'), () =>
    scenario(host, async (s) => {
      const orch = orchestration(s, { commits: true });
      const { service } = serviceOf(s);
      const [a, b] = await Promise.all([service.open(orch), service.open(orch)]);
      assert.equal(rows(s), 1);
      assert.equal([a, b].filter((r) => r.detail === 'pull request opened').length, 1);
      assert.ok([a, b].some((r) => r.detail === 'already being opened' || r.detail === 'already open'));
      assert.equal((await service.open(orch)).detail, 'already open');
      assert.equal(rows(s), 1);
    }));

  test(tag('a merge is read back and announced, and nothing else moves'), () =>
    scenario(host, async (s) => {
      const orch = orchestration(s, { commits: true });
      const { service, events } = serviceOf(s);
      await service.open(orch);
      if (host === 'github') view(s.r, 'OPEN', [], number);
      else viewMr(s.r, 'opened', null, number);
      await new PullRequestWatcher([service]).tick();
      assert.equal(service.newest('o1')?.phase, 'open');
      // The first read gives the row its CI state, which is announced; the next, unchanged, is not
      await new PullRequestWatcher([service]).tick();
      const before = events.length;
      if (host === 'github') view(s.r, 'MERGED', [], number);
      else viewMr(s.r, 'merged', null, number);
      await new PullRequestWatcher([service]).tick();
      assert.equal(service.newest('o1')?.phase, 'merged');
      assert.ok(service.newest('o1')?.closedAt);
      assert.equal(events.length, before + 1);
    }));

  test(tag('says how a read went: held by the floor, lost claim, read'), () =>
    scenario(host, async (s) => {
      const orch = orchestration(s, { commits: true });
      const { service } = serviceOf(s);
      await service.open(orch);
      if (host === 'github') view(s.r, 'OPEN', [], number);
      else viewMr(s.r, 'opened', null, number);
      const id = idOf(s);
      const [a, b] = await Promise.all([service.check(id), service.check(id)]);
      assert.deepEqual([a, b].sort(), ['read', 'skipped']);
      const hostname = host === 'github' ? 'github.com' : (rowOf(s).hostname ?? '');
      const limiter = new HostRateLimiter(s.db.connection);
      limiter.observe(hostname, 'core', { limit: 5000, remaining: 10, resetAt: new Date(Date.now() + 10 * 60_000) });
      limiter.observe(hostname, 'graphql', { limit: 5000, remaining: 10, resetAt: new Date(Date.now() + 10 * 60_000) });
      assert.equal(await service.check(id), 'paused');
      assert.equal(await service.check(id, true), 'read');
    }));

  test(tag('a failed read is told to the pacer, and a nudge in the back-off is not lost'), () =>
    scenario(host, async (s) => {
      const orch = orchestration(s, { commits: true });
      const { service } = serviceOf(s);
      await service.open(orch);
      const id = idOf(s);
      s.db.connection.prepare('UPDATE orchestration_pull_requests SET number = 9999 WHERE id = ?').run(id);
      const watcher = new PullRequestWatcher([service]);
      await watcher.tick();
      assert.equal(watcher.pacer.nextAt(id, { checkedAt: null, ci: null, signature: '|', since: Date.now() }) > Date.now() + 30_000, true, 'the back-off applies to the orchestration row');
      watcher.nudge(id);
      await watcher.pass();
      assert.ok(watcher.pacer.nextAt(id, { checkedAt: null, ci: null, signature: '|', since: Date.now() }) > Date.now() + 30_000, 'a nudge does not break the back-off');
    }));

  test(tag('a close is read back, and a new request may follow'), () =>
    scenario(host, async (s) => {
      const orch = orchestration(s, { commits: true });
      const { service } = serviceOf(s);
      await service.open(orch);
      if (host === 'github') view(s.r, 'CLOSED', [], number);
      else viewMr(s.r, 'closed', null, number);
      await new PullRequestWatcher([service]).tick();
      assert.equal(service.newest('o1')?.phase, 'closed');
      assert.equal(service.openRows().length, 0);
    }));
}
