import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PullRequestWatcher } from '../src/pull-requests.ts';
import { cleanup, expectGolden, note, opened, record, reviewed, setup, sh, viewMr, type Setup } from './fixtures/pr-harness.ts';

// The scenarios of the GitHub baseline, run against fake-glab.sh (which replays the glab 1.120.0
// recordings): the same service, the same flow, a merge request in place of a pull request. Every
// call to git and glab is compared with a committed log in golden/phase1-gitlab, written once when
// the service moved behind the CodeHost adapters.

const PHASE = 'phase1-gitlab';

async function scenario(name: string, run: (s: Setup) => Promise<void>, opts: Omit<NonNullable<Parameters<typeof setup>[0]>, 'host'> = {}): Promise<void> {
  const s = setup({ ...opts, host: 'gitlab' });
  try {
    await run(s);
    expectGolden(s.r, PHASE, name);
  } finally {
    cleanup(s);
  }
}

const ready = { status: 'ready', detail: null, defaultBranch: 'main', host: 'gitlab', hostname: 'gitlab.com', remedy: null };

// ---------- readiness ----------

test('gitlab: readiness is ready on gitlab.com', () =>
  scenario('readiness-ready', async (s) => {
    record(s.r);
    assert.deepEqual(await s.service.readiness(s.r.project), ready);
  }));

test('gitlab: readiness asks glab for the default branch when origin/HEAD is not set', () =>
  scenario('readiness-no-origin-head', async (s) => {
    record(s.r);
    sh(s.r.project, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    assert.deepEqual(await s.service.readiness(s.r.project), ready);
  }));

test('gitlab: readiness when glab is signed out', () =>
  scenario('readiness-signed-out', async (s) => {
    record(s.r);
    writeFileSync(join(s.r.glabState, 'unauth-gitlab.com'), '');
    const readiness = await s.service.readiness(s.r.project);
    assert.equal(readiness.status, 'cli-signed-out');
    assert.equal(readiness.host, 'gitlab');
    assert.equal(readiness.remedy?.kind, 'sign-in');
  }));

test('gitlab: readiness when glab is missing', () =>
  scenario(
    'readiness-cli-missing',
    async (s) => {
      record(s.r);
      const readiness = await s.service.readiness(s.r.project);
      assert.equal(readiness.status, 'cli-missing');
      assert.equal(readiness.remedy?.kind, 'install');
    },
    { noGh: true },
  ));

// ---------- approving ----------

test('gitlab: approve opens a merge request, and the row is a gitlab one', () =>
  scenario('approve-open', async (s) => {
    const item = reviewed(s);
    record(s.r);
    note(s.r, 'approve');
    await opened(s, item);
    const pr = s.items.find(item.id)?.pullRequest;
    assert.equal(pr?.number, 4);
    assert.equal(pr?.host, 'gitlab');
    assert.equal(pr?.ref, '!4');
    assert.equal(pr?.url, 'https://gitlab.com/acme/shop/-/merge_requests/4');
  }));

test('gitlab: approve when a merge request already exists for the branch', () =>
  scenario('approve-already-exists', async (s) => {
    const item = reviewed(s);
    writeFileSync(join(s.r.glabState, 'dup'), '');
    record(s.r);
    note(s.r, 'approve');
    await opened(s, item);
    assert.equal(s.items.find(item.id)?.pullRequest?.number, 7);
  }));

// ---------- watching ----------

test('gitlab: the watcher follows a merge request from a running pipeline to failed, passed and merged', () =>
  scenario('watch-merged', async (s) => {
    const item = reviewed(s);
    await opened(s, item);
    record(s.r);
    const watcher = new PullRequestWatcher(s.service);
    for (const [label, pipeline] of [
      ['pending', 'running'],
      ['failing', 'failed'],
      ['passing', 'success'],
    ] as const) {
      note(s.r, `tick, ci ${label}`);
      viewMr(s.r, 'opened', pipeline);
      await watcher.tick();
      assert.equal(s.items.find(item.id)?.pullRequest?.ci, label);
    }
    note(s.r, 'tick, merged');
    viewMr(s.r, 'merged', 'success');
    await watcher.tick();
    assert.equal(s.items.find(item.id)?.status, 'done');
  }));

test('gitlab: the watcher sees a merge request closed without merging', () =>
  scenario('watch-closed', async (s) => {
    const item = reviewed(s);
    await opened(s, item);
    record(s.r);
    const watcher = new PullRequestWatcher(s.service);
    note(s.r, 'tick, open');
    viewMr(s.r, 'opened');
    await watcher.tick();
    note(s.r, 'tick, closed');
    viewMr(s.r, 'closed');
    await watcher.tick();
    assert.equal(s.items.find(item.id)?.pullRequest?.phase, 'closed');
  }));

test('gitlab: after a glab failure the watcher backs off, and a refresh still asks', () =>
  scenario('watch-backoff', async (s) => {
    const item = reviewed(s);
    await opened(s, item);
    record(s.r);
    const watcher = new PullRequestWatcher(s.service);
    writeFileSync(join(s.r.glabState, 'fail'), '');
    note(s.r, 'tick, glab fails');
    await watcher.tick();
    note(s.r, 'tick, backed off: no call');
    await watcher.tick();
    rmSync(join(s.r.glabState, 'fail'));
    viewMr(s.r, 'opened', 'success');
    note(s.r, 'refresh');
    await s.service.refresh(item.id);
    assert.equal(s.items.find(item.id)?.pullRequest?.ci, 'passing');
  }));

test("gitlab: a person's refresh asks glab about the open merge request", () =>
  scenario('refresh', async (s) => {
    const item = reviewed(s);
    await opened(s, item);
    record(s.r);
    viewMr(s.r, 'opened', 'running');
    note(s.r, 'refresh');
    const refreshed = await s.service.refresh(item.id);
    assert.equal(refreshed.pullRequest?.ci, 'pending');
  }));
