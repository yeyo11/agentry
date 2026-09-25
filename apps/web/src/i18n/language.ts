// The UI language, kept apart from i18next so lib/format can ask for the Intl locale without
// pulling React in, and so detection can be unit-tested with any navigator.languages.

export type Language = 'en' | 'es';

/** Each language is offered under its own name, so a reader who cannot read the current one still finds theirs. */
export const LANGUAGES: ReadonlyArray<{ code: Language; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
];

const STORAGE_KEY = 'agentry-language';

// POSIX tags (`es_ES.UTF-8`) separate the region with an underscore
const primary = (tag: string) => tag.toLowerCase().split(/[-_.@]/)[0];

/**
 * The first browser language Agentry has decides, so ['de', 'es', 'en'] reads Spanish and
 * ['en-US', 'es'] English; a browser with neither gets English.
 */
export function detectLanguage(browser: readonly string[]): Language {
  for (const tag of browser) {
    const code = primary(tag);
    if (code === 'es') return 'es';
    if (code === 'en') return 'en';
  }
  return 'en';
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

function readStored(): Language | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'es') return stored;
  } catch {
    // storage blocked (or no storage at all under node): follow the browser
  }
  return null;
}

let current: Language = readStored() ?? detectLanguage(browserLanguages());

export function currentLanguage(): Language {
  return current;
}

/** Only records the choice; i18n/index.ts's setLanguage is what the UI calls. */
export function storeLanguage(next: Language): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // not persisted; still applied for this visit
  }
}

/**
 * The locale Intl formats with: the browser's own variant of the active language when it lists
 * one (en-GB keeps day-first dates, es-MX its own), otherwise a sensible default for it.
 */
export function intlLocale(language: Language = current, browser: readonly string[] = browserLanguages()): string {
  for (const tag of browser) {
    if (primary(tag) !== language) continue;
    const valid = canonical(tag);
    if (valid) return valid;
  }
  return language === 'es' ? 'es-ES' : 'en-US';
}

/**
 * A browser tag Intl accepts, or null. Some Linux browsers report the POSIX locale as is
 * (`en-US@posix`, `es_ES.UTF-8`), and Intl throws a RangeError on it, which took down every widget
 * that formats a date or a number.
 */
function canonical(tag: string): string | null {
  const bcp47 = tag.split(/[.@]/)[0]?.replace(/_/g, '-') ?? '';
  if (!bcp47) return null;
  try {
    return Intl.getCanonicalLocales(bcp47)[0] ?? null;
  } catch {
    return null;
  }
}
