import type { SupervisorConfig } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Combobox, NumberInput, Switch } from '../../components/controls';
import { ICON_SM } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Card, ErrorBox, Field, MODEL_OPTIONS, Skeleton } from '../../components/ui';
import { useDirty } from '../../lib/dirty';

/** The server refuses a ceiling outside (0, 5]: a supervisor reads a few lines and writes two. */
const MAX_COST = 5;

/**
 * The optional supervisor: a small model that reads a worker's last steps when its health turns
 * bad and proposes a hint. Off by default; each answer is a housekeeping chat of the CLI, paid for.
 */
export function SupervisorTab() {
  const { t } = useTranslation('observe');
  const { data, error, isLoading } = useQuery({ queryKey: keys.supervisor, queryFn: api.supervisorConfig });
  return (
    <Card title={t('supervisor.settingsTitle')}>
      <ErrorBox error={error} />
      {isLoading ? <Skeleton rows={4} /> : data && <SupervisorForm saved={data} />}
    </Card>
  );
}

function SupervisorForm({ saved }: { saved: SupervisorConfig }) {
  const { t } = useTranslation('observe');
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(saved);
  const [touched, setTouched] = useState(false);
  useDirty('supervisor', touched);

  const patch = (next: Partial<SupervisorConfig>) => {
    setForm((current) => ({ ...current, ...next }));
    setTouched(true);
  };
  const model = form.model.trim();
  const costValid = Number.isFinite(form.maxCostUsd) && form.maxCostUsd > 0 && form.maxCostUsd <= MAX_COST;
  const valid = model !== '' && costValid;

  const save = useMutation({
    mutationFn: () => api.putSupervisorConfig({ ...form, model }),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.supervisor, next);
      setForm(next);
      setTouched(false);
      toast.success(t('supervisor.saved'));
    },
  });

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <p className="small muted">{t('supervisor.intro')}</p>
      <Switch checked={form.enabled} onChange={(enabled) => patch({ enabled })}>
        {t('supervisor.enabled')}
      </Switch>
      <div className="form-grid">
        <Field label={t('supervisor.model')} hint={t('supervisor.modelHint')}>
          <Combobox aria-label={t('supervisor.model')} value={form.model} onChange={(value) => patch({ model: value })} options={MODEL_OPTIONS} />
        </Field>
        <Field label={t('supervisor.maxCost')} hint={t('supervisor.maxCostHint')}>
          <NumberInput
            aria-label={t('supervisor.maxCost')}
            min={0.01}
            max={MAX_COST}
            step={0.01}
            value={form.maxCostUsd}
            onChange={(maxCostUsd) => patch({ maxCostUsd: maxCostUsd ?? 0 })}
          />
        </Field>
      </div>
      {!costValid && (
        <p className="alert alert-warn small" role="status">
          {t('supervisor.costInvalid', { max: MAX_COST })}
        </p>
      )}
      <Switch checked={form.autoSend} onChange={(autoSend) => patch({ autoSend })}>
        {t('supervisor.autoSend')}
      </Switch>
      <p className="small muted">{t('supervisor.autoSendHint')}</p>
      <ErrorBox error={save.error} />
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={!valid || !touched || save.isPending}>
          <Save {...ICON_SM} /> {save.isPending ? t('supervisor.saving') : t('supervisor.save')}
        </button>
      </div>
    </form>
  );
}
