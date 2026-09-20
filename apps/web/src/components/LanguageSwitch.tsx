import { ChevronDown } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES } from '../i18n';
import { ICON_SM } from './icons';

// The menu is Radix Select (~14 kB gzip), which the shell otherwise never needs on first paint
const LanguageMenu = lazy(() => import('./LanguageMenu').then((m) => ({ default: m.LanguageMenu })));

/** The language menu for the top bar; until its chunk arrives, a look-alike keeps the bar from shifting. */
export function LanguageSwitch() {
  const { i18n } = useTranslation();
  const name = LANGUAGES.find(({ code }) => code === i18n.resolvedLanguage)?.name ?? 'English';
  return (
    <Suspense
      fallback={
        <span className="select-trigger language-switch" aria-hidden>
          <span className="select-value">{name}</span>
          <span className="select-chevron">
            <ChevronDown {...ICON_SM} />
          </span>
        </span>
      }
    >
      <LanguageMenu />
    </Suspense>
  );
}
