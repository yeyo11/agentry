import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PullRequestWatcher } from '../src/pull-requests.ts';
import { cleanup, expectGolden, note, opened, record, reviewed, setup, sh, view, type Setup } from './fixtures/pr-harness.ts';

// The GitHub baseline: today's PullRequestService runs through fixed scenarios, and every call it
// makes to git and gh (arguments, the variables set around gh, the body on stdin) is compared with
// a committed log. The logs are the contract any later adapter must keep, byte for byte, except for
// the differences a task declares. Only the task that wrote them may run with UPDATE_GOLDEN=1.

const PHASE = 'phase1';

async function scenario(name: string, run: (s: Setup) => Promise<void>, opts: Parameters<typeof setup>[0] = {}): Promise<void> {
  const s = setup(opts);
  try {
    await run(s);
    expectGolden(s.r, PHASE, name);
  } finally {
    cleanup(s);
  }
}

// ---------- readiness ----------

test('golden: readiness is ready on github.com', () =>
  scenario('readiness-ready', async (s) => {
    record(s.r);
    assert.deepEqual(await s.service.readiness(s.r.project), { status: 'ready', detail: null, defaultBranch: 'main', host: 'github', hostname: 'github.com', remedy: null });
  }));

test('golden: readiness asks gh for the default branch when origin/HEAD is not set', () =>
  scenario('readiness-no-origin-head', async (s) => {
    record(s.r);
    sh(s.r.project, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    assert.deepEqual(await s.service.readiness(s.r.project), { status: 'ready', detail: null, defaultBranch: 'main', host: 'github', hostname: 'github.com', remedy: null });
  }));

test('golden: readiness when gh is signed out', () =>
  scenario('readiness-signed-out', async (s) => {
    record(s.r);
    writeFileSync(join(s.r.state, 'unauth'), '');
    assert.equal((await s.service.readiness(s.r.project)).status, 'cli-signed-out');
  }));

test('golden: readiness when gh is missing', () =>
  scenario(
    'readiness-gh-missing',
    async (s) => {
      record(s.r);
      assert.equal((await s.service.readiness(s.r.project)).status, 'cli-missing');
    },
    { noGh: true },
  ));

test('golden: readiness on an enterprise host gh knows', () =>
  scenario('readiness-enterprise-known', async (s) => {
    record(s.r);
    sh(s.r.project, 'remote', 'set-url', 'origin', 'https://github.example.com/acme/shop.git');
    writeFileSync(join(s.r.state, 'hosts'), 'github.com github.example.com');
    assert.deepEqual(await s.service.readiness(s.r.project), { status: 'ready', detail: null, defaultBranch: 'main', host: 'github', hostname: 'github.example.com', remedy: null });
  }));

test('golden: readiness on an enterprise host gh does not know', () =>
  scenario('readiness-enterprise-unknown', async (s) => {
    record(s.r);
    sh(s.r.project, 'remote', 'set-url', 'origin', 'https://github.example.com/acme/shop.git');
    assert.equal((await s.service.readiness(s.r.project)).status, 'unsupported-host');
  }));

// ---------- approving ----------

test('golden: approve opens a pull request', () =>
  scenario('approve-open', async (s) => {
    const item = reviewed(s);
    s.items.checkCriterion(item.id, item.acceptanceCriteria[0]?.id ?? '', { checked: true });
    record(s.r);
    note(s.r, 'approve');
    await opened(s, item);
    assert.equal(s.items.find(item.id)?.pullRequest?.number, 7);
  }));

test('golden: approve when a pull request already exists for the branch', () =>
  scenario('approve-already-exists', async (s) => {
    const item = reviewed(s);
    writeFileSync(join(s.r.state, 'exists'), '');
    record(s.r);
    note(s.r, 'approve');
    await opened(s, item);
    assert.equal(s.items.find(item.id)?.pullRequest?.number, 7);
  }));

// ---------- watching ----------

test('golden: the watcher follows a pull request from pending CI to failing, passing and merged', () =>
  scenario('watch-merged', async (s) => {
    const item = reviewed(s);
    await opened(s, item);
    record(s.r);
    const watcher = new PullRequestWatcher(s.service);
    for (const [label, rollup] of [
      ['pending', [{ status: 'IN_PROGRESS', conclusion: '' }]],
      ['failing', [{ status: 'COMPLETED', conclusion: 'FAILURE' }]],
      ['passing', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]],
    ] as const) {
      note(s.r, `tick, ci ${label}`);
      view(s.r, 'OPEN', [...rollup]);
      await watcher.tick();
      assert.equal(s.items.find(item.id)?.pullRequest?.ci, label);
    }
    note(s.r, 'tick, merged');
    view(s.r, 'MERGED', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]);
    await watcher.tick();
    assert.equal(s.items.find(item.id)?.status, 'done');
  }));

test('golden: the watcher sees a pull request closed without merging', () =>
  scenario('watch-closed', async (s) => {
    const item = reviewed(s);
    await opened(s, item);
    record(s.r);
    const watcher = new PullRequestWatcher(s.service);
    note(s.r, 'tick, open');
    view(s.r, 'OPEN');
    await watcher.tick();
    note(s.r, 'tick, closed');
    view(s.r, 'CLOSED');
    await watcher.tick();
    assert.equal(s.items.find(item.id)?.pullRequest?.phase, 'closed');
  }));

test('golden: after a gh failure the watcher backs off, and a refresh still asks', () =>
  scenario('watch-backoff', async (s) => {
    const item = reviewed(s);
    await opened(s, item);
    record(s.r);
    const watcher = new PullRequestWatcher(s.service);
    writeFileSync(join(s.r.state, 'fail'), '');
    note(s.r, 'tick, gh fails');
    await watcher.tick();
    note(s.r, 'tick, backed off: no call');
    await watcher.pass();
    rmSync(join(s.r.state, 'fail'));
    view(s.r, 'OPEN', [{ state: 'SUCCESS' }]);
    note(s.r, 'refresh');
    await s.service.refresh(item.id);
    assert.equal(s.items.find(item.id)?.pullRequest?.ci, 'passing');
  }));

test("golden: a person's refresh asks gh about the open pull request", () =>
  scenario('refresh', async (s) => {
    const item = reviewed(s);
    await opened(s, item);
    record(s.r);
    view(s.r, 'OPEN', [{ status: 'IN_PROGRESS', conclusion: '' }]);
    note(s.r, 'refresh');
    const refreshed = await s.service.refresh(item.id);
    assert.equal(refreshed.pullRequest?.ci, 'pending');
  }));
