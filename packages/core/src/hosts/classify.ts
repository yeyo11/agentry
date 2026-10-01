import type { HostReason } from '@agentry/shared';
import type { HostCall, HostResult } from './exec.ts';
import { tryParseJson } from './json.ts';

// Whether a call can change something on a host. A write is never retried and is always followed by
// a re-read, so a wrong answer here is the one mistake that matters: when the classifier cannot be
// sure, it says write. The adapters declare `kind` themselves and a test runs this over every call
// each of them can build, failing when the two disagree.

/** Porcelain verbs that change something. `run` and `note` only count after the command group, so `gh run view` is a read. */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  'create', 'edit', 'update', 'delete', 'close', 'reopen', 'merge', 'comment', 'note', 'review', 'ready', 'approve', 'revoke',
  'rerun', 'retry', 'cancel', 'run', 'trigger', 'develop', 'lock', 'unlock', 'transfer', 'publish', 'resolve', 'transition',
  'assign', 'link', 'archive',
]);

/** Flags that take a value, so the value is not mistaken for a command word. An unknown flag is not skipped: a leaked word can only make a read look like a write. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-R', '--repo', '--hostname', '-X', '--method', '-H', '--header', '-f', '-F', '--field', '--raw-field', '--input', '-q', '--jq',
  '--template', '--cache', '-L', '--limit', '--json', '--head', '--base', '-B', '--title', '-t', '--body', '-b', '--body-file',
  '-s', '--state', '-P', '--per-page', '-p', '--page', '--source-branch', '--target-branch', '--description-file', '--output', '--path',
  '--jql', '--fields',
]);

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

interface Parsed {
  /** command words, flags and their values removed */
  words: string[];
  /** every flag with the value it carried (`--method=POST`, `-XPOST` and `-X POST` alike), in order */
  flags: Array<{ name: string; value: string | null }>;
}

function parse(args: readonly string[]): Parsed {
  const words: string[] = [];
  const flags: Parsed['flags'] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      words.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags.push({ name: arg.slice(0, eq), value: arg.slice(eq + 1) });
      } else if (VALUE_FLAGS.has(arg)) {
        flags.push({ name: arg, value: args[i + 1] ?? null });
        i += 1;
      } else {
        flags.push({ name: arg, value: null });
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const name = arg.slice(0, 2);
      if (arg.length > 2 && VALUE_FLAGS.has(name)) {
        flags.push({ name, value: arg.slice(2).replace(/^=/, '') });
      } else if (VALUE_FLAGS.has(arg)) {
        flags.push({ name: arg, value: args[i + 1] ?? null });
        i += 1;
      } else {
        flags.push({ name: arg, value: null });
      }
      continue;
    }
    words.push(arg);
  }
  return { words, flags };
}

const flagValue = (parsed: Parsed, ...names: string[]): string | null => parsed.flags.find((f) => names.includes(f.name))?.value ?? null;
const hasFlag = (parsed: Parsed, ...names: string[]): boolean => parsed.flags.some((f) => names.includes(f.name));

/** The text of a GraphQL document with comments and leading space removed, or null when it is not inline */
function graphqlDocument(parsed: Parsed, input: string | undefined): string | null {
  const fields = parsed.flags.filter((f) => ['-f', '-F', '--field', '--raw-field'].includes(f.name) && f.value !== null);
  for (const field of fields) {
    const value = field.value ?? '';
    if (!value.startsWith('query=')) continue;
    const document = value.slice('query='.length);
    // `query=@file` reads a file the classifier cannot see
    if (document.startsWith('@') && field.name !== '-f' && field.name !== '--raw-field') return null;
    return document;
  }
  if (hasFlag(parsed, '--input') && input !== undefined) {
    const body = tryParseJson(input);
    if (typeof body === 'object' && body !== null && typeof (body as { query?: unknown }).query === 'string') return (body as { query: string }).query;
  }
  return null;
}

const stripGraphqlNoise = (document: string): string => document.replace(/#[^\n]*/g, '').trim();

function classifyApi(parsed: Parsed, input: string | undefined): HostCall['kind'] {
  const method = flagValue(parsed, '-X', '--method')?.toUpperCase() ?? null;
  const isGraphql = parsed.words[1]?.toLowerCase() === 'graphql';
  if (isGraphql) {
    // Every GraphQL call is a POST; what it does is in the document
    const document = graphqlDocument(parsed, input);
    if (document === null) return 'write';
    return /^mutation\b/i.test(stripGraphqlNoise(document)) ? 'write' : 'read';
  }
  if (method !== null) return READ_METHODS.has(method) ? 'read' : 'write';
  // Both CLIs send a POST as soon as a field or a body is given and no method says otherwise
  if (hasFlag(parsed, '-f', '-F', '--field', '--raw-field', '--input')) return 'write';
  return 'read';
}

function classifyYoutrack(parsed: Parsed): HostCall['kind'] {
  if (parsed.words[0] === 'rest' && parsed.words[1] === 'request') {
    const method = flagValue(parsed, '--method', '-X')?.toUpperCase() ?? null;
    return method === null || READ_METHODS.has(method) ? 'read' : 'write';
  }
  return 'read';
}

/** How many command words after the group can carry the verb: `mr note create`, `jira workitem comment create` */
const VERB_WINDOW: Record<'gh' | 'glab' | 'acli', number> = { gh: 2, glab: 2, acli: 4 };

/** `read` or `write`, from the argv alone */
export function classifyCall(call: Pick<HostCall, 'cli' | 'args' | 'input'>): HostCall['kind'] {
  const parsed = parse(call.args);
  if (call.cli === 'youtrack-app') return classifyYoutrack(parsed);
  if (parsed.words[0] === 'api') return classifyApi(parsed, call.input);
  const words = parsed.words.slice(1, 1 + VERB_WINDOW[call.cli]).map((w) => w.toLowerCase());
  const at = words.findIndex((w) => WRITE_VERBS.has(w));
  if (at < 0) return 'read';
  // `glab mr note list` reads the notes; the same word with `create` writes one
  if (words[at] === 'note' && words[at + 1] === 'list') return 'read';
  return 'write';
}

// ---------- why a call failed ----------

export interface HostErrorFields {
  /** from `-i`, else the body's `status` */
  status: number | null;
  errors: Array<{ code?: string; field?: string; resource?: string; type?: string }>;
}

/**
 * The structured part of a failure: after a non-zero exit stdout may hold the host's documented
 * error body, and only these fields are read from it. glab's `{"error":{"message":…}}` is not data
 * and its message is never read; stderr is never read at all.
 */
export function hostErrorFields(result: Pick<HostResult, 'http' | 'stdout'>): HostErrorFields {
  const body = tryParseJson(result.stdout);
  const object = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  let status = result.http?.status ?? null;
  if (status === null && (typeof object.status === 'string' || typeof object.status === 'number')) {
    const parsed = Number(object.status);
    if (Number.isInteger(parsed) && parsed >= 100 && parsed < 600) status = parsed;
  }
  const errors: HostErrorFields['errors'] = [];
  if (Array.isArray(object.errors)) {
    for (const entry of object.errors) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const picked: HostErrorFields['errors'][number] = {};
      for (const key of ['code', 'field', 'resource', 'type'] as const) {
        const value = record[key];
        if (typeof value === 'string') picked[key] = value;
      }
      errors.push(picked);
    }
  }
  return { status, errors };
}

/**
 * The reason a failed result carries when nothing more specific is known: from Agentry's own kill,
 * gh's exit code 4, and the HTTP status. Rate limits are the breaker's to say (it needs the
 * headers and the clock), so a 403 or 429 here is only `forbidden` or `slowed-down`.
 * Null for a call that succeeded.
 */
export function reasonOf(result: Pick<HostResult, 'exitCode' | 'http' | 'stdout' | 'reason'>, cli: HostCall['cli']): HostReason | null {
  if (result.reason) return result.reason;
  if (result.exitCode === 0) return null;
  if (result.exitCode === null) return 'timeout';
  if (cli === 'gh' && result.exitCode === 4) return 'auth-failed';
  if (cli === 'youtrack-app' && result.exitCode === 3) return 'auth-failed';
  if (cli === 'youtrack-app' && result.exitCode === 4) return 'not-found';
  const { status } = hostErrorFields(result);
  if (status === 401) return 'auth-failed';
  if (status === 404) return 'not-found';
  if (status === 429) return 'slowed-down';
  if (status === 403) return 'forbidden';
  if (status !== null && status >= 500) return 'server-error';
  return 'unreachable';
}
