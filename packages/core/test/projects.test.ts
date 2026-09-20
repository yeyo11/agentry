import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Core } from '../src/index.ts';
import type { WorktreeFacts } from '../src/locations.ts';
import { attachProject, projectCandidates, ProjectStore, type ProjectRecord } from '../src/projects.ts';
import { encodeProjectId } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

const line = (o: object) => JSON.stringify(o);
const project = (id: string, path: string): ProjectRecord => ({ id, name: id, path });
const noWorktrees = () => null;

/** A resolver that knows the given worktrees, as the locator does once it has read a transcript or a .git file. */
const knowing =
  (...facts: WorktreeFacts[]) =>
  (dir: string): WorktreeFacts | null =>
    facts.find((f) => dir === f.path || dir.startsWith(`${f.path}/`)) ?? null;

test('a directory belongs to the deepest project that holds it, and to none when no project does', () => {
  const projects = [project('app', '/work/app'), project('api', '/work/app/apps/api'), project('two', '/work/app-two')];
  const idOf = (dir: string) => attachProject(projects, dir, noWorktrees)?.project.id ?? null;

  assert.equal(idOf('/work/app'), 'app');
  assert.equal(idOf('/work/app/packages/core'), 'app');
  assert.equal(idOf('/work/app/apps/api/src'), 'api');
  // A shared prefix is not a shared directory
  assert.equal(idOf('/work/app-two/src'), 'two');
  assert.equal(idOf('/work/app-three'), null);
  assert.equal(idOf('/elsewhere'), null);
  assert.equal(idOf(''), null);
});

test('a worktree belongs to the project it came from, wherever it lives', () => {
  const projects = [project('app', '/work/app'), project('other', '/work/other')];
  const outside: WorktreeFacts = { path: '/tmp/wt-feature', name: 'wt-feature', branch: 'feature', parentPath: '/work/app' };
  const inRepo: WorktreeFacts = { path: '/work/app/.claude/worktrees/1-api', name: '1-api', branch: 'worktree-1-api', parentPath: '/work/app' };

  const far = attachProject(projects, '/tmp/wt-feature/packages/core', knowing(outside));
  assert.equal(far?.project.id, 'app');
  assert.equal(far?.worktree?.branch, 'feature');
  assert.equal(attachProject(projects, inRepo.path, knowing(inRepo))?.project.id, 'app');

  // The repository it came from wins over the project whose directory happens to hold it
  const nested: WorktreeFacts = { path: '/work/other/wt', name: 'wt', branch: 'x', parentPath: '/work/app' };
  assert.equal(attachProject(projects, '/work/other/wt', knowing(nested))?.project.id, 'app');
  // ...but when that repository is not imported, where it lives decides
  const orphan: WorktreeFacts = { path: '/work/other/wt', name: 'wt', branch: 'x', parentPath: '/work/gone' };
  assert.equal(attachProject(projects, '/work/other/wt', knowing(orphan))?.project.id, 'other');
});

test('a worktree of a repository whose project is one of its subdirectories still finds it', () => {
  const projects = [project('core', '/work/mono/packages/core')];
  const wt: WorktreeFacts = { path: '/tmp/mono-wt', name: 'mono-wt', branch: 'b', parentPath: '/work/mono' };
  assert.equal(attachProject(projects, '/tmp/mono-wt/packages/core/src', knowing(wt))?.project.id, 'core');
  // The worktree's other packages are not in that project
  assert.equal(attachProject(projects, '/tmp/mono-wt/packages/web', knowing(wt)), null);
});

test('a chat in a worktree whose repository is not imported is loose', () => {
  const wt: WorktreeFacts = { path: '/tmp/solo-wt', name: 'solo-wt', branch: 'b', parentPath: '/work/solo' };
  assert.equal(attachProject([project('app', '/work/app')], '/tmp/solo-wt', knowing(wt)), null);
});

test('candidates are the busiest directories not imported, worktrees counted for their repository, scratch and missing ones left out', () => {
  // Real directories outside the OS temp dir, which is what marks a directory as scratch
  const here = import.meta.dirname;
  const parent = dirname(here);
  const grand = dirname(parent);
  const chat = (cwd: string, updatedAt: string) => ({ cwd, updatedAt });
  const wt: WorktreeFacts = { path: '/tmp/parent-wt', name: 'parent-wt', branch: 'b', parentPath: parent };

  const candidates = projectCandidates(
    [project('grand', grand)],
    [
      chat(here, '2026-01-01'),
      chat(here, '2026-01-02'),
      chat(parent, '2026-01-03'),
      chat('/tmp/parent-wt/src', '2026-01-04'),
      chat('/var/tmp/scratch', '2026-01-05'),
      chat('/does/not/exist', '2026-01-06'),
      chat('', '2026-01-07'),
      chat(grand, '2026-01-08'),
    ],
    knowing(wt),
  );
  // `grand` holds `parent` and `here`, so they are already adopted and nothing is left to offer
  assert.deepEqual(candidates, []);

  const offered = projectCandidates(
    [],
    [chat(here, '2026-01-01'), chat(here, '2026-01-02'), chat(parent, '2026-01-03'), chat('/tmp/parent-wt/src', '2026-01-04'), chat('/does/not/exist', '2026-01-06')],
    knowing(wt),
  );
  assert.deepEqual(
    offered.map((c) => [c.path, c.chatCount, c.lastActivity]),
    [
      [parent, 2, '2026-01-04'],
      [here, 2, '2026-01-02'],
    ],
  );
  assert.equal(projectCandidates([], [chat(here, 'a'), chat(parent, 'b')], noWorktrees, 1).length, 1);
});

test('the store keeps imported projects in a JSON document, across restarts', async () => {
  const config = tempConfig();
  const dir = mkdtempSync(join(tmpdir(), 'agentry-proj-'));
  const store = new ProjectStore(config);
  assert.deepEqual(store.list(), []);

  const added = await store.add({ path: dir }, noWorktrees);
  assert.equal(added.path, dir);
  assert.match(added.id, /^[0-9a-f-]{36}$/);
  await assert.rejects(store.add({ path: dir }, noWorktrees), /already a project/);
  await assert.rejects(store.add({ path: join(dir, 'missing') }, noWorktrees), /not a directory/);
  await assert.rejects(store.add({ path: '' }, noWorktrees), /path is required/);

  const renamed = await store.rename(added.id, '  Shop  ');
  assert.equal(renamed.name, 'Shop');
  await assert.rejects(store.rename(added.id, '   '), /name is required/);
  await assert.rejects(store.rename('nope', 'x'), /project not found/);

  const reloaded = new ProjectStore(config);
  assert.deepEqual(reloaded.list(), [{ id: added.id, name: 'Shop', path: dir }]);
  await reloaded.remove(added.id);
  await assert.rejects(reloaded.remove(added.id), /project not found/);
  assert.deepEqual(new ProjectStore(config).list(), []);
});

test('a git worktree cannot be imported: it belongs to its repository', async () => {
  const store = new ProjectStore(tempConfig());
  const dir = mkdtempSync(join(tmpdir(), 'agentry-proj-'));
  const wt: WorktreeFacts = { path: dir, name: 'wt', branch: 'b', parentPath: '/work/app' };
  await assert.rejects(store.add({ path: dir }, knowing(wt)), /git worktree of \/work\/app; import that instead/);
  assert.deepEqual(store.list(), []);
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-repo-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=a', '-c', 'user.email=a@b', ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'f'), 'x');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('importing adopts the chats already there, worktrees included; removing lets them go loose again', async () => {
  const config = tempConfig();
  const root = repo();
  const wt = `${root}-feature`;
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'feature', wt]);
  const stray = mkdtempSync(join(tmpdir(), 'agentry-stray-'));

  const write = (cwd: string, id: string, at: string) => {
    const dir = join(config.projectsDir, encodeProjectId(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), line({ type: 'user', uuid: '1', timestamp: at, cwd, message: { role: 'user', content: 'go' } }));
  };
  write(root, 'in-root', '2026-01-01T10:00:00Z');
  write(join(root, 'sub'), 'in-sub', '2026-01-02T10:00:00Z');
  write(wt, 'in-worktree', '2026-01-03T10:00:00Z');
  write(stray, 'stray', '2026-01-04T10:00:00Z');

  const core = new Core(config);
  const chatsIn = (project: string | null) => core.chats.list({ project, origins: ['agentry', 'external'] });
  try {
    assert.deepEqual(await core.projects(), [], 'nothing is a project until it is imported');
    assert.equal((await chatsIn(null)).length, 4);

    await assert.rejects(core.importProject({ path: wt }), /git worktree of .* import that instead/);
    const imported = await core.importProject({ path: root, name: 'Shop' });
    assert.equal(imported.name, 'Shop');
    assert.equal(imported.exists, true);
    assert.equal(imported.chatCount, 3);
    assert.equal(imported.lastActivity, '2026-01-03T10:00:00Z');
    assert.deepEqual(
      imported.worktrees.map((w) => [w.path, w.name, w.branch]),
      [[wt, wt.split('/').pop(), 'feature']],
    );

    // The worktree is not a project of its own
    assert.deepEqual((await core.projects()).map((p) => p.path), [root]);
    assert.deepEqual((await chatsIn(imported.id)).map((c) => c.id).sort(), ['in-root', 'in-sub', 'in-worktree']);
    assert.deepEqual((await chatsIn(null)).map((c) => c.id), ['stray']);
    assert.deepEqual(await chatsIn('nope'), [], 'a project that does not exist holds nothing');

    // What a chat resolves to
    assert.deepEqual(core.projectOf(join(root, 'sub')), { project: { id: imported.id, name: 'Shop' }, worktree: null });
    assert.deepEqual(core.projectOf(join(wt, 'src')).project, { id: imported.id, name: 'Shop' });
    assert.deepEqual(core.projectOf(join(wt, 'src')).worktree, { path: wt, name: wt.split('/').pop(), branch: 'feature' });
    assert.equal(core.projectOf(stray).project, null);

    // Only the imported project is offered to Config and Memory, under its own id
    assert.deepEqual((await core.memoryOverview()).map((m) => [m.projectId, m.projectName]), [[imported.id, 'Shop']]);
    await core.saveMemory(imported.id, 'note.md', '# note');
    assert.deepEqual((await core.memoryFiles(imported.id)).map((f) => [f.name, f.projectId]), [['note.md', imported.id]]);
    assert.equal((await core.resolveScope(imported.id)).kind, 'project');

    // Removing is harmless: the chats are still there, loose again
    await core.removeProject(imported.id);
    assert.deepEqual(await core.projects(), []);
    assert.equal((await chatsIn(null)).length, 4);
    await assert.rejects(core.purgeProject(imported.id), /project not found/);
  } finally {
    core.db.close();
  }
});

test('a project renamed or removed is remembered by the next start', async () => {
  const config = tempConfig();
  const dir = mkdtempSync(join(tmpdir(), 'agentry-proj-'));
  const first = new Core(config);
  const { id } = await first.importProject({ path: dir });
  await first.renameProject(id, 'Renamed');
  first.db.close();

  const second = new Core(config);
  assert.deepEqual((await second.projects()).map((p) => [p.id, p.name, p.chatCount]), [[id, 'Renamed', 0]]);
  second.db.close();
});
