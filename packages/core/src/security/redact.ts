import { REDACTED } from '@agentry/shared';

/**
 * The maps whose values are secrets: an MCP server's `env` (API keys) and `headers` (bearer
 * tokens), and the `env` of a settings document. Only the top level of the document is looked at,
 * because that is where the CLI reads them from; nothing deeper is a secret by convention.
 */
export const SECRET_MAPS = ['env', 'headers'] as const;

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A copy with every value of `env` / `headers` replaced by the placeholder, so a secret configured
 * once never leaves the process again. The key stays: a reader may know a value is set, and the
 * panel needs the name to show the row.
 */
export function redactSecrets<T>(document: T, keys: readonly string[] = SECRET_MAPS): T {
  if (!isMap(document)) return document;
  let copy: Record<string, unknown> | null = null;
  for (const key of keys) {
    const map = document[key];
    if (!isMap(map)) continue;
    const redacted: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(map)) redacted[name] = typeof value === 'string' ? REDACTED : value;
    copy ??= { ...document };
    copy[key] = redacted;
  }
  return (copy ?? document) as T;
}

/**
 * The inverse, for a write: a placeholder that comes back unchanged means "keep what is stored".
 * A placeholder with nothing stored behind it is refused rather than written, because writing it
 * would hand the literal placeholder to whatever reads the configuration.
 */
export function restoreSecrets<T>(next: T, stored: unknown, keys: readonly string[] = SECRET_MAPS): T {
  if (!isMap(next)) return next;
  const previous = isMap(stored) ? stored : {};
  let copy: Record<string, unknown> | null = null;
  for (const key of keys) {
    const map = next[key];
    if (!isMap(map)) continue;
    const before = isMap(previous[key]) ? (previous[key] as Record<string, unknown>) : {};
    const restored: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(map)) {
      if (value !== REDACTED) {
        restored[name] = value;
        continue;
      }
      if (!(name in before)) throw new Error(`no stored value behind the placeholder for ${key}.${name}; send the real value`);
      restored[name] = before[name];
    }
    copy ??= { ...next };
    copy[key] = restored;
  }
  return (copy ?? next) as T;
}

/** True when the document still carries a placeholder, i.e. a write that was not merged. */
export function hasRedacted(document: unknown, keys: readonly string[] = SECRET_MAPS): boolean {
  if (!isMap(document)) return false;
  for (const key of keys) {
    const map = document[key];
    if (isMap(map) && Object.values(map).includes(REDACTED)) return true;
  }
  return false;
}
