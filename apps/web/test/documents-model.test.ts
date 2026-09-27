import type { DocumentNode, DocumentTie, WorkItemLink } from '@agentry/shared';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ancestorsOf,
  documentLinks,
  filesOf,
  filterTree,
  mainTie,
  newDocumentPath,
  normalizeNewPath,
  tiedDocuments,
  titleOf,
} from '../src/pages/documents/model.ts';
import { byteSize, dayGroups, localDay, memoryDir, sortMemoryFiles } from '../src/pages/home/memory/model.ts';

// The Documents tab and the Memory tab do their sums in these two models: the tree, the list of
// documents tied to tasks, where a new document goes, and the journal's days.

const tie = (over: Partial<DocumentTie> = {}): DocumentTie => ({
  linkId: 'l1',
  item: { id: 'i1', key: 'AGN-28', title: 'Board', type: 'story', status: 'todo' },
  kind: 'spec',
  linkRole: 'refine',
  teamRole: 'product-owner',
  chatId: 'c1',
  createdAt: '2026-09-27T10:00:00.000Z',
  ...over,
});

const file = (path: string, over: Partial<DocumentNode> = {}): DocumentNode => ({
  name: path.split('/').pop() ?? path,
  path,
  type: 'file',
  title: null,
  ties: [],
  ...over,
});

const dir = (path: string, children: DocumentNode[]): DocumentNode => ({
  name: path.split('/').pop() ?? path,
  path,
  type: 'dir',
  children,
  fileCount: filesOf(children).length,
  ties: [],
});

const TREE: DocumentNode[] = [
  dir('docs/adr', [file('docs/adr/ADR-007-links.md', { title: 'Links are rows', ties: [tie({ kind: 'adr', teamRole: 'architect', createdAt: '2026-09-27T11:00:00.000Z' })] })]),
  dir('docs/specs', [
    file('docs/specs/agn-28-board.md', { title: 'Board with fixed columns', ties: [tie({ teamRole: null, linkRole: 'reference' }), tie()] }),
    file('docs/specs/agn-33-links.md'),
  ]),
  file('docs/status.md', { title: 'Status' }),
];

test('the tree walks to its files, in the order it draws them', () => {
  assert.deepEqual(
    filesOf(TREE).map((f) => f.path),
    ['docs/adr/ADR-007-links.md', 'docs/specs/agn-28-board.md', 'docs/specs/agn-33-links.md', 'docs/status.md'],
  );
});

test('a filter keeps the folders on the way to each match, and matches titles too', () => {
  const found = filterTree(TREE, 'fixed columns');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.path, 'docs/specs');
  assert.deepEqual(found[0]?.children?.map((f) => f.path), ['docs/specs/agn-28-board.md']);
  assert.equal(filterTree(TREE, '  ').length, TREE.length);
  assert.deepEqual(filterTree(TREE, 'nothing like it'), []);
});

test('opening a file opens every folder above it', () => {
  assert.deepEqual(ancestorsOf('docs/specs/sub/a.md'), ['docs/specs', 'docs/specs/sub']);
  assert.deepEqual(ancestorsOf('docs/a.md'), []);
});

test('what an agent wrote is the tie a document shows first', () => {
  assert.equal(mainTie([tie({ teamRole: null }), tie({ teamRole: 'qa' })])?.teamRole, 'qa');
  assert.equal(mainTie([tie({ teamRole: null })])?.teamRole, null);
  assert.equal(mainTie([]), null);
});

test('the tied list has one row per file, newest tie first, titled by its heading', () => {
  const tied = tiedDocuments(TREE);
  assert.deepEqual(
    tied.map((d) => [d.path, d.title, d.tie.teamRole]),
    [
      ['docs/adr/ADR-007-links.md', 'Links are rows', 'architect'],
      ['docs/specs/agn-28-board.md', 'Board with fixed columns', 'product-owner'],
    ],
  );
});

test("a work item's documents: only document links, newest first, one row per path", () => {
  const link = (id: string, over: Partial<WorkItemLink>): WorkItemLink => ({
    id,
    itemId: 'i1',
    kind: 'document',
    role: 'refine',
    chatId: null,
    orchestrationId: null,
    taskId: null,
    createdAt: '2026-09-27T10:00:00.000Z',
    ...over,
  });
  const links = documentLinks([
    link('a', { documentPath: 'docs/specs/a.md', createdAt: '2026-09-27T09:00:00.000Z' }),
    link('b', { kind: 'chat', chatId: 'c1' }),
    link('c', { documentPath: 'docs/adr/b.md', createdAt: '2026-09-27T12:00:00.000Z' }),
    link('d', { documentPath: 'docs/specs/a.md', role: 'reference', createdAt: '2026-09-27T11:00:00.000Z' }),
  ]);
  assert.deepEqual(
    links.map((l) => l.id),
    ['c', 'd'],
  );
});

test('a new document goes in its kind folder, named after the item and its title', () => {
  assert.equal(newDocumentPath('docs', 'spec', { key: 'AGN-28', title: 'Tablero con columnas fijas' }), 'docs/specs/agn-28-tablero-con-columnas-fijas.md');
  assert.equal(newDocumentPath('docs/', 'adr', { title: 'Links are rows' }), 'docs/adr/links-are-rows.md');
  assert.equal(newDocumentPath('docs', 'doc', { title: '' }), 'docs/untitled.md');
});

test('a typed path is kept inside the documents folder, as Markdown, with no way out', () => {
  assert.equal(normalizeNewPath('docs', 'notes/today'), 'docs/notes/today.md');
  assert.equal(normalizeNewPath('docs', './docs/a.md'), 'docs/a.md');
  assert.equal(normalizeNewPath('docs', 'docs//b.md'), 'docs/b.md');
  assert.equal(normalizeNewPath('docs', '../secrets.md'), null);
  assert.equal(normalizeNewPath('docs', '/etc/passwd'), null);
  assert.equal(normalizeNewPath('docs', '   '), null);
});

test("a document's title is its first heading", () => {
  assert.equal(titleOf('intro\n\n# Board with fixed columns\n\n## Columns'), 'Board with fixed columns');
  assert.equal(titleOf('## Only a second level'), null);
});

test('the journal groups by the local day: today, yesterday, then each date', () => {
  const now = new Date(2026, 8, 27, 15, 0);
  const at = (d: number, h: number) => ({ createdAt: new Date(2026, 8, d, h, 0).toISOString() });
  const groups = dayGroups([at(27, 14), at(27, 9), at(26, 18), at(24, 8), at(24, 7)], now);
  assert.deepEqual(
    groups.map((g) => [g.day, g.entries.length]),
    [
      ['today', 2],
      ['yesterday', 1],
      [localDay(new Date(2026, 8, 24)), 2],
    ],
  );
  assert.equal(localDay(new Date(2026, 0, 5)), '2026-01-05');
});

test('memory sizes are bytes on disk, and the index reads first', () => {
  assert.equal(byteSize('abc'), 3);
  assert.equal(byteSize('ñ'), 2);
  assert.equal(memoryDir([{ path: '/h/.claude/projects/x/memory/a.md' }]), '/h/.claude/projects/x/memory');
  assert.equal(memoryDir([]), null);
  assert.deepEqual(
    sortMemoryFiles([
      { name: 'b.md', isIndex: false },
      { name: 'MEMORY.md', isIndex: true },
      { name: 'a.md', isIndex: false },
    ]).map((f) => f.name),
    ['MEMORY.md', 'a.md', 'b.md'],
  );
});
