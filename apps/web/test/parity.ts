// Colour parity between the two engines behind highlight(): every character of a block, in both
// themes, as @tanstack/highlight plus our painting colours it and as shiki colours it. Shared by
// the parity test and `pnpm --filter @agentry/web parity`, the report run on demand.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createHighlighter, type BundledLanguage } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { highlight, type Highlighted } from '../src/components/highlight.ts';

const THEMES = { light: 'github-light-default', dark: 'github-dark-default' } as const;

/** One character's colour in both themes, `light/dark`, lower case */
type Colour = string;

export interface Difference {
  /** The run of characters, as they read in the source */
  text: string;
  ours: Colour;
  theirs: Colour;
  /** shiki's innermost scope for the run: why the grammar colours it the way it does */
  scope: string;
}

export interface Parity {
  /** Characters a reader sees: everything but whitespace */
  chars: number;
  /** Of those, the ones in the same colour in both themes */
  same: number;
  differences: Difference[];
}

let shiki: ReturnType<typeof createHighlighter> | null = null;

/**
 * shiki as the app runs it for the languages TanStack does not take: the JavaScript regex engine,
 * forgiving, so the reference is what the UI would show had the block gone through shiki. Every
 * language of the corpus is loaded up front, so a fenced block in markdown or a script in HTML is
 * coloured the way shiki colours it once it knows that language.
 */
function reference() {
  shiki ??= createHighlighter({ themes: Object.values(THEMES), langs: [...PARITY_LANGS], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  return shiki;
}

/** Every language highlight() hands to TanStack, by a name shiki knows too */
export const PARITY_LANGS = ['typescript', 'tsx', 'javascript', 'jsx', 'json', 'css', 'yaml', 'markdown', 'bash', 'python', 'html', 'diff', 'dockerfile'] as const;

function oursPerChar(out: Highlighted): Colour[] {
  const colour = (style: Record<string, string>) => `${style['--shiki-light']}/${style['--shiki-dark']}`.toLowerCase();
  const base = colour(out.base);
  return out.lines.flatMap((line, i) => [
    ...(i > 0 ? [base] : []),
    ...line.flatMap((run) => {
      const [text, c] = typeof run === 'string' ? [run, base] : [run.content, colour(run.style)];
      return Array.from({ length: text.length }, () => c);
    }),
  ]);
}

const CACHE = join(import.meta.dirname, '../node_modules/.cache/parity');
const SHIKI_VERSION = (createRequire(import.meta.url)('shiki/package.json') as { version: string }).version;

/**
 * shiki takes minutes over the whole corpus, and its answer only changes with its version: kept on
 * disk, a report after a change to our painting costs seconds.
 */
async function theirsPerChar(code: string, lang: string): Promise<{ colours: Colour[]; scopes: string[] }> {
  const file = join(CACHE, `${createHash('sha1').update(`${SHIKI_VERSION}\0${PARITY_LANGS.join()}\0${lang}\0${code}`).digest('hex')}.json`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { colours: Colour[]; scopes: string[] };
  } catch {
    const theirs = await tokenizeWithShiki(code, lang);
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(file, JSON.stringify(theirs));
    return theirs;
  }
}

async function tokenizeWithShiki(code: string, lang: string): Promise<{ colours: Colour[]; scopes: string[] }> {
  const h = await reference();
  const fg = `${h.getTheme(THEMES.light).fg}/${h.getTheme(THEMES.dark).fg}`.toLowerCase();
  const { tokens } = h.codeToTokens(code, { lang: lang as BundledLanguage, themes: THEMES, defaultColor: false, includeExplanation: 'scopeName', tokenizeTimeLimit: 0 });
  const colours: Colour[] = [];
  const scopes: string[] = [];
  tokens.forEach((line, i) => {
    if (i > 0) {
      colours.push(fg);
      scopes.push('');
    }
    for (const token of line) {
      const style = (token.htmlStyle ?? {}) as Record<string, string>;
      const c = style['--shiki-light'] ? `${style['--shiki-light']}/${style['--shiki-dark']}`.toLowerCase() : fg;
      for (const part of token.explanation ?? [{ content: token.content, scopes: [] }]) {
        const scope = part.scopes.at(-1)?.scopeName ?? '';
        for (let k = 0; k < part.content.length; k++) {
          colours.push(c);
          scopes.push(scope);
        }
      }
    }
  });
  return { colours, scopes };
}

/** Both engines on one block; `lang` is a name shiki knows and highlight() takes */
export async function parity(code: string, lang: string): Promise<Parity> {
  const out = await highlight(code, lang);
  if (!out) throw new Error(`${lang}: not highlighted`);
  const ours = oursPerChar(out);
  const theirs = await theirsPerChar(code, lang);
  if (ours.length !== code.length || theirs.colours.length !== code.length) throw new Error(`${lang}: ${ours.length} / ${theirs.colours.length} colours for ${code.length} characters`);
  let chars = 0;
  let same = 0;
  const differences: Difference[] = [];
  // Where the last difference ends: the next one extends it when only whitespace lies between
  let end = -1;
  for (let i = 0; i < code.length; i++) {
    if (/\s/.test(code[i]!)) continue;
    chars++;
    const o = ours[i]!;
    const t = theirs.colours[i]!;
    const scope = theirs.scopes[i]!;
    if (o === t) {
      same++;
      continue;
    }
    const last = differences.at(-1);
    if (last && last.ours === o && last.theirs === t && last.scope === scope && /^\s*$/.test(code.slice(end, i))) last.text += code.slice(end, i + 1);
    else differences.push({ text: code[i]!, ours: o, theirs: t, scope });
    end = i + 1;
  }
  return { chars, same, differences };
}
