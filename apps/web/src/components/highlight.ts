// Syntax highlighting for code blocks, loaded on the first block that needs it. Two engines behind
// one output: @tanstack/highlight for the languages it knows (a few KB and a few ms a block), shiki
// with its TextMate grammars for everything else (tens of KB and a slow tokenizer, but hundreds of
// languages). Every language is a chunk of its own, fetched the first time a block in that language
// appears, so a transcript without code never pays for any of it, and one with only TypeScript
// never downloads shiki.
// What still differs from shiki, once the painters have done their work (the share of visible
// characters that match is in test/parity.test.ts, the differences themselves in
// `pnpm --filter @agentry/web parity <language> --context`):
//
//   TypeScript, TSX, JSX  a name's kind where only a type-checker knows it: an enum's members, a
//                         type alias used as a value, a module-level constant assigned once, the
//                         support objects `Symbol` and `module.exports`, a class a JSX component
//                         extends. TanStack classes a lexeme by its looks, and these read alike.
//   CSS                   the grammar's own word lists: the property values it knows (`grid`,
//                         `color`), the media features it knows (`max-width` but not
//                         `prefers-color-scheme`), and `background` in a `transition`, which it
//                         paints as a deprecated system colour — shiki against itself, not us.
//   YAML                  `on:` as a key, which the grammar reads as YAML 1.1's boolean, aliases
//                         (`*defaults`), merge keys and `---`.
//   Markdown              a fenced shell block after a `\` continuation: shiki colours the same
//                         line one way on its own and another inside a fence, and we follow the
//                         standalone bash it reads that block as. A reference definition's title
//                         (`[ref]: url "Title"`) stays plain, a quoted word in prose being the
//                         same text.
//   shell                 `$1` inside single quotes, brace expansion (`{a,b,c}`) and `find`'s `{}`.
//   Python                a raw string, which the grammar reads as a regular expression and
//                         colours inside, and a class's bases (`class A(Base, metaclass=M)`).
//   diff                  formats other than unified: SVN's `====` separators and normal diffs
//                         (`3c3`, `<`, `>`). Over this repository's last 40 commits, 99.98%.
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
  // A carriage return is no part of a language, and TanStack's CSS rules take cubic time over one:
  // 8 000 characters of CRLF took a minute. The tokenizers read the text without them, and they go
  // back into the coloured runs afterwards, so what comes out is what came in.
  const source = code.includes('\r') ? code.replace(/\r/g, '') : code;
  const out = await highlightSource(source, lang);
  return out && source !== code ? withReturns(out, code) : out;
}

async function highlightSource(code: string, lang: string): Promise<Highlighted | null> {
  const cost = lineCost(code);
  const id = lang.toLowerCase();
  const tanstack = TANSTACK_IDS[id];
  if (tanstack && cost <= TANSTACK_BUDGET && !TANSTACK[tanstack]!.unfit?.(code)) {
    if (runaway(code, TANSTACK[tanstack]!.family)) return null;
    const out = await highlightTanstack(code, tanstack);
    // Only a block TanStack read wrongly is worth shiki's time; one it choked on is not code
    if (out !== 'shiki') return out;
  }
  return cost > SHIKI_BUDGET ? null : highlightShiki(code, id);
}

/** The carriage returns of `code` put back into runs painted from the text without them */
function withReturns(out: Highlighted, code: string): Highlighted {
  const lines = code.split('\n').map((line, i) => {
    const runs = out.lines[i] ?? [];
    if (!line.includes('\r')) return runs;
    // A line of returns alone has no run to put them in
    if (runs.length === 0) return [line];
    // Each run takes as much of the line as holds its characters, returns in between included
    let at = 0;
    return runs.map((run, k) => {
      const content = typeof run === 'string' ? run : run.content;
      let end = at;
      for (let taken = 0; taken < content.length; end++) if (line[end] !== '\r') taken++;
      if (k === runs.length - 1) end = line.length;
      const text = line.slice(at, end);
      at = end;
      return typeof run === 'string' ? text : { ...run, content: text };
    });
  });
  return { ...out, lines };
}

/**
 * Both tokenizers are quadratic in the length of a line: 59 000 characters on one line took
 * TanStack fifteen seconds and shiki over a minute, and shiki's own per-line time limit does not
 * stop it. The sum of the squares of the line lengths is what their cost follows, so it is what
 * they are budgeted by — past the budget the block stays plain. Prose and code a reader could
 * follow are orders of magnitude below it; a minified line is not.
 */
const lineCost = (code: string) => code.split('\n').reduce((cost, line) => cost + line.length ** 2, 0);
const TANSTACK_BUDGET = 2e8;
const SHIKI_BUDGET = 5e7;

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
  /** Text its tokenizer cannot take at all, read before it is handed any: shiki's, then */
  unfit?: (code: string) => boolean;
}

/**
 * TanStack's CSS rules take cubic time over a run of whitespace with no rule in it: 500 characters
 * of it cost 0.2 s, 2 000 cost 4 s and 4 000 cost 30 s, where shiki reads the same in one. No
 * stylesheet holds a gap that wide, and the ones that do are shiki's.
 */
const WIDE_GAP = (code: string) => /\s{200,}/.test(code);

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
 *
 * `@tanstack/highlight` is pinned to the exact version its tokens were read against: a new one
 * moves classes around, and the painters are written to what each class means. On an upgrade, run
 * `pnpm --filter @agentry/web parity`, hold the numbers against the floors in test/parity.test.ts,
 * and re-read three things the painters lean on: which lexemes come out unclassed (each painter
 * cuts that text itself), whether `misread` still describes a real misreading, and whether the
 * tokenizer still recurses per nested `${` or JSX element, which `runaway` and the catch around
 * `tokenize` are there for.
 */
const TANSTACK: Record<string, TanstackLanguage> = {
  ts: { load: () => import('@tanstack/highlight/languages/ts').then((m) => m.ts), family: 'script' },
  tsx: { load: () => import('@tanstack/highlight/languages/tsx').then((m) => m.tsx), family: 'script' },
  js: { load: () => import('@tanstack/highlight/languages/js').then((m) => m.js), family: 'script' },
  jsx: { load: () => import('@tanstack/highlight/languages/jsx').then((m) => m.jsx), family: 'script' },
  json: { load: () => import('@tanstack/highlight/languages/json').then((m) => m.json), family: 'json' },
  css: { load: () => import('@tanstack/highlight/languages/css').then((m) => m.css), family: 'css', unfit: WIDE_GAP },
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
