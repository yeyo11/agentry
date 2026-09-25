// Ported from docs/design-system/illustrations/no-results.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
import { useTranslation } from 'react-i18next';

export function NoResults() {
  const { t } = useTranslation('components');
  return (
    <>
      <path d="M131 97 L158 124" className="ln-grad w8" />
      <circle cx="106" cy="72" r="35" className="s1" /><circle cx="106" cy="72" r="35" className="ln-ink w3" />
      <rect x="86" y="62" width="40" height="6" rx="3" className="s3" /><rect x="86" y="76" width="26" height="6" rx="3" className="s3" />
      <path d="M84 54 A28 28 0 0 1 100 45" className="ln-soft" />
      <g className="a-float"><rect x="150" y="28" width="76" height="22" rx="11" className="c2" /><text x="188" y="42.5" textAnchor="middle" className="txt">{t('illustrations.noResults')}</text></g>
    </>
  );
}
