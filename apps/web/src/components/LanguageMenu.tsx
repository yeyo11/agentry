import { useTranslation } from 'react-i18next';
import { LANGUAGES, setLanguage, type Language } from '../i18n';
import { Select } from './controls/Select';

const OPTIONS = LANGUAGES.map(({ code, name }) => ({ value: code, label: <span lang={code}>{name}</span> }));

/** Lists each language under its own name, so it can be found from either one. */
export function LanguageMenu() {
  const { t, i18n } = useTranslation();
  const value: Language = i18n.resolvedLanguage === 'es' ? 'es' : 'en';
  return <Select value={value} onChange={setLanguage} options={OPTIONS} aria-label={t('language')} />;
}
