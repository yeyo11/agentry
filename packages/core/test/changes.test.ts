import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Orchestration, OrchestrationTaskState, TranscriptEntry } from '@agentry/shared';
import { ChangeWatcher } from '../src/change-watcher.ts';
import { Changes } from '../src/changes.ts';
import { EventBus } from '../src/events.ts';
import {
  addWorktree,
  aheadCount,
  commitAll,
  commitsBetween,
  currentBranch,
  diffFiles,
  fileDiff,
  headCommit,
  mergeBase,
  pathInside,
  probeChanges,
  removeWorktree,
  uncommittedFiles,
  untrackedDiff,
} from '../src/git.ts';

const TEXT = 'one\ntwo\nthree\nfour\nfive\nsix\n';

/** A repository with a few files, an identity, and one commit: what a user's project looks like. */
function repoWithFiles(): { repo: string; base: string; git: (...args: string[]) => string } {
  const repo = mkdtempSync(join(tmpdir(), 'agentry-changes-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  // Distinct contents: git pairs a deleted file with a created one by similarity, and identical
  // files would make "which one was renamed" a coin toss
  for (const name of ['README.md', 'old.txt', 'gone.txt', 'keep.txt']) writeFileSync(join(repo, name), name === 'README.md' ? 'project\n' : `${name}\n${TEXT}`);
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { repo, base: headCommit(repo), git };
}

/** A worker's branch: a modification, a deletion, a rename and a file in a directory with spaces, committed. */
function workerBranch(repo: string, base: string): string {
  const path = join(repo, '.claude', 'worktrees', 'w1');
  addWorktree(repo, path, 'worktree-w1', base);
  const wt = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe', encoding: 'utf8' });
  wt('config', 'user.name', 'Worker');
  wt('config', 'user.email', 'worker@example.com');
  writeFileSync(join(path, 'README.md'), 'project\nmore\n');
  wt('rm', '-q', 'gone.txt');
  wt('mv', 'old.txt', 'moved.txt');
  mkdirSync(join(path, 'new dir'));
  writeFileSync(join(path, 'new dir', 'my file.txt'), 'a\nb\n');
  wt('add', '-A');
  wt('commit', '-q', '-m', 'do the work');
  return path;
}

test('lists what the commits changed against the base, with kinds and line counts', () => {
  const { repo, base } = repoWithFiles();
  const path = workerBranch(repo, base);

  assert.deepEqual(diffFiles(path, base, 'HEAD').sort((a, b) => (a.path < b.path ? -1 : 1)), [
    { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
    { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 7 },
    { path: 'moved.txt', status: 'renamed', additions: 0, deletions: 0, previousPath: 'old.txt' },
    // A path with a space in it comes back as it is, not quoted
    { path: 'new dir/my file.txt', status: 'added', additions: 2, deletions: 0 },
  ]);
  assert.equal(currentBranch(path), 'worktree-w1');
  assert.equal(aheadCount(path, base), 1);
  const [commit] = commitsBetween(path, base);
  assert.equal(commit?.subject, 'do the work');
  assert.equal(commit?.author, 'Worker');
  assert.match(commit?.at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(mergeBase(path, 'HEAD', 'main'), base);
});

test('uncommitted work is the tracked changes, staged or not, and the files nobody added yet', () => {
  const { repo, base } = repoWithFiles();
  const path = workerBranch(repo, base);
  assert.deepEqual(uncommittedFiles(path), []);

  writeFileSync(join(path, 'keep.txt'), `keep.txt\n${TEXT}seven\n`);
  writeFileSync(join(path, 'staged.txt'), 'x\n');
  execFileSync('git', ['-C', path, 'add', 'staged.txt']);
  // No trailing newline: the last line still counts
  writeFileSync(join(path, 'scratch.txt'), 'a\nb');

  assert.deepEqual(uncommittedFiles(path).sort((a, b) => (a.path < b.path ? -1 : 1)), [
    { path: 'keep.txt', status: 'modified', additions: 1, deletions: 0 },
    { path: 'scratch.txt', status: 'added', additions: 2, deletions: 0 },
    { path: 'staged.txt', status: 'added', additions: 1, deletions: 0 },
  ]);
});

test('a diff covers the committed and the uncommitted change of a file, and a new file shows as all added', () => {
  const { repo, base } = repoWithFiles();
  const path = workerBranch(repo, base);
  writeFileSync(join(path, 'README.md'), 'project\nmore\nand more\n');
  writeFileSync(join(path, 'scratch.txt'), 'fresh\n');

  const readme = fileDiff(path, base, undefined, ['README.md']);
  assert.match(readme, /^\+more$/m);
  assert.match(readme, /^\+and more$/m);
  const scratch = untrackedDiff(path, 'scratch.txt');
  assert.match(scratch, /^\+\+\+ b\/scratch\.txt$/m);
  assert.match(scratch, /^\+fresh$/m);

  // A rename asked for by both names is a rename; by the new one alone it would be a file from nothing
  assert.match(fileDiff(path, base, 'HEAD', ['old.txt', 'moved.txt']), /rename from old\.txt/);
});

test('a file named like a glob is that file, not a pattern for the others', () => {
  const { repo, base } = repoWithFiles();
  const path = workerBranch(repo, base);
  writeFileSync(join(path, '*.md'), 'star\n');
  execFileSync('git', ['-C', path, 'add', '*.md'], { stdio: 'pipe' });
  execFileSync('git', ['-C', path, 'commit', '-q', '-m', 'star'], { stdio: 'pipe' });

  const diff = fileDiff(path, base, 'HEAD', ['*.md']);
  assert.match(diff, /^\+star$/m);
  assert.doesNotMatch(diff, /README\.md/);
});

test('a path that leaves the checkout, or is empty or absolute, is refused before git sees it', () => {
  const { repo } = repoWithFiles();
  for (const bad of ['', '../outside', 'a/../../outside', '/etc/passwd', '..']) {
    assert.throws(() => pathInside(repo, bad), /inside the checkout/, bad);
  }
  assert.equal(pathInside(repo, 'a/./b/../c.txt'), 'a/c.txt');
});

// ---------- the service ----------

interface Fakes {
  orch: Orchestration;
  changes: Changes;
}

/** The service over a graph that is only what it reads: no process, no database. */
function service(repo: string, base: string, path: string, over: Partial<Orchestration> = {}, taskOver: Partial<OrchestrationTaskState> = {}, messages: TranscriptEntry[] | null = null): Fakes {
  const task: OrchestrationTaskState = {
    id: 't1', name: 'Task', prompt: 'p', status: 'running', attempts: 1, runId: 'chat-1', sessionId: 'chat-1',
    result: null, error: null, startedAt: null, endedAt: null, costUsd: 0,
    worktree: path, branch: 'worktree-w1', ...taskOver,
  };
  const orch = {
    id: 'o1', name: 'Graph', cwd: repo, worktree: true, baseCommit: base, tasks: [task], integration: null, ...over,
  } as unknown as Orchestration;
  const changes = new Changes({
    orchestrator: { get: (id: string) => (id === 'o1' ? orch : null) } as never,
    chats: { summaryOf: async () => null } as never,
    sessions: { toolCalls: async () => null } as never,
    runtime: { messages: () => messages } as never,
  });
  return { orch, changes };
}

test('a task is measured from the commit it started at, not from where the graph did', () => {
  const { repo, base } = repoWithFiles();
  const path = workerBranch(repo, base);
  // Its dependencies' work is already in its branch: that is the graph's base for it, and not its own doing
  const started = headCommit(path);
  writeFileSync(join(path, 'mine.txt'), 'x\n');
  commitAll(path, 'mine');

  const { changes } = service(repo, base, path, {}, { baseCommit: started });
  const summary = changes.taskChanges('o1', 't1');
  assert.deepEqual(summary.files.map((f) => f.path), ['mine.txt']);
  assert.equal(summary.base, started);
  assert.equal(summary.ahead, 1);
  assert.equal(summary.branch, 'worktree-w1');

  // A graph that predates the field falls back to the graph's base
  const older = service(repo, base, path).changes.taskChanges('o1', 't1');
  assert.equal(older.base, base);
  assert.equal(older.ahead, 2);
  assert.equal(older.files.length, 5);
});

test('the summary carries what is not committed yet, and the diff of a file that only exists uncommitted', () => {
  const { repo, base } = repoWithFiles();
  const path = workerBranch(repo, base);
  writeFileSync(join(path, 'draft.txt'), 'wip\n');
  const { changes } = service(repo, base, path);

  assert.deepEqual(changes.taskChanges('o1', 't1').uncommitted.map((f) => f.path), ['draft.txt']);
  assert.match(changes.taskDiff('o1', 't1', 'draft.txt').diff, /^\+wip$/m);
  assert.match(changes.taskDiff('o1', 't1', 'moved.txt').diff, /rename from old\.txt/);
  assert.throws(() => changes.taskDiff('o1', 't1', 'keep.txt'), /keep\.txt not found among the changes/);
  assert.throws(() => changes.taskDiff('o1', 't1', '../README.md'), /inside the checkout/);
});

test('once the worktree is gone the branch still says what was committed, and nothing is left uncommitted', () => {
  const { repo, base } = repoWithFiles();
  const path = workerBranch(repo, base);
  removeWorktree(repo, path);
  const { changes } = service(repo, base, path);

  const summary = changes.taskChanges('o1', 't1');
  assert.equal(summary.ahead, 1);
  assert.equal(summary.files.length, 4);
  assert.deepEqual(summary.uncommitted, []);
  assert.match(changes.taskDiff('o1', 't1', 'README.md').diff, /^\+more$/m);
});

test('a task that has not started has an empty summary, and a graph without worktrees has none to give', () => {
  const { repo, base } = repoWithFiles();
  const pending = service(repo, base, '', {}, { status: 'pending', worktree: null, branch: null }).changes.taskChanges('o1', 't1');
  assert.deepEqual(pending, { branch: null, base, ahead: 0, commits: [], files: [], uncommitted: [] });

  const shared = service(repo, base, '', { worktree: false }).changes;
  assert.throws(() => shared.taskChanges('o1', 't1'), /no worktrees/);
  assert.throws(() => shared.integrationChanges('o1'), /no worktrees/);
  assert.throws(() => shared.taskChanges('nope', 't1'), /orchestration not found/);
  assert.throws(() => shared.taskChanges('o1', 'nope'), /task not found/);
});

test('the integration branch is measured against the graph base, and is empty before it exists', () => {
  const { repo, base } = repoWithFiles();
  const path = workerBranch(repo, base);
  assert.deepEqual(service(repo, base, path).changes.integrationChanges('o1').files, []);

  const { changes } = service(repo, base, path, { integration: { status: 'merging', branch: 'worktree-w1', worktree: path, merged: [], conflicts: [] } as never });
  const summary = changes.integrationChanges('o1');
  assert.equal(summary.branch, 'worktree-w1');
  assert.equal(summary.files.length, 4);
  assert.match(changes.integrationDiff('o1', 'README.md').diff, /^\+more$/m);
});

const message = (blocks: TranscriptEntry['blocks'], timestamp: string): TranscriptEntry => ({
  uuid: timestamp, role: 'assistant', timestamp, model: null, isSidechain: false, parentToolUseId: null, blocks,
});

test('the checklist and the touched files come from the calls a chat streamed when it has no transcript yet', async () => {
  const { repo, base } = repoWithFiles();
  const entries = [
    message([{ type: 'tool_use', id: 'c1', name: 'TodoWrite', input: { todos: [{ content: 'write it', status: 'in_progress' }, { content: 'test it', status: 'pending' }] } }], '2026-01-01T10:00:00Z'),
    message([{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/p/a.ts' } }], '2026-01-01T10:01:00Z'),
  ];
  const { changes } = service(repo, base, '', {}, { worktree: null, branch: null }, entries);

  assert.deepEqual(await changes.taskChecklist('o1', 't1'), {
    items: [{ text: 'write it', status: 'in_progress' }, { text: 'test it', status: 'pending' }],
    updatedAt: '2026-01-01T10:00:00Z',
  });
  const fresh = service(repo, base, '', {}, { worktree: null, branch: null, runId: null, sessionId: null }).changes;
  assert.deepEqual(await fresh.taskChecklist('o1', 't1'), { items: [], updatedAt: null });
});

// ---------- the watcher ----------

function watcherOver(orch: Orchestration) {
  const bus = new EventBus();
  const heard: Array<{ taskId: string | null; ahead: number; uncommitted: number }> = [];
  bus.subscribe((e) => {
    if (e.type === 'changes.updated') heard.push({ taskId: e.taskId, ahead: e.ahead, uncommitted: e.uncommitted });
  });
  return { bus, heard, watcher: new ChangeWatcher({ list: () => [orch] }, bus, 1_000_000) };
}

test('a commit and a burst of edits are each one event, and a quiet worktree says nothing', async () => {
  const { repo, base } = repoWithFiles();
  const path = workerBranch(repo, base);
  const { orch } = service(repo, base, path, {}, { baseCommit: headCommit(path) });
  const { heard, watcher } = watcherOver(orch);

  await watcher.tick(); // the first look is the baseline, and there is nothing to show yet
  await watcher.tick();
  assert.deepEqual(heard, []);

  // Five saves between two looks are one change
  for (let i = 0; i < 5; i++) writeFileSync(join(path, 'draft.txt'), `${'x\n'.repeat(i + 1)}`);
  await watcher.tick();
  assert.deepEqual(heard, [{ taskId: 't1', ahead: 0, uncommitted: 1 }]);
  await watcher.tick();
  assert.equal(heard.length, 1);

  // Keeps editing the same new file: the count of files does not move, the content did
  writeFileSync(join(path, 'draft.txt'), 'much longer now\nthan before\n');
  await watcher.tick();
  assert.equal(heard.length, 2);

  commitAll(path, 'draft');
  await watcher.tick();
  assert.deepEqual(heard.at(-1), { taskId: 't1', ahead: 1, uncommitted: 0 });
});

test('the commit that ends a task is heard after the task stops being watched, once', async () => {
  const { repo, base } = repoWithFiles();
  const path = workerBranch(repo, base);
  const { orch } = service(repo, base, path, {}, { baseCommit: headCommit(path) });
  const { heard, watcher } = watcherOver(orch);
  await watcher.tick();

  const task = orch.tasks[0] as OrchestrationTaskState;
  writeFileSync(join(path, 'last.txt'), 'x\n');
  commitAll(path, 'last');
  task.status = 'completed';
  await watcher.tick();
  await watcher.tick();
  assert.deepEqual(heard, [{ taskId: 't1', ahead: 1, uncommitted: 0 }]);
});

test('nothing is looked at, or said, while nobody listens to the feed', async () => {
  const { repo, base } = repoWithFiles();
  const path = workerBranch(repo, base);
  const { orch } = service(repo, base, path, {}, { baseCommit: headCommit(path) });
  const bus = new EventBus();
  const watcher = new ChangeWatcher({ list: () => [orch] }, bus, 1_000_000);
  writeFileSync(join(path, 'draft.txt'), 'x\n');
  await watcher.tick();
  assert.equal(bus.lastEventId, 0);
});

test('the probe changes when a commit lands and when uncommitted work moves, and not otherwise', async () => {
  const { repo, base } = repoWithFiles();
  const path = workerBranch(repo, base);
  const first = await probeChanges(path, base);
  assert.deepEqual([first.ahead, first.dirty], [1, 0]);
  assert.equal((await probeChanges(path, base)).fingerprint, first.fingerprint);

  writeFileSync(join(path, 'keep.txt'), 'changed\n');
  const dirty = await probeChanges(path, base);
  assert.equal(dirty.dirty, 1);
  assert.notEqual(dirty.fingerprint, first.fingerprint);
  rmSync(join(path, 'keep.txt'));
});
