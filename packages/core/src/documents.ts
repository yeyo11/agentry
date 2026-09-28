import type { Dirent } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type {
  DocumentFile,
  DocumentKind,
  DocumentNode,
  DocumentTie,
  ProjectDocuments,
  TieDocumentRequest,
  WorkItemLink,
  WorkItemLinkRole,
  WriteDocumentRequest,
} from '@agentry/shared';
import { DOCUMENT_KINDS } from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import { DocumentPathError, documentPath, isMarkdown, rootSegments } from './document-paths.ts';
import type { AgentryEventInput } from './events.ts';
import type { WorkItemContext, WorkItemService } from './work-items.ts';

/**
 * The Documents module: the Markdown files of a project's documents folder (`documents.path`,
 * `docs` by default), read and written from Agentry, and tied to work items as `document` links.
 *
 * Every path a caller hands in goes through two checks. `document-paths.ts` refuses its shape
 * (absolute, `..`, hidden parts, not Markdown, outside the folder) before the disk is touched; then
 * the file, or the nearest folder of it that exists, is resolved through its symbolic links and
 * must still be inside the documents folder, so a link planted in the repository cannot carry a
 * read or a write out of it.
 */

/** The folder a project's documents live in when its settings leave `documents.path` out */
export const DEFAULT_DOCUMENTS_PATH = 'docs';

/**
 * A document written from the editor; a file larger than this is not a note someone types. The
 * API's body limit (1 MiB) as well, so a document the core would take is never one the route drops.
 */
export const DOCUMENT_CONTENT_MAX = 1024 * 1024;

/** How much of a file is read to find its title for the tree */
const TITLE_READ_BYTES = 16 * 1024;

/**
 * Bounds on the walk, for a folder set to the project's root in a large repository: past them the
 * tree is cut rather than the request taking the machine with it.
 */
const TREE_MAX_DEPTH = 16;
const TREE_MAX_FILES = 5000;

/** Folders that are never documents, even when the documents folder is the project itself */
const SKIPPED_DIRS = new Set(['node_modules']);

export class DocumentError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/** Where a project's documents are, once the caller may read or write them. */
export interface DocumentsPlace {
  /** The project's directory, absolute */
  projectPath: string;
  /** `documents.path`, relative to the project */
  root: string;
}

export interface DocumentServiceDeps {
  items: WorkItemService;
  /**
   * The project's directory and its documents folder. Throws for a project that is not imported;
   * for a write, also when its Documents module is off. Reads go on with the module off, as the
   * board's do: switching a module off hides it, it does not make the files look gone.
   */
  place: (projectId: string, access: 'read' | 'write') => Promise<DocumentsPlace>;
  /** The item's project, after checking the item may be changed (its project's Board module is on) */
  itemProject: (itemId: string) => Promise<string>;
  emit?: (event: AgentryEventInput) => void;
}

/** How a tie is made. A person ties by hand in `reference`; the flow ties what a run wrote. */
export interface TieOptions extends WorkItemContext {
  role?: WorkItemLinkRole;
  teamRole?: string | null;
  chatId?: string | null;
  /**
   * The file must be on disk in the project's directory. A flow run writes in the item's worktree,
   * so what it reports is not in the project's checkout until that branch is merged: the flow ties
   * it with this off.
   */
  requireFile?: boolean;
}

export class DocumentService {
  constructor(private readonly deps: DocumentServiceDeps) {}

  /** The folder's tree, Markdown files only, directories first, each file with its ties. */
  async tree(projectId: string): Promise<ProjectDocuments> {
    const place = await this.deps.place(projectId, 'read');
    const rootDir = rootDirOf(place);
    const ties = tiesByPath(this.deps.items.documentTies(projectId));
    const base = rootSegments(place.root).join('/');
    const realRoot = await resolvedRoot(place);
    const exists = realRoot !== null && (await stat(realRoot).then((s) => s.isDirectory()).catch(() => false));
    const budget = { files: TREE_MAX_FILES };
    const tree = exists ? await walk(rootDir, base, 0, ties, budget) : [];
    const files = flatten(tree);
    return {
      projectId,
      root: place.root,
      exists,
      tree,
      fileCount: files.length,
      tiedCount: files.filter((f) => f.ties.length > 0).length,
    };
  }

  async read(projectId: string, path: unknown): Promise<DocumentFile> {
    const place = await this.deps.place(projectId, 'read');
    const rel = checked(path, place.root);
    const file = await existingFile(place, rel);
    const [content, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    return {
      path: rel,
      content,
      title: titleOf(content),
      size: info.size,
      updatedAt: info.mtime.toISOString(),
      ties: this.tiesOf(projectId, rel),
    };
  }

  /**
   * Creates or replaces a file, and the folders it needs. With `baseUpdatedAt`, a file changed since
   * the editor read it (an agent wrote it meanwhile) is refused with 409 instead of overwritten; a
   * file gone since is refused as well, since the editor was working on something that no longer is.
   */
  async write(projectId: string, path: unknown, request: WriteDocumentRequest): Promise<DocumentFile> {
    const place = await this.deps.place(projectId, 'write');
    const rel = checked(path, place.root);
    const content: unknown = request?.content;
    if (typeof content !== 'string') throw new DocumentError('content must be text', 400);
    if (Buffer.byteLength(content, 'utf8') > DOCUMENT_CONTENT_MAX) {
      throw new DocumentError(`a document is larger than ${String(DOCUMENT_CONTENT_MAX / 1024 / 1024)} MiB`, 400);
    }
    const base: unknown = request.baseUpdatedAt;
    if (base !== undefined && base !== null && typeof base !== 'string') throw new DocumentError('baseUpdatedAt must be a date or null', 400);
    const file = await writableFile(place, rel);
    const before = await stat(file).catch(() => null);
    if (before && !before.isFile()) throw new DocumentError(`${rel} is not a file`, 409);
    if (typeof base === 'string') {
      if (!before) throw new DocumentError(`${rel} was removed since it was opened`, 409);
      if (before.mtime.toISOString() !== base) throw new DocumentError(`${rel} changed since it was opened: reload it before saving`, 409);
    }
    await writeAtomic(file, content);
    this.emit({ type: 'document.changed', title: `Document ${rel} written`, projectId, path: rel, action: 'written', itemId: null });
    return this.read(projectId, rel);
  }

  /**
   * Deletes a file and unties it from every item: a tie to a file that is gone would open onto
   * nothing. Each untie is recorded in its item's history like any other.
   */
  async remove(projectId: string, path: unknown, ctx?: WorkItemContext): Promise<void> {
    const place = await this.deps.place(projectId, 'write');
    const rel = checked(path, place.root);
    const file = await existingFile(place, rel);
    await unlink(file);
    for (const tie of this.tiesOf(projectId, rel)) {
      try {
        this.deps.items.unlink(tie.linkId, ctx);
      } catch {
        // already untied by someone else in the meantime: what was asked is done
      }
    }
    this.emit({ type: 'document.changed', title: `Document ${rel} removed`, projectId, path: rel, action: 'removed', itemId: null });
  }

  /**
   * Ties a document of the item's project to it, as a `document` link. By hand it is `reference`,
   * and the file must exist; the flow passes the role, the team role and the chat of its run.
   */
  async tie(itemId: string, request: TieDocumentRequest, options: TieOptions = {}): Promise<WorkItemLink> {
    const projectId = await this.deps.itemProject(itemId);
    const place = await this.deps.place(projectId, 'write');
    const rel = checked(request?.path, place.root);
    const kind = kindOf(request.kind);
    if (options.requireFile !== false) await existingFile(place, rel);
    const { role, teamRole, chatId, ...ctx } = options;
    return this.deps.items.link(
      itemId,
      { kind: 'document', role: role ?? 'reference', documentPath: rel, documentKind: kind, teamRole: teamRole ?? null, chatId: chatId ?? null },
      ctx,
    );
  }

  private tiesOf(projectId: string, rel: string): DocumentTie[] {
    return this.deps.items.documentTies(projectId, rel).map((t) => t.tie);
  }

  private emit(event: AgentryEventInput): void {
    try {
      this.deps.emit?.(event);
    } catch {
      // the file is written; a broken listener must not turn it into an error for the caller
    }
  }
}

// ---------- paths ----------

function rootDirOf(place: DocumentsPlace): string {
  return join(place.projectPath, ...rootSegments(place.root));
}

function checked(path: unknown, root: string): string {
  try {
    return documentPath(path, root);
  } catch (err) {
    if (err instanceof DocumentPathError) throw new DocumentError(err.message, 400);
    throw err;
  }
}

function kindOf(value: unknown): DocumentKind {
  if (value === undefined || value === null) return 'doc';
  if (typeof value !== 'string' || !(DOCUMENT_KINDS as readonly string[]).includes(value)) {
    throw new DocumentError(`kind must be one of ${DOCUMENT_KINDS.join(', ')}`, 400);
  }
  return value as DocumentKind;
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * The documents folder through its symbolic links, or null while it does not exist. The files are
 * checked against this folder, so the folder itself (or a folder on the way to it) must not be a
 * link that leads out of the project: `docs -> /home/someone` would make every file there a document.
 */
async function resolvedRoot(place: DocumentsPlace): Promise<string | null> {
  const realRoot = await realpath(rootDirOf(place)).catch(() => null);
  if (!realRoot) return null;
  const realProject = await realpath(place.projectPath).catch(() => null);
  if (!realProject || !inside(realRoot, realProject)) {
    throw new DocumentError(`the documents folder ${place.root} is outside the project`, 400);
  }
  return realRoot;
}

/**
 * The file a checked path names on disk. A name is matched as written first, then by its NFC form:
 * the same accented name can be stored composed or decomposed (a checkout made on macOS), and a
 * path typed or reported by an agent is composed, so without this it would not find the file, and a
 * write would add a second one beside it.
 */
async function onDisk(place: DocumentsPlace, rel: string): Promise<string> {
  let dir = place.projectPath;
  const segments = rel.split('/');
  for (const [i, segment] of segments.entries()) {
    const exact = join(dir, segment);
    if (await lstat(exact).catch(() => null)) {
      dir = exact;
      continue;
    }
    const wanted = segment.normalize('NFC');
    const names = await readdir(dir).catch(() => [] as string[]);
    const match = names.find((name) => name.normalize('NFC') === wanted);
    if (!match) return join(exact, ...segments.slice(i + 1));
    dir = join(dir, match);
  }
  return dir;
}

/** The file on disk for a checked path, which must exist, be a file, and resolve inside the folder. */
async function existingFile(place: DocumentsPlace, rel: string): Promise<string> {
  const file = await onDisk(place, rel);
  const realRoot = await resolvedRoot(place);
  const real = await realpath(file).catch(() => null);
  if (!realRoot || !real) throw new DocumentError(`document ${rel} not found`, 404);
  if (!inside(real, realRoot) || real === realRoot) throw new DocumentError(`${rel} is outside the documents folder`, 400);
  const info = await stat(real);
  if (!info.isFile()) throw new DocumentError(`document ${rel} not found`, 404);
  return real;
}

/**
 * Where a checked path may be written. The nearest part of it that exists is resolved: it must be
 * inside the documents folder, or, while the folder itself does not exist yet, inside the project.
 * The folders are then made, and the file's own folder checked again once it exists, so a link
 * swapped in between cannot carry the write out either.
 */
async function writableFile(place: DocumentsPlace, rel: string): Promise<string> {
  const file = await onDisk(place, rel);
  const rootDir = rootDirOf(place);
  const outside = new DocumentError(`${rel} is outside the documents folder`, 400);
  const realProject = await realpath(place.projectPath).catch(() => null);
  if (!realProject) throw new DocumentError(`the project's directory ${place.projectPath} is missing`, 409);
  let probe = dirname(file);
  while (!(await lstat(probe).catch(() => null))) {
    const up = dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const realProbe = await realpath(probe).catch(() => null);
  const realRoot = await resolvedRoot(place);
  const allowed = realProbe !== null && (realRoot ? inside(realProbe, realRoot) : inside(realProbe, realProject));
  if (!allowed || realProbe === null) throw outside;
  // A file where a folder of the path should be: mkdir fails with ENOTDIR, which is the caller's path
  // meeting what is on disk, not a fault of the server
  if (!(await stat(realProbe).then((s) => s.isDirectory()).catch(() => false))) {
    throw new DocumentError(`${relativeTo(place, probe)} is a file, so it cannot hold ${rel}`, 409);
  }
  await mkdir(dirname(file), { recursive: true });
  // Checked again on what now exists: the folder the file goes in, and the file if it is a link
  const realDir = await realpath(dirname(file));
  const madeRoot = await resolvedRoot(place);
  if (!madeRoot || !inside(realDir, madeRoot)) throw outside;
  const target = join(realDir, basename(file));
  const link = await lstat(target).catch(() => null);
  if (link?.isSymbolicLink()) {
    const real = await realpath(target).catch(() => null);
    if (!real || !inside(real, madeRoot)) throw outside;
  }
  return target;
}

function relativeTo(place: DocumentsPlace, path: string): string {
  return relative(place.projectPath, path).split(sep).join('/');
}

// ---------- the tree ----------

function tiesByPath(entries: Array<{ path: string; tie: DocumentTie }>): Map<string, DocumentTie[]> {
  const out = new Map<string, DocumentTie[]>();
  for (const { path, tie } of entries) out.set(path, [...(out.get(path) ?? []), tie]);
  return out;
}

/**
 * One folder's entries. Symbolic links are left out rather than followed: one can point anywhere,
 * and the tree is what the editor offers to open. Folders with no Markdown under them are left out.
 */
async function walk(dir: string, rel: string, depth: number, ties: Map<string, DocumentTie[]>, budget: { files: number }): Promise<DocumentNode[]> {
  if (depth > TREE_MAX_DEPTH) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const dirs: DocumentNode[] = [];
  const files: DocumentNode[] = [];
  const at = (name: string): string => (rel ? `${rel}/${name}` : name);
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      const children = await walk(join(dir, entry.name), at(entry.name), depth + 1, ties, budget);
      const fileCount = countFiles(children);
      if (fileCount > 0) dirs.push({ name: entry.name, path: at(entry.name), type: 'dir', children, fileCount, ties: [] });
    } else if (entry.isFile() && isMarkdown(entry.name) && budget.files > 0) {
      budget.files--;
      const full = join(dir, entry.name);
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      files.push({
        name: entry.name,
        path: at(entry.name),
        type: 'file',
        title: await readTitle(full),
        size: info.size,
        updatedAt: info.mtime.toISOString(),
        // Ties are kept under the NFC form of the path, whichever form the name has on disk
        ties: ties.get(at(entry.name).normalize('NFC')) ?? [],
      });
    }
  }
  return [...dirs, ...files];
}

function countFiles(nodes: DocumentNode[]): number {
  return nodes.reduce((n, node) => n + (node.type === 'file' ? 1 : (node.fileCount ?? 0)), 0);
}

function flatten(nodes: DocumentNode[]): DocumentNode[] {
  return nodes.flatMap((n) => (n.type === 'file' ? [n] : flatten(n.children ?? [])));
}

async function readTitle(file: string): Promise<string | null> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(TITLE_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TITLE_READ_BYTES, 0);
    return titleOf(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

/** The first level-one ATX heading, outside fenced code; a closing run of `#` is not part of it. */
export function titleOf(content: string): string | null {
  let fenced = false;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^# +(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}
