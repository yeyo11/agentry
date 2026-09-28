import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { DocumentNode, WorkItemLink } from '@agentry/shared';
import { DOCUMENT_LINKS_SCHEMA_VERSION, Db, migrate } from '../src/db.ts';
import { documentPath, DocumentPathError } from '../src/document-paths.ts';
import { DEFAULT_DOCUMENTS_PATH, DOCUMENT_CONTENT_MAX, DocumentError, DocumentService, titleOf } from '../src/documents.ts';
import type { AgentryEventInput } from '../src/events.ts';
import { isLive, linkOf } from '../src/work-item-rows.ts';
import { WorkItemError, WorkItemService } from '../src/work-items.ts';
import { tempConfig } from './helpers.ts';

// The documents folder over real scratch directories and a real store: nothing here reads the real
// ~/.claude or spawns the CLI.

interface Setup {
  project: string;
  outside: string;
  items: WorkItemService;
  docs: DocumentService;
  events: AgentryEventInput[];
  modules: Set<string>;
  root: { path: string };
  board: { on: boolean };
}

function setup(): Setup {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const base = mkdtempSync(join(tmpdir(), 'agentry-docs-'));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(join(project, 'docs', 'specs'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.md'), '# Secret\nnot yours\n');
  const events: AgentryEventInput[] = [];
  const items = new WorkItemService({ db: new Db(config), project: () => ({ keyPrefix: 'AGN', columnLimits: {} }), emit: (e) => events.push(e) });
  const modules = new Set(['board', 'documents']);
  const root = { path: DEFAULT_DOCUMENTS_PATH };
  const board = { on: true };
  const docs = new DocumentService({
    items,
    place: async (projectId, access) => {
      if (projectId !== 'p1') throw new Error('project not found');
      if (access === 'write' && !modules.has('documents')) throw new DocumentError('the Documents module is off', 409);
      return { projectPath: project, root: root.path };
    },
    itemProject: async (itemId) => {
      if (!board.on) throw new WorkItemError('the Board module is off', 409);
      return items.get(itemId).projectId;
    },
    emit: (e) => events.push(e),
  });
  return { project, outside, items, docs, events, modules, root, board };
}

const refused = (status: number, pattern?: RegExp) => (err: unknown) =>
  (err instanceof DocumentError || err instanceof WorkItemError) && err.statusCode === status && (!pattern || pattern.test(err.message));

const names = (nodes: DocumentNode[]): unknown => nodes.map((n) => (n.type === 'dir' ? { [n.name]: names(n.children ?? []) } : n.name));

// ---------- paths ----------

test('a path is refused for its shape before the disk is touched', () => {
  const bad = [
    '',
    '/etc/passwd.md',
    'C:/x.md',
    '../outside/secret.md',
    'docs/../../outside/secret.md',
    'docs/./a.md',
    'docs//a.md',
    'docs/a.md/',
    'docs\\..\\a.md',
    'docs/.hidden.md',
    'docs/.git/config.md',
    'docs/a\u0000.md',
    'docs/a.txt',
    'docs/.md',
    'src/a.md',
    'docs',
    'documents/a.md',
    'x'.repeat(1100) + '.md',
  ];
  for (const path of bad) assert.throws(() => documentPath(path, 'docs'), DocumentPathError, JSON.stringify(path));
  assert.throws(() => documentPath(42, 'docs'), DocumentPathError);
  assert.throws(() => documentPath(null, 'docs'), DocumentPathError);
  assert.equal(documentPath('docs/specs/agn-1.md', 'docs'), 'docs/specs/agn-1.md');
  assert.equal(documentPath('docs/A.MARKDOWN', './docs/'), 'docs/A.MARKDOWN');
  assert.equal(documentPath('handbook/pages/x.md', 'handbook/pages'), 'handbook/pages/x.md');
  // The folder set to the project itself takes any Markdown file in it, still no hidden one
  assert.equal(documentPath('README.md', '.'), 'README.md');
  assert.throws(() => documentPath('.claude/agents/qa.md', '.'), DocumentPathError);
});

test('no read, write, delete or tie leaves the documents folder, symbolic links included', async () => {
  const s = setup();
  // A link to a file outside, and a folder that is a link to outside, both planted inside the folder
  symlinkSync(join(s.outside, 'secret.md'), join(s.project, 'docs', 'leak.md'));
  symlinkSync(s.outside, join(s.project, 'docs', 'out'));
  writeFileSync(join(s.project, 'secret-at-root.md'), '# root\n');

  for (const path of ['../outside/secret.md', 'docs/../../outside/secret.md', '/etc/passwd', 'secret-at-root.md', 'docs/%2e%2e/secret.md']) {
    await assert.rejects(s.docs.read('p1', path), refused(path.includes('%') ? 404 : 400), path);
  }
  await assert.rejects(s.docs.read('p1', 'docs/leak.md'), refused(400, /outside the documents folder/));
  await assert.rejects(s.docs.read('p1', 'docs/out/secret.md'), refused(400, /outside the documents folder/));

  await assert.rejects(s.docs.write('p1', 'docs/../../outside/new.md', { content: 'x' }), refused(400));
  await assert.rejects(s.docs.write('p1', 'docs/out/new.md', { content: 'x' }), refused(400, /outside/));
  await assert.rejects(s.docs.write('p1', 'docs/out/deeper/new.md', { content: 'x' }), refused(400, /outside/));
  await assert.rejects(s.docs.write('p1', 'docs/leak.md', { content: 'overwritten' }), refused(400, /outside/));
  assert.equal(existsSync(join(s.outside, 'new.md')), false);
  assert.equal(existsSync(join(s.outside, 'deeper')), false);
  assert.equal(readFileSync(join(s.outside, 'secret.md'), 'utf8'), '# Secret\nnot yours\n');

  await assert.rejects(s.docs.remove('p1', 'docs/leak.md'), refused(400));
  await assert.rejects(s.docs.remove('p1', 'docs/out/secret.md'), refused(400));
  assert.ok(existsSync(join(s.outside, 'secret.md')));

  const item = s.items.create('p1', { title: 'Tie' });
  await assert.rejects(s.docs.tie(item.id, { path: 'docs/out/secret.md' }), refused(400));
  await assert.rejects(s.docs.tie(item.id, { path: '../outside/secret.md' }), refused(400));
  // The store refuses a climbing path on its own too, for a caller that skips the service
  assert.throws(() => s.items.link(item.id, { kind: 'document', role: 'reference', documentPath: '../outside/secret.md' }), refused(400));
  assert.throws(() => s.items.link(item.id, { kind: 'document', role: 'reference', documentPath: '/etc/passwd.md' }), refused(400));

  // The tree does not follow links either
  const tree = await s.docs.tree('p1');
  assert.equal(JSON.stringify(tree).includes('secret'), false);
});

test('a documents folder that is itself missing is created inside the project, never through a link out of it', async () => {
  const s = setup();
  s.root.path = 'handbook/pages';
  symlinkSync(s.outside, join(s.project, 'handbook'));
  await assert.rejects(s.docs.write('p1', 'handbook/pages/a.md', { content: '# A' }), refused(400, /outside/));
  assert.equal(existsSync(join(s.outside, 'pages')), false);

  s.root.path = 'wiki';
  const written = await s.docs.write('p1', 'wiki/deep/er/a.md', { content: '# A' });
  assert.equal(written.path, 'wiki/deep/er/a.md');
  assert.equal(readFileSync(join(s.project, 'wiki', 'deep', 'er', 'a.md'), 'utf8'), '# A');
});

test('a documents folder that is a link out of the project is refused for every read and write', async () => {
  const s = setup();
  // The folder itself, and a folder on the way to it, each a link that leads out of the project
  for (const [root, link] of [['linked', 'linked'], ['via/pages', 'via']] as const) {
    s.root.path = root;
    symlinkSync(s.outside, join(s.project, link));
    const inFolder = `${root}/secret.md`;
    if (root === 'via/pages') {
      mkdirSync(join(s.outside, 'pages'));
      writeFileSync(join(s.outside, 'pages', 'secret.md'), '# Secret\n');
    }
    await assert.rejects(s.docs.read('p1', inFolder), refused(400, /outside the project/), root);
    await assert.rejects(s.docs.write('p1', `${root}/new.md`, { content: 'x' }), refused(400, /outside/), root);
    await assert.rejects(s.docs.remove('p1', inFolder), refused(400, /outside the project/), root);
    await assert.rejects(s.docs.tree('p1'), refused(400, /outside the project/), root);
    const item = s.items.create('p1', { title: 'Tie' });
    await assert.rejects(s.docs.tie(item.id, { path: inFolder }), refused(400, /outside the project/), root);
  }
  assert.equal(existsSync(join(s.outside, 'new.md')), false);
  assert.equal(existsSync(join(s.outside, 'pages', 'new.md')), false);
  assert.ok(existsSync(join(s.outside, 'secret.md')));
});

// ---------- the tree ----------

test('the tree lists Markdown files only, directories first, with titles, counts and ties', async () => {
  const s = setup();
  writeFileSync(join(s.project, 'docs', 'b.md'), '# Bee\n');
  writeFileSync(join(s.project, 'docs', 'a.markdown'), 'no heading\n');
  writeFileSync(join(s.project, 'docs', 'image.png'), 'png');
  writeFileSync(join(s.project, 'docs', 'specs', 'agn-1.md'), '```\n# not a title\n```\n# Board spec #\n');
  mkdirSync(join(s.project, 'docs', 'empty'));
  mkdirSync(join(s.project, 'docs', 'node_modules'));
  writeFileSync(join(s.project, 'docs', 'node_modules', 'x.md'), '# x');
  mkdirSync(join(s.project, 'docs', '.obsidian'));
  writeFileSync(join(s.project, 'docs', '.obsidian', 'x.md'), '# x');

  const item = s.items.create('p1', { title: 'Board' });
  await s.docs.tie(item.id, { path: 'docs/specs/agn-1.md', kind: 'spec' });

  const tree = await s.docs.tree('p1');
  assert.equal(tree.root, 'docs');
  assert.equal(tree.exists, true);
  assert.deepEqual(names(tree.tree), [{ specs: ['agn-1.md'] }, 'a.markdown', 'b.md']);
  assert.equal(tree.fileCount, 3);
  assert.equal(tree.tiedCount, 1);
  const specs = tree.tree[0];
  assert.equal(specs?.path, 'docs/specs');
  assert.equal(specs?.fileCount, 1);
  const spec = specs?.children?.[0];
  assert.equal(spec?.title, 'Board spec');
  assert.equal(spec?.ties[0]?.item.key, 'AGN-1');
  assert.equal(spec?.ties[0]?.kind, 'spec');
  assert.equal(spec?.ties[0]?.linkRole, 'reference');
  assert.equal(tree.tree.find((n) => n.name === 'a.markdown')?.title, null);
  assert.equal(tree.tree.find((n) => n.name === 'b.md')?.size, 6);
});

test('a folder not on disk reads as empty, and an unknown project is not found', async () => {
  const s = setup();
  s.root.path = 'nowhere';
  const tree = await s.docs.tree('p1');
  assert.deepEqual({ exists: tree.exists, tree: tree.tree, fileCount: tree.fileCount }, { exists: false, tree: [], fileCount: 0 });
  await assert.rejects(s.docs.tree('p2'), /project not found/);
});

test('the title is the first level-one heading outside code', () => {
  assert.equal(titleOf('intro\n## Two\n# One\n# Later'), 'One');
  assert.equal(titleOf('~~~\n# code\n~~~\ntext'), null);
  assert.equal(titleOf('#NoSpace'), null);
  assert.equal(titleOf('# Closed ##'), 'Closed');
});

// ---------- read, write, delete ----------

test('writing creates the file and its folders, and a stale base is refused instead of overwriting', async () => {
  const s = setup();
  const first = await s.docs.write('p1', 'docs/adr/0001-store.md', { content: '# Store\n' });
  assert.deepEqual({ path: first.path, title: first.title, content: first.content, ties: first.ties }, { path: 'docs/adr/0001-store.md', title: 'Store', content: '# Store\n', ties: [] });
  assert.ok(first.updatedAt);
  const written = s.events.filter((e) => e.type === 'document.changed');
  assert.deepEqual(written.map((e) => e.type === 'document.changed' && [e.action, e.path, e.itemId]), [['written', 'docs/adr/0001-store.md', null]]);

  // The editor saves on top of what it read
  const second = await s.docs.write('p1', 'docs/adr/0001-store.md', { content: '# Store v2\n', baseUpdatedAt: first.updatedAt });
  assert.equal(second.content, '# Store v2\n');

  // An agent writes meanwhile: the editor's save on the old base is refused, and the agent's text stays
  const file = join(s.project, 'docs', 'adr', '0001-store.md');
  writeFileSync(file, '# By the agent\n');
  const later = new Date(Date.parse(second.updatedAt ?? '') + 5000);
  utimesSync(file, later, later);
  await assert.rejects(s.docs.write('p1', 'docs/adr/0001-store.md', { content: 'mine', baseUpdatedAt: second.updatedAt }), refused(409, /changed since/));
  assert.equal(readFileSync(file, 'utf8'), '# By the agent\n');
  // A base for a file that is gone is refused too; without a base, it is simply written
  await assert.rejects(s.docs.write('p1', 'docs/adr/gone.md', { content: 'x', baseUpdatedAt: second.updatedAt }), refused(409, /removed/));
  await s.docs.write('p1', 'docs/adr/0001-store.md', { content: 'forced' });
  assert.equal(readFileSync(file, 'utf8'), 'forced');
});

test('what a write is given is checked', async () => {
  const s = setup();
  await assert.rejects(s.docs.write('p1', 'docs/a.md', { content: 42 as unknown as string }), refused(400, /content/));
  // The API's body limit: a larger document would open in the editor and never save
  await assert.rejects(s.docs.write('p1', 'docs/a.md', { content: 'x'.repeat(1024 * 1024 + 1) }), refused(400, /larger/));
  assert.equal(DOCUMENT_CONTENT_MAX, 1024 * 1024);
  await assert.rejects(s.docs.write('p1', 'docs/a.md', { content: 'x', baseUpdatedAt: 5 as unknown as string }), refused(400));
  mkdirSync(join(s.project, 'docs', 'dir.md'));
  await assert.rejects(s.docs.write('p1', 'docs/dir.md', { content: 'x' }), refused(409, /not a file/));
  await assert.rejects(s.docs.read('p1', 'docs/dir.md'), refused(404));
  await assert.rejects(s.docs.read('p1', 'docs/missing.md'), refused(404));
});

test('with the Documents module off, reads go on and every change is refused', async () => {
  const s = setup();
  writeFileSync(join(s.project, 'docs', 'a.md'), '# A');
  const item = s.items.create('p1', { title: 'x' });
  s.modules.delete('documents');
  assert.equal((await s.docs.tree('p1')).fileCount, 1);
  assert.equal((await s.docs.read('p1', 'docs/a.md')).title, 'A');
  await assert.rejects(s.docs.write('p1', 'docs/a.md', { content: 'x' }), refused(409, /Documents module is off/));
  await assert.rejects(s.docs.remove('p1', 'docs/a.md'), refused(409));
  await assert.rejects(s.docs.tie(item.id, { path: 'docs/a.md' }), refused(409));
  assert.equal(readFileSync(join(s.project, 'docs', 'a.md'), 'utf8'), '# A');
  // And an item whose board is off cannot be tied to
  s.modules.add('documents');
  s.board.on = false;
  await assert.rejects(s.docs.tie(item.id, { path: 'docs/a.md' }), refused(409, /Board/));
});

test('deleting a file unties it from every item, each in its history', async () => {
  const s = setup();
  writeFileSync(join(s.project, 'docs', 'a.md'), '# A');
  const one = s.items.create('p1', { title: 'One' });
  const two = s.items.create('p1', { title: 'Two' });
  await s.docs.tie(one.id, { path: 'docs/a.md' });
  await s.docs.tie(two.id, { path: 'docs/a.md', kind: 'adr' });
  s.events.length = 0;
  await s.docs.remove('p1', 'docs/a.md');
  assert.equal(existsSync(join(s.project, 'docs', 'a.md')), false);
  assert.deepEqual(s.items.links(one.id), []);
  assert.deepEqual(s.items.links(two.id), []);
  assert.deepEqual(
    s.items.history(one.id).filter((h) => h.change === 'link').map((h) => [h.from ? 'removed' : 'added']),
    [['added'], ['removed']],
  );
  const docEvents = s.events.filter((e): e is Extract<AgentryEventInput, { type: 'document.changed' }> => e.type === 'document.changed');
  assert.deepEqual(docEvents.map((e) => [e.action, e.itemId]), [['untied', one.id], ['untied', two.id], ['removed', null]]);
  await assert.rejects(s.docs.remove('p1', 'docs/a.md'), refused(404));
});

// ---------- ties ----------

test('tying by hand is a reference to a file on disk, once per file whatever its role', async () => {
  const s = setup();
  writeFileSync(join(s.project, 'docs', 'specs', 'agn-1.md'), '# Spec');
  const item = s.items.create('p1', { title: 'Board' });
  await assert.rejects(s.docs.tie(item.id, { path: 'docs/specs/missing.md' }), refused(404));
  await assert.rejects(s.docs.tie(item.id, { path: 'docs/specs/agn-1.md', kind: 'poem' as never }), refused(400, /kind/));

  s.events.length = 0;
  const link = await s.docs.tie(item.id, { path: 'docs/specs/agn-1.md' });
  assert.deepEqual(
    { kind: link.kind, role: link.role, documentPath: link.documentPath, documentKind: link.documentKind, chatId: link.chatId, teamRole: link.teamRole },
    { kind: 'document', role: 'reference', documentPath: 'docs/specs/agn-1.md', documentKind: 'doc', chatId: null, teamRole: undefined },
  );
  assert.deepEqual(
    s.events.map((e) => e.type),
    ['workitem.updated', 'document.changed'],
  );
  const again = await s.docs.tie(item.id, { path: 'docs/specs/agn-1.md', kind: 'spec' }, { role: 'refine' });
  assert.equal(again.id, link.id);
  assert.equal(s.items.links(item.id).length, 1);
  // The history names the file
  assert.deepEqual(s.items.history(item.id).find((h) => h.change === 'link')?.to, { id: link.id, label: 'docs/specs/agn-1.md' });

  // Untying through the generic route's store call tells the documents feed too
  s.events.length = 0;
  s.items.unlink(link.id);
  const untied = s.events.find((e) => e.type === 'document.changed');
  assert.ok(untied?.type === 'document.changed' && untied.action === 'untied' && untied.itemId === item.id && untied.path === 'docs/specs/agn-1.md');
});

test('the flow ties what a run wrote in the worktree, with its role, team role and chat, and it is never live', async () => {
  const s = setup();
  const item = s.items.create('p1', { title: 'Board' });
  // Written in the item's worktree, so not in the project's checkout: tied all the same
  const link = await s.docs.tie(item.id, { path: 'docs/specs/agn-1-board.md', kind: 'spec' }, { role: 'refine', teamRole: 'product-owner', chatId: 'chat-po', requireFile: false, actor: { kind: 'agent', role: 'product-owner' } });
  assert.deepEqual([link.role, link.documentKind, link.teamRole, link.chatId], ['refine', 'spec', 'product-owner', 'chat-po']);
  assert.deepEqual(s.items.history(item.id).at(-1)?.actor, { kind: 'agent', role: 'product-owner' });
  // Still refused outside the folder
  await assert.rejects(s.docs.tie(item.id, { path: 'src/x.md' }, { requireFile: false }), refused(400));

  // A document whose chat is running is not what makes the item live: the chat's own link is
  const ties = s.items.documentTies('p1');
  assert.deepEqual(ties.map((t) => [t.path, t.tie.teamRole, t.tie.chatId, t.tie.item.key]), [['docs/specs/agn-1-board.md', 'product-owner', 'chat-po', 'AGN-1']]);
  assert.equal(isLive({ ...link, chatState: 'working' }), false);
  assert.equal(s.items.linksOfChat('chat-po').length, 1);
  assert.equal(s.items.find(item.id)?.activeLink, null);
});

test('the store takes every kind and role of the contract, and checks each document field', () => {
  const s = setup();
  const item = s.items.create('p1', { title: 'x' });
  for (const role of ['origin', 'refine', 'work', 'verify', 'reference'] as const) {
    const link = s.items.link(item.id, { kind: 'chat', role, chatId: `c-${role}` });
    assert.equal(link.role, role);
    assert.equal(link.documentPath, undefined);
  }
  assert.throws(() => s.items.link(item.id, { kind: 'chat', role: 'work', chatId: 'c', documentPath: 'docs/a.md' }), refused(400, /document link only/));
  assert.throws(() => s.items.link(item.id, { kind: 'document', role: 'reference' }), refused(400, /documentPath/));
  assert.throws(() => s.items.link(item.id, { kind: 'document', role: 'reference', documentPath: 'docs/a.txt' }), refused(400, /Markdown/));
  assert.throws(() => s.items.link(item.id, { kind: 'document', role: 'reference', documentPath: 'docs/a.md', documentKind: 'poem' as never }), refused(400));
  assert.throws(() => s.items.link(item.id, { kind: 'chat', role: 'work', chatId: 'c', teamRole: '' }), refused(400, /teamRole/));
  assert.throws(() => s.items.link(item.id, { kind: 'bogus' as never, role: 'work' }), refused(400));
  const withRole = s.items.link(item.id, { kind: 'chat', role: 'verify', chatId: 'qa', teamRole: ' qa ' });
  assert.equal(withRole.teamRole, 'qa');
});

test('a row of a kind or role this version does not know reads as an inert link', () => {
  const base = { id: 'l', item_id: 'i', chat_id: 'c', orchestration_id: null, task_id: null, document_path: null, document_kind: null, team_role: null, created_at: 'now' };
  const odd: WorkItemLink = linkOf({ ...base, kind: 'hologram', role: 'haunt' });
  assert.deepEqual([odd.kind, odd.role], ['chat', 'reference']);
  const doc = linkOf({ ...base, kind: 'document', role: 'verify', document_path: 'docs/r.md', document_kind: 'scroll', team_role: 'qa' });
  assert.deepEqual([doc.documentPath, doc.documentKind, doc.teamRole], ['docs/r.md', 'doc', 'qa']);
});

// ---------- persistence ----------

test('the document link migration applies on top of the version before it and keeps every link', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(raw, DOCUMENT_LINKS_SCHEMA_VERSION - 1);
  raw.exec(`INSERT INTO work_item_counters (project_id, last_number) VALUES ('p1', 1)`);
  raw.exec(
    `INSERT INTO work_items (id, project_id, number, type, title, description, status, priority, rank, created_at, updated_at)
     VALUES ('i1', 'p1', 1, 'task', 'Old', '', 'todo', 'medium', 'm', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
  );
  raw.exec(`INSERT INTO work_item_links (id, item_id, kind, role, chat_id, created_at) VALUES ('l1', 'i1', 'chat', 'work', 'c1', '2026-09-01T00:00:00.000Z')`);
  raw.close();

  const db = new Db(config);
  const items = new WorkItemService({ db, project: () => ({ keyPrefix: 'AGN', columnLimits: {} }) });
  const [old] = items.links('i1');
  assert.deepEqual([old?.kind, old?.role, old?.chatId, old?.documentPath, old?.teamRole], ['chat', 'work', 'c1', undefined, undefined]);
  const doc = items.link('i1', { kind: 'document', role: 'reference', documentPath: 'docs/a.md' });
  assert.equal(doc.documentPath, 'docs/a.md');
  db.close();

  const check = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  const columns = (check.prepare('PRAGMA table_info(work_item_links)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(['document_path', 'document_kind', 'team_role'].every((c) => columns.includes(c)));
  const indexes = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'work_item_links'").all() as Array<{ name: string }>).map((i) => i.name);
  assert.ok(indexes.includes('work_item_links_document'));
  check.close();
});

