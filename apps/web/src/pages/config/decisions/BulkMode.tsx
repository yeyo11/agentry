import type { DecisionMode } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { MoreActions } from '@agentry/ui/components/controls';

const MODES: readonly DecisionMode[] = ['off', 'shadow', 'active'];

/**
 * One menu that sets the mode of a whole set of points (all of them, or a group): a dropdown on a
 * desktop, a sheet of big buttons on a phone. Choosing a mode only proposes it: what cannot take
 * it keeps a lower one, and the page says how many.
 */
export function BulkMode({ scope, onApply, className = '' }: { scope: string; onApply: (mode: DecisionMode) => void; className?: string }) {
  const { t } = useTranslation('decisions');
  return (
    <MoreActions
      className={`dp-bulk-trigger ${className}`.trim()}
      text={t('bulk.trigger')}
      label={t('bulk.label', { scope })}
      title={t('bulk.label', { scope })}
      entries={MODES.map((mode) => ({ id: mode, label: t('bulk.setTo', { mode: t(`points.modes.${mode}`) }), onSelect: () => onApply(mode) }))}
    />
  );
}
