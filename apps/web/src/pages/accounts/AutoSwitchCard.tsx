import type { AutoSwitchSettings } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { NumberInput, Slider, Switch } from '../../components/controls';
import { useToast } from '../../components/Toast';
import { Segmented, Tag } from '../../components/ui';

const STRATEGIES = ['best', 'consume-first'] as const;

/**
 * The supervised `cswap auto`: one card with every setting of it. Nothing applies until Save, the
 * switch in the head included, so a half-edited threshold never reaches a running supervisor.
 */
export function AutoSwitchCard({ settings, running }: { settings: AutoSwitchSettings; running: boolean }) {
  const { t } = useTranslation(['accountsConfig', 'config']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = useId();
  const [draft, setDraft] = useState(settings);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const mutation = useMutation({
    mutationFn: (next: Partial<AutoSwitchSettings>) => api.setAutoSwitch(next),
    onSuccess: (saved) => {
      setDraft(saved);
      toast.success(t('config:accounts.autoUpdated'));
      void queryClient.invalidateQueries({ queryKey: keys.accounts });
    },
    onError: (err) => toast.error(t('config:accounts.autoUpdateFailed'), err),
  });

  return (
    <section className="card rotation-card" aria-labelledby={`${id}-title`}>
      <form
        className="rotation-form"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(draft);
        }}
      >
        <div className="rotation-head">
          <span className="rotation-title">
            <h2 id={`${id}-title`}>{t('config:accounts.autoRotation')}</h2>
            <span className="muted small">{t('rotation.subtitle')}</span>
          </span>
          {running ? <Tag tone="ok">{t('config:accounts.supervisorRunning')}</Tag> : <Tag tone="muted">{t('config:accounts.stopped')}</Tag>}
          <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} tooltip={t('config:accounts.rotateBefore')}>
            {t('rotation.enable')}
          </Switch>
        </div>

        <div className="rotation-grid">
          <div className="rotation-field">
            <span className="section-label">{t('config:accounts.threshold')}</span>
            <Slider aria-label={t('config:accounts.threshold')} min={50} max={99} value={draft.threshold} onChange={(threshold) => setDraft({ ...draft, threshold })} />
            <span className="field-hint">{t('rotation.thresholdAt', { pct: draft.threshold })}</span>
          </div>
          <div className="rotation-field">
            <span className="section-label">{t('config:accounts.strategy')}</span>
            <Segmented<AutoSwitchSettings['strategy']>
              label={t('config:accounts.strategy')}
              value={draft.strategy}
              onChange={(strategy) => setDraft({ ...draft, strategy })}
              // The CLI's own value in the tooltip: it is what `cswap auto --strategy` takes
              options={STRATEGIES.map((s) => ({ value: s, label: t(`rotation.strategies.${s}`), title: s }))}
            />
          </div>
          {/* Not a <label>: the stepper's own buttons would take its name */}
          <div className="rotation-field">
            <span className="section-label">{t('config:accounts.interval')}</span>
            <NumberInput
              aria-label={t('config:accounts.interval')}
              min={15}
              max={3600}
              step={15}
              value={draft.intervalSec}
              placeholder={t('rotation.intervalPlaceholder')}
              onChange={(intervalSec) => setDraft({ ...draft, intervalSec: intervalSec ?? 0 })}
            />
          </div>
          <label className="rotation-field">
            <span className="section-label">{t('rotation.watchAlso')}</span>
            <input
              value={draft.models.join(',')}
              onChange={(e) => setDraft({ ...draft, models: e.target.value.split(',').map((m) => m.trim()).filter(Boolean) })}
              placeholder={t('rotation.modelsPlaceholder')}
              title={t('config:accounts.modelsHint')}
            />
          </label>
        </div>

        <div className="rotation-foot">
          <Switch checked={draft.rotateOnLimit} onChange={(rotateOnLimit) => setDraft({ ...draft, rotateOnLimit })}>
            {t('config:accounts.rotateOnLimit')}
          </Switch>
          <span className="rotation-actions">
            {dirty && (
              <button type="button" className="btn btn-small" onClick={() => setDraft(settings)}>
                {t('config:shared.reset')}
              </button>
            )}
            <button type="submit" className="btn btn-small btn-primary" disabled={!dirty || mutation.isPending}>
              {t('config:shared.save')}
            </button>
          </span>
        </div>
      </form>
    </section>
  );
}
