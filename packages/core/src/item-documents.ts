import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { WorkItem, WorkItemLink } from '@agentry/shared';
import { DocumentPathError, documentPath } from './document-paths.ts';
import { DocumentError, existingDocument } from './documents.ts';
import { commitPaths, git, headCommit, mergeBase } from './git.ts';
import type { ItemPlace } from './work-links.ts';

/**
 * Brings the documents tied to a work item into its worktree before a work or verify run starts
 * there. A refine writes the item's specification in the project's checkout, where the Documents
 * module reads, and leaves it uncommitted; the worktree is cut from a commit, so without this the
 * run would be told of a file that is not where it works.
 *
 * The checkout's copy is the source, but never over the branch's own: a document the branch has
 * committed since it forked, or has uncommitted edits to, was changed by whoever works there, and is
 * left as it is. What is copied is committed on the item's branch in a commit of its own, so it
 * travels with the branch while the developer's uncommitted work stays out.
 */

export interface ItemDocumentSync {
  /** Every tied document found in the worktree afterwards, copied or already there, in link order */
  present: string[];
  /** The documents copied in this pass */
  copied: string[];
  /** The commit that holds them, or null when nothing was copied */
  commit: string | null;
  /** Documents left out, with why: a refused path, a file missing from the checkout */
  skipped: Array<{ path: string; reason: string }>;
}

export interface ItemDocumentSyncInput {
  item: Pick<WorkItem, 'key'>;
  /** The item's links; only its `document` links are read */
  links: readonly WorkItemLink[];
  /** The project's checkout, where the refine wrote */
  projectPath: string;
  /** `documents.path`, relative to the project */
  documentsRoot: string;
  place: ItemPlace;
}

/** The message of the commit the sync makes, which is also how its own commits are told from the branch's. */
export function documentSyncMessage(item: Pick<WorkItem, 'key'>): string {
  return `docs: bring ${item.key}'s specification into its branch`;
}

/** The line a work or verify prompt gets, naming the documents the run finds in its worktree; null when there are none. */
export function documentsLine(present: readonly string[]): string | null {
  if (!present.length) return null;
  return `The item's specification is in this worktree: ${present.map((p) => `\`${p}\``).join(', ')}.`;
}

/**
 * The prompt with the documents line in it, right after the item's own part (above the `---` that
 * opens the member's instructions in `flowPrompt`), where the description naming the spec sits. The
 * rule is matched with the line after it, since a description can hold a `---` of its own.
 */
export function withDocumentsLine(prompt: string, line: string): string {
  const cut = prompt.indexOf('\n\n---\n\nYou are the ');
  return cut < 0 ? `${prompt}\n\n${line}` : `${prompt.slice(0, cut)}\n\n${line}${prompt.slice(cut)}`;
}

/**
 * Copies the item's tied documents from the checkout into its worktree where they are missing or
 * differ and the branch has not made them its own, and commits what it copied. A refused or missing
 * document is skipped and reported; a git or disk failure while copying or committing throws, so the
 * run does not start without its specification.
 */
export async function syncItemDocuments(input: ItemDocumentSyncInput): Promise<ItemDocumentSync> {
  const { item, place, projectPath, documentsRoot } = input;
  const out: ItemDocumentSync = { present: [], copied: [], commit: null, skipped: [] };
  const seen = new Set<string>();
  const realCwd = await realpath(place.cwd);
  const forkPoint = mergeBase(place.cwd, 'HEAD', headCommit(projectPath));
  const ownMessage = documentSyncMessage(item);
  for (const link of input.links) {
    if (link.kind !== 'document' || !link.documentPath) continue;
    let rel: string;
    try {
      rel = documentPath(link.documentPath, documentsRoot);
    } catch (err) {
      if (!(err instanceof DocumentPathError)) throw err;
      out.skipped.push({ path: link.documentPath, reason: err.message });
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    const target = join(place.cwd, ...rel.split('/'));
    if (!(await landsInside(target, realCwd))) {
      out.skipped.push({ path: rel, reason: `${rel} is outside the worktree` });
      continue;
    }
    let source: Buffer | null = null;
    try {
      source = await readFile((await existingDocument({ projectPath, root: documentsRoot }, rel)).file);
    } catch (err) {
      if (!(err instanceof DocumentError)) throw err;
      out.skipped.push({ path: rel, reason: err.message });
      // Refused rather than missing: its copy in the worktree is not named either
      if (err.statusCode === 400) continue;
    }
    const current = await readFile(target).catch(() => null);
    if (source && !current?.equals(source) && !branchOwns(place.cwd, rel, forkPoint, ownMessage)) {
      await mkdir(dirname(target), { recursive: true });
      // Checked again now that its folders exist: a link among them could carry the write out
      if (!(await landsInside(target, realCwd))) throw new Error(`${rel} would be written outside the worktree ${place.cwd}`);
      await writeFile(target, source);
      out.copied.push(rel);
      out.present.push(rel);
    } else if (current) {
      out.present.push(rel);
    }
  }
  if (out.copied.length) out.commit = commitPaths(place.cwd, ownMessage, out.copied);
  return out;
}

/**
 * Whether the branch has made the document its own: a commit touching it since the branch forked
 * from the project's HEAD (the sync's own commits do not count), or uncommitted changes to it.
 */
function branchOwns(cwd: string, rel: string, forkPoint: string | null, ownMessage: string): boolean {
  if (git(cwd, ['--literal-pathspecs', 'status', '--porcelain', '--untracked-files=all', '--', rel])) return true;
  if (!forkPoint) return false;
  const subjects = git(cwd, ['--literal-pathspecs', 'log', '--format=%s', `${forkPoint}..HEAD`, '--', rel]);
  return subjects.split('\n').some((s) => s !== '' && s !== ownMessage);
}

/**
 * Whether a copy to `path` stays inside `realDir`: the part of it that exists resolves inside, and
 * the file itself, when there, is a plain file rather than a link or a folder.
 */
async function landsInside(path: string, realDir: string): Promise<boolean> {
  const own = await lstat(path).catch(() => null);
  if (own && !own.isFile()) return false;
  let probe = dirname(path);
  while (!(await lstat(probe).catch(() => null))) {
    const up = dirname(probe);
    if (up === probe) return false;
    probe = up;
  }
  const real = await realpath(probe).catch(() => null);
  return real !== null && (real === realDir || real.startsWith(realDir.endsWith(sep) ? realDir : realDir + sep));
}
