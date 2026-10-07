/*
 * What may leave the machine in a decision's state. The point's builder chooses the fields; this
 * file is the last gate before a provider sees them: secrets are masked and every string and the
 * whole document are cut to the point's byte limit (D12). The consent preview shows its output.
 */

export const SECRET_MASK = '[redacted]';
/** The marker left where a string was cut, so a reader knows it is not the whole text */
const CUT = '…';

/**
 * Values that look like credentials wherever they appear in text: provider keys, bearer tokens, JWTs,
 * private key blocks and `NAME=value` assignments whose name says it is a secret.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // A chat's own API token, whatever names it: the prefix is there so a leaked one is recognised
  /\bagc_[A-Za-z0-9_-]{20,}/g,
];

/**
 * Secrets Agentry itself holds, which no pattern can tell from other text: the owner's API token
 * written as `T="…"` looks like any long word (seen leaving the machine in a decision's state on
 * 2026-10-02). `values` are the ones kept in plain (the Jev key, the webhook secrets), masked
 * wherever they appear; `isSecret` answers for one Agentry keeps only as a hash (the owner's and the
 * desktop's token, the live chat tokens), asked about every word long enough to be one.
 */
export interface SecretRecognizer {
  values(): readonly string[];
  isSecret(word: string): boolean;
}

const recognizers = new Set<SecretRecognizer>();

/** Registers what Agentry's own secrets are; the returned function takes it back (a test, a shutdown). */
export function recognizeSecrets(recognizer: SecretRecognizer): () => void {
  recognizers.add(recognizer);
  return () => recognizers.delete(recognizer);
}

/**
 * A word that could be a generated token or key: no shorter than the shortest Agentry accepts, and
 * not starting or ending with a dot, so the full stop after a token in a sentence is not part of it
 */
const TOKEN_WORD = /[A-Za-z0-9_~+/=-][A-Za-z0-9._~+/=-]{22,}[A-Za-z0-9_~+/=-]/g;
/** Shorter plain values would mask ordinary words */
const MIN_KNOWN_VALUE = 12;

function maskKnown(text: string): string {
  if (recognizers.size === 0) return text;
  let out = text;
  for (const recognizer of recognizers) {
    for (const value of recognizer.values()) {
      if (value.length >= MIN_KNOWN_VALUE && out.includes(value)) out = out.split(value).join(SECRET_MASK);
    }
  }
  return out.replace(TOKEN_WORD, (word) => ([...recognizers].some((r) => r.isSecret(word)) ? SECRET_MASK : word));
}
/** `API_KEY=abc`, `"password": "abc"`, `token: abc`; the name stays, the value goes */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)[^\s"',;}]{4,}/gi;
/** A field named like this never carries text worth sending */
const SECRET_KEY = /(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|credential|authorization)/i;

/** The text with anything that looks like a secret replaced by the mask */
export function maskSecrets(text: string): string {
  let out = maskKnown(text);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, scheme: unknown) => (typeof scheme === 'string' ? `${scheme} ${SECRET_MASK}` : SECRET_MASK));
  }
  return out.replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}${SECRET_MASK}`);
}

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

/** The longest prefix of `text` that fits in `bytes` without splitting a character, marked when cut */
export function cutToBytes(text: string, bytes: number): string {
  if (byteLength(text) <= bytes) return text;
  const room = Math.max(0, bytes - byteLength(CUT));
  let end = Math.min(text.length, room);
  while (end > 0 && byteLength(text.slice(0, end)) > room) end -= 1;
  // Never end on half of a surrogate pair
  if (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${CUT}`;
}

const isMap = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function clean(value: unknown, stringBytes: number, depth: number): unknown {
  if (typeof value === 'string') return cutToBytes(maskSecrets(value), stringBytes);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  // Deeper than any builder's state goes: cut rather than recurse without end
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.map((item) => clean(item, stringBytes, depth + 1));
  if (isMap(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = SECRET_KEY.test(key) && typeof item === 'string' ? SECRET_MASK : clean(item, stringBytes, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * The state as it may be sent: secrets masked, every string cut to `maxBytes`, and if the document
 * still does not fit, the longest string is halved until it does (a state is prose, so that is what
 * gives) and, as the last resort, trailing array items are dropped.
 */
export function redactState(state: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const cleaned = clean(state, maxBytes, 0);
  const document = isMap(cleaned) ? cleaned : {};
  let guard = 0;
  while (byteLength(JSON.stringify(document)) > maxBytes && guard < 200) {
    guard += 1;
    if (!shrink(document)) break;
  }
  return document;
}

interface Slot {
  holder: Record<string, unknown> | unknown[];
  key: string | number;
  bytes: number;
}

/** Halves the longest string, or drops the last item of the longest array; false when nothing is left to give */
function shrink(document: Record<string, unknown>): boolean {
  let longest: Slot | null = null;
  let longestArray: unknown[] | null = null;
  const visit = (holder: Record<string, unknown> | unknown[]): void => {
    const entries: Array<[string | number, unknown]> = Array.isArray(holder) ? holder.map((v, i) => [i, v]) : Object.entries(holder);
    for (const [key, item] of entries) {
      if (typeof item === 'string') {
        const bytes = byteLength(item);
        if (bytes > (longest?.bytes ?? 32)) longest = { holder, key, bytes };
      } else if (Array.isArray(item)) {
        if (item.length > (longestArray?.length ?? 1)) longestArray = item;
        visit(item);
      } else if (isMap(item)) visit(item);
    }
  };
  visit(document);
  const slot = longest as Slot | null;
  if (slot) {
    const current = (slot.holder as Record<string | number, unknown>)[slot.key] as string;
    (slot.holder as Record<string | number, unknown>)[slot.key] = cutToBytes(current, Math.floor(slot.bytes / 2));
    return true;
  }
  const array = longestArray as unknown[] | null;
  if (array && array.length > 1) {
    array.pop();
    return true;
  }
  return false;
}

export function stateBytes(state: Record<string, unknown>): number {
  return byteLength(JSON.stringify(state));
}
