import type { Orchestration, OrchestrationTaskSpec } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Rocket } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, keys } from '../api';
import { cleanTask, specOfTask } from '../lib/orchestration-v2';
import { Combobox, NumberInput } from './controls';
import { ICON_SM } from './icons';
import { removeTaskAt, renameTask, TaskEditor, validateGraph } from './TaskEditor';
import { Card, ErrorBox, Field, MODEL_OPTIONS } from './ui';

/**
 * Corrects a finished graph and runs it again as a new orchestration. The original stays as it was:
 * its chats, branches and result are what the corrections are measured against.
 */
export function RelaunchPanel({ orch, onCancel }: { orch: Orchestration; onCancel: () => void }) {
  const { t } = useTranslation(['orchestrationV2', 'orchestration', 'config', 'common']);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState(orch.name);
  const [objective, setObjective] = useState(orch.objective ?? '');
  const [model, setModel] = useState(orch.model ?? '');
  const [concurrency, setConcurrency] = useState(orch.concurrency);
  const [maxAttempts, setMaxAttempts] = useState(orch.maxAttempts);
  const [tasks, setTasks] = useState<OrchestrationTaskSpec[]>(() => orch.tasks.map(specOfTask));
  const [problem, setProblem] = useState<string | null>(null);
  const graph = (orch.engine ?? 'graph') === 'graph';

  const relaunch = useMutation({
    mutationFn: () =>
      api.relaunchOrchestration(orch.id, {
        // Only what a form can leave empty is left out; the rest overrides the original's value
        spec: {
          name: name.trim(),
          ...(objective.trim() ? { objective: objective.trim() } : {}),
          ...(model.trim() ? { model: model.trim() } : {}),
          concurrency,
          ...(graph ? { maxAttempts } : {}),
        },
        tasks: tasks.map(cleanTask),
      }),
    onSuccess: (next) => {
      void queryClient.invalidateQueries({ queryKey: keys.orchestrations });
      navigate(`/orchestration/${next.id}`);
    },
  });

  const submit = () => {
    const invalid = validateGraph(name, tasks);
    setProblem(invalid);
    if (!invalid) relaunch.mutate();
  };

  return (
    <Card title={t('relaunch.title')}>
      <div className="form">
        <p className="muted small">{t('relaunch.intro')}</p>
        <div className="form-grid form-grid-3">
          <Field label={t('orchestration:taskEditor.name')}>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('orchestration:taskEditor.model')}>
            <Combobox aria-label={t('orchestration:taskEditor.model')} placeholder={t('orchestration:defaultPlaceholder')} value={model} onChange={setModel} options={MODEL_OPTIONS} />
          </Field>
          <Field label={t('config:orchestration.concurrency')} hint={t('config:orchestration.concurrencyHint')}>
            <NumberInput min={1} max={8} value={concurrency} onChange={(v) => setConcurrency(v || 1)} />
          </Field>
          {graph && (
            <Field label={t('orchestration:attemptsPerTask')} hint={t('orchestration:attemptsHint')}>
              <NumberInput min={1} max={10} value={maxAttempts} onChange={(v) => setMaxAttempts(v || 1)} />
            </Field>
          )}
        </div>
        <Field label={t('config:orchestration.objective')}>
          <textarea rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} />
        </Field>

        <div className="card-head">
          <h3>{t('config:orchestration.tasks', { count: tasks.length })}</h3>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setTasks((prev) => [...prev, { id: `task-${prev.length + 1}`, name: '', prompt: '', dependsOn: [] }])}
          >
            <Plus {...ICON_SM} /> {t('config:orchestration.addTask')}
          </button>
        </div>
        <div className="stack">
          {tasks.map((task, i) => (
            <TaskEditor
              key={i}
              task={task}
              others={tasks.filter((_, j) => j !== i).map((other) => other.id).filter(Boolean)}
              onChange={(patch) => setTasks((prev) => renameTask(prev, i, patch))}
              onRemove={() => setTasks((prev) => removeTaskAt(prev, i))}
            />
          ))}
        </div>
        {problem && (
          <div className="alert alert-warn" role="alert">
            {problem}
          </div>
        )}
        <ErrorBox error={relaunch.error} title={t('relaunch.failed')} />
        <div className="form-actions">
          <button type="button" className="btn btn-primary" disabled={relaunch.isPending} onClick={submit}>
            <Rocket {...ICON_SM} /> {relaunch.isPending ? t('relaunch.launching') : t('relaunch.launch', { count: tasks.length })}
          </button>
          <button type="button" className="btn" disabled={relaunch.isPending} onClick={onCancel}>
            {t('common:actions.cancel')}
          </button>
        </div>
      </div>
    </Card>
  );
}
