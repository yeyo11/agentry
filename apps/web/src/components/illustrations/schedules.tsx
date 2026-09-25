// Ported from docs/design-system/illustrations/schedules.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
import { useTranslation } from 'react-i18next';

export function Schedules() {
  const { t } = useTranslation('components');
  return (
    <>
      <circle cx="120" cy="80" r="58" className="ln-soft dash a-orbit" />
      <g className="a-orbit"><circle cx="120" cy="22" r="5" className="f-grad" /></g>
      <circle cx="120" cy="80" r="42" className="c1" />
      <path d="M120.0 49.0 L120.0 42.0 M137.0 50.6 L139.0 47.1 M149.4 63.0 L152.9 61.0 M151.0 80.0 L158.0 80.0 M149.4 97.0 L152.9 99.0 M137.0 109.4 L139.0 112.9 M120.0 111.0 L120.0 118.0 M103.0 109.4 L101.0 112.9 M90.6 97.0 L87.1 99.0 M89.0 80.0 L82.0 80.0 M90.6 63.0 L87.1 61.0 M103.0 50.6 L101.0 47.1" className="ln-soft" />
      <path d="M120 80 L98 80" className="ln-ink w3" /><path d="M120 80 L120 52" className="ln-grad w3" /><circle cx="120" cy="80" r="4" className="f-fg" />
      <g className="a-float"><rect x="16" y="26" width="54" height="22" rx="11" className="c2" /><text x="43" y="40.5" textAnchor="middle" className="txt">09:00</text></g>
      <g className="a-float-2"><rect x="174" y="112" width="50" height="22" rx="11" className="c2" /><text x="199" y="126.5" textAnchor="middle" className="txt">{t('illustrations.weekday')}</text></g>
    </>
  );
}
