// Lossless JSON for host output. Webhook delivery ids and other 64-bit ids do not survive a double,
// and `--jq`'s `tostring`, `@tsv` and `--template` lose them too (recorded), so Agentry parses the
// JSON itself and reads an integer above Number.MAX_SAFE_INTEGER as the string it was written as.
// `JSON.parse`'s reviver gets the source text of a primitive from Node 22 on.

interface ReviverContext {
  source?: string;
}

const INTEGER = /^-?\d+$/;

/** `JSON.parse` that keeps an unsafe integer as its decimal string. Throws like `JSON.parse` on malformed text. */
export function parseJson(text: string): unknown {
  return JSON.parse(text, function reviver(_key: string, value: unknown, context?: ReviverContext) {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && INTEGER.test(context.source)) return context.source;
    return value;
  } as (key: string, value: unknown) => unknown);
}

/** `parseJson` that answers null instead of throwing, for text that may not be JSON at all (an error body) */
export function tryParseJson(text: string): unknown {
  try {
    return parseJson(text);
  } catch {
    return null;
  }
}
