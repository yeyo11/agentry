import type { DocumentKind, DocumentNode, DocumentTie, WorkItemLink } from '@agentry/shared';

/**
 * The pure part of the Documents tab and of a work item's documents: walking the tree, filtering
 * it, the list of documents tied to items, and where a new document goes. No React, so it is tested
 * on its own (test/documents-model.test.ts).
 */

/** The mono tag each kind wears on a row (SPEC, ADR…): a kind is a fact, never a colour. */
export const DOCUMENT_KINDS: readonly DocumentKind[] = ['spec', 'adr', 'report', 'doc'];

/** A file's tie the Documents tab shows first: what an agent wrote beats a tie made by hand. */
export function mainTie(ties: readonly DocumentTie[]): DocumentTie | null {
  return ties.find((tie) => tie.teamRole !== null) ?? ties[0] ?? null;
}

/** Every file of the tree, in the order the tree draws them. */
export function filesOf(tree: readonly DocumentNode[]): DocumentNode[] {
  const out: DocumentNode[] = [];
  const walk = (nodes: readonly DocumentNode[]) => {
    for (const node of nodes) {
      if (node.type === 'file') out.push(node);
      else walk(node.children ?? []);
    }
  };
  walk(tree);
  return out;
}

export function findFile(tree: readonly DocumentNode[], path: string): DocumentNode | null {
  return filesOf(tree).find((file) => file.path === path) ?? null;
}

/**
 * The tree cut down to what matches `query` (by name, path or title), keeping the folders on the
 * way to each match. An empty query keeps everything.
 */
export function filterTree(tree: readonly DocumentNode[], query: string): DocumentNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tree];
  const out: DocumentNode[] = [];
  for (const node of tree) {
    if (node.type === 'file') {
      const hay = `${node.path} ${node.title ?? ''}`.toLowerCase();
      if (hay.includes(q)) out.push(node);
      continue;
    }
    const children = filterTree(node.children ?? [], q);
    if (children.length > 0) out.push({ ...node, children });
  }
  return out;
}

/** The folders holding `path`, from the root down, so opening a file shows where it is. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(1, -1).map((_, i) => parts.slice(0, i + 2).join('/'));
}

/** One file tied to an item, for the "Tied to tasks" list: newest tie first. */
export interface TiedDocument {
  path: string;
  title: string;
  tie: DocumentTie;
}

export function tiedDocuments(tree: readonly DocumentNode[]): TiedDocument[] {
  return filesOf(tree)
    .flatMap((file) => {
      const tie = mainTie(file.ties);
      return tie ? [{ path: file.path, title: file.title ?? file.name, tie }] : [];
    })
    .sort((a, b) => b.tie.createdAt.localeCompare(a.tie.createdAt));
}

/** A work item's `document` links, newest first; a path tied twice (two roles) shows once. */
export function documentLinks(links: readonly WorkItemLink[]): WorkItemLink[] {
  const seen = new Set<string>();
  return [...links]
    .filter((link) => link.kind === 'document' && link.documentPath)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((link) => {
      const path = link.documentPath ?? '';
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    });
}

/** The folder a kind of document goes in by default, under the documents folder. */
const KIND_FOLDER: Record<DocumentKind, string> = { spec: 'specs', adr: 'adr', report: 'reports', doc: '' };

const slug = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');

/**
 * Where a new document is written: `<root>/<folder>/<key>-<title>.md` for one made from a work
 * item, `<root>/<name>.md` for a blank one. The person can change it before saving.
 */
export function newDocumentPath(root: string, kind: DocumentKind, from: { key?: string; title: string }): string {
  const folder = KIND_FOLDER[kind];
  const name = [from.key ? slug(from.key) : '', slug(from.title)].filter(Boolean).join('-') || 'untitled';
  return [root.replace(/\/+$/, ''), folder, `${name}.md`].filter(Boolean).join('/');
}

/**
 * A path the person typed for a new document, made relative to the project and checked the way the
 * API checks it: inside the documents folder, a Markdown file, no `..`. Null when it is not one.
 */
export function normalizeNewPath(root: string, typed: string): string | null {
  let path = typed.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (!path || path.startsWith('/')) return null;
  const base = root.replace(/\/+$/, '');
  if (!path.startsWith(`${base}/`)) path = `${base}/${path}`;
  if (!path.endsWith('.md')) path = `${path}.md`;
  if (path.split('/').some((part) => part === '..' || part === '.' || part === '')) return null;
  return path;
}

/** A file's name without the folders, for a heading when it has no `# ` title. */
export const baseName = (path: string) => path.split('/').pop() ?? path;

/** The first `# ` heading of a Markdown text, as the API's `title` reads it. */
export function titleOf(content: string): string | null {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(content);
  return match?.[1]?.trim() || null;
}

/** A starting text for a new document: its title, and for one from an item, which item. */
export function newDocumentContent(title: string, item?: { key: string }): string {
  return item ? `# ${title}\n\n${item.key}\n` : `# ${title}\n`;
}
