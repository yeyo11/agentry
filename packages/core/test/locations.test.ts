import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { Core } from '../src/index.ts';
import { Locator } from '../src/locations.ts';
import { SessionStore } from '../src/sessions.ts';
import { encodeProjectId } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

const line = (o: object) => JSON.stringify(o);

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-loc-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=a', '-c', 'user.email=a@b', ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'f'), 'x');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('a worktree anywhere resolves to its repository, from its .git file', () => {
  const root = repo();
  const outside = `${root}-feature`;
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'feature', outside]);
  mkdirSync(join(outside, 'packages', 'core'), { recursive: true });

  const loc = new Locator().locate(join(outside, 'packages', 'core'));
  assert.equal(loc.projectPath, root);
  assert.equal(loc.projectId, encodeProjectId(root));
  // git names the worktree after its directory
  assert.deepEqual(loc.worktree, { name: basename(outside), branch: 'feature', path: outside });
  // The main checkout is not a worktree of anything
  assert.equal(new Locator().locate(root).worktree, null);
  assert.equal(new Locator().locate(root).projectPath, root);
});

test('the CLI layout and its transcript record resolve a worktree even once it is gone', () => {
  const locator = new Locator();
  // Removed from disk: only the path says what it was
  const byPath = locator.locate('/gone/repo/.claude/worktrees/abc-task/src');
  assert.equal(byPath.projectPath, '/gone/repo');
  assert.equal(byPath.worktree?.name, 'abc-task');
  // The record the CLI wrote wins, branch included
  locator.learn({ path: '/elsewhere/wt', parentPath: '/gone/repo', name: 'wt', branch: 'worktree-wt' });
  assert.deepEqual(locator.locate('/elsewhere/wt').worktree, { name: 'wt', branch: 'worktree-wt', path: '/elsewhere/wt' });
});

test('a session run in a worktree carries the CLI record, and its project nests under the repository', async () => {
  const config = tempConfig();
  const parent = '/work/app';
  const wt = '/work/app/.claude/worktrees/1234-api';
  const write = (path: string, id: string, extra: object[] = []) => {
    const dir = join(config.projectsDir, encodeProjectId(path));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        line({ type: 'user', uuid: '1', timestamp: '2026-01-01T10:00:00Z', cwd: path, message: { role: 'user', content: 'go' } }),
        ...extra.map(line),
      ].join('\n'),
    );
  };
  write(parent, 'p-1');
  write(wt, 'w-1', [
    {
      type: 'worktree-state',
      worktreeSession: { originalCwd: parent, worktreePath: wt, worktreeName: '1234-api', worktreeBranch: 'worktree-1234-api' },
    },
  ]);

  const summary = await new SessionStore(config).summary('w-1');
  assert.deepEqual(summary?.worktree, { path: wt, parentPath: parent, name: '1234-api', branch: 'worktree-1234-api' });

  const core = new Core(config);
  const projects = await core.projects();
  const child = projects.find((p) => p.path === wt);
  assert.equal(child?.parentId, encodeProjectId(parent));
  assert.deepEqual(child?.worktree, { name: '1234-api', branch: 'worktree-1234-api' });
  assert.equal(projects.find((p) => p.path === parent)?.parentId, null);
  // Asking for the repository's chats includes the worktree's
  const ids = (await core.chats.list({ project: encodeProjectId(parent), origins: ['agentry', 'external'] })).map((c) => c.id).sort();
  assert.deepEqual(ids, ['p-1', 'w-1']);
  core.db.close();
});

test('a repository only worked on through worktrees still appears, to hold them', async () => {
  const config = tempConfig();
  const wt = '/work/solo/.claude/worktrees/x';
  const dir = join(config.projectsDir, encodeProjectId(wt));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 's.jsonl'), line({ type: 'user', uuid: '1', timestamp: '2026-01-01T10:00:00Z', cwd: wt, message: { role: 'user', content: 'go' } }));
  const core = new Core(config);
  const projects = await core.projects();
  assert.ok(projects.find((p) => p.path === '/work/solo'));
  assert.equal(projects.find((p) => p.path === wt)?.parentPath, '/work/solo');
  core.db.close();
});
