// Syntax highlighting for code blocks, loaded on the first block that needs it. Every language is a
// chunk of its own, fetched the first time a block in that language appears, so a transcript
// without code never pays for any of it.
import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core';
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

/**
 * Tokens with both themes' colours as CSS variables (`--shiki-light`, `--shiki-dark`), so the
 * stylesheet picks one and a theme switch needs no re-render. Null when the language is unknown.
 */
export async function highlight(code: string, lang: string): Promise<ThemedToken[][] | null> {
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
  return h.codeToTokens(code, { lang: id, themes: THEMES, defaultColor: false }).tokens;
}
