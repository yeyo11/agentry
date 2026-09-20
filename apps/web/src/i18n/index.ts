/**
 * Internationalisation of the web UI: English (default) and Spanish, through i18next.
 *
 * Adding a string
 * 1. Pick the namespace by where the string lives:
 *    - `common`: words shared across the app (`actions.*`, status names, times). A string that
 *      three screens spell the same way belongs here, not copied into each namespace.
 *    - `chat`: the chat page (ChatView, pages/chat/*, ChatBadges, ChatDelete)
 *    - `chats`: the chat list, New chat, the run-workflow dialog and lib/chat-model
 *    - `home`: Home, its Activity tab, the project selector and Settings
 *    - `projects`: Projects and the project tabs (memory, worktrees, settings, resources)
 *    - `orchestration`: the Orchestrations list and the task board
 *    - `orchestrationDetail`: one orchestration's page
 *    - `observe`: what an agent is really doing: its changes, checklist, health actions and the
 *      editor links (components/observe/*, the Editor tab of Settings)
 *    - `config`: pages/config/* (settings, MCP, resources, files, plugins), Accounts and the
 *      wording of the previous Orchestration pages that the two above still reuse
 *    - `components`: components/**, the App.tsx shell and navigation, CommandPalette, notifications
 *    - `work`: what is left of the pages the chats redesign removed (Dashboard, Agents, Sessions…)
 * 2. Add the key to `locales/en/<ns>.json` with today's English text, byte for byte (the e2e specs
 *    find elements by it), and the same key to `locales/es/<ns>.json`. Group keys by screen or
 *    component (`"runView": { "send": "Send" }`). A key missing from either file fails
 *    `pnpm typecheck` and test/i18n.test.ts. Follow GLOSSARY.md for the Spanish.
 * 3. Use it:
 *      const { t } = useTranslation('work');           // typed: unknown keys do not compile
 *      t('runView.send')
 *      t('common:actions.save')                        // another namespace, with it loaded too:
 *      const { t } = useTranslation(['work', 'common']); // the ns: prefix only types loaded ones
 *    Interpolation: `"subtitle": "up {{uptime}}"` → t('dashboard.subtitle', { uptime }). Values are
 *    not HTML-escaped (React already escapes), so never build markup from them.
 *    Plurals: one key per CLDR category, `"count_one": "{{count}} account"` and
 *    `"count_other": "{{count}} accounts"`, then t('accounts.count', { count }). Spanish writes the
 *    same two; its `_many` (1000000) is derived from `_other` in resources.ts, so both files keep
 *    the same keys. For a number shown in the text, format it: { count, n: formatNumber(count) }
 *    with "{{n}} accounts", so Spanish gets "1.500".
 *    Markup inside a sentence: <Trans t={t} i18nKey="…" components={{ code: <code /> }} /> with
 *    `<code>…</code>` in the JSON. Never name a tag after an HTML void element
 *    (`link`, `img`, `br`, `input`): the parser closes it at once and it renders empty.
 *    Outside React (a module constant, a toast built in a callback): import `i18n` from here and
 *    call i18n.t('work:…') at the moment the text is shown, never at import time, or it freezes
 *    in the language the page loaded with.
 * 4. Never translate what comes from the CLI, from Claude or from the user (transcripts, tool
 *    names, file contents, API error messages). test/hardcoded-strings.test.ts fails on any other
 *    user-visible English left in a .tsx or .ts file; what legitimately stays English goes in its
 *    ALLOWED list, with the reason.
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
