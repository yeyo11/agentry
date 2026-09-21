import type { TaskLimits } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { limitsOf, type InstallMode, type VerificationDraft } from '../lib/orchestration-v2';
import { Combobox, NumberInput, Select, Switch } from './controls';
import { Field, MODEL_OPTIONS } from './ui';

const INSTALL_MODES: readonly InstallMode[] = ['detected', 'command', 'none'];

/** What every task may spend unless it says otherwise. A task's own limits win. */
export function DefaultLimits({ value, onChange }: { value: TaskLimits | undefined; onChange: (limits: TaskLimits | undefined) => void }) {
  const { t } = useTranslation('orchestrationV2');
  return (
    <div className="stack-tight">
      <div className="strong small">{t('limits.graphTitle')}</div>
      <div className="form-grid">
        <Field label={t('limits.maxMinutes')}>
          <NumberInput
            aria-label={t('limits.graphMinutes')}
            min={1}
            max={1440}
            step={5}
            placeholder={t('limits.none')}
            value={value?.maxMinutes}
            onChange={(maxMinutes) => onChange(limitsOf(maxMinutes, value?.maxCostUsd))}
          />
        </Field>
        <Field label={t('limits.maxCost')}>
          <NumberInput
            aria-label={t('limits.graphCost')}
            min={0.5}
            max={1000}
            step={0.5}
            placeholder={t('limits.none')}
            value={value?.maxCostUsd}
            onChange={(maxCostUsd) => onChange(limitsOf(value?.maxMinutes, maxCostUsd))}
          />
        </Field>
      </div>
      <p className="muted small">{t('limits.graphHint')}</p>
    </div>
  );
}

/**
 * The checks that run once, on the integration branch, after the graph is merged. Workers run
 * typecheck and unit tests; this is where the slow suite goes, so it is not run in every worktree.
 */
export function VerificationFields({ value, onChange }: { value: VerificationDraft; onChange: (next: VerificationDraft) => void }) {
  const { t } = useTranslation('orchestrationV2');
  return (
    <div className="stack-tight">
      <Switch checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })}>
        {t('verification.enable')}
      </Switch>
      <p className="muted small">{t('verification.enableHint')}</p>
      {value.enabled && (
        <>
          <Field label={t('verification.commands')} hint={t('verification.commandsHint')}>
            <textarea
              rows={3}
              className="mono"
              value={value.commands}
              placeholder={t('verification.commandsPlaceholder')}
              onChange={(e) => onChange({ ...value, commands: e.target.value })}
            />
          </Field>
          <div className="form-grid">
            <Field label={t('verification.install')} hint={t(`verification.installHint.${value.install}`)}>
              <Select<InstallMode>
                aria-label={t('verification.install')}
                value={value.install}
                onChange={(install) => onChange({ ...value, install })}
                options={INSTALL_MODES.map((mode) => ({ value: mode, label: t(`verification.installMode.${mode}`) }))}
              />
            </Field>
            {value.install === 'command' && (
              <Field label={t('verification.installCommand')}>
                <input
                  className="mono"
                  value={value.installCommand}
                  placeholder={t('verification.installPlaceholder')}
                  onChange={(e) => onChange({ ...value, installCommand: e.target.value })}
                />
              </Field>
            )}
          </div>
          <Switch checked={value.fixer} onChange={(fixer) => onChange({ ...value, fixer })}>
            {t('verification.fixer')}
          </Switch>
          {value.fixer && (
            <div className="form-grid">
              <Field label={t('verification.attempts')} hint={t('verification.attemptsHint')}>
                <NumberInput min={1} max={5} value={value.maxAttempts} onChange={(v) => onChange({ ...value, maxAttempts: v || 1 })} />
              </Field>
              <Field label={t('verification.model')}>
                <Combobox
                  aria-label={t('verification.model')}
                  placeholder={t('verification.modelDefault')}
                  value={value.model}
                  onChange={(model) => onChange({ ...value, model })}
                  options={MODEL_OPTIONS}
                />
              </Field>
              <Field label={t('verification.maxCost')} hint={t('verification.maxCostHint')}>
                <NumberInput
                  aria-label={t('verification.maxCost')}
                  min={0.1}
                  max={1000}
                  step={0.5}
                  placeholder={t('limits.none')}
                  value={value.maxCostUsd}
                  onChange={(maxCostUsd) => onChange({ ...value, maxCostUsd })}
                />
              </Field>
            </div>
          )}
          <Switch checked={value.failGraph} onChange={(failGraph) => onChange({ ...value, failGraph })}>
            {t('verification.failGraph')}
          </Switch>
          <p className="muted small">{t('verification.failGraphHint')}</p>
        </>
      )}
    </div>
  );
}
