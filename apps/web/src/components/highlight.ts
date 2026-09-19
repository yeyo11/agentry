// Syntax highlighting for code blocks, loaded on the first block that needs it. Every language is a
// chunk of its own, fetched the first time a block in that language appears, so a transcript
// without code never pays for any of it.
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages, bundledLanguagesAlias } from 'shiki/langs';
import { bundledThemes } from 'shiki/themes';

const THEMES = { light: 'github-light-default', dark: 'github-dark-default' } as const;
/** Past this, tokenizing costs more than colour is worth: the block stays plain */
const MAX_CHARS = 60_000;

let highlighter: Promise<HighlighterCore> | null = null;
const loading = new Map<string, Promise<void>>();

function core(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [bundledThemes[THEMES.light], bundledThemes[THEMES.dark]],
    langs: [],
    // The JS engine needs no WASM; `forgiving` skips the odd pattern it cannot translate
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

type Loader = (typeof bundledLanguages)[keyof typeof bundledLanguages];

function loaderFor(lang: string): Loader | undefined {
  return (bundledLanguages as Record<string, Loader>)[lang] ?? (bundledLanguagesAlias as Record<string, Loader>)[lang];
}

/** A run of text in one colour: bare for the theme's own foreground, styled for anything else. */
export type Segment = string | { content: string; style: Record<string, string> };

export interface Highlighted {
  lines: Segment[][];
  /** The themes' foreground, as the same CSS variables a segment carries, for the block itself */
  base: Record<string, string>;
}

const same = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/**
 * Lines of coloured runs, each run's colours for both themes as CSS variables (`--shiki-light`,
 * `--shiki-dark`), so the stylesheet picks one and a theme switch needs no re-render. Null when
 * the language is unknown.
 *
 * shiki hands back one token per lexeme, and a span each is most of the DOM a long transcript
 * carries. Neighbours of one colour are one run, and text in the foreground colour needs no span
 * at all once the block carries that colour itself: about 60% fewer elements, same look.
 */
export async function highlight(code: string, lang: string): Promise<Highlighted | null> {
  const id = lang.toLowerCase();
  const loader = loaderFor(id);
  if (!loader || code.length > MAX_CHARS) return null;
  const h = await core();
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
  const plain = (style: Record<string, string>) =>
    Object.keys(style).length === 2 &&
    style['--shiki-light']?.toLowerCase() === base['--shiki-light'].toLowerCase() &&
    style['--shiki-dark']?.toLowerCase() === base['--shiki-dark'].toLowerCase();

  const lines = tokens.map((line) => {
    const runs: Segment[] = [];
    for (const token of line) {
      const style = (token.htmlStyle ?? {}) as Record<string, string>;
      const prev = runs[runs.length - 1];
      if (plain(style)) {
        if (typeof prev === 'string') runs[runs.length - 1] = prev + token.content;
        else runs.push(token.content);
      } else if (prev !== undefined && typeof prev !== 'string' && same(prev.style, style)) {
        prev.content += token.content;
      } else {
        runs.push({ content: token.content, style });
      }
    }
    return runs;
  });
  return { lines, base };
}
