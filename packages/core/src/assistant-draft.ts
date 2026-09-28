import type { AssistantResourceDraft, AssistantResourceKind } from '@agentry/shared';

/**
 * "Create with AI" while it runs: the one resource as the chat writes it. The CLI streams a
 * structured result as the JSON input of a tool call, so what there is to read at any moment is JSON
 * cut off anywhere, even inside a string or an escape. It is read for what it holds so far, never
 * trusted: the proposal is still made from the whole result once the run ends.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Marks where the text ran out: what was read up to there is kept, and nothing after it is guessed. */
const CUT = Symbol('cut');

/**
 * Reads JSON that may stop at any point. Everything complete is read as it is; a string or a list
 * cut off keeps what it has; a key with no value yet, or a number or literal cut in half, is left
 * out. Text that is not JSON at all reads as undefined.
 */
export function partialJson(text: string): unknown {
  let i = 0;
  const space = () => {
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
  };

  const string = (): { value: string; done: boolean } => {
    i++; // the opening quote
    let out = '';
    while (i < text.length) {
      const c = text.charAt(i);
      if (c === '"') {
        i++;
        return { value: out, done: true };
      }
      if (c !== '\\') {
        out += c;
        i++;
        continue;
      }
      const next = text.charAt(i + 1);
      if (!next) break;
      if (next === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      const escaped: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
      out += escaped[next] ?? next;
      i += 2;
    }
    i = text.length;
    return { value: out, done: false };
  };

  const value = (): unknown => {
    space();
    if (i >= text.length) return CUT;
    const c = text.charAt(i);
    if (c === '"') {
      const s = string();
      return s.value;
    }
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        space();
        if (i >= text.length) return obj;
        if (text.charAt(i) === '}') {
          i++;
          return obj;
        }
        if (text.charAt(i) === ',') {
          i++;
          continue;
        }
        if (text.charAt(i) !== '"') throw new SyntaxError('expected a key');
        const key = string();
        if (!key.done) return obj;
        space();
        if (i >= text.length) return obj;
        if (text.charAt(i) !== ':') throw new SyntaxError('expected a colon');
        i++;
        const v = value();
        if (v === CUT) return obj;
        obj[key.value] = v;
      }
    }
    if (c === '[') {
      i++;
      const list: unknown[] = [];
      for (;;) {
        space();
        if (i >= text.length) return list;
        if (text.charAt(i) === ']') {
          i++;
          return list;
        }
        if (text.charAt(i) === ',') {
          i++;
          continue;
        }
        const v = value();
        if (v === CUT) return list;
        list.push(v);
      }
    }
    const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!literal) throw new SyntaxError('unexpected character');
    i += literal[0].length;
    // A number or a literal is whole only once something follows it
    if (i >= text.length) return CUT;
    return JSON.parse(literal[0]) as unknown;
  };

  try {
    const v = value();
    return v === CUT ? undefined : v;
  } catch {
    return undefined;
  }
}

/**
 * The resource a running "Create with AI" has written so far, from its streamed structured result;
 * null before the chat has begun writing it.
 */
export function resourceDraft(raw: string, kind: AssistantResourceKind): AssistantResourceDraft | null {
  const value = partialJson(raw);
  if (!isObject(value) || !Array.isArray(value.resources)) return null;
  const first: unknown = value.resources[0];
  if (!isObject(first)) return null;
  const name = typeof first.name === 'string' ? first.name.trim().replace(/^\//, '').replace(/\.md$/i, '') : '';
  return {
    kind,
    name: name || null,
    content: typeof first.content === 'string' ? first.content : '',
  };
}
