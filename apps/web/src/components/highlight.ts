// Syntax highlighting for code blocks, loaded on the first block that needs it. Two engines behind
// one output: @tanstack/highlight for the languages it knows (a few KB and a few ms a block), shiki
// with its TextMate grammars for everything else (tens of KB and a slow tokenizer, but hundreds of
// languages). Every language is a chunk of its own, fetched the first time a block in that language
// appears, so a transcript without code never pays for any of it, and one with only TypeScript
// never downloads shiki.
import { PALETTE, type Painter, type Role } from './highlight/paint';
import type { HighlightToken, LanguageDefinition } from '@tanstack/highlight/core';

export { PALETTE };

/** Past this, tokenizing costs more than colour is worth: the block stays plain */
const MAX_CHARS = 60_000;

/** A run of text in one colour: bare for the theme's own foreground, styled for anything else. */
export type Segment = string | { content: string; style: Record<string, string> };

export interface Highlighted {
  lines: Segment[][];
  /** The themes' foreground, as the same CSS variables a segment carries, for the block itself */
  base: Record<string, string>;
}

/**
 * Lines of coloured runs, each run's colours for both themes as CSS variables (`--shiki-light`,
 * `--shiki-dark`), so the stylesheet picks one and a theme switch needs no re-render. Null when
 * the language is unknown.
 */
export async function highlight(code: string, lang: string): Promise<Highlighted | null> {
  if (code.length > MAX_CHARS) return null;
  const id = lang.toLowerCase();
  const tanstack = TANSTACK_IDS[id];
  if (tanstack) {
    if (runaway(code, TANSTACK[tanstack]!.family)) return null;
    const out = await highlightTanstack(code, tanstack);
    // Only a block TanStack read wrongly is worth shiki's time; one it choked on is not code
    if (out !== 'shiki') return out;
  }
  return highlightShiki(code, id);
}

/**
 * Openers TanStack looks for a closer of all the way to the end of the block. A few hundred of
 * them left open turns its tokenizer quadratic — 60 000 characters of `<a<a<a…` took five seconds,
 * on the main thread — and no engine reads text like that as code anyway, so the block stays plain.
 */
const RUNAWAY: Partial<Record<Family, [open: string, close: string][]>> = {
  script: [['${', '}']],
  markdown: [['[', ']'], ['(', ')']],
  html: [['<', '>']],
};
const LIMIT = 500;

const runaway = (code: string, family: Family) =>
  (RUNAWAY[family] ?? []).some(([open, close]) => code.split(open).length - code.split(close).length > LIMIT);

/**
 * shiki and TanStack both hand back one token per lexeme, and a span each is most of the DOM a
 * long transcript carries. Neighbours of one colour are one run, and text in the foreground colour
 * needs no span at all once the block carries that colour itself: about 60% fewer elements.
 */
class Runs {
  lines: Segment[][] = [[]];

  constructor(private readonly base: Record<string, string>) {}

  push(text: string, style: Record<string, string> | null) {
    const parts = text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) this.lines.push([]);
      if (part) this.add(part, style);
    });
  }

  private add(text: string, style: Record<string, string> | null) {
    const runs = this.lines[this.lines.length - 1]!;
    const prev = runs[runs.length - 1];
    if (!style || same(style, this.base)) {
      if (typeof prev === 'string') runs[runs.length - 1] = prev + text;
      else runs.push(text);
    } else if (prev !== undefined && typeof prev !== 'string' && same(prev.style, style)) {
      prev.content += text;
    } else {
      runs.push({ content: text, style });
    }
  }
}

const same = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k]?.toLowerCase() === b[k]?.toLowerCase());
};

// ---------------------------------------------------------------------------------------------
// shiki: every language TanStack does not cover

const THEMES = { light: 'github-light-default', dark: 'github-dark-default' } as const;

type Shiki = typeof import('shiki/core');
type Langs = typeof import('shiki/langs');
type HighlighterCore = Awaited<ReturnType<Shiki['createHighlighterCore']>>;

/** Per line, for the grammars shiki handles; see where it is passed. */
const TOKENIZE_BUDGET_MS = 2000;
type Loader = Langs['bundledLanguages'][keyof Langs['bundledLanguages']];

let shiki: Promise<{ h: HighlighterCore; langs: Langs }> | null = null;
const loading = new Map<string, Promise<void>>();

function shikiCore() {
  shiki ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, langs, { bundledThemes }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/langs'),
      import('shiki/themes'),
    ]);
    const h = await createHighlighterCore({
      themes: [bundledThemes[THEMES.light], bundledThemes[THEMES.dark]],
      langs: [],
      // The JS engine needs no WASM; `forgiving` skips the odd pattern it cannot translate
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
    return { h, langs };
  })();
  return shiki;
}

async function highlightShiki(code: string, id: string): Promise<Highlighted | null> {
  const { h, langs } = await shikiCore();
  const loader =
    (langs.bundledLanguages as Record<string, Loader>)[id] ?? (langs.bundledLanguagesAlias as Record<string, Loader>)[id];
  if (!loader) return null;
  if (!h.getLoadedLanguages().includes(id)) {
    let pending = loading.get(id);
    if (!pending) {
      pending = h.loadLanguage(loader);
      loading.set(id, pending);
    }
    await pending;
  }
  // shiki gives up on a line after 500 ms by default and returns the rest of it uncoloured. The
  // first call in a language compiles its grammar within that budget, which a busy machine
  // overruns, so the first block on screen lost its colours. A wider budget keeps the guard
  // against a pathological line without tripping over the grammar's own start-up.
  const { tokens } = h.codeToTokens(code, { lang: id, themes: THEMES, defaultColor: false, tokenizeTimeLimit: TOKENIZE_BUDGET_MS });
  const base = { '--shiki-light': h.getTheme(THEMES.light).fg, '--shiki-dark': h.getTheme(THEMES.dark).fg };
  const runs = new Runs(base);
  tokens.forEach((line, i) => {
    if (i > 0) runs.push('\n', null);
    for (const token of line) runs.push(token.content, (token.htmlStyle ?? {}) as Record<string, string>);
  });
  return { lines: runs.lines, base };
}

// ---------------------------------------------------------------------------------------------
// TanStack: a class per token, painted with the colours the GitHub themes give the same scopes

/** The palette as the CSS variables a run carries, one pair of colours per role */
const STYLES = {} as Record<Role, Record<string, string>>;
for (const role of Object.keys(PALETTE) as Role[]) STYLES[role] = { '--shiki-light': PALETTE[role][0], '--shiki-dark': PALETTE[role][1] };

type Family = 'script' | 'json' | 'yaml' | 'css' | 'markdown' | 'shell' | 'python' | 'html' | 'other';

interface TanstackLanguage {
  load: () => Promise<LanguageDefinition>;
  family: Family;
  /** Languages its blocks embed (a `<style>`, a `<script>`) */
  embeds?: string[];
  /** Tokens TanStack got wrong, where the block goes to shiki instead */
  misread?: (tokens: HighlightToken[]) => boolean;
}

/**
 * TanStack ends a double-quoted string at the first quote inside a `$(…)` or `${…}` it holds, so
 * `"$(dirname "$f")"` flips what is quoted for the rest of the block, comments included. The
 * string token it leaves behind is the tell: a substitution opened and never closed.
 */
const unclosedSubstitution = (tokens: HighlightToken[]) =>
  tokens.some((t) => t.className === 'string' && t.value.startsWith('"') && /\$[({]/.test(t.value) && count(t.value, /[({]/g) > count(t.value, /[)}]/g));
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/**
 * Only the TanStack languages whose colours were held against shiki's on real files. Its others
 * stay on shiki: C++ (a quarter of it coloured differently), Dockerfile (a sixth: quoted
 * arguments plain, image names and variables coloured, where shiki takes 0.6 ms for a whole file
 * anyway) and those nobody measured yet (go, sql, toml, php, vue, svelte, nginx…).
 */
const TANSTACK: Record<string, TanstackLanguage> = {
  ts: { load: () => import('@tanstack/highlight/languages/ts').then((m) => m.ts), family: 'script' },
  tsx: { load: () => import('@tanstack/highlight/languages/tsx').then((m) => m.tsx), family: 'script' },
  js: { load: () => import('@tanstack/highlight/languages/js').then((m) => m.js), family: 'script' },
  jsx: { load: () => import('@tanstack/highlight/languages/jsx').then((m) => m.jsx), family: 'script' },
  json: { load: () => import('@tanstack/highlight/languages/json').then((m) => m.json), family: 'json' },
  css: { load: () => import('@tanstack/highlight/languages/css').then((m) => m.css), family: 'css' },
  yaml: { load: () => import('@tanstack/highlight/languages/yaml').then((m) => m.yaml), family: 'yaml' },
  markdown: { load: () => import('@tanstack/highlight/languages/markdown').then((m) => m.markdown), family: 'markdown' },
  shell: { load: () => import('@tanstack/highlight/languages/shell').then((m) => m.shell), family: 'shell', misread: unclosedSubstitution },
  python: { load: () => import('@tanstack/highlight/languages/python').then((m) => m.python), family: 'python' },
  html: { load: () => import('@tanstack/highlight/languages/html').then((m) => m.html), family: 'html', embeds: ['css', 'js', 'ts'] },
  diff: { load: () => import('@tanstack/highlight/languages/diff').then((m) => m.diff), family: 'other' },
};

/** Block language (as written after the fence) → TanStack language */
const TANSTACK_IDS: Record<string, string> = {
  ts: 'ts',
  typescript: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  javascript: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  yaml: 'yaml',
  yml: 'yaml',
  markdown: 'markdown',
  md: 'markdown',
  bash: 'shell',
  sh: 'shell',
  shell: 'shell',
  shellscript: 'shell',
  zsh: 'shell',
  python: 'python',
  py: 'python',
  html: 'html',
  htm: 'html',
  diff: 'diff',
  patch: 'diff',
};

const tanstackLoaded = new Map<string, Promise<LanguageDefinition>>();
let tanstackCore: Promise<typeof import('@tanstack/highlight/core')> | null = null;

/** The TanStack languages a block needs: its own and those it embeds, for markdown those of its fenced blocks */
function wantedLanguages(code: string, name: string): string[] {
  const fenced =
    name === 'markdown' ? [...code.matchAll(/^\s*(?:```|~~~)\s*([\w+-]+)/gm)].map((m) => TANSTACK_IDS[m[1]!.toLowerCase()]) : [];
  const own = [name, ...fenced.filter((n): n is string => n !== undefined)];
  return [...new Set(own.flatMap((n) => [n, ...(TANSTACK[n]!.embeds ?? [])]))];
}

async function tanstackTokens(code: string, name: string): Promise<HighlightToken[] | null> {
  const wanted = wantedLanguages(code, name);
  for (const n of wanted) if (!tanstackLoaded.has(n)) tanstackLoaded.set(n, TANSTACK[n]!.load());
  tanstackCore ??= import('@tanstack/highlight/core');
  const [{ createHighlighter }, ...languages] = await Promise.all([tanstackCore, ...wanted.map((n) => tanstackLoaded.get(n)!)]);
  // A highlighter is a map of definitions: building one per block costs nothing next to tokenizing
  try {
    return createHighlighter({ languages }).tokenize(code, { lang: name }).tokens;
  } catch {
    // Its template scanner recurses once per nested `${`: thousands of them overflow the stack
    return null;
  }
}

async function highlightTanstack(code: string, name: string): Promise<Highlighted | 'shiki' | null> {
  const [tokens, paint] = await Promise.all([tanstackTokens(code, name), PAINTERS[TANSTACK[name]!.family]()]);
  if (!tokens) return null;
  if (TANSTACK[name]!.misread?.(tokens)) return 'shiki';
  const runs = new Runs(STYLES.fg);
  for (const part of name === 'markdown' ? fences(tokens) : [{ tokens, lang: name }]) {
    // A fenced block is painted like a block of its own language, fetching that painter if need be
    const painter = part.lang === name ? paint : await PAINTERS[TANSTACK[part.lang]!.family]();
    for (const [text, role] of painter(part.tokens, part.lang)) runs.push(text, role ? STYLES[role] : null);
  }
  return { lines: runs.lines, base: STYLES.fg };
}

/**
 * Markdown cut at its fenced blocks: TanStack tokenizes a fence in its language, and classes the
 * text its rules leave over `code-inline`, which inside a fence means no class at all.
 */
function fences(tokens: HighlightToken[]): { tokens: HighlightToken[]; lang: string }[] {
  const parts = [{ tokens: [] as HighlightToken[], lang: 'markdown' }];
  for (const token of tokens) {
    const part = parts[parts.length - 1]!;
    const fence = token.className === 'meta' ? /^\s*(?:```|~~~)\s*([\w+-]*)/.exec(token.value) : null;
    if (fence && part.lang !== 'markdown') {
      parts.push({ tokens: [token], lang: 'markdown' });
      continue;
    }
    part.tokens.push(part.lang !== 'markdown' && token.className === 'code-inline' ? { ...token, className: undefined } : token);
    const lang = fence?.[1] ? TANSTACK_IDS[fence[1].toLowerCase()] : undefined;
    if (lang) parts.push({ tokens: [], lang });
  }
  return parts;
}

/** One painter per family, each in its own chunk: a TypeScript block never fetches the rest */
const PAINTERS: Record<Family, () => Promise<Painter>> = {
  script: () => import('./highlight/script').then((m) => m.paintScript),
  python: () => import('./highlight/python').then((m) => m.paintPython),
  css: () => import('./highlight/css').then((m) => m.paintCss),
  json: () => import('./highlight/data').then((m) => m.paintData),
  yaml: () => import('./highlight/data').then((m) => m.paintData),
  markdown: () => import('./highlight/markdown').then((m) => m.paintMarkdown),
  shell: () => import('./highlight/shell').then((m) => m.paintShell),
  html: () => import('./highlight/html').then((m) => m.paintHtml),
  other: () => import('./highlight/other').then((m) => m.paintOther),
};
