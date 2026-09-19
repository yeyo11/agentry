// Syntax highlighting for code blocks, loaded on the first block that needs it. Two engines behind
// one output: @tanstack/highlight for the languages it knows (a few KB and a few ms a block), shiki
// with its TextMate grammars for everything else (tens of KB and a slow tokenizer, but hundreds of
// languages). Every language is a chunk of its own, fetched the first time a block in that language
// appears, so a transcript without code never pays for any of it, and one with only TypeScript
// never downloads shiki.
import type { HighlightToken, LanguageDefinition } from '@tanstack/highlight/core';

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
  return tanstack ? highlightTanstack(code, tanstack) : highlightShiki(code, id);
}

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
  const { tokens } = h.codeToTokens(code, { lang: id, themes: THEMES, defaultColor: false });
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

/**
 * The github-light-default / github-dark-default colours shiki paints with, by the scope family
 * that gets them. A test holds these against the themes themselves.
 */
export const PALETTE = {
  fg: ['#1f2328', '#e6edf3'], // the theme's foreground
  comment: ['#6e7781', '#8b949e'], // comment
  keyword: ['#cf222e', '#ff7b72'], // keyword, storage, keyword.operator
  constant: ['#0550ae', '#79c0ff'], // constant, support, variable.language, entity.other.attribute-name
  entity: ['#953800', '#ffa657'], // entity.name (types), variable in css/markdown lists
  function: ['#8250df', '#d2a8ff'], // entity.name.function
  tag: ['#116329', '#7ee787'], // entity.name.tag, support.type.property-name.json, markup.inserted
  string: ['#0a3069', '#a5d6ff'], // string
  deleted: ['#82071e', '#ffa198'], // markup.deleted
} as const;
type Role = keyof typeof PALETTE;

const STYLES = {} as Record<Role, Record<string, string>>;
for (const role of Object.keys(PALETTE) as Role[]) STYLES[role] = { '--shiki-light': PALETTE[role][0], '--shiki-dark': PALETTE[role][1] };

type Family = 'script' | 'json' | 'yaml' | 'css' | 'markdown' | 'shell' | 'python' | 'other';

interface TanstackLanguage {
  load: () => Promise<LanguageDefinition>;
  family: Family;
  /** Languages its blocks embed (a `<style>`, a `<script>`) */
  embeds?: string[];
}

/**
 * Only the TanStack languages whose colours were held against shiki's on real files. Its others
 * stay on shiki: C++ (a quarter of it coloured differently) and those nobody measured yet (go,
 * sql, toml, php, vue, svelte, nginx…).
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
  shell: { load: () => import('@tanstack/highlight/languages/shell').then((m) => m.shell), family: 'shell' },
  python: { load: () => import('@tanstack/highlight/languages/python').then((m) => m.python), family: 'python' },
  html: { load: () => import('@tanstack/highlight/languages/html').then((m) => m.html), family: 'other', embeds: ['css', 'js', 'ts'] },
  diff: { load: () => import('@tanstack/highlight/languages/diff').then((m) => m.diff), family: 'other' },
  dockerfile: { load: () => import('@tanstack/highlight/languages/dockerfile').then((m) => m.dockerfile), family: 'other' },
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
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
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

async function tanstackTokens(code: string, name: string): Promise<HighlightToken[]> {
  const wanted = wantedLanguages(code, name);
  for (const n of wanted) if (!tanstackLoaded.has(n)) tanstackLoaded.set(n, TANSTACK[n]!.load());
  tanstackCore ??= import('@tanstack/highlight/core');
  const [{ createHighlighter }, ...languages] = await Promise.all([tanstackCore, ...wanted.map((n) => tanstackLoaded.get(n)!)]);
  // A highlighter is a map of definitions: building one per block costs nothing next to tokenizing
  return createHighlighter({ languages }).tokenize(code, { lang: name }).tokens;
}

async function highlightTanstack(code: string, name: string): Promise<Highlighted> {
  const tokens = await tanstackTokens(code, name);
  const runs = new Runs(STYLES.fg);
  for (const [text, role] of PAINTERS[TANSTACK[name]!.family](tokens, name)) runs.push(text, role ? STYLES[role] : null);
  return { lines: runs.lines, base: STYLES.fg };
}

/**
 * What each TanStack class is in the GitHub themes. The painters below correct it where a TextMate
 * grammar tells apart what TanStack lumps into one class, and colour the operators and names it
 * leaves unclassed. They look at a token and its neighbours, never at a parse.
 *
 * No clean equivalent: `meta` (markdown fences, shell shebangs: the themes leave them in the
 * foreground), `link` (the themes colour the link text, not the URL: split below), `property`
 * (a JSON/YAML key is a tag, a CSS property a constant, a JS member plain or a call).
 */
const CLASS_ROLE: Record<string, Role | null> = {
  attr: 'constant',
  'code-inline': 'constant',
  command: 'entity',
  comment: 'comment',
  deleted: 'deleted',
  function: 'function',
  heading: 'constant',
  inserted: 'tag',
  keyword: 'keyword',
  link: 'string',
  literal: 'constant',
  meta: null,
  number: 'constant',
  operator: 'keyword',
  property: 'constant',
  selector: 'constant',
  string: 'string',
  tag: 'tag',
  type: 'entity',
  variable: 'entity',
};

type Piece = [text: string, role: Role | null];
type Painter = (tokens: HighlightToken[], lang: string) => Generator<Piece>;

const roleOf = (token: HighlightToken): Role | null => (token.className ? (CLASS_ROLE[token.className] ?? null) : null);

const PRIMITIVES = new Set(['string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'void', 'unknown', 'any', 'never', 'undefined', 'null']);

/** Operators and JSX expression braces: TanStack leaves both in the plain text between tokens */
const SCRIPT_PLAIN = /=>|\.\.\.|[=!]==?|[<>]=|&&=?|\|\|=?|\?\?=?|[-+*%]=?|\?(?!\.)|!|\||&|=|(?<=\s)[<>/](?=\s)|[{}:]/g;

function* paintScript(tokens: HighlightToken[], lang: string): Generator<Piece> {
  const jsx = lang === 'tsx' || lang === 'jsx';
  // For each `{` still open: whether it opened a JSX expression, whose braces the themes colour
  const braces: boolean[] = [];
  // Between `import` and its source the names are bindings, in the foreground
  let importing = false;
  for (const [i, token] of tokens.entries()) {
    const { value, className } = token;
    const prev = tokens[i - 1];
    if (!className) {
      yield* pieces(value, SCRIPT_PLAIN, (op, at) => {
        if (op === '{') {
          const before = value.slice(0, at).trimEnd();
          const open = jsx && ((before === '=' && prev?.className === 'attr') || (/>$/.test(before) && !/=>$/.test(before)));
          braces.push(open);
          return open ? 'keyword' : null;
        }
        if (op === '}') return braces.pop() ? 'keyword' : null;
        // A type annotation or a ternary; an object key's colon stays plain
        if (op === ':') return value[at - 1] === ' ' || (tokens[i + 1]?.className === 'type' && !value.slice(at + 1).trim()) ? 'keyword' : null;
        return 'keyword';
      });
      continue;
    }
    const after = tokens[i + 1]?.value ?? '';
    let role = roleOf(token);
    if (className === 'keyword' && (value === 'import' || value === 'from')) importing = value === 'import';
    else if (className === 'string') importing = false;
    if (className === 'keyword' && (value === 'this' || value === 'super')) role = 'constant';
    // TanStack takes any capitalised name for a type: the grammar knows better where it is a value
    else if (className === 'type' && (importing || after.startsWith('.'))) role = null;
    else if (className === 'type' && after.startsWith('(')) role = 'function';
    else if (className === 'type' && (PRIMITIVES.has(value) || /^[A-Z][A-Z\d_]+$/.test(value))) role = 'constant';
    // A member is plain unless it is called
    else if (className === 'property') role = after.startsWith('(') ? 'function' : null;
    // `${` and `}` of a template literal
    else if (className === 'operator') role = 'string';
    yield [value, role];
  }
}

const PYTHON_BUILTINS =
  'abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip self cls';
const PYTHON_PLAIN = new RegExp(`(?<![.\\w])(?:${PYTHON_BUILTINS.split(' ').join('|')})\\b|[=!<>]=|\\*\\*=?|//=?|->|[-+*/%@&|^]=?|=|[<>]`, 'g');

function* paintPython(tokens: HighlightToken[]): Generator<Piece> {
  for (const token of tokens) {
    if (!token.className) yield* pieces(token.value, PYTHON_PLAIN, (m) => (/\w/.test(m) ? 'constant' : 'keyword'));
    // Builtin types (`str`, `int`) are support.type in the grammar
    else yield [token.value, token.className === 'type' ? 'constant' : roleOf(token)];
  }
}

function* paintCss(tokens: HighlightToken[]): Generator<Piece> {
  for (const [i, token] of tokens.entries()) {
    const { value, className } = token;
    if (!className) {
      // Unclassed words in a declaration are keyword values (`flex`, `solid`); `%` is a unit TanStack leaves out of the number
      const afterNumber = tokens[i - 1]?.className === 'number';
      yield* pieces(value, /(?<![\w-])[a-z][\w-]*|!important|^%/gi, (m) => (/^[a-z]/i.test(m) ? 'constant' : m === '%' && !afterNumber ? null : 'keyword'));
    } else if (className === 'number') {
      const unit = /[a-z%]+$/i.exec(value);
      if (unit && unit.index > 0) yield* [[value.slice(0, unit.index), 'constant'], [unit[0], 'keyword']] as Piece[];
      else yield [value, 'constant'];
    } else if (className === 'selector') {
      // The whole prelude is one token: classes, ids and pseudos are attribute names, bare words tags
      yield* pieces(value, /[.#]-?[\w-]+|::?[\w-]+|\[[^\]]*\]|(?<![\w-])[a-z][\w-]*|[>+~*]/gi, (m) =>
        /^[>+~]$/.test(m) ? 'keyword' : /^[a-z*]/i.test(m) ? 'tag' : 'constant',
      );
    } else yield [value, className === 'function' ? 'constant' : roleOf(token)];
  }
}

function* paintData(tokens: HighlightToken[], lang: string): Generator<Piece> {
  for (const token of tokens) {
    const { value, className } = token;
    if (className === 'property') yield [value, 'tag'];
    // Block scalar indicators
    else if (className === 'string' && /^[|>][-+]?$/.test(value)) yield [value, 'keyword'];
    // An unquoted YAML scalar is a string to the themes, and TanStack leaves it plain
    else if (!className && lang === 'yaml') yield* pieces(value, /[^\s:\-[\]{},#][^\n]*?(?=\s*$)/gm, () => 'string');
    else yield [value, roleOf(token)];
  }
}

function* paintMarkdown(tokens: HighlightToken[]): Generator<Piece> {
  for (const token of tokens) {
    const { value, className } = token;
    if (className === 'link') {
      const m = /^(!?\[)(.*)(\][\s\S]*)$/.exec(value);
      yield* (m ? [[m[1]!, null], [m[2]!, 'string'], [m[3]!, null]] : [[value, null]]) as Piece[];
    } else if (className === 'meta') yield [value, /^\s*([-*+]|\d+[.)])\s*$/.test(value) ? 'entity' : null];
    // The unclassed rest of a fenced block is the block's own foreground, unlike inline code
    else if (className === 'code-inline') yield [value, value.startsWith('`') ? 'constant' : null];
    else yield [value, roleOf(token)];
  }
}

const SHELL_BUILTINS = new Set(
  '. alias bg bind break builtin caller cd command compgen complete continue declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait'.split(' '),
);
const SHELL_WORD = /\\\n|\d*>>?&?\d*|&>|\|\||&&|;;|[|;&(){}\n=]|\$\(|\$\{?[\w*@#?$!-]+\}?|[^\s|;&(){}<>"'$=]+|[<>]/g;
const SHELL_EXPANSION = /\$\{?[\d*@#?$!]\}?|\$\{?[A-Za-z_]\w*\}?/g;
/** After these a command may start */
const SHELL_SEPARATORS = new Set(['\n', ';', '|', '||', '&&', '&', '$(', '{', '(']);
const expansion = (word: string): Role | null => (/^\$\{?[A-Za-z_]/.test(word) ? null : 'constant');

/**
 * TanStack marks commands only at the start of a line and leaves arguments, options and most
 * operators unclassed, where the shell grammar colours all three. Enough of a shell's shape to
 * tell them apart: whether a word stands where a command goes, or where a case pattern does.
 */
function* paintShell(tokens: HighlightToken[]): Generator<Piece> {
  let command = true;
  let pattern = false;
  let assigned = false;
  for (const token of tokens) {
    const text = token.value;
    switch (token.className) {
      case 'keyword':
        pattern = text === 'in' ? pattern : false;
        if (text === 'case') pattern = true;
        command = text !== 'in' && text !== 'case';
        yield [text, 'keyword'];
        break;
      case 'command':
        // The `1` of `2>&1` comes out as a command
        yield [text, /^\d+$/.test(text) ? 'keyword' : SHELL_BUILTINS.has(text) ? 'constant' : 'entity'];
        command = false;
        break;
      case 'variable':
        // An assignment's name, in the foreground like every variable
        yield [text, null];
        break;
      case 'string':
        yield* pieces(text, SHELL_EXPANSION, expansion, 'string');
        command = false;
        assigned = false;
        break;
      case undefined:
        yield* pieces(text, SHELL_WORD, (word, at) => {
          if (word === '=') {
            assigned = true;
            return 'keyword';
          }
          if (word === ';;') {
            pattern = true;
            return null;
          }
          if (SHELL_SEPARATORS.has(word)) {
            command = !pattern;
            assigned = false;
            return word === '||' || (word === '|' && !pattern) ? 'keyword' : null;
          }
          // A line continuation
          if (word === '\\\n') return 'keyword';
          if (word === ')') {
            if (!pattern) return null;
            pattern = false;
            command = true;
            return 'keyword';
          }
          if (/^\d*[<>]|^&>/.test(word)) return 'keyword';
          if (word === '}' || word === ']' || word === ']]') return null;
          if (word.startsWith('$')) return expansion(word);
          if (pattern) return 'string';
          if (assigned) {
            assigned = false;
            return /^\d+$/.test(word) ? 'constant' : 'string';
          }
          if (command) {
            // `NAME=value` before a command
            if (text[at + word.length] === '=') return null;
            command = false;
            if (word === '[' || word === '[[') return null;
            if (text.startsWith('()', at + word.length)) return 'function';
            // A command given by path is an unquoted string to the grammar
            return SHELL_BUILTINS.has(word) ? 'constant' : word.includes('/') ? 'string' : 'entity';
          }
          return /^--?[A-Za-z\d]/.test(word) || /^\d+$/.test(word) ? 'constant' : 'string';
        });
        break;
      default:
        yield [text, roleOf(token)];
    }
  }
}

function* paintOther(tokens: HighlightToken[], lang: string): Generator<Piece> {
  for (const token of tokens) {
    const { value, className } = token;
    if (lang === 'diff' && className === 'meta') {
      // A diff's headers: TanStack has one class for all of them, the grammar one colour each
      const range = /^@@[^@]*@@/.exec(value)?.[0];
      if (range) yield* [[range, 'function'], [value.slice(range.length), null]] as Piece[];
      else yield [value, value.startsWith('---') ? 'deleted' : value.startsWith('+++') ? 'tag' : value.startsWith('diff ') ? 'constant' : null];
    }
    // The Dockerfile grammar leaves the commands of a RUN in the foreground
    else if (lang === 'dockerfile' && className === 'command') yield [value, null];
    else yield [value, roleOf(token)];
  }
}

const PAINTERS: Record<Family, Painter> = {
  script: paintScript,
  python: paintPython,
  css: paintCss,
  json: paintData,
  yaml: paintData,
  markdown: paintMarkdown,
  shell: paintShell,
  other: paintOther,
};

/** `value` cut at each match of `pattern`, every match in the role `role` gives it and the rest in `rest` */
function* pieces(
  value: string,
  pattern: RegExp,
  role: (match: string, at: number) => Role | null,
  rest: Role | null = null,
): Generator<Piece> {
  let at = 0;
  for (const m of value.matchAll(pattern)) {
    if (!m[0]) continue;
    if (m.index > at) yield [value.slice(at, m.index), rest];
    yield [m[0], role(m[0], m.index)];
    at = m.index + m[0].length;
  }
  if (at < value.length) yield [value.slice(at), rest];
}
