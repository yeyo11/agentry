import { redactSecrets } from '../security/redact.ts';
import { redactText } from '../../scripts/redact-recordings.mjs';

// One redaction for everything a host CLI says: the first line of stderr kept as a detail, an error
// stored in a row, a body shown in a log panel, and (through the same script) a committed
// recording. The rules live in scripts/redact-recordings.mjs so that the fixtures and the running
// app are cleaned by the same code.

/** Keys Agentry drops from a host's objects before storing them, wherever they are */
const DROPPED_KEYS: ReadonlySet<string> = new Set(['runners_token', 'author_email', 'committer_email']);

/** Token patterns, Authorization and token headers, and e-mail addresses other than noreply ones */
export const redactHostText = (text: string): string => redactText(text);

/** The first non-empty line, redacted and cut: what the person reads beside Agentry's own sentence. Never parsed. */
export function firstLine(text: string, max = 500): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return redactHostText(line).slice(0, max);
}

/**
 * A copy of a parsed host object without the keys Agentry never stores (`runners_token` in GitLab's
 * project object, `commit.author_email` and `committer_email` in job objects, `config.secret` of a
 * hook), with every string inside run through the text rules.
 */
export function redactHostObject<T>(value: T): T {
  return walk(redactSecrets(value), false) as T;
}

function walk(value: unknown, insideConfig: boolean): unknown {
  if (typeof value === 'string') return redactHostText(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, false));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (DROPPED_KEYS.has(key)) continue;
    if (insideConfig && key === 'secret') continue;
    out[key] = walk(inner, key === 'config');
  }
  return out;
}
