import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AgentryEvent, DocumentFile, Project, ProjectDocuments, WorkItem, WorkItemDetail, WorkItemLink } from '@agentry/shared';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

// The documents routes over a real core with scratch dirs and a missing CLI: nothing here spawns
// Claude or reads the real ~/.claude.
let app: FastifyInstance;
let core: Core;
let root: string;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const scratch = () => mkdtempSync(join(tmpdir(), 'agentry-api-docs-'));
const q = (path: string) => `?path=${encodeURIComponent(path)}`;

async function importProject(name: string, modules: string[] = ['board', 'documents']): Promise<{ project: Project; dir: string }> {
  const dir = scratch();
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const res = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: dir, name, modules }) });
  assert.equal(res.statusCode, 201, res.body);
  return { project: res.json<Project>(), dir };
}

async function createItem(projectId: string, title: string): Promise<WorkItem> {
  const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/work-items`, ...json({ title }) });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<WorkItem>();
}

async function feed(fn: () => Promise<void>): Promise<AgentryEvent[]> {
  const events: AgentryEvent[] = [];
  const stop = core.events.subscribe((e) => events.push(e));
  try {
    await fn();
  } finally {
    stop();
  }
  return events;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-documents-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(() => app.close());

test('write, read, list and delete a document, each announced on the feed', async () => {
  const { project, dir } = await importProject('Docs');
  const base = `/api/projects/${project.id}/documents`;

  const empty = (await app.inject(base)).json<ProjectDocuments>();
  assert.deepEqual({ root: empty.root, exists: empty.exists, fileCount: empty.fileCount }, { root: 'docs', exists: true, fileCount: 0 });

  let written: DocumentFile | undefined;
  const events = await feed(async () => {
    const res = await app.inject({ method: 'PUT', url: `${base}/file${q('docs/specs/board.md')}`, ...json({ content: '# Board\n' }) });
    assert.equal(res.statusCode, 200, res.body);
    written = res.json<DocumentFile>();
  });
  assert.equal(written?.title, 'Board');
  assert.equal(readFileSync(join(dir, 'docs', 'specs', 'board.md'), 'utf8'), '# Board\n');
  const changed = events.find((e) => e.type === 'document.changed');
  assert.ok(changed?.type === 'document.changed' && changed.action === 'written' && changed.path === 'docs/specs/board.md' && changed.projectId === project.id);

  const tree = (await app.inject(base)).json<ProjectDocuments>();
  assert.equal(tree.fileCount, 1);
  assert.equal(tree.tree[0]?.children?.[0]?.path, 'docs/specs/board.md');

  const read = await app.inject(`${base}/file${q('docs/specs/board.md')}`);
  assert.equal(read.json<DocumentFile>().content, '# Board\n');

  // A stale save is a conflict, not an overwrite
  writeFileSync(join(dir, 'docs', 'specs', 'board.md'), '# Agent\n');
  const later = new Date(Date.parse(written?.updatedAt ?? '') + 5000);
  utimesSync(join(dir, 'docs', 'specs', 'board.md'), later, later);
  const stale = await app.inject({ method: 'PUT', url: `${base}/file${q('docs/specs/board.md')}`, ...json({ content: 'mine', baseUpdatedAt: written?.updatedAt }) });
  assert.equal(stale.statusCode, 409, stale.body);

  const removed = await app.inject({ method: 'DELETE', url: `${base}/file${q('docs/specs/board.md')}` });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(existsSync(join(dir, 'docs', 'specs', 'board.md')), false);
  assert.equal((await app.inject(`${base}/file${q('docs/specs/board.md')}`)).statusCode, 404);
});

test('no request reaches a file outside the documents folder, however the path is spelt', async () => {
  const { project, dir } = await importProject('Traversal');
  const outside = scratch();
  writeFileSync(join(outside, 'secret.md'), '# Secret');
  writeFileSync(join(dir, 'README.md'), '# Readme');
  symlinkSync(join(outside, 'secret.md'), join(dir, 'docs', 'leak.md'));
  symlinkSync(outside, join(dir, 'docs', 'out'));
  const base = `/api/projects/${project.id}/documents/file`;
  const rel = outside.split('/').pop() ?? '';

  const paths = [
    `?path=${encodeURIComponent(`../${rel}/secret.md`)}`,
    `?path=${encodeURIComponent(`docs/../../${rel}/secret.md`)}`,
    `?path=docs/../../${rel}/secret.md`,
    `?path=docs%2F..%2F..%2F${rel}%2Fsecret.md`,
    `?path=${encodeURIComponent(join(outside, 'secret.md'))}`,
    `?path=${encodeURIComponent('docs\\..\\..\\secret.md')}`,
    `?path=${encodeURIComponent('docs/leak.md')}`,
    `?path=${encodeURIComponent('docs/out/secret.md')}`,
    `?path=README.md`,
    `?path=docs%00.md`,
    '',
  ];
  for (const query of paths) {
    const read = await app.inject(`${base}${query}`);
    assert.equal(read.statusCode, 400, `GET ${query}: ${read.body}`);
    const write = await app.inject({ method: 'PUT', url: `${base}${query}`, ...json({ content: 'pwned' }) });
    assert.equal(write.statusCode, 400, `PUT ${query}: ${write.body}`);
    const del = await app.inject({ method: 'DELETE', url: `${base}${query}` });
    assert.equal(del.statusCode, 400, `DELETE ${query}: ${del.body}`);
  }
  // Also as an array of values, which a query string can carry
  assert.equal((await app.inject(`${base}?path=docs/a.md&path=../x.md`)).statusCode, 400);
  assert.equal(readFileSync(join(outside, 'secret.md'), 'utf8'), '# Secret');
  assert.equal(existsSync(join(outside, 'pwned')), false);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# Readme');

  const item = await createItem(project.id, 'Tie out');
  for (const path of [`../${rel}/secret.md`, 'docs/out/secret.md', 'README.md']) {
    const tie = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/documents`, ...json({ path }) });
    assert.equal(tie.statusCode, 400, `tie ${path}: ${tie.body}`);
    const link = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/links`, ...json({ kind: 'document', role: 'reference', documentPath: path }) });
    assert.equal(link.statusCode, 400, `link ${path}: ${link.body}`);
  }
  assert.deepEqual((await app.inject(`/api/work-items/${item.id}/links`)).json<WorkItemLink[]>(), []);
});

test('a document tied by hand shows on the item and in the tree, and untying it tells both', async () => {
  const { project, dir } = await importProject('Ties');
  writeFileSync(join(dir, 'docs', 'adr.md'), '# Decision');
  const item = await createItem(project.id, 'Decide');

  const missing = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/documents`, ...json({ path: 'docs/none.md' }) });
  assert.equal(missing.statusCode, 404);

  let link: WorkItemLink | undefined;
  const events = await feed(async () => {
    const res = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/documents`, ...json({ path: 'docs/adr.md', kind: 'adr' }) });
    assert.equal(res.statusCode, 201, res.body);
    link = res.json<WorkItemLink>();
  });
  assert.deepEqual([link?.kind, link?.role, link?.documentPath, link?.documentKind], ['document', 'reference', 'docs/adr.md', 'adr']);
  assert.deepEqual(
    events.map((e) => e.type),
    ['workitem.updated', 'document.changed'],
  );

  const detail = (await app.inject(`/api/work-items/${item.id}`)).json<WorkItemDetail>();
  assert.equal(detail.links[0]?.documentPath, 'docs/adr.md');
  const tree = (await app.inject(`/api/projects/${project.id}/documents`)).json<ProjectDocuments>();
  assert.equal(tree.tiedCount, 1);
  assert.equal(tree.tree[0]?.ties[0]?.item.key, item.key);

  // Tied again through the generic links route: the same link
  const again = await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/links`, ...json({ kind: 'document', role: 'work', documentPath: 'docs/adr.md' }) });
  assert.equal(again.statusCode, 201, again.body);
  assert.equal(again.json<WorkItemLink>().id, link?.id);

  const untie = await feed(async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/work-items/${item.id}/links/${link?.id ?? ''}` });
    assert.equal(res.statusCode, 200, res.body);
  });
  const untied = untie.find((e) => e.type === 'document.changed');
  assert.ok(untied?.type === 'document.changed' && untied.action === 'untied' && untied.itemId === item.id);
  assert.equal((await app.inject(`/api/projects/${project.id}/documents/file${q('docs/adr.md')}`)).json<DocumentFile>().ties.length, 0);
  assert.ok(existsSync(join(dir, 'docs', 'adr.md')), 'untying leaves the file');
});

test('with the Documents module off the folder stays readable and refuses every change', async () => {
  const { project, dir } = await importProject('Off', ['board']);
  writeFileSync(join(dir, 'docs', 'a.md'), '# A');
  const item = await createItem(project.id, 'x');
  assert.equal((await app.inject(`/api/projects/${project.id}/documents`)).json<ProjectDocuments>().fileCount, 1);
  assert.equal((await app.inject(`/api/projects/${project.id}/documents/file${q('docs/a.md')}`)).statusCode, 200);
  const put = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/documents/file${q('docs/a.md')}`, ...json({ content: 'x' }) });
  assert.equal(put.statusCode, 409);
  assert.match(put.json<{ error: string }>().error, /Documents module is off/);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/documents/file${q('docs/a.md')}` })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/documents`, ...json({ path: 'docs/a.md' }) })).statusCode, 409);
  assert.equal(readFileSync(join(dir, 'docs', 'a.md'), 'utf8'), '# A');
});

test('the folder follows documents.path, and an unknown project is not found', async () => {
  const { project, dir } = await importProject('Handbook');
  const settings = (await app.inject(`/api/projects/${project.id}/settings`)).json<Record<string, unknown>>();
  const saved = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/settings`, ...json({ ...settings, documents: { path: 'handbook' } }) });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/documents/file${q('docs/a.md')}`, ...json({ content: 'x' }) })).statusCode, 400);
  const res = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/documents/file${q('handbook/a.md')}`, ...json({ content: '# H' }) });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(existsSync(join(dir, 'handbook', 'a.md')));
  const tree = (await app.inject(`/api/projects/${project.id}/documents`)).json<ProjectDocuments>();
  assert.equal(tree.root, 'handbook');

  assert.equal((await app.inject('/api/projects/nope/documents')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/work-items/nope/documents', ...json({ path: 'docs/a.md' }) })).statusCode, 404);
});
