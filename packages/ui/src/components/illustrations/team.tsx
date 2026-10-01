// Ported from docs/design-system/illustrations/team.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
// The slots name the template's roles by the acronyms a team uses in either language.
import { useTranslation } from 'react-i18next';

/**
 * The flow's three roles in their order, the Product Owner arriving first, each over the stage it
 * does. No "+" disc: nothing here is a button (decision 9).
 */
export function Team() {
  const { t } = useTranslation('primitives');
  return (
    <>
      <path d="M84 72 h10 M90 68 l4 4 l-4 4" className="ln-soft" />
      <path d="M148 72 h10 M154 68 l4 4 l-4 4" className="ln-soft" />
      <rect x="98" y="50" width="44" height="44" rx="12" className="ln-soft dash-lg" />
      <rect x="162" y="50" width="44" height="44" rx="12" className="ln-soft dash-lg" />
      <text x="120" y="75" textAnchor="middle" className="txt">DEV</text>
      <text x="184" y="75" textAnchor="middle" className="txt">QA</text>
      <text x="56" y="114" textAnchor="middle" className="txt">{t('illustration.refine')}</text>
      <text x="120" y="114" textAnchor="middle" className="txt">{t('illustration.work')}</text>
      <text x="184" y="114" textAnchor="middle" className="txt">{t('illustration.verify')}</text>
      <g className="a-float">
        <rect x="34" y="50" width="44" height="44" rx="12" className="cg" />
        <text x="56" y="78" textAnchor="middle" className="glyph">PO</text>
      </g>
    </>
  );
}
