import type { ReviewSuggestion } from '@agentry/shared';
import { HostParseError } from './code-host.ts';
import { parseJson } from './json.ts';

// What both review adapters read the same way: JSON objects and text, suggestion fences, and the
// names that may reach an argv.

export const objectOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** A number, or a string of digits the lossless parser kept for an id above 2^53 */
export function idText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return typeof value === 'string' && /^\d+$/.test(value) ? value : null;
}

/** An id that goes into an argv or a path: digits only, so nothing a host sent can become a flag or a path. */
export function digits(value: unknown, what: string): string {
  const id = idText(value);
  if (id === null) throw new HostParseError(`${what} has no numeric id`);
  return id;
}

export function jsonOf(stdout: string, what: string): unknown {
  try {
    return parseJson(stdout);
  } catch {
    throw new HostParseError(`${what} is not JSON`);
  }
}

/**
 * The JSON documents of an output that may hold several: `gh api --paginate` prints one per page,
 * and with `-i` each page has its own status line and headers first (recorded). A document is a
 * line that starts with `{`, which a header line never does.
 */
export function documentsOf(stdout: string, what: string): Record<string, unknown>[] {
  const documents = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      const object = objectOf(jsonOf(line, what));
      if (!object) throw new HostParseError(`${what} is not an object`);
      return object;
    });
  if (documents.length === 0) throw new HostParseError(`${what} has no document`);
  return documents;
}

/** `--paginate --slurp` of a list endpoint: an array of pages, each an array; a single array is one page. */
export function listOf(stdout: string, what: string): Record<string, unknown>[] {
  const value = jsonOf(stdout, what);
  if (!Array.isArray(value)) throw new HostParseError(`${what} is not an array`);
  return value.flat().map((item) => {
    const object = objectOf(item);
    if (!object) throw new HostParseError(`${what} holds a non-object`);
    return object;
  });
}

/**
 * A suggestion fence. A body that holds backticks gets a longer fence, so nothing in it can close
 * the block early. `info` is what follows the word: GitHub has none, GitLab `:-N+M`.
 */
export function suggestionFence(content: string, info: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}suggestion${info}\n${content.endsWith('\n') ? content : `${content}\n`}${fence}`;
}

const FENCE = /^(`{3,})suggestion[^\n]*\n([\s\S]*?)^\1[ \t]*$/m;

/** The first suggestion block of a comment body, read as the lines `fromLine`..`toLine` replaced by it. */
export function suggestionOf(body: string, fromLine: number | null, toLine: number | null): ReviewSuggestion | null {
  const match = FENCE.exec(body);
  if (!match || fromLine === null || toLine === null) return null;
  return { fromLine, toLine, fromContent: null, toContent: match[2] ?? '' };
}

/** A GitHub login: letters, digits and single hyphens, or a bot's `[bot]`. It never starts with `-`. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;

/** A GitLab username: it may hold dots and underscores, and never starts with `-`. */
export const GITLAB_USERNAME = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/;

export function login(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new HostParseError('a reviewer name has characters a host login does not');
  return value;
}

/** Every body Agentry sends travels as JSON on stdin */
export const json = (value: unknown): string => JSON.stringify(value);
