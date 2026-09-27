/**
 * The shape of a document's path, checked before anything touches the disk. Kept apart from
 * `documents.ts` so the work item store can refuse a bad `document` link without depending on the
 * file service built on top of it.
 *
 * A document path is relative to the project and `/`-separated, as the contract carries it. It is
 * refused rather than normalised: a path that needs cleaning (`docs/./a.md`, `docs//a.md`) is not
 * the one the caller will look it up by afterwards, and one that climbs (`..`) is refused whatever
 * it would resolve to, so no reading of it can leave the folder.
 */

/** Longer than any path a person types; short of one that would bloat every read of an item */
export const DOCUMENT_PATH_MAX = 1024;

/** The extensions listed and written. Anything else in the folder is not a document here. */
export const DOCUMENT_EXTENSIONS = ['.md', '.markdown'] as const;

export class DocumentPathError extends Error {
  readonly statusCode = 400;
}

export function isMarkdown(name: string): boolean {
  const lower = name.toLowerCase();
  return DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

/**
 * The segments of a path relative to the project, or an error naming what is wrong with it. Hidden
 * segments are refused too: `.git` and `.claude` hold what Agentry and the CLI run on, never
 * documents, and are the first place a crafted path would aim.
 */
export function pathSegments(value: unknown, field = 'path'): string[] {
  if (typeof value !== 'string' || !value) throw new DocumentPathError(`${field} is required`);
  if (value.length > DOCUMENT_PATH_MAX) throw new DocumentPathError(`${field} is longer than ${String(DOCUMENT_PATH_MAX)} characters`);
  // A NUL cuts the path short in the system call; a backslash is a separator on Windows and a
  // character on Linux, so a path that carries one means something different on each
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(value)) throw new DocumentPathError(`${field} has a character a path cannot have`);
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new DocumentPathError(`${field} must be relative to the project`);
  const segments = value.split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') throw new DocumentPathError(`${field} must be a plain path inside the documents folder, without empty, "." or ".." parts`);
    if (s.startsWith('.')) throw new DocumentPathError(`${field} cannot name a hidden file or folder`);
  }
  return segments;
}

/** The documents folder as the settings name it (`docs`, `handbook/pages`), in segments. */
export function rootSegments(root: string): string[] {
  return root
    .split(/[\\/]/)
    .filter((s) => s !== '' && s !== '.');
}

/**
 * A path that names a Markdown file inside the documents folder, as written back to the caller.
 * Only the shape: whether the folder on disk agrees is `documents.ts`'s to check.
 */
export function documentPath(value: unknown, root: string, field = 'path'): string {
  const segments = pathSegments(value, field);
  const base = rootSegments(root);
  if (segments.length <= base.length || base.some((s, i) => segments[i] !== s)) {
    throw new DocumentPathError(`${field} must be inside the documents folder ${base.join('/') || '.'}`);
  }
  if (!isMarkdown(segments[segments.length - 1] ?? '')) throw new DocumentPathError(`${field} must name a Markdown file (${DOCUMENT_EXTENSIONS.join(', ')})`);
  return segments.join('/');
}
