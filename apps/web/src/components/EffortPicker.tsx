import type { TFunction } from 'i18next';
import { COSTLY_EFFORTS, EFFORT_LEVELS, effortRecommendation, type Effort, type EffortUse } from '@agentry/shared';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '@agentry/ui/components/ui';
import { Select, type SelectOption } from '@agentry/ui/components/controls/Select';
import { Tooltip } from '@agentry/ui/components/controls/Tooltip';

/** Why the picker cannot be used: the provider has no effort, or the engine takes the orchestration's alone. */
export type EffortUnavailable = 'provider' | 'workflow';

/**
 * What the picker says for an unset effort, and in its tooltip: the level recommended for the model
 * and the use (with why), or the one a resume starts with, or that the CLI decides.
 */
export function effortWords(
  t: TFunction<'components'>,
  model: string | null | undefined,
  use: EffortUse,
  { inherited, unavailable, set }: { inherited?: string | null; unavailable?: EffortUnavailable; set: boolean },
): { unset: string; tip: string } {
  const recommendation = effortRecommendation(model, use);
  const unset = inherited ? t('effort.asBefore', { level: inherited }) : recommendation ? t('effort.recommended', { level: recommendation.effort }) : t('effort.cliDefault');
  if (unavailable) return { unset, tip: t(unavailable === 'provider' ? 'effort.unavailableProvider' : 'effort.unavailableWorkflow') };
  return { unset, tip: !set && recommendation && !inherited ? t(`effort.reason.${recommendation.reason}`) : '' };
}

/**
 * How hard a model thinks (`--effort`), chosen wherever a model is. Unset is "<level> · recommended"
 * for the model and the use, with the reason in a tooltip; where nothing is recommended it is the
 * CLI's own default. `xhigh` and `max` are offered, marked as costly. A provider without effort, or
 * the workflow engine, gets the control disabled with the reason in a tooltip, and nothing to send.
 */
export function EffortPicker({
  value,
  onChange,
  model,
  use,
  unavailable,
  allowUnset = true,
  inherited,
  className = '',
  'aria-label': ariaLabel,
}: {
  value: Effort | '';
  onChange: (value: Effort | '') => void;
  /** The model it goes with: the recommendation is calibrated per model */
  model: string | null | undefined;
  use: EffortUse;
  unavailable?: EffortUnavailable;
  /** False where the setting always holds a level (the Decisions tab): there is no "recommended" row */
  allowUnset?: boolean;
  /** On a resume or a fork, the effort the last execution ran with: left unset, that is what starts */
  inherited?: string | null;
  className?: string;
  'aria-label'?: string;
}) {
  const { t } = useTranslation('components');
  const { unset: unsetLabel, tip } = effortWords(t, model, use, { inherited, unavailable, set: value !== '' });
  const options: SelectOption<Effort | ''>[] = [
    ...(allowUnset ? [{ value: '' as const, label: <span className="effort-level">{unsetLabel}</span> }] : []),
    ...EFFORT_LEVELS.map((level): SelectOption<Effort | ''> => ({
      value: level,
      label: (
        <span className="effort-level">
          {level}
          {COSTLY_EFFORTS.includes(level) && <span className="effort-costly">{t('effort.costly')}</span>}
        </span>
      ),
      ...(COSTLY_EFFORTS.includes(level) ? { hint: t('effort.costlyHint') } : {}),
    })),
  ];
  return (
    <Tooltip content={tip}>
      <span className={`effort-pick ${className}`.trim()}>
        <Select<Effort | ''> aria-label={ariaLabel ?? t('effort.label')} value={value} onChange={onChange} options={options} disabled={Boolean(unavailable)} />
      </span>
    </Tooltip>
  );
}

/** The picker under its label, for the forms that lay fields out with `Field`. */
export function EffortField(props: ComponentProps<typeof EffortPicker>) {
  const { t } = useTranslation('components');
  return (
    <Field label={t('effort.label')}>
      <EffortPicker {...props} />
    </Field>
  );
}

/** The effort a run actually used (or, `recommended`, one proposed for a model), as a tag beside it; nothing when none was passed. */
export function EffortTag({ effort, recommended = false }: { effort: string | null | undefined; recommended?: boolean }) {
  const { t } = useTranslation('components');
  if (!effort) return null;
  return (
    <span className="model-tag effort-tag" title={recommended ? t('effort.recommendedTitle') : t('effort.used')}>
      {effort}
    </span>
  );
}
