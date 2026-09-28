import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WorkItemLink, WorkItemLinkRole } from '@agentry/shared';
import { documentsLine, documentSyncMessage, syncItemDocuments, withDocumentsLine } from '../src/item-documents.ts';
import { itemWorktree, type ItemPlace } from '../src/work-links.ts';

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=Someone', '-c', 'user.email=s@example.com', ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();

const ITEM = { key: 'AGN-7' };
const MESSAGE = documentSyncMessage(ITEM);

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-item-docs-'));
  gitIn(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'project\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

/** Writes a file in the checkout, uncommitted, as a refine leaves its specification. */
function write(dir: string, rel: string, content: string): void {
  const file = join(dir, ...rel.split('/'));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

let seq = 0;
function docLink(documentPath: string, role: WorkItemLinkRole = 'refine', itemId = 'item-1'): WorkItemLink {
  seq++;
  return { id: `l${seq}`, itemId, kind: 'document', role, documentPath, documentKind: 'spec', chatId: null, orchestrationId: null, taskId: null, createdAt: new Date().toISOString() };
}

function setup(): { dir: string; place: ItemPlace } {
  const dir = repo();
  const place = itemWorktree(dir, { key: ITEM.key, worktree: null, branch: null });
  assert.ok(place);
  return { dir, place };
}

const sync = (dir: string, place: ItemPlace, links: WorkItemLink[]) => syncItemDocuments({ item: ITEM, links, projectPath: dir, documentsRoot: 'docs', place });

const commitsOf = (place: ItemPlace) => gitIn(place.cwd, 'log', '--format=%s').split('\n');
const filesOf = (place: ItemPlace, ref = 'HEAD') => gitIn(place.cwd, 'show', '--name-only', '--format=', ref).split('\n').filter(Boolean);

test("a fresh worktree gets the refine's uncommitted specification, committed on its branch in one commit of its own", async () => {
  const { dir, place } = setup();
  write(dir, 'docs/plans/limit.md', '# Limit\n');
  write(dir, 'docs/reference.md', '# Reference\n');
  // The developer's own uncommitted work, which the sync's commit must leave out
  writeFileSync(join(place.cwd, 'wip.ts'), 'export {};\n');
  writeFileSync(join(place.cwd, 'README.md'), 'changed\n');

  const result = await sync(dir, place, [docLink('docs/plans/limit.md'), docLink('docs/reference.md', 'reference')]);

  assert.deepEqual(result.copied, ['docs/plans/limit.md', 'docs/reference.md']);
  assert.deepEqual(result.present, ['docs/plans/limit.md', 'docs/reference.md']);
  assert.ok(result.commit);
  assert.equal(readFileSync(join(place.cwd, 'docs/plans/limit.md'), 'utf8'), '# Limit\n');
  assert.deepEqual(commitsOf(place), [MESSAGE, 'initial']);
  assert.deepEqual(filesOf(place).sort(), ['docs/plans/limit.md', 'docs/reference.md']);
  assert.equal(gitIn(place.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), place.branch);
  const left = gitIn(place.cwd, 'status', '--porcelain');
  assert.match(left, /README\.md/);
  assert.match(left, /wip\.ts/);
  assert.doesNotMatch(gitIn(place.cwd, 'log', '-1', '--format=%B'), /Co-Authored-By/i);
});

test('an up-to-date worktree is left alone: nothing is copied and no commit is made', async () => {
  const { dir, place } = setup();
  write(dir, 'docs/plans/limit.md', '# Limit\n');
  const links = [docLink('docs/plans/limit.md')];
  await sync(dir, place, links);
  const head = gitIn(place.cwd, 'rev-parse', 'HEAD');

  const again = await sync(dir, place, links);

  assert.deepEqual(again.copied, []);
  assert.equal(again.commit, null);
  assert.deepEqual(again.present, ['docs/plans/limit.md']);
  assert.equal(gitIn(place.cwd, 'rev-parse', 'HEAD'), head);
});

test('a spec the checkout changed since the last round reaches the branch in a new commit', async () => {
  const { dir, place } = setup();
  write(dir, 'docs/plans/limit.md', '# Limit\n');
  const links = [docLink('docs/plans/limit.md')];
  await sync(dir, place, links);
  write(dir, 'docs/plans/limit.md', '# Limit\n\nOne more rule.\n');

  const again = await sync(dir, place, links);

  assert.deepEqual(again.copied, ['docs/plans/limit.md']);
  assert.equal(readFileSync(join(place.cwd, 'docs/plans/limit.md'), 'utf8'), '# Limit\n\nOne more rule.\n');
  assert.deepEqual(commitsOf(place), [MESSAGE, MESSAGE, 'initial']);
});

test('a spec the branch committed as its own, or has uncommitted edits to, wins over the checkout', async () => {
  const { dir, place } = setup();
  write(dir, 'docs/plans/limit.md', '# Limit\n');
  write(dir, 'docs/plans/other.md', '# Other\n');
  const links = [docLink('docs/plans/limit.md'), docLink('docs/plans/other.md')];
  await sync(dir, place, links);
  // The developer edits one on the branch and commits it; a person edits the other and leaves it
  writeFileSync(join(place.cwd, 'docs/plans/limit.md'), '# Limit, as built\n');
  gitIn(place.cwd, 'commit', '-q', '-am', 'feat: build it');
  writeFileSync(join(place.cwd, 'docs/plans/other.md'), '# Other, being edited\n');
  const head = gitIn(place.cwd, 'rev-parse', 'HEAD');
  write(dir, 'docs/plans/limit.md', '# Limit, rewritten in the checkout\n');
  write(dir, 'docs/plans/other.md', '# Other, rewritten in the checkout\n');

  const again = await sync(dir, place, links);

  assert.deepEqual(again.copied, []);
  assert.equal(again.commit, null);
  assert.deepEqual(again.present, ['docs/plans/limit.md', 'docs/plans/other.md']);
  assert.equal(readFileSync(join(place.cwd, 'docs/plans/limit.md'), 'utf8'), '# Limit, as built\n');
  assert.equal(readFileSync(join(place.cwd, 'docs/plans/other.md'), 'utf8'), '# Other, being edited\n');
  assert.equal(gitIn(place.cwd, 'rev-parse', 'HEAD'), head);
});

test('a refused path is not copied, and the documents beside it still are', async () => {
  const { dir, place } = setup();
  write(dir, 'docs/plans/limit.md', '# Limit\n');
  write(dir, 'src/secret.md', '# Not a document\n');
  write(dir, 'docs/.hidden/note.md', '# Hidden\n');
  write(dir, 'docs/notes.txt', 'not markdown\n');
  // A link in the documents folder that leads out of it
  const outside = mkdtempSync(join(tmpdir(), 'agentry-outside-'));
  writeFileSync(join(outside, 'loot.md'), '# Loot\n');
  symlinkSync(join(outside, 'loot.md'), join(dir, 'docs', 'loot.md'));
  // An untied spec in the folder, and one tied only to another item, are never read here
  write(dir, 'docs/plans/untied.md', '# Untied\n');

  const result = await sync(dir, place, [
    docLink('docs/../src/secret.md'),
    docLink('src/secret.md'),
    docLink('docs/.hidden/note.md'),
    docLink('docs/notes.txt'),
    docLink('/etc/passwd.md'),
    docLink('docs/loot.md'),
    docLink('docs/plans/limit.md'),
  ]);

  assert.deepEqual(result.copied, ['docs/plans/limit.md']);
  assert.deepEqual(result.present, ['docs/plans/limit.md']);
  assert.equal(result.skipped.length, 6);
  assert.ok(!existsSync(join(place.cwd, 'docs', 'loot.md')), 'the symlink target was copied');
  assert.ok(!existsSync(join(place.cwd, 'src', 'secret.md')));
  assert.ok(!existsSync(join(place.cwd, 'docs', 'plans', 'untied.md')));
  assert.deepEqual(filesOf(place), ['docs/plans/limit.md']);
});

test('a tied document missing from the checkout is skipped without stopping the others', async () => {
  const { dir, place } = setup();
  write(dir, 'docs/plans/limit.md', '# Limit\n');
  const result = await sync(dir, place, [docLink('docs/plans/gone.md'), docLink('docs/plans/limit.md')]);
  assert.deepEqual(result.copied, ['docs/plans/limit.md']);
  assert.deepEqual(result.skipped.map((s) => s.path), ['docs/plans/gone.md']);
});

test('a worktree of a subdirectory project gets the document under its copy of that subdirectory', async () => {
  const dir = repo();
  const project = join(dir, 'apps', 'shop');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'index.md'), 'x\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'shop');
  const place = itemWorktree(project, { key: ITEM.key, worktree: null, branch: null });
  assert.ok(place);
  write(project, 'docs/plans/limit.md', '# Limit\n');
  const result = await syncItemDocuments({ item: ITEM, links: [docLink('docs/plans/limit.md')], projectPath: project, documentsRoot: 'docs', place });
  assert.deepEqual(result.copied, ['docs/plans/limit.md']);
  assert.ok(existsSync(join(place.worktree, 'apps', 'shop', 'docs', 'plans', 'limit.md')));
  assert.deepEqual(filesOf(place), ['apps/shop/docs/plans/limit.md']);
});

test('a commit that fails throws with git\'s message, so the run does not start without its spec', async () => {
  const { dir, place } = setup();
  write(dir, 'docs/plans/limit.md', '# Limit\n');
  // A lock git leaves behind when another process holds the index
  const gitDir = gitIn(place.cwd, 'rev-parse', '--absolute-git-dir');
  writeFileSync(join(gitDir, 'index.lock'), '');
  await assert.rejects(sync(dir, place, [docLink('docs/plans/limit.md')]), /index\.lock/);
});

test('the prompt line names every present document, sits above the member\'s instructions, and is absent with none', () => {
  assert.equal(documentsLine([]), null);
  const line = documentsLine(['docs/plans/a.md', 'docs/b.md']);
  assert.equal(line, "The item's specification is in this worktree: `docs/plans/a.md`, `docs/b.md`.");
  const prompt = 'AGN-7 · Title\n\nDescription\n\n---\n\nnot this rule\n\n---\n\nYou are the Developer of this team.';
  const out = withDocumentsLine(prompt, line ?? '');
  assert.ok(out.indexOf(line ?? '') < out.indexOf('You are the Developer'));
  assert.ok(out.indexOf(line ?? '') > out.indexOf('not this rule'));
});
