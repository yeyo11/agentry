import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { Orchestration } from '@agentry/shared';
import { runHostCall } from '../src/hosts/exec.ts';
import type { MergeService } from '../src/hosts/merge-service.ts';
import { OrchestrationPullRequestService } from '../src/orchestration-pull-requests.ts';
import { cleanup, expectGolden, note, opened, record, reviewed, setup, sh, write, type Setup } from './fixtures/pr-harness.ts';

// The pushes that open a change request can land on a branch that already has one, with auto-merge
// armed: they hold it the way a fix's push does, find the request first (the `pr list` call in the
// golden logs), and let go when the push is over, whatever came of it.

const BRANCH = 'agentry/graph-integration';

interface Hold {
  held: string[];
  released: string[];
  /** Whether the branch was already on the remote when the hold was taken: the hold must come first */
  pushedAtHold: boolean[];
  merge: MergeService;
}

function holding(s: Setup, branch: string, refuse = false): Hold {
  const hold: Hold = { held: [], released: [], pushedAtHold: [], merge: {} as MergeService };
  hold.merge = {
    holdForPush: async (id: string) => {
      hold.held.push(id);
      hold.pushedAtHold.push(execFileSync('git', ['-C', s.r.remote, 'branch', '--list', branch], { encoding: 'utf8' }).trim() !== '');
      if (refuse) throw new Error('auto-merge could not be turned off');
      return { disarmed: true, release: () => void hold.released.push(id) };
    },
  } as unknown as MergeService;
  return hold;
}

/** An open pull request for the branch exists on the host already (opened by hand, say) */
const alreadyOpen = (s: Setup): void => {
  writeFileSync(join(s.r.state, 'list.json'), '[{"number":9,"url":"https://github.com/acme/shop/pull/9","state":"OPEN","headRefName":"task/cw-1","baseRefName":"main","isCrossRepository":false}]\n');
};

/** The service is built before the scenario knows its remote: the stub asks whoever is set when the push comes */
const delegating = (holder: { hold: Hold | null }): MergeService =>
  ({ holdForPush: (id: string) => (holder.hold?.merge as unknown as { holdForPush: (id: string) => Promise<unknown> }).holdForPush(id) }) as unknown as MergeService;

test('golden: approve on a branch that has an open request finds it, holds it for the push and releases it', async () => {
  const holder: { hold: Hold | null } = { hold: null };
  const s = setup({ merge: delegating(holder) });
  try {
    holder.hold = holding(s, 'task/cw-1');
    const item = reviewed(s);
    s.items.checkCriterion(item.id, item.acceptanceCriteria[0]?.id ?? '', { checked: true });
    alreadyOpen(s);
    record(s.r);
    note(s.r, 'approve');
    await opened(s, item);
    const hold = holder.hold;
    const row = s.db.connection.prepare('SELECT id FROM work_item_pull_requests WHERE item_id = ?').get(item.id) as { id: string };
    assert.deepEqual(hold.held, [row.id]);
    assert.deepEqual(hold.pushedAtHold, [false], 'auto-merge is turned off before the push');
    assert.deepEqual(hold.released, [row.id], 'and the request is let go once the push is over');
    assert.equal(s.items.find(item.id)?.pullRequest?.number, 9);
    expectGolden(s.r, 'phase4', 'approve-open-existing-request');
  } finally {
    cleanup(s);
  }
});

test('approving with no request on the host holds nothing, and a hold that is refused stops the push', async () => {
  const holder: { hold: Hold | null } = { hold: null };
  const s = setup({ merge: delegating(holder) });
  try {
    holder.hold = holding(s, 'task/cw-1');
    const item = reviewed(s);
    await opened(s, item);
    assert.deepEqual(holder.hold.held, []);

    // A later pull request for the same item, on a branch whose request cannot be disarmed
    const refusing = setup({ merge: delegating(holder) });
    try {
      holder.hold = holding(refusing, 'task/cw-1', true);
      const other = reviewed(refusing);
      alreadyOpen(refusing);
      const result = await refusing.service.approve(other.id);
      assert.equal(result.status, 202);
      await refusing.service.settled();
      assert.equal(refusing.items.find(other.id)?.pullRequest?.phase, 'failed');
      assert.equal(refusing.items.find(other.id)?.pullRequest?.number ?? null, 9, 'the request found is the one named');
      assert.equal(sh(refusing.r.remote, 'branch', '--list', 'task/cw-1'), '', 'nothing was pushed');
    } finally {
      cleanup(refusing);
    }
  } finally {
    cleanup(s);
  }
});

function orchestration(s: Setup): Orchestration {
  sh(s.r.project, 'branch', '-f', BRANCH, 'main');
  sh(s.r.project, 'checkout', '-q', BRANCH);
  write(s.r.project, 'graph.ts', 'export const graph = 1;\n');
  sh(s.r.project, 'add', '-A');
  sh(s.r.project, 'commit', '-q', '-m', 'integrate the graph');
  sh(s.r.project, 'checkout', '-q', 'main');
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

test('an orchestration opening onto a branch that has a request holds it across the push, and a refusal stops the push', async () => {
  const s = setup();
  try {
    const orch = orchestration(s);
    alreadyOpen(s);
    const hold = holding(s, BRANCH);
    const path = `${s.r.bin}:${process.env.PATH ?? ''}`;
    const service = new OrchestrationPullRequestService({
      db: s.db,
      codeHost: (p) => s.service.codeHost(p),
      emit: () => undefined,
      merge: hold.merge,
      env: { PATH: path, FAKE_GH_STATE: s.r.state, FAKE_GLAB_STATE: s.r.glabState },
      searchPath: async () => path,
      run: (call, where) => runHostCall(call, { binaryPath: where.binaryPath, cwd: where.cwd, baseEnv: where.env, retry: { sleep: async () => undefined, ...(call.class === 'probe' ? { delaysMs: [] } : {}) } }),
    });
    const result = await service.open(orch);
    assert.equal(result.pullRequest?.phase, 'open');
    assert.equal(hold.held.length, 1);
    assert.deepEqual(hold.pushedAtHold, [false]);
    assert.deepEqual(hold.released, hold.held);

    // The same with a request that cannot be disarmed: the push does not happen
    const refusing = holding(s, 'agentry/other', true);
    s.db.connection.prepare('DELETE FROM orchestration_pull_requests').run();
    sh(s.r.remote, 'branch', '-D', BRANCH);
    const again = new OrchestrationPullRequestService({
      db: s.db,
      codeHost: (p) => s.service.codeHost(p),
      emit: () => undefined,
      merge: refusing.merge,
      env: { PATH: path, FAKE_GH_STATE: s.r.state, FAKE_GLAB_STATE: s.r.glabState },
      searchPath: async () => path,
      run: (call, where) => runHostCall(call, { binaryPath: where.binaryPath, cwd: where.cwd, baseEnv: where.env, retry: { sleep: async () => undefined, ...(call.class === 'probe' ? { delaysMs: [] } : {}) } }),
    });
    await assert.rejects(again.open(orch), /could not push/);
    assert.equal(sh(s.r.remote, 'branch', '--list', BRANCH), '');
  } finally {
    cleanup(s);
  }
});
