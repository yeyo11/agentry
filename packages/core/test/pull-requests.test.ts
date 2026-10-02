import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentryEvent, FlowCriterionResult, IssueRef, WorkItem, WorkItemHistoryPullRequest } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { flowPrompt, stageRules } from '../src/flow.ts';
import { branchExists, mergeInProgress } from '../src/git.ts';
import { ISSUE_TEXT_MARK, neutralizeClosing } from '../src/trackers/links.ts';
import { ciOf, pullRequestBody, pullRequestTitle, PullRequestWatcher, WATCH_BACKOFF } from '../src/pull-requests.ts';
import { itemWorktree } from '../src/work-links.ts';
import { WorkItemService } from '../src/work-items.ts';
import { cleanup, landOnMain, opened, repo, reviewed, setup, sh, view, write, type Repo, type Setup } from './fixtures/pr-harness.ts';

// A project with a bare repository beside it as `origin` (named as github.com for the tests), and a
// fake `gh` on the PATH (fixtures/fake-gh.sh) that answers as GitHub would and writes down what it
// was asked. Everything else is real git. The project is built by fixtures/pr-harness.ts.

const calls = (r: Repo): string[] => (existsSync(join(r.state, 'calls')) ? readFileSync(join(r.state, 'calls'), 'utf8').trim().split('\n') : []);
const creates = (r: Repo): string[] => calls(r).filter((c) => c.startsWith('pr create'));
const remoteHas = (r: Repo, branch: string): boolean => execFileSync('git', ['-C', r.remote, 'branch', '--list', branch], { encoding: 'utf8' }).trim() !== '';
const prEntries = (s: Setup, itemId: string) =>
  s.items
    .history(itemId)
    .filter((e) => e.change === 'pull_request')
    .map((e) => e.to as WorkItemHistoryPullRequest);
const lastMove = (s: Setup, itemId: string) =>
  s.items
    .history(itemId)
    .filter((e) => e.change === 'status')
    .pop();

type Refusal = { statusCode: number; reason: string | null };
const refusedWith = (status: number, reason?: string) => (err: Refusal) => err.statusCode === status && (reason === undefined || err.reason === reason);

// ---------- what the PR says ----------

test("a PR's title is Conventional, typed by a Conventional label or else fix for a bug and feat for the rest", () => {
  assert.equal(pullRequestTitle({ key: 'CW-3', title: 'Fix the cart', type: 'bug', labels: [] }), 'fix: Fix the cart (CW-3)');
  assert.equal(pullRequestTitle({ key: 'CW-4', title: 'Add a cart', type: 'story', labels: ['ui'] }), 'feat: Add a cart (CW-4)');
  assert.equal(pullRequestTitle({ key: 'CW-5', title: 'Explain the flow', type: 'task', labels: ['area', 'Docs'] }), 'docs: Explain the flow (CW-5)');
  const long = pullRequestTitle({ key: 'CW-6', title: 'x'.repeat(200), type: 'task', labels: [] });
  assert.ok(long.endsWith(' (CW-6)'));
  assert.ok(long.length <= 72 + ' (CW-6)'.length);
});

test("a PR's body carries the description, each criterion with QA's note and a link to the card", () => {
  const body = pullRequestBody(
    {
      key: 'CW-9',
      description: 'The total was off by one.',
      acceptanceCriteria: [
        { id: 'a', text: 'The total adds up', checked: true, checkedBy: null },
        { id: 'b', text: 'A test covers it', checked: false, checkedBy: null },
      ],
    },
    [{ id: 'a', met: true, note: 'cart.test.ts passes' }],
    'http://localhost:8787/',
  );
  assert.match(body, /^The total was off by one\./);
  assert.match(body, /## Acceptance criteria\n\n- \[x\] The total adds up — cart\.test\.ts passes\n- \[ \] A test covers it/);
  assert.match(body, /## Work item\n\n\[CW-9\]\(http:\/\/localhost:8787\/tasks\/CW-9\)/);
});

test('the issues of an item go into the title (Jira, YouTrack) and a Linked issue section of the body', () => {
  const issues = [
    { tracker: 'jira' as const, scope: 'PROJ', key: 'PROJ-12', externalId: null, title: 't', state: 'open', url: null, importedAt: '', syncedAt: null, syncState: 'none' as const, syncReason: null },
    { tracker: 'youtrack' as const, scope: 'AB', key: 'AB-3', externalId: null, title: 't', state: 'open', url: null, importedAt: '', syncedAt: null, syncState: 'none' as const, syncReason: null },
  ];
  assert.equal(pullRequestTitle({ key: 'CW-3', title: 'Fix the cart', type: 'bug', labels: [], issues }), 'fix: Fix the cart (CW-3, PROJ-12, AB-3)');
  const body = pullRequestBody({ key: 'CW-9', description: 'd', acceptanceCriteria: [] }, [], null, ['Closes #12']);
  assert.match(body, /^d\n\n## Linked issue\n\nCloses #12\n\n## Work item/);
  assert.ok(!pullRequestBody({ key: 'CW-9', description: 'd', acceptanceCriteria: [] }, [], null).includes('Linked issue'));
});

test('statusCheckRollup maps to none, pending, passing and failing', () => {
  assert.equal(ciOf([]), 'none');
  assert.equal(ciOf(null), 'none');
  assert.equal(ciOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
  assert.equal(ciOf([{ state: 'PENDING' }]), 'pending');
  assert.equal(ciOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }, { state: 'SUCCESS' }]), 'passing');
  assert.equal(ciOf([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'QUEUED' }]), 'failing');
  assert.equal(ciOf([{ status: 'COMPLETED', conclusion: 'TIMED_OUT' }]), 'failing');
  assert.equal(ciOf([{ status: 'COMPLETED', conclusion: 'CANCELLED' }]), 'failing');
});

test('no stage of the flow may push, the work run that resolves a conflict included', () => {
  const extra = { documentsPath: 'docs', testCommands: ['Bash(pnpm test)'] };
  const variants = [
    stageRules('refine', undefined, extra),
    stageRules('verify', undefined, extra),
    stageRules('work', undefined, extra),
    stageRules('work', ['src'], extra),
    stageRules('work', undefined, { ...extra, commands: ['git *'] }),
    stageRules('work', ['src'], { ...extra, commands: [] }),
  ];
  for (const rules of variants) {
    assert.ok(rules.disallowedTools.includes('Bash(git push)'));
    assert.ok(rules.disallowedTools.includes('Bash(git push *)'));
  }
});

// ---------- readiness ----------

test('a project with no remote, no gh, gh not logged in, a host gh does not know or no git says why it cannot open a PR', async () => {
  const s = setup();
  try {
    assert.deepEqual(await s.service.readiness(s.r.project), { status: 'ready', detail: null, defaultBranch: 'main', host: 'github', hostname: 'github.com', remedy: null });

    writeFileSync(join(s.r.state, 'unauth'), '');
    s.service.forgetReadiness();
    const unauth = await s.service.readiness(s.r.project);
    assert.equal(unauth.status, 'cli-signed-out');
    assert.match(unauth.detail ?? '', /not logged into any GitHub hosts/);

    // A host that neither gh nor glab knows is never sent to a CLI
    sh(s.r.project, 'remote', 'set-url', 'origin', 'https://git.example.org/acme/shop.git');
    s.service.forgetReadiness();
    assert.equal((await s.service.readiness(s.r.project)).status, 'unsupported-host');
    rmSync(join(s.r.state, 'unauth'));

    // Only git on the PATH: gh is missing
    sh(s.r.project, 'remote', 'set-url', 'origin', s.r.remote);
    s.service.forgetReadiness();
    const bare = setup({ r: s.r, noGh: true });
    assert.equal((await bare.service.readiness(s.r.project)).status, 'cli-missing');

    sh(s.r.project, 'remote', 'remove', 'origin');
    s.service.forgetReadiness();
    assert.equal((await s.service.readiness(s.r.project)).status, 'no-remote');

    const plain = mkdtempSync(join(tmpdir(), 'agentry-plain-'));
    assert.equal((await s.service.readiness(plain)).status, 'not-git');
    rmSync(plain, { recursive: true, force: true });
  } finally {
    cleanup(s);
  }
});

test('readiness is cached for a minute, so a board read does not ask gh every time', async () => {
  const s = setup();
  try {
    await s.service.readiness(s.r.project);
    const asked = calls(s.r).length;
    await s.service.readiness(s.r.project);
    await s.service.readiness(s.r.project);
    assert.equal(calls(s.r).length, asked);
  } finally {
    cleanup(s);
  }
});

// ---------- approving ----------

test('approving commits what is left, merges origin/main into the branch, pushes it and opens exactly one PR', async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    s.items.checkCriterion(item.id, item.acceptanceCriteria[0]?.id ?? '', { checked: true });
    landOnMain(s.r, 'shipping.ts', 'export const fee = 3;\n');
    // What QA verified and nobody committed
    write(item.worktree ?? '', 'cart.test.ts', 'test\n');

    const result = await s.service.approve(item.id);
    assert.equal(result.status, 202);
    assert.equal(result.pullRequest.phase, 'preparing');
    await s.service.settled();

    const after = s.items.find(item.id);
    assert.equal(after?.status, 'in_review');
    assert.equal(after?.waiting, 'merge');
    assert.equal(after?.pullRequest?.phase, 'open');
    assert.equal(after?.pullRequest?.number, 7);
    assert.equal(after?.pullRequest?.url, 'https://github.com/acme/shop/pull/7');
    assert.equal(after?.pullRequest?.branch, 'task/cw-1');
    assert.equal(after?.pullRequest?.base, 'main');

    const wt = item.worktree ?? '';
    assert.equal(sh(wt, 'status', '--porcelain'), '');
    assert.match(sh(wt, 'log', '--format=%s'), /chore\(cw-1\): keep the work QA verified/);
    assert.ok(existsSync(join(wt, 'shipping.ts')), 'origin/main was merged into the branch');
    assert.ok(remoteHas(s.r, 'task/cw-1'), 'the branch was pushed');
    assert.equal(sh(s.r.remote, 'rev-parse', 'task/cw-1'), sh(wt, 'rev-parse', 'HEAD'));

    assert.equal(creates(s.r).length, 1);
    assert.match(readFileSync(join(s.r.state, 'create-7'), 'utf8'), /--head task\/cw-1 --base main --title feat: Fix the cart total \(CW-1\) --body-file -/);
    const body = readFileSync(join(s.r.state, 'body-7'), 'utf8');
    assert.match(body, /The total was off by one\./);
    assert.match(body, /- \[x\] The total adds up/);
    assert.match(body, /- \[ \] A test covers it/);
    assert.match(body, /http:\/\/localhost:8787\/tasks\/CW-1/);
    assert.deepEqual(prEntries(s, item.id), [{ phase: 'open', number: 7, url: 'https://github.com/acme/shop/pull/7', conflicts: [] }]);

    // A second approval while it is open answers the same PR and opens nothing
    const again = await s.service.approve(item.id);
    assert.equal(again.status, 200);
    assert.equal(again.pullRequest.number, 7);
    await s.service.settled();
    assert.equal(creates(s.r).length, 1);
  } finally {
    cleanup(s);
  }
});

test('an item with a linked issue opens its PR with Closes in the body, into the default branch', async () => {
  const s = setup({ tracker: { id: 'github-issues', scope: 'acme/shop', query: '', statusMap: {} } });
  try {
    const item = reviewed(s);
    s.items.linkIssue(item.id, { tracker: 'github-issues', scope: 'acme/shop', key: '12', externalId: null, title: 'The total is wrong', state: 'open', url: null });
    await s.service.approve(item.id);
    await s.service.settled();
    const body = readFileSync(join(s.r.state, 'body-7'), 'utf8');
    assert.match(body, /## Linked issue\n\nCloses #12\n/);
    assert.match(readFileSync(join(s.r.state, 'create-7'), 'utf8'), /--title feat: Fix the cart total \(CW-1\) --body-file -/);
  } finally {
    cleanup(s);
  }
});

test("QA's notes from its newest passing verification go into the PR's body", async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    const [first] = item.acceptanceCriteria;
    assert.ok(first);
    const noted = setup({ r: s.r, db: s.db, verdicts: [{ id: first.id, met: true, note: 'the cart test passes' }] });
    await noted.service.approve(item.id);
    await noted.service.settled();
    assert.match(readFileSync(join(s.r.state, 'body-7'), 'utf8'), /- \[x\] The total adds up — the cart test passes/);
  } finally {
    cleanup(s);
  }
});

test('approving refuses an epic, an item not in review, one being worked on, nothing to propose and a project that is not ready', async () => {
  const s = setup();
  try {
    const epic = s.items.create('p1', { title: 'Checkout', type: 'epic', status: 'in_review' });
    await assert.rejects(s.service.approve(epic.id), refusedWith(400));

    const todo = s.items.create('p1', { title: 'Later', status: 'todo' });
    await assert.rejects(s.service.approve(todo.id), refusedWith(409, 'not-in-review'));

    const item = reviewed(s);
    s.busy.add(item.id);
    await assert.rejects(s.service.approve(item.id), refusedWith(409, 'busy'));
    s.busy.delete(item.id);

    // A branch with no commit ahead of main and nothing uncommitted
    const idle = s.items.create('p1', { title: 'Nothing yet', status: 'todo' });
    const place = itemWorktree(s.r.project, { ...idle, projectId: 'p1' });
    assert.ok(place);
    s.items.setWorktree(idle.id, { worktree: place.worktree, branch: place.branch });
    s.items.move(idle.id, { status: 'in_review' });
    await assert.rejects(s.service.approve(idle.id), refusedWith(409, 'nothing-to-propose'));

    writeFileSync(join(s.r.state, 'unauth'), '');
    s.service.forgetReadiness();
    await assert.rejects(s.service.approve(item.id), refusedWith(409, 'cli-signed-out'));
    assert.equal(creates(s.r).length, 0);
    assert.equal(s.items.find(item.id)?.pullRequest ?? null, null);
  } finally {
    cleanup(s);
  }
});

test('a failed push records its step and the first line of error, and the item waits for approval again', async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    // A remote that refuses every push
    writeFileSync(join(s.r.remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected by policy" >&2\nexit 1\n');
    chmodSync(join(s.r.remote, 'hooks', 'pre-receive'), 0o755);
    await s.service.approve(item.id);
    await s.service.settled();
    const after = s.items.find(item.id);
    assert.equal(after?.pullRequest?.phase, 'failed');
    assert.equal(after?.pullRequest?.error?.code, 'push');
    assert.ok(after?.pullRequest?.error?.detail);
    assert.ok(!after?.pullRequest?.error?.detail.includes('\n'));
    assert.equal(after?.waiting, 'approval');
    assert.equal(creates(s.r).length, 0);
  } finally {
    cleanup(s);
  }
});

// ---------- conflicts ----------

test('a conflict pushes nothing, keeps the merge in the worktree and sends the item back to work as the person with the paths named', async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    landOnMain(s.r, 'cart.ts', 'export const total = 3;\n');
    const result = await s.service.approve(item.id);
    assert.equal(result.status, 202);
    await s.service.settled();

    const after = s.items.find(item.id);
    assert.equal(after?.status, 'in_progress');
    assert.equal(after?.pullRequest?.phase, 'conflict');
    assert.deepEqual(after?.pullRequest?.conflicts, ['cart.ts']);
    assert.ok(mergeInProgress(item.worktree ?? ''));
    assert.ok(!remoteHas(s.r, 'task/cw-1'), 'nothing was pushed');
    assert.equal(creates(s.r).length, 0);

    const moved = lastMove(s, item.id);
    assert.equal(moved?.actor.kind, 'person');
    assert.equal(moved?.cause?.event, 'pr.conflict');
    assert.deepEqual(prEntries(s, item.id), [{ phase: 'conflict', number: null, url: null, conflicts: ['cart.ts'] }]);

    const conflict = s.service.conflictOf(item.id);
    assert.deepEqual(conflict, { base: 'main', paths: ['cart.ts'] });
    const prompt = flowPrompt('work', 'in_progress', after ?? item, { role: 'developer', agent: 'developer', model: 'opus', responsibility: 'Implements' }, { documentsPath: 'docs', rejection: null, conflict });
    assert.match(prompt, /Resolve the merge of `main` into this branch/);
    assert.match(prompt, /- `cart\.ts`/);
    assert.match(prompt, /Do not push/);
  } finally {
    cleanup(s);
  }
});

test('after the conflict run, conflicts left fail it, a resolved merge is committed, and QA passing opens the PR with no second approval', async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    landOnMain(s.r, 'cart.ts', 'export const total = 3;\n');
    await s.service.approve(item.id);
    await s.service.settled();
    const wt = item.worktree ?? '';

    // The Developer's run ended with the markers still there
    assert.deepEqual(s.service.settleConflict(item.id), ['cart.ts']);
    assert.equal(s.items.find(item.id)?.pullRequest?.phase, 'conflict');

    // Resolved and staged, but the merge left for Agentry to commit
    write(wt, 'cart.ts', 'export const total = 4;\n');
    sh(wt, 'add', 'cart.ts');
    assert.equal(s.service.settleConflict(item.id), null);
    assert.ok(!mergeInProgress(wt));
    assert.match(sh(wt, 'log', '-1', '--format=%s'), /Merge origin\/main into task\/cw-1/);
    assert.equal(s.items.find(item.id)?.pullRequest?.phase, 'awaiting-verify');

    // The flow moves it to review and QA passes it: no second click
    s.items.move(item.id, { status: 'in_review' }, { actor: { kind: 'agent', role: 'developer' } });
    s.service.verified(item.id);
    await s.service.settled();
    const after = s.items.find(item.id);
    assert.equal(after?.pullRequest?.phase, 'open');
    assert.equal(after?.waiting, 'merge');
    assert.ok(remoteHas(s.r, 'task/cw-1'));
    assert.equal(creates(s.r).length, 1);
  } finally {
    cleanup(s);
  }
});

test("a person's move after the conflict drops the remembered approval, and QA's pass then opens nothing", async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    landOnMain(s.r, 'cart.ts', 'export const total = 3;\n');
    await s.service.approve(item.id);
    await s.service.settled();
    const wt = item.worktree ?? '';
    write(wt, 'cart.ts', 'export const total = 4;\n');
    sh(wt, 'add', 'cart.ts');
    s.service.settleConflict(item.id);
    // The person takes it to review themselves
    s.items.move(item.id, { status: 'in_review' });
    s.service.verified(item.id);
    await s.service.settled();
    assert.equal(s.items.find(item.id)?.pullRequest ?? null, null);
    assert.equal(creates(s.r).length, 0);
  } finally {
    cleanup(s);
  }
});

// ---------- the watcher ----------

test('the watcher writes the CI state and announces the item only when it changes', async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    await opened(s, item);
    const watcher = new PullRequestWatcher(s.service);
    const updates = () => s.events.filter((e) => e.type === 'workitem.updated' && e.itemId === item.id).length;

    view(s.r, 'OPEN', [{ status: 'IN_PROGRESS', conclusion: '' }]);
    let before = updates();
    await watcher.tick();
    assert.equal(s.items.find(item.id)?.pullRequest?.ci, 'pending');
    assert.equal(updates(), before + 1);

    before = updates();
    await watcher.tick();
    assert.equal(updates(), before, 'the same state is not announced again');
    assert.ok(s.items.find(item.id)?.pullRequest?.checkedAt);

    view(s.r, 'OPEN', [{ status: 'COMPLETED', conclusion: 'FAILURE' }]);
    await watcher.tick();
    assert.equal(s.items.find(item.id)?.pullRequest?.ci, 'failing');
    view(s.r, 'OPEN', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]);
    await watcher.tick();
    assert.equal(s.items.find(item.id)?.pullRequest?.ci, 'passing');
    assert.equal(s.items.find(item.id)?.status, 'in_review');
  } finally {
    cleanup(s);
  }
});

test('after a gh error the watcher leaves the row alone for the pacer’s first failure step, and a refresh still asks', async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    await opened(s, item);
    const watcher = new PullRequestWatcher(s.service);
    writeFileSync(join(s.r.state, 'fail'), '');
    const views = () => calls(s.r).filter((c) => c.startsWith('pr view 7')).length;
    await watcher.tick();
    // The execution layer retries a read that fails with nothing structured, twice
    assert.equal(views(), 3);
    await watcher.pass();
    assert.equal(views(), 3, 'backed off');
    rmSync(join(s.r.state, 'fail'));
    view(s.r, 'OPEN', [{ state: 'SUCCESS' }]);
    await s.service.refresh(item.id);
    assert.equal(views(), 4);
    assert.equal(s.items.find(item.id)?.pullRequest?.ci, 'passing');
  } finally {
    cleanup(s);
  }
});

test('a merged PR moves the item to Done as the person, removes its clean worktree, keeps its branch and fast-forwards a clean checkout', async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    await opened(s, item);
    const wt = item.worktree ?? '';
    // "GitHub" squash-merges it
    landOnMain(s.r, 'cart.ts', 'export const total = 2;\n');
    view(s.r, 'MERGED', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]);
    await new PullRequestWatcher(s.service).tick();

    const after = s.items.find(item.id);
    assert.equal(after?.status, 'done');
    assert.equal(after?.waiting ?? null, null);
    assert.equal(after?.pullRequest?.phase, 'merged');
    const moved = lastMove(s, item.id);
    assert.equal(moved?.actor.kind, 'person');
    assert.equal(moved?.cause?.event, 'pr.merged');
    assert.deepEqual(prEntries(s, item.id).pop(), { phase: 'merged', number: 7, url: 'https://github.com/acme/shop/pull/7', conflicts: [] });

    assert.ok(!existsSync(wt), 'the worktree was removed');
    assert.ok(branchExists(s.r.project, 'task/cw-1'), 'the branch stays for Changes');
    assert.equal(after?.branch, 'task/cw-1');
    assert.equal(sh(s.r.project, 'rev-parse', 'HEAD'), sh(s.r.project, 'rev-parse', 'origin/main'));
    assert.deepEqual(s.service.checkout(s.r.project, 'main'), { defaultBranch: 'main', branch: 'main', behind: 0, reason: null });
  } finally {
    cleanup(s);
  }
});

test('a merged PR tells the tracker sync once, after the item is Done, and what the host says it closed', async () => {
  const told: Array<{ itemId: string; closed: unknown; host: string; status: string | undefined }> = [];
  const holder: { s?: Setup } = {};
  const s = setup({
    onMerged: async (notice) => {
      told.push({ ...notice, status: holder.s?.items.find(notice.itemId)?.status });
      return { closedUnlinked: [] };
    },
  });
  holder.s = s;
  try {
    const item = reviewed(s);
    await opened(s, item);
    view(s.r, 'MERGED', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]);
    await new PullRequestWatcher(s.service).tick();
    await new PullRequestWatcher(s.service).tick();
    // no tracker on the project: nothing a host closes is its, and nothing is read
    assert.deepEqual(told, [{ itemId: item.id, closed: [], host: 'github', status: 'done' }]);
  } finally {
    cleanup(s);
  }
});

test('a merged PR reaches Done from any column the item was moved to meanwhile', async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    await opened(s, item);
    s.items.move(item.id, { status: 'todo' });
    view(s.r, 'MERGED');
    await new PullRequestWatcher(s.service).tick();
    assert.equal(s.items.find(item.id)?.status, 'done');
  } finally {
    cleanup(s);
  }
});

test('a merged PR leaves a dirty checkout and a dirty worktree alone, and the checkout says why it is behind', async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    await opened(s, item);
    const wt = item.worktree ?? '';
    write(wt, 'notes.md', 'left behind\n');
    write(s.r.project, 'README.md', 'edited by the person\n');
    landOnMain(s.r, 'cart.ts', 'export const total = 2;\n');
    view(s.r, 'MERGED');
    await new PullRequestWatcher(s.service).tick();

    const after = s.items.find(item.id);
    assert.equal(after?.status, 'done');
    assert.ok(existsSync(wt), 'a worktree with uncommitted work is kept');
    assert.equal(after?.pullRequest?.error?.code, 'worktree-kept');
    assert.deepEqual(s.service.checkout(s.r.project, 'main'), { defaultBranch: 'main', branch: 'main', behind: 1, reason: 'dirty' });

    sh(s.r.project, 'checkout', '-q', '--', 'README.md');
    sh(s.r.project, 'checkout', '-q', '-b', 'spike');
    assert.equal(s.service.checkout(s.r.project, 'main')?.reason, 'not-on-default');
    sh(s.r.project, 'checkout', '-q', 'main');
    write(s.r.project, 'local.md', 'x\n');
    sh(s.r.project, 'add', '-A');
    sh(s.r.project, 'commit', '-q', '-m', 'local only');
    assert.equal(s.service.checkout(s.r.project, 'main')?.reason, 'diverged');
  } finally {
    cleanup(s);
  }
});

test('a merge is handled once even with two processes watching one database', async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    await opened(s, item);
    const second = setup({ r: s.r, db: s.db });
    landOnMain(s.r, 'cart.ts', 'export const total = 2;\n');
    view(s.r, 'MERGED');
    await Promise.all([new PullRequestWatcher(s.service).tick(), new PullRequestWatcher(second.service).tick()]);
    const merges = s.items.history(item.id).filter((e) => e.change === 'status' && e.cause?.event === 'pr.merged');
    assert.equal(merges.length, 1);
    assert.equal(prEntries(s, item.id).filter((e) => e.phase === 'merged').length, 1);
  } finally {
    cleanup(s);
  }
});

test('a PR closed without merging leaves the item in review waiting for approval, and approving again opens a new one', async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    await opened(s, item);
    view(s.r, 'CLOSED');
    await new PullRequestWatcher(s.service).tick();

    const after = s.items.find(item.id);
    assert.equal(after?.status, 'in_review');
    assert.equal(after?.waiting, 'approval');
    assert.equal(after?.pullRequest?.phase, 'closed');
    assert.equal(after?.pullRequest?.number, 7);
    assert.equal(prEntries(s, item.id).pop()?.phase, 'closed');
    const waited = s.items
      .history(item.id)
      .filter((e) => e.change === 'waiting')
      .pop();
    assert.equal(waited?.cause?.event, 'pr.closed');

    writeFileSync(join(s.r.state, 'next'), '8');
    rmSync(join(s.r.state, 'view.json'));
    const again = await s.service.approve(item.id);
    assert.equal(again.status, 202);
    await s.service.settled();
    assert.equal(s.items.find(item.id)?.pullRequest?.number, 8);
    assert.equal(creates(s.r).length, 2);
    assert.deepEqual(
      s.service.all(item.id).map((p) => [p.phase, p.number]),
      [
        ['closed', 7],
        ['open', 8],
      ],
    );
  } finally {
    cleanup(s);
  }
});

test('the timings and limits moved from the GitHub-only service are unchanged', () => {
  assert.equal(WATCH_BACKOFF, 5 * 60_000);
  const title = pullRequestTitle({ key: 'CW-1', title: 'x'.repeat(200), type: 'task', labels: [] });
  assert.equal(title, `feat: ${'x'.repeat(65)}… (CW-1)`);
  const body = pullRequestBody({ key: 'CW-1', description: 'y'.repeat(70_000), acceptanceCriteria: [] }, [], null);
  assert.ok(body.startsWith('y'.repeat(60_000)) && body.endsWith('… cut at 60000 characters'));
});

test('an issue text cannot close another issue: every closing word, both hosts references', () => {
  const words = ['close', 'closes', 'closed', 'closing', 'fix', 'fixes', 'fixed', 'fixing', 'resolve', 'resolves', 'resolved', 'resolving'];
  const refs = ['#99', 'acme/shop#99', 'group/sub/project#99', 'https://github.com/acme/shop/issues/99', 'https://gitlab.com/group/project/-/issues/99', 'GH-99'];
  const issues = [{ tracker: 'github-issues', key: '12' }] as unknown as IssueRef[];
  for (const word of words) {
    for (const casing of [word, word.toUpperCase(), `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`]) {
      for (const ref of refs) {
        const title = pullRequestTitle({ key: 'CW-3', title: `${casing} ${ref}`, type: 'task', labels: [], issues });
        assert.ok(title.includes(`${casing} \`${ref}\``), title);
        assert.equal(neutralizeClosing(`${casing}: ${ref}`), `${casing}: \`${ref}\``);
      }
    }
  }
  assert.equal(pullRequestTitle({ key: 'CW-3', title: 'Closes #99', type: 'task', labels: [], issues }), 'feat: Closes `#99` (CW-3)');
  assert.equal(neutralizeClosing('Fixes: #1, #2 and #3'), 'Fixes: `#1`, `#2` and `#3`');
  assert.equal(neutralizeClosing('Closes #1\nresolves\n#2'), 'Closes `#1`\nresolves\n`#2`');
  // Words that are not closing words, and references with no word, stay as written
  assert.equal(neutralizeClosing('Prefix #99 and enclose #5, see #7'), 'Prefix #99 and enclose #5, see #7');
  // A card nobody linked to an issue keeps the title its author wrote
  assert.equal(pullRequestTitle({ key: 'CW-3', title: 'Closes #99', type: 'task', labels: [], issues: [] }), 'feat: Closes #99 (CW-3)');
});

test('the body neutralises an imported description, but not the linked issue lines', () => {
  const description = `> **From GitHub Issues #12** — ${ISSUE_TEXT_MARK}\n>\n> Fixes #99`;
  const body = pullRequestBody({ key: 'CW-3', description, acceptanceCriteria: [], issues: [] }, [], null, ['Closes #12']);
  assert.ok(body.includes('> Fixes `#99`'));
  assert.ok(body.includes('## Linked issue\n\nCloses #12'));
  const own = pullRequestBody({ key: 'CW-4', description: 'Fixes #99', acceptanceCriteria: [] }, [], null);
  assert.ok(own.includes('Fixes #99'));
});
