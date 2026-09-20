import type { OrchestrationTaskSpec } from '@agentry/shared';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { limitsOf } from '../lib/orchestration-v2';
import { Combobox, NumberInput } from './controls';
import { Field, MODEL_OPTIONS } from './ui';

/**
 * One task of a graph, editable: the launch form, the relaunch panel and a template all edit the
 * same shape. `others` are the ids it may depend on.
 */
export function TaskEditor({
  task,
  others,
  onChange,
  onRemove,
}: {
  task: OrchestrationTaskSpec;
  others: string[];
  onChange: (patch: Partial<OrchestrationTaskSpec>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation(['orchestration', 'orchestrationV2', 'config']);
  const deps = task.dependsOn ?? [];
  return (
    <div className="task-editor" role="group" aria-label={t('taskEditor.group', { id: task.id || t('taskEditor.noId') })}>
      <div className="form-grid form-grid-3">
        <Field label={t('taskEditor.id')}>
          <input value={task.id} onChange={(e) => onChange({ id: e.target.value.replace(/\s+/g, '-') })} />
        </Field>
        <Field label={t('taskEditor.name')}>
          <input value={task.name} placeholder={t('config:orchestration.shortLabel')} onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        <Field label={t('config:orchestration.modelOptional')}>
          <Combobox
            aria-label={t('taskEditor.model')}
            value={task.model ?? ''}
            placeholder={t('config:orchestration.inherit')}
            onChange={(model) => onChange({ model: model || undefined })}
            options={MODEL_OPTIONS}
          />
        </Field>
      </div>
      <Field label={t('config:orchestration.prompt')}>
        <textarea rows={3} value={task.prompt} onChange={(e) => onChange({ prompt: e.target.value })} />
      </Field>
      <div className="form-grid">
        <Field label={t('orchestrationV2:limits.maxMinutes')} hint={t('orchestrationV2:limits.taskHint')}>
          <NumberInput
            aria-label={t('orchestrationV2:limits.maxMinutesOf', { id: task.id || t('taskEditor.noId') })}
            min={1}
            max={1440}
            step={5}
            placeholder={t('orchestrationV2:limits.default')}
            value={task.limits?.maxMinutes}
            onChange={(maxMinutes) => onChange({ limits: limitsOf(maxMinutes, task.limits?.maxCostUsd) })}
          />
        </Field>
        <Field label={t('orchestrationV2:limits.maxCost')}>
          <NumberInput
            aria-label={t('orchestrationV2:limits.maxCostOf', { id: task.id || t('taskEditor.noId') })}
            min={0.5}
            max={1000}
            step={0.5}
            placeholder={t('orchestrationV2:limits.default')}
            value={task.limits?.maxCostUsd}
            onChange={(maxCostUsd) => onChange({ limits: limitsOf(task.limits?.maxMinutes, maxCostUsd) })}
          />
        </Field>
      </div>
      <div className="task-editor-foot">
        <div className="chips" role="group" aria-label={t('config:orchestration.dependsOn')}>
          <span className="field-label" aria-hidden>
            {t('config:orchestration.dependsOn')}
          </span>
          {others.length === 0 && <span className="muted small">{t('config:orchestration.noOtherTasks')}</span>}
          {others.map((id) => (
            <button
              key={id}
              type="button"
              className={`chip ${deps.includes(id) ? 'chip-on' : ''}`}
              aria-pressed={deps.includes(id)}
              onClick={() => onChange({ dependsOn: deps.includes(id) ? deps.filter((d) => d !== id) : [...deps, id] })}
            >
              {deps.includes(id) && <Check size={12} strokeWidth={2.2} aria-hidden />}
              {id}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>
          {t('config:orchestration.removeTask')}
        </button>
      </div>
    </div>
  );
}

/** Keeps every dependency reference in step when a task is renamed or removed. */
export function renameTask(tasks: OrchestrationTaskSpec[], index: number, patch: Partial<OrchestrationTaskSpec>): OrchestrationTaskSpec[] {
  const current = tasks[index];
  if (!current) return tasks;
  const next = tasks.map((t, i) => (i === index ? { ...t, ...patch } : t));
  if (patch.id === undefined || patch.id === current.id) return next;
  const renamed = patch.id;
  return next.map((t) => ({ ...t, dependsOn: (t.dependsOn ?? []).map((d) => (d === current.id ? renamed : d)) }));
}

export function removeTaskAt(tasks: OrchestrationTaskSpec[], index: number): OrchestrationTaskSpec[] {
  const removed = tasks[index]?.id;
  return tasks.filter((_, i) => i !== index).map((t) => ({ ...t, dependsOn: (t.dependsOn ?? []).filter((d) => d !== removed) }));
}

/** The reason a graph cannot be launched, in the language of the moment it is raised; null when it can. */
export function validateGraph(name: string, tasks: OrchestrationTaskSpec[]): string | null {
  const t = i18n.t.bind(i18n);
  if (!name.trim()) return t('config:orchestration.errors.name');
  if (tasks.length === 0) return t('config:orchestration.errors.noTasks');
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.id.trim()) return t('config:orchestration.errors.noId');
    if (ids.has(task.id)) return t('config:orchestration.errors.duplicate', { id: task.id });
    ids.add(task.id);
    if (!task.prompt.trim()) return t('config:orchestration.errors.noPrompt', { id: task.id });
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!ids.has(dep)) return t('config:orchestration.errors.unknownDep', { id: task.id, dep });
    }
  }
  return null;
}
