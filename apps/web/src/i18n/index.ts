/**
 * Internationalisation of the web UI: English (default) and Spanish, through i18next.
 *
 * Adding a string
 * 1. Pick the namespace by where the string lives:
 *    - `common`: words shared across the app (Save, Cancel, Delete…, status names)
 *    - `work`: Dashboard, Agents, Tasks, Workflows, Sessions, SessionView, RunView, NewRun, Projects
 *    - `config`: Config and pages/config/*, Accounts, Memory, Plugins, Orchestration(Detail)
 *    - `components`: components/**, the App.tsx shell and navigation, CommandPalette, notifications
 * 2. Add the key to `locales/en/<ns>.json` with today's English text, byte for byte (the e2e specs
 *    find elements by it), and the same key to `locales/es/<ns>.json`. Group keys by screen or
 *    component (`"runView": { "stop": "Stop" }`). A key missing from either file fails
 *    `pnpm typecheck` and test/i18n.test.ts. Follow GLOSSARY.md for the Spanish.
 * 3. Use it:
 *      const { t } = useTranslation('work');           // typed: unknown keys do not compile
 *      t('runView.stop')
 *      t('common:save')                                // another namespace, `ns:` prefix
 *      const { t } = useTranslation(['work', 'common']); // or load several, first is the default
 *    Interpolation: `"subtitle": "up {{uptime}}"` → t('dashboard.subtitle', { uptime }). Values are
 *    not HTML-escaped (React already escapes), so never build markup from them.
 *    Plurals: one key per CLDR category, `"count_one": "{{count}} account"` and
 *    `"count_other": "{{count}} accounts"`, then t('accounts.count', { count }). Spanish writes the
 *    same two; its `_many` (1000000) is derived from `_other` in resources.ts, so both files keep
 *    the same keys. For a number shown in the text, format it: { count, n: formatNumber(count) }
 *    with "{{n}} accounts", so Spanish gets "1.500".
 *    Markup inside a sentence: <Trans t={t} i18nKey="…" components={{ code: <code /> }} /> with
 *    `<code>…</code>` in the JSON.
 *    Outside React (a module constant, a toast built in a callback): import `i18n` from here and
 *    call i18n.t('work:…') at the moment the text is shown, never at import time, or it freezes
 *    in the language the page loaded with.
 * 4. Never translate what comes from the CLI, from Claude or from the user (transcripts, tool
 *    names, file contents, API error messages).
 *
 * Dates, numbers, durations and costs go through lib/format, which follows the active language.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { currentLanguage, storeLanguage, type Language } from './language';
import { defaultNS, en, resources, type Namespace } from './resources';

export { LANGUAGES, type Language } from './language';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: typeof en;
  }
}

function applyLang(language: Language): void {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

// Every resource is bundled, so init is synchronous: the first render already has its text and
// nothing needs a Suspense boundary.
void i18n.use(initReactI18next).init({
  resources,
  lng: currentLanguage(),
  fallbackLng: 'en',
  supportedLngs: ['en', 'es'],
  ns: Object.keys(en) as Namespace[],
  defaultNS,
  initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});
applyLang(currentLanguage());

export function setLanguage(next: Language): void {
  storeLanguage(next);
  applyLang(next);
  void i18n.changeLanguage(next);
}

export default i18n;
