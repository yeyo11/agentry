// Ported from docs/design-system/illustrations/not-found.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
import { useTranslation } from 'react-i18next';

export function NotFound() {
  const { t } = useTranslation('components');
  return (
    <>
      <circle cx="42" cy="80" r="11" className="c2" /><circle cx="42" cy="80" r="4" className="f-grad" />
      <path d="M53 80 H88" className="ln-grad" />
      <path d="M88 80 l6 -9 l6 13 l6 -8" className="ln-tone" />
      <path d="M122 80 H168" className="ln a-dash" />
      <circle cx="192" cy="80" r="24" className="ln dash-lg" />
      <text x="192" y="85" textAnchor="middle" className="txt-big">404</text>
      <g className="a-float"><rect x="72" y="30" width="72" height="22" rx="11" className="c2" /><text x="108" y="44.5" textAnchor="middle" className="txt">{t('illustrations.notFound')}</text></g>
    </>
  );
}
