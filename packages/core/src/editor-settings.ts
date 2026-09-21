import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EditorSettings, EditorSettingsDoc } from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import type { CoreConfig } from './paths.ts';

/*
 * How a path and a line become a link that opens the person's editor. The server keeps it so every
 * browser of the same person gets the same links; it still describes the person's machine, not the
 * server's (the wrapper often runs in a container). Nothing here reaches the CLI: the template is
 * only ever filled into a link, and the diff command is only ever shown to be copied.
 */

export const DEFAULT_EDITOR: EditorSettings = { template: 'vscode://file/{path}:{line}' };

/** Schemes a link may never use, whatever the template says: a setting is text somebody pasted. */
const UNSAFE_SCHEME = /^(javascript|data|vbscript|file|blob):/i;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const MAX_TEXT = 2000;
const MAX_PATH_MAP = 50;

export type EditorTemplateProblem = 'empty' | 'scheme' | 'unsafe' | 'path';

/** Why a template cannot be used, or null. */
export function templateProblem(template: string): EditorTemplateProblem | null {
  const value = template.trim();
  if (!value) return 'empty';
  if (!SCHEME.test(value)) return 'scheme';
  if (UNSAFE_SCHEME.test(value)) return 'unsafe';
  if (!value.includes('{path}')) return 'path';
  return null;
}

const PROBLEM_MESSAGE: Record<EditorTemplateProblem, string> = {
  empty: 'template is required',
  scheme: 'template must start with a URL scheme, e.g. vscode://',
  unsafe: 'template uses a scheme that is never allowed (javascript:, data:, vbscript:, file:, blob:)',
  path: 'template must contain {path}',
};

/**
 * What a stored value is worth: a template with a safe scheme, and only well-formed rows. Used on
 * read, where a hand-edited file falls back to the default rather than failing every page.
 */
export function sanitizeEditor(value: unknown): EditorSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_EDITOR };
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
    template: template && templateProblem(template) === null ? template : DEFAULT_EDITOR.template,
    ...(diffCommand ? { diffCommand } : {}),
    ...(pathMap.length ? { pathMap } : {}),
  };
}

/** Validates what a person sent: unlike `sanitizeEditor`, a bad value is refused, not replaced. */
export function parseEditorSettings(input: unknown): EditorSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('editor settings must be a JSON object');
  const body = input as Record<string, unknown>;
  if (typeof body.template !== 'string') throw new Error('template must be a string');
  const problem = templateProblem(body.template);
  if (problem) throw new Error(PROBLEM_MESSAGE[problem]);
  if (body.template.length > MAX_TEXT) throw new Error(`template is longer than ${MAX_TEXT} characters`);
  if (body.diffCommand !== undefined && typeof body.diffCommand !== 'string') throw new Error('diffCommand must be a string');
  if (typeof body.diffCommand === 'string' && body.diffCommand.length > MAX_TEXT) throw new Error(`diffCommand is longer than ${MAX_TEXT} characters`);
  if (body.pathMap !== undefined) {
    if (!Array.isArray(body.pathMap)) throw new Error('pathMap must be an array');
    if (body.pathMap.length > MAX_PATH_MAP) throw new Error(`pathMap has more than ${MAX_PATH_MAP} rows`);
    for (const row of body.pathMap as unknown[]) {
      const { from, to } = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
      if (typeof from !== 'string' || typeof to !== 'string') throw new Error('every pathMap row needs a string from and to');
      if (!from.trim()) throw new Error('a pathMap row needs a non-empty from');
    }
  }
  return sanitizeEditor(body);
}

/**
 * `editor.json` in the data directory. It does not exist until the first write, and the document
 * says so: a browser that still holds settings of its own from before they lived here uses that to
 * migrate them once.
 */
export class EditorSettingsStore {
  private readonly file: string;

  constructor(config: CoreConfig) {
    this.file = join(config.dataDir, 'editor.json');
    mkdirSync(config.dataDir, { recursive: true });
  }

  get(): EditorSettingsDoc {
    if (!existsSync(this.file)) return { stored: false, settings: { ...DEFAULT_EDITOR } };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      // A document that does not parse would otherwise be overwritten by the next edit
      throw new Error(`${this.file} is not valid JSON; fix or remove it`);
    }
    return { stored: true, settings: sanitizeEditor(raw) };
  }

  async set(input: unknown): Promise<EditorSettingsDoc> {
    const settings = parseEditorSettings(input);
    await writeAtomic(this.file, `${JSON.stringify(settings, null, 2)}\n`);
    return { stored: true, settings };
  }
}
