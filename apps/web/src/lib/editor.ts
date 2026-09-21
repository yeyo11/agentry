import type { EditorSettings, EditorSettingsDoc } from '@agentry/shared';

/*
 * How a path and a line become a link that opens the person's editor. The settings are kept on the
 * server (`editor.json`), so every browser of the same person builds the same links; the server
 * refuses an unsafe template too, and these checks stay here to say so while the person types.
 * Nothing here reaches the CLI.
 */

export const DEFAULT_EDITOR: EditorSettings = { template: 'vscode://file/{path}:{line}' };

/** Where each browser kept its own settings before the server did: read once, to move them there. */
export const LEGACY_EDITOR_KEY = 'agentry-editor:v1';

/** Schemes a link may never use, whatever the template says: a setting is text somebody pasted. */
const UNSAFE_SCHEME = /^(javascript|data|vbscript|file|blob):/i;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** What a stored or pasted value is worth: a template with a safe scheme, and only well-formed rows. */
export function sanitizeEditor(value: unknown): EditorSettings {
  if (!value || typeof value !== 'object') return DEFAULT_EDITOR;
  const raw = value as Record<string, unknown>;
  const template = typeof raw.template === 'string' ? raw.template.trim() : '';
  const diffCommand = typeof raw.diffCommand === 'string' ? raw.diffCommand.trim() : '';
  const pathMap = Array.isArray(raw.pathMap)
    ? raw.pathMap.flatMap((row): Array<{ from: string; to: string }> => {
        if (!row || typeof row !== 'object') return [];
        const { from, to } = row as Record<string, unknown>;
        return typeof from === 'string' && typeof to === 'string' && from.trim() ? [{ from: from.trim(), to: to.trim() }] : [];
      })
    : [];
  return {
    template: template || DEFAULT_EDITOR.template,
    ...(diffCommand ? { diffCommand } : {}),
    ...(pathMap.length ? { pathMap } : {}),
  };
}

/** Why a template cannot be used, or null: the settings form says it before a link is ever built. */
export function templateProblem(template: string): 'empty' | 'scheme' | 'unsafe' | 'path' | null {
  const value = template.trim();
  if (!value) return 'empty';
  if (!SCHEME.test(value)) return 'scheme';
  if (UNSAFE_SCHEME.test(value)) return 'unsafe';
  if (!value.includes('{path}')) return 'path';
  return null;
}

/**
 * The host path for a container one: the first row whose `from` is the path itself or a directory
 * above it wins, and only whole path segments match (`/work` does not claim `/workspace`).
 */
export function mapPath(path: string, map: EditorSettings['pathMap']): string {
  for (const { from, to } of map ?? []) {
    const root = from.replace(/\/+$/, '');
    if (path === root || path.startsWith(`${root}/`)) return `${to.replace(/\/+$/, '')}${path.slice(root.length)}`;
  }
  return path;
}

/** `dir` and a relative `file` as one path, whatever slashes either brought. */
export function joinPath(dir: string, file: string): string {
  return `${dir.replace(/\/+$/, '')}/${file.replace(/^\/+/, '')}`;
}

const encodePath = (path: string): string => encodeURI(path).replace(/[?#]/g, encodeURIComponent);

/**
 * The link that opens `path` (absolute, in the wrapper's own filesystem) at `line`, or null when the
 * template cannot be trusted. Without a line the `:{line}` and `:{column}` parts go away with it,
 * because `vscode://file/x.ts:` is not a file.
 */
export function editorLink(settings: EditorSettings, path: string, line?: number, column?: number): string | null {
  if (templateProblem(settings.template) !== null) return null;
  const host = mapPath(path, settings.pathMap);
  let out = settings.template.trim();
  out = column ? out.replaceAll('{column}', String(column)) : out.replaceAll(/:?\{column\}/g, '');
  out = line ? out.replaceAll('{line}', String(line)) : out.replaceAll(/:?\{line\}/g, '');
  // `vscode://file/{path}` and an absolute path would otherwise put two slashes where one is meant;
  // after the `//` of a scheme (`zed://{path}`) the path's own slash is the one that belongs there
  out = out.replaceAll(/(?<!\/)\/\{path\}/g, () => `/${encodePath(host.replace(/^\/+/, ''))}`);
  return out.replaceAll('{path}', () => encodePath(host));
}

/** One argument, quoted for a POSIX shell only when it has to be. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The command for a side-by-side diff of two files, to copy: a browser cannot run it for the person. */
export function diffCommand(settings: EditorSettings, left: string, right: string): string | null {
  const template = settings.diffCommand?.trim();
  if (!template) return null;
  const map = (p: string) => shellQuote(mapPath(p, settings.pathMap));
  return template.replaceAll('{left}', map(left)).replaceAll('{right}', map(right));
}

// ---------- moving a browser's own settings to the server ----------

/** What loading the settings comes to: what to apply, and what to do about this browser's old copy. */
export interface EditorLoad {
  settings: EditorSettings;
  /** Send these to the server, and drop the old copy once it has them */
  migrate: EditorSettings | null;
  /** The old copy is of no more use: the server has settings of its own, or the copy is unusable */
  dropLegacy: boolean;
}

/**
 * The server's settings win once it has any. Before that, the settings this browser kept for itself
 * move there, once: after the first save the server says `stored`, and no other browser's copy is
 * ever read again. A copy that is corrupt or whose template the server would refuse is dropped.
 */
export function planEditorLoad(doc: EditorSettingsDoc, legacy: string | null): EditorLoad {
  const server = sanitizeEditor(doc.settings);
  if (legacy === null) return { settings: server, migrate: null, dropLegacy: false };
  if (doc.stored) return { settings: server, migrate: null, dropLegacy: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(legacy);
  } catch {
    return { settings: server, migrate: null, dropLegacy: true };
  }
  const settings = sanitizeEditor(parsed);
  if (templateProblem(settings.template) !== null) return { settings: server, migrate: null, dropLegacy: true };
  return { settings, migrate: settings, dropLegacy: false };
}
