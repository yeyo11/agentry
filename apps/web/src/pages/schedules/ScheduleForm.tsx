import type { CreateScheduleRequest, OrchestrationTaskSpec, PermissionMode, Schedule, ScheduleTarget } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Combobox, NumberInput, Select, Switch } from '../../components/controls';
import { Dialog } from '../../components/Dialog';
import { ICON_SM } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { ErrorBox, Field, MODEL_OPTIONS, PERMISSION_MODES, Segmented } from '../../components/ui';
import { buildCron, CRON_MODES, parseCron, timeZones, type CronMode, type CronParts } from '../../lib/cron-builder';
import { formatDateTime } from '../../lib/format';

interface TaskDraft {
  id: string;
  name: string;
  prompt: string;
}

/** Each field a person edits; whatever the form does not show is carried over from `schedule` untouched. */
function initialTasks(schedule: Schedule | undefined): TaskDraft[] {
  if (schedule?.target.kind !== 'orchestration') return [{ id: 't1', name: '', prompt: '' }];
  return schedule.target.spec.tasks.map((task) => ({ id: task.id, name: task.name, prompt: task.prompt }));
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** Create or edit a schedule: what to start, and when, with the timetable said back in words before it is saved. */
export function ScheduleForm({ schedule, defaultCwd, onClose }: { schedule?: Schedule; defaultCwd?: string; onClose: () => void }) {
  const { t } = useTranslation(['schedules', 'common']);
  const toast = useToast();
  const queryClient = useQueryClient();
  const target = schedule?.target;
  const chat = target?.kind === 'chat' ? target.chat : undefined;
  const orchestration = target?.kind === 'orchestration' ? target.spec : undefined;

  const [name, setName] = useState(schedule?.name ?? '');
  const [kind, setKind] = useState<ScheduleTarget['kind']>(target?.kind ?? 'chat');
  const [parts, setParts] = useState<CronParts>(() => (schedule ? parseCron(schedule.cron) : parseCron('0 9 * * *')));
  const [timezone, setTimezone] = useState(schedule?.timezone ?? '');
  const [prompt, setPrompt] = useState(chat?.prompt ?? '');
  const [cwd, setCwd] = useState(chat?.cwd ?? orchestration?.cwd ?? defaultCwd ?? '');
  const [model, setModel] = useState(chat?.model ?? orchestration?.model ?? '');
  // Nobody is at the keyboard when it fires, so the default is a mode that does not stop to ask
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(chat?.permissionMode ?? orchestration?.permissionMode ?? 'acceptEdits');
  const [objective, setObjective] = useState(orchestration?.objective ?? '');
  const [worktree, setWorktree] = useState(orchestration?.worktree ?? true);
  const [tasks, setTasks] = useState<TaskDraft[]>(() => initialTasks(schedule));

  const cron = buildCron(parts);
  const zone = timezone.trim() || undefined;
  const debouncedCron = useDebounced(cron, 300);
  const preview = useQuery({
    queryKey: keys.schedulePreview(debouncedCron, zone),
    queryFn: () => api.schedulePreview(debouncedCron, zone, 5),
    enabled: debouncedCron !== '',
    placeholderData: (previous) => previous,
  });
  const zones = useMemo(() => timeZones().map((value) => ({ value })), []);

  const set = (patch: Partial<CronParts>) => setParts((current) => ({ ...current, ...patch }));
  const setMode = (mode: CronMode) => setParts((current) => (mode === 'custom' ? { ...current, mode, text: buildCron(current) } : { ...current, mode }));
  const setTask = (index: number, patch: Partial<TaskDraft>) => setTasks((current) => current.map((task, i) => (i === index ? { ...task, ...patch } : task)));

  const buildTarget = (): ScheduleTarget => {
    if (kind === 'chat') {
      return {
        kind: 'chat',
        // Spread first: fields set elsewhere (an account pin, a tool preset) survive an edit
        chat: { ...chat, prompt: prompt.trim(), cwd: cwd.trim() || undefined, model: model.trim() || undefined, permissionMode, permissionPrompts: chat?.permissionPrompts ?? 'none' },
      };
    }
    const previous = new Map((orchestration?.tasks ?? []).map((task) => [task.id, task]));
    const specTasks: OrchestrationTaskSpec[] = tasks.map((task) => ({ ...previous.get(task.id), id: task.id, name: task.name.trim(), prompt: task.prompt.trim() }));
    return {
      kind: 'orchestration',
      spec: {
        ...orchestration,
        name: name.trim(),
        objective: objective.trim() || undefined,
        cwd: cwd.trim() || undefined,
        model: model.trim() || undefined,
        permissionMode,
        permissionPrompts: orchestration?.permissionPrompts ?? 'none',
        worktree,
        tasks: specTasks,
      },
    };
  };

  const save = useMutation({
    mutationFn: () => {
      const body: CreateScheduleRequest = { name: name.trim(), cron, target: buildTarget() };
      // `null` on an edit goes back to the server's zone
      return schedule ? api.updateSchedule(schedule.id, { ...body, timezone: zone ?? null }) : api.createSchedule({ ...body, timezone: zone });
    },
    onSuccess: () => {
      toast.success(schedule ? t('form.saved') : t('form.created'));
      void queryClient.invalidateQueries({ queryKey: keys.schedules });
      onClose();
    },
  });

  const valid = preview.data?.valid !== false && cron !== '';
  const targetReady =
    kind === 'chat' ? prompt.trim() !== '' : tasks.length > 0 && tasks.every((task) => task.name.trim() !== '' && task.prompt.trim() !== '');
  const ready = name.trim() !== '' && valid && targetReady;

  return (
    <Dialog
      title={schedule ? t('form.editTitle') : t('form.newTitle')}
      onClose={onClose}
      width={680}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
          <button type="submit" form="schedule-form" className="btn btn-primary" disabled={!ready || save.isPending}>
            {save.isPending ? t('form.saving') : schedule ? t('form.save') : t('form.create')}
          </button>
        </>
      }
    >
      <form
        id="schedule-form"
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) save.mutate();
        }}
      >
        <Field label={t('form.name')}>
          <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('form.namePlaceholder')} />
        </Field>

        <fieldset className="fieldset">
          <legend className="field-label">{t('form.when')}</legend>
          <div className="form-grid">
            <Field label={t('form.repeat')}>
              <Select<CronMode>
                aria-label={t('form.repeat')}
                value={parts.mode}
                onChange={setMode}
                options={CRON_MODES.map((mode) => ({ value: mode, label: t(`form.modes.${mode}`) }))}
              />
            </Field>
            {parts.mode === 'minutes' && (
              <Field label={t('form.everyMinutes')}>
                <NumberInput aria-label={t('form.everyMinutes')} value={parts.every} onChange={(v) => set({ every: v ?? 1 })} min={1} max={59} />
              </Field>
            )}
            {parts.mode === 'weekly' && (
              <Field label={t('form.weekday')}>
                <Select
                  aria-label={t('form.weekday')}
                  value={String(parts.weekday)}
                  onChange={(v) => set({ weekday: Number(v) })}
                  options={WEEKDAYS.map((day) => ({ value: String(day), label: t(`form.weekdays.${day}`) }))}
                />
              </Field>
            )}
            {parts.mode === 'monthly' && (
              <Field label={t('form.dayOfMonth')} hint={t('form.dayOfMonthHint')}>
                <NumberInput aria-label={t('form.dayOfMonth')} value={parts.day} onChange={(v) => set({ day: v ?? 1 })} min={1} max={31} />
              </Field>
            )}
          </div>
          {(parts.mode === 'daily' || parts.mode === 'weekdays' || parts.mode === 'weekly' || parts.mode === 'monthly') && (
            <div className="form-grid">
              <Field label={t('form.hour')}>
                <NumberInput aria-label={t('form.hour')} value={parts.hour} onChange={(v) => set({ hour: v ?? 0 })} min={0} max={23} />
              </Field>
              <Field label={t('form.minute')}>
                <NumberInput aria-label={t('form.minute')} value={parts.minute} onChange={(v) => set({ minute: v ?? 0 })} min={0} max={59} />
              </Field>
            </div>
          )}
          {parts.mode === 'hourly' && (
            <Field label={t('form.minutePastHour')}>
              <NumberInput aria-label={t('form.minutePastHour')} value={parts.minute} onChange={(v) => set({ minute: v ?? 0 })} min={0} max={59} />
            </Field>
          )}
          <Field label={t('form.cron')} hint={parts.mode === 'custom' ? t('form.cronHint') : t('form.cronBuilt')}>
            <input
              className="mono"
              value={parts.mode === 'custom' ? parts.text : cron}
              readOnly={parts.mode !== 'custom'}
              onChange={(e) => set({ text: e.target.value })}
              spellCheck={false}
              placeholder="0 9 * * 1-5"
            />
          </Field>
          <Field label={t('form.timezone')} hint={t('form.timezoneHint')}>
            <Combobox aria-label={t('form.timezone')} value={timezone} onChange={setTimezone} options={zones} placeholder={t('form.serverZone')} />
          </Field>

          {/* The whole point of the builder: say what the timetable will do before it is saved */}
          <div className={`cron-preview ${preview.data?.valid === false ? 'is-invalid' : ''}`} role="status" aria-live="polite" data-testid="cron-preview">
            <CalendarClock {...ICON_SM} aria-hidden />
            <div>
              {preview.data?.valid === false ? (
                <strong>{preview.data.error ?? t('form.invalidCron')}</strong>
              ) : preview.data ? (
                <>
                  <strong>{preview.data.description}</strong>
                  <div className="muted small">{t('form.zoneNote', { zone: preview.data.timezone })}</div>
                  {preview.data.next.length > 0 && (
                    <ul className="cron-next small">
                      {preview.data.next.map((at) => (
                        <li key={at}>{formatDateTime(at)}</li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <span className="muted">{t('form.previewLoading')}</span>
              )}
            </div>
          </div>
          <p className="muted small">{t('form.missedNote')}</p>
        </fieldset>

        <fieldset className="fieldset">
          <legend className="field-label">{t('form.what')}</legend>
          <Segmented<ScheduleTarget['kind']>
            label={t('form.what')}
            value={kind}
            onChange={setKind}
            options={[
              { value: 'chat', label: t('form.kinds.chat') },
              { value: 'orchestration', label: t('form.kinds.orchestration') },
            ]}
          />
          {kind === 'chat' ? (
            <Field label={t('form.prompt')}>
              <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('form.promptPlaceholder')} />
            </Field>
          ) : (
            <>
              <Field label={t('form.objective')} hint={t('form.optional')}>
                <textarea rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} />
              </Field>
              <div className="stack">
                <span className="field-label">{t('form.tasks')}</span>
                {tasks.map((task, index) => (
                  <div key={task.id} className="task-draft">
                    <div className="task-draft-head">
                      <input aria-label={t('form.taskName', { n: index + 1 })} value={task.name} onChange={(e) => setTask(index, { name: e.target.value })} placeholder={t('form.taskNamePlaceholder')} />
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={t('form.removeTask', { n: index + 1 })}
                        disabled={tasks.length === 1}
                        onClick={() => setTasks((current) => current.filter((_, i) => i !== index))}
                      >
                        <Trash2 {...ICON_SM} />
                      </button>
                    </div>
                    <textarea aria-label={t('form.taskPrompt', { n: index + 1 })} rows={3} value={task.prompt} onChange={(e) => setTask(index, { prompt: e.target.value })} placeholder={t('form.taskPromptPlaceholder')} />
                  </div>
                ))}
                <div>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => setTasks((current) => [...current, { id: nextTaskId(current), name: '', prompt: '' }])}
                  >
                    <Plus {...ICON_SM} /> {t('form.addTask')}
                  </button>
                </div>
                <span className="field-hint">{t('form.tasksHint')}</span>
              </div>
              <Switch checked={worktree} onChange={setWorktree}>
                {t('form.worktree')}
              </Switch>
            </>
          )}
          <div className="form-grid">
            <Field label={t('form.cwd')}>
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" spellCheck={false} />
            </Field>
            <Field label={t('form.model')}>
              <Combobox aria-label={t('form.model')} value={model} onChange={setModel} options={MODEL_OPTIONS} placeholder={t('form.modelPlaceholder')} />
            </Field>
            <Field label={t('form.permissionMode')} hint={t('form.permissionModeHint')}>
              <Select<PermissionMode>
                aria-label={t('form.permissionMode')}
                value={permissionMode}
                onChange={setPermissionMode}
                options={PERMISSION_MODES.map((mode) => ({ value: mode, label: mode }))}
              />
            </Field>
          </div>
          {permissionMode === 'manual' && (
            <p className="muted small" role="note">
              {t('form.manualWarning')}
            </p>
          )}
        </fieldset>
        <ErrorBox error={save.error} title={t('form.saveFailed')} />
      </form>
    </Dialog>
  );
}

function nextTaskId(tasks: readonly TaskDraft[]): string {
  const taken = new Set(tasks.map((task) => task.id));
  let n = tasks.length + 1;
  while (taken.has(`t${n}`)) n += 1;
  return `t${n}`;
}
