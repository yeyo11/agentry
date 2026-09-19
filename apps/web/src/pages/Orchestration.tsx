import { Plus } from 'lucide-react';
import type { OrchestrationEngine, OrchestrationSpec, OrchestrationTaskSpec, PermissionMode } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { api, keys, useOrchestrations, useProjects } from '../api';
import { Combobox, NumberInput, Select, Switch } from '../components/controls';
import { Card, Empty, ErrorBox, Field, Loading, MODEL_OPTIONS, PageHeader, PERMISSION_MODES, Segmented, StatusBadge, Tag } from '../components/ui';
import { useFallbackInterval } from '../lib/feed';
import { formatCost, timeAgo, truncate } from '../lib/format';

type Mode = 'auto' | 'manual';

const emptyTask = (index: number): OrchestrationTaskSpec => ({
  id: `task-${index}`,
  name: '',
  prompt: '',
  dependsOn: [],
});

function validate(t: TFunction<'config'>, name: string, tasks: OrchestrationTaskSpec[]): string | null {
  if (!name.trim()) return t('orchestration.errors.name');
  if (tasks.length === 0) return t('orchestration.errors.noTasks');
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.id.trim()) return t('orchestration.errors.noId');
    if (ids.has(task.id)) return t('orchestration.errors.duplicate', { id: task.id });
    ids.add(task.id);
    if (!task.prompt.trim()) return t('orchestration.errors.noPrompt', { id: task.id });
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!ids.has(dep)) return t('orchestration.errors.unknownDep', { id: task.id, dep });
    }
  }
  return null;
}

function TaskEditor({
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
  const { t } = useTranslation(['config', 'common']);
  const deps = task.dependsOn ?? [];
  return (
    <div className="task-editor">
      <div className="form-grid form-grid-3">
        <Field label={t('plugins.id')}>
          <input value={task.id} onChange={(e) => onChange({ id: e.target.value.replace(/\s+/g, '-') })} />
        </Field>
        <Field label={t('mcp.name')}>
          <input value={task.name} placeholder={t('orchestration.shortLabel')} onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        <Field label={t('orchestration.modelOptional')}>
          <Combobox
            aria-label={t('settingsGuided.model')}
            value={task.model ?? ''}
            placeholder={t('orchestration.inherit')}
            onChange={(model) => onChange({ model: model || undefined })}
            options={MODEL_OPTIONS}
          />
        </Field>
      </div>
      <Field label={t('orchestration.prompt')}>
        <textarea rows={3} value={task.prompt} onChange={(e) => onChange({ prompt: e.target.value })} />
      </Field>
      <div className="task-editor-foot">
        <div className="chips">
          <span className="field-label">{t('orchestration.dependsOn')}</span>
          {others.length === 0 && <span className="muted small">{t('orchestration.noOtherTasks')}</span>}
          {others.map((id) => (
            <button
              key={id}
              type="button"
              className={`chip ${deps.includes(id) ? 'chip-on' : ''}`}
              aria-pressed={deps.includes(id)}
              onClick={() => onChange({ dependsOn: deps.includes(id) ? deps.filter((d) => d !== id) : [...deps, id] })}
            >
              {id}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>
          {t('orchestration.removeTask')}
        </button>
      </div>
    </div>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(['config', 'common']);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useProjects(false);
  const [mode, setMode] = useState<Mode>('auto');
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [maxTasks, setMaxTasks] = useState(5);
  const [concurrency, setConcurrency] = useState(3);
  const [synthesize, setSynthesize] = useState(true);
  const [worktree, setWorktree] = useState(true);
  const [engine, setEngine] = useState<OrchestrationEngine>('graph');
  const [engineReason, setEngineReason] = useState<string | null>(null);
  const [allowedTools, setAllowedTools] = useState('Bash,Read,Write,Edit,Glob,Grep');
  const [askPermissions, setAskPermissions] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [tasks, setTasks] = useState<OrchestrationTaskSpec[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  // The planner is a run like any other: it is started, then watched. Holding an HTTP request
  // open for the couple of minutes it takes is what used to lose the plan on a dropped connection.
  const [plannerRunId, setPlannerRunId] = useState<string | null>(null);
  const [appliedRunId, setAppliedRunId] = useState<string | null>(null);

  const applyDraft = (draft: OrchestrationSpec) => {
    setTasks(draft.tasks.map((task) => ({ ...task, dependsOn: task.dependsOn ?? [] })));
    if (draft.name) setName(draft.name);
    if (draft.objective && !objective.trim()) setObjective(draft.objective);
    if (draft.cwd && !cwd.trim()) setCwd(draft.cwd);
    if (draft.concurrency) setConcurrency(draft.concurrency);
    if (draft.synthesize != null) setSynthesize(draft.synthesize);
    setEngine(draft.engine === 'workflow' ? 'workflow' : 'graph');
    setEngineReason(draft.engineReason ?? null);
  };

  const plan = useMutation({
    mutationFn: () =>
      api.startPlan({
        objective: objective.trim(),
        cwd: cwd.trim() || undefined,
        model: model.trim() || undefined,
        maxTasks,
      }),
    onSuccess: (run) => {
      setPlannerRunId(run.id);
      setAppliedRunId(null);
    },
  });

  const fallback = useFallbackInterval();
  const plannerRun = useQuery({
    queryKey: ['run', plannerRunId],
    queryFn: () => api.run(plannerRunId ?? ''),
    enabled: plannerRunId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status && ['completed', 'failed', 'stopped'].includes(status) ? false : fallback;
    },
  });
  const plannerStatus = plannerRun.data?.run.status;
  const planning = plannerRunId !== null && appliedRunId !== plannerRunId && plannerStatus !== 'failed' && plannerStatus !== 'stopped';

  const draft = useMutation({
    mutationFn: (runId: string) => api.planDraft(runId),
    onSuccess: (spec, runId) => {
      applyDraft(spec);
      setAppliedRunId(runId);
      void queryClient.invalidateQueries({ queryKey: keys.planDrafts });
    },
  });

  // The draft is recorded server-side when the planner finishes, so this only fetches it.
  useEffect(() => {
    if (plannerRunId && plannerStatus === 'completed' && appliedRunId !== plannerRunId && !draft.isPending) {
      draft.mutate(plannerRunId);
    }
  }, [plannerRunId, plannerStatus, appliedRunId, draft]);

  const drafts = useQuery({ queryKey: keys.planDrafts, queryFn: api.planDrafts });

  const create = useMutation({
    mutationFn: (spec: OrchestrationSpec) => api.createOrchestration(spec),
    onSuccess: (orch) => {
      void queryClient.invalidateQueries({ queryKey: keys.orchestrations });
      onDone();
      navigate(`/orchestration/${orch.id}`);
    },
  });

  const updateTask = (index: number, patch: Partial<OrchestrationTaskSpec>) => {
    setTasks((prev) => {
      const current = prev[index];
      if (!current) return prev;
      const next = prev.map((task, i) => (i === index ? { ...task, ...patch } : task));
      // Keep dependency references in sync when an id is renamed.
      if (patch.id !== undefined && patch.id !== current.id) {
        return next.map((task) => ({ ...task, dependsOn: (task.dependsOn ?? []).map((d) => (d === current.id ? patch.id! : d)) }));
      }
      return next;
    });
  };

  const removeTask = (index: number) => {
    setTasks((prev) => {
      const removed = prev[index]?.id;
      return prev
        .filter((_, i) => i !== index)
        .map((task) => ({ ...task, dependsOn: (task.dependsOn ?? []).filter((d) => d !== removed) }));
    });
  };

  const launch = () => {
    const problem = validate(t, name, tasks);
    setLocalError(problem);
    if (problem) return;
    create.mutate({
      name: name.trim(),
      objective: objective.trim() || undefined,
      cwd: cwd.trim() || undefined,
      model: model.trim() || undefined,
      permissionMode: permissionMode || undefined,
      concurrency,
      synthesize,
      engine,
      ...(engineReason ? { engineReason } : {}),
      // A workflow runs every task in the project directory
      worktree: engine === 'workflow' ? false : worktree,
      allowedTools: allowedTools
        .split(',')
        .map((tool) => tool.trim())
        .filter(Boolean),
      permissionPrompts: askPermissions ? ('host' as const) : ('none' as const),
      tasks: tasks.map((task) => ({
        ...task,
        id: task.id.trim(),
        name: task.name.trim() || task.id.trim(),
        prompt: task.prompt.trim(),
        dependsOn: task.dependsOn?.length ? task.dependsOn : undefined,
      })),
    });
  };

  return (
    <Card
      title={t('orchestration.new')}
      actions={
        <Segmented
          label={t('orchestration.creationMode')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'auto', label: t('orchestration.autoPlan') },
            { value: 'manual', label: t('orchestration.manual') },
          ]}
        />
      }
    >
      <div className="form">
        <Field
          label={t('orchestration.objective')}
          hint={mode === 'auto' ? t('orchestration.objectiveAutoHint') : t('orchestration.objectiveManualHint')}
        >
          <textarea rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} />
        </Field>
        <div className="form-grid form-grid-3">
          <Field label={t('orchestration.cwd')}>
            <Combobox
              aria-label={t('orchestration.cwd')}
              placeholder={t('orchestration.cwdPlaceholder')}
              value={cwd}
              onChange={setCwd}
              options={(projects.data ?? []).filter((p) => p.exists).map((p) => ({ value: p.path, label: p.name, hint: p.path }))}
            />
          </Field>
          <Field label={t('settingsGuided.model')}>
            <Combobox
              aria-label={t('settingsGuided.model')}
              placeholder={t('settingsGuided.defaultPlaceholder')}
              value={model} onChange={setModel} options={MODEL_OPTIONS} />
          </Field>
          {mode === 'auto' && (
            <Field label={t('orchestration.maxTasks')}>
              <NumberInput min={1} max={12} value={maxTasks} onChange={(v) => setMaxTasks(v || 1)} />
            </Field>
          )}
        </div>
        {mode === 'auto' && (
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!objective.trim() || plan.isPending || planning}
              onClick={() => plan.mutate()}
            >
              {planning ? t('orchestration.planning') : tasks.length ? t('orchestration.replan') : t('orchestration.generate')}
            </button>
            {planning && <span className="spinner" />}
            {plannerRunId && (
              <span className="muted small">
                {planning ? (
                  <>
                    {plannerRun.data?.run.turns ? t('orchestration.turns', { count: plannerRun.data.run.turns }) : ''}
                    {t('orchestration.plannerRunning')}{' '}
                  </>
                ) : plannerStatus === 'failed' || plannerStatus === 'stopped' ? (
                  <>{t(`orchestration.planner.${plannerStatus}`)} </>
                ) : (
                  <>{t('orchestration.planReady')} </>
                )}
                <Link to={`/runs/${plannerRunId}`}>{t('orchestration.watchAgent')}</Link>
                {draft.isPending && t('orchestration.loadingPlan')}
              </span>
            )}
          </div>
        )}
        {/* The plan is stored server-side, so leaving this page never loses it. */}
        {plannerRunId && !planning && plannerStatus !== 'completed' && (
          <p className="muted small">
            {t('orchestration.noPlan', {
              status:
                plannerStatus === 'failed' || plannerStatus === 'stopped'
                  ? t(`orchestration.plannerEnded.${plannerStatus}`)
                  : (plannerStatus ?? t('orchestration.plannerEnded.ended')),
            })}
          </p>
        )}
        <ErrorBox error={plan.error} title={t('orchestration.planStartFailed')} />
        <ErrorBox error={draft.error} title={t('orchestration.planLoadFailed')} />

        {mode === 'auto' && (drafts.data?.length ?? 0) > 0 && (
          <div className="stack-sm">
            <hr />
            <div className="muted small">{t('orchestration.drafts')}</div>
            <ul className="list">
              {(drafts.data ?? []).slice(0, 5).map((d) => (
                <li key={d.runId} className="list-row small">
                  <span className="strong ellipsis">{d.name}</span>
                  <span className="muted ellipsis">{d.objective ?? ''}</span>
                  <span className="muted nowrap">
                    {t('orchestration.taskCount', { count: d.taskCount })} · {timeAgo(d.createdAt)}
                  </span>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={draft.isPending}
                    onClick={() => {
                      setPlannerRunId(d.runId);
                      draft.mutate(d.runId);
                    }}
                  >
                    {t('orchestration.load')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(mode === 'manual' || tasks.length > 0) && (
          <>
            <hr />
            <div className="form-grid form-grid-3">
              <Field label={t('mcp.name')}>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('orchestration.namePlaceholder')} />
              </Field>
              <Field label={t('orchestration.concurrency')} hint={t('orchestration.concurrencyHint')}>
                <NumberInput min={1} max={8} value={concurrency} onChange={(v) => setConcurrency(v || 1)} />
              </Field>
              <Field label={t('orchestration.permissionMode')}>
                <Select<PermissionMode | ''>
                  value={permissionMode}
                  onChange={setPermissionMode}
                  options={[{ value: '', label: t('orchestration.default') }, ...PERMISSION_MODES.map((m) => ({ value: m, label: m }))]}
                />
              </Field>
            </div>
            <Field label={t('orchestration.engine')} hint={engineReason ? t('orchestration.plannerReason', { reason: engineReason }) : undefined}>
              <Segmented<OrchestrationEngine>
                label={t('orchestration.engine')}
                value={engine}
                onChange={setEngine}
                options={[
                  { value: 'graph', label: t('orchestration.graph'), title: t('orchestration.graphTitle') },
                  { value: 'workflow', label: t('orchestration.workflow'), title: t('orchestration.workflowTitle') },
                ]}
              />
            </Field>
            <p className="muted small">
              {engine === 'graph' ? t('orchestration.graphHint') : t('orchestration.workflowHint')}
            </p>
            <Switch checked={synthesize} onChange={setSynthesize}>
              {t('orchestration.synthesize')}
            </Switch>
            {engine === 'graph' && (
              <Switch checked={worktree} onChange={setWorktree}>
                {t('orchestration.worktree')}
              </Switch>
            )}
            <Switch checked={askPermissions} onChange={setAskPermissions}>
              {t('orchestration.askPermissions')}
            </Switch>
            <p className="muted small">{t('orchestration.askPermissionsHint')}</p>
            <Field label={t('orchestration.tools')} hint={t('orchestration.toolsHint')}>
              <input value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} placeholder="Bash,Read,Write,Edit" />
            </Field>
            {engine === 'graph' && worktree && (
              <p className="muted small">
                {t('orchestration.worktreeHint')}
              </p>
            )}

            <div className="card-head">
              <h2>{t('orchestration.tasks', { count: tasks.length })}</h2>
              <button type="button" className="btn btn-small" onClick={() => setTasks((prev) => [...prev, emptyTask(prev.length + 1)])}>
                <Plus size={14} strokeWidth={2} aria-hidden />
                {t('orchestration.addTask')}
              </button>
            </div>
            {tasks.length === 0 && <Empty title={t('orchestration.noTasks')}>{t('orchestration.noTasksHint')}</Empty>}
            <div className="stack">
              {tasks.map((task, i) => (
                <TaskEditor
                  key={i}
                  task={task}
                  others={tasks.filter((_, j) => j !== i).map((other) => other.id).filter(Boolean)}
                  onChange={(patch) => updateTask(i, patch)}
                  onRemove={() => removeTask(i)}
                />
              ))}
            </div>
            {localError && <div className="alert alert-warn">{localError}</div>}
            <ErrorBox error={create.error} title={t('orchestration.launchFailed')} />
            <div className="form-actions">
              <button type="button" className="btn btn-primary" disabled={create.isPending} onClick={launch}>
                {create.isPending ? t('orchestration.launching') : t('orchestration.launch', { count: tasks.length })}
              </button>
              <button type="button" className="btn" onClick={onDone}>
                {t('common:actions.cancel')}
              </button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

export function Orchestration() {
  const { t } = useTranslation(['config', 'common']);
  const { data, error, isLoading } = useOrchestrations();
  const [creating, setCreating] = useState(false);
  const list = data ?? [];

  return (
    <>
      <PageHeader
        title={t('orchestration.title')}
        subtitle={t('orchestration.subtitle')}
        actions={
          !creating && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={14} strokeWidth={2} aria-hidden />
              {t('orchestration.new')}
            </button>
          )
        }
      />
      {creating && <CreateForm onDone={() => setCreating(false)} />}
      <ErrorBox error={error} />
      <Card title={t('orchestration.list', { count: list.length })}>
        {isLoading ? (
          <Loading />
        ) : list.length === 0 ? (
          <Empty title={t('orchestration.none')} />
        ) : (
          <div className="list">
            {list.map((orch) => {
              // Progress is completed work only: counting stopped tasks as done drew a full bar and
              // "5/5" over a graph that had finished two tasks and been interrupted.
              const completed = orch.tasks.filter((task) => task.status === 'completed').length;
              const stopped = orch.tasks.filter((task) => task.status === 'stopped' || task.status === 'skipped').length;
              const failed = orch.tasks.filter((task) => task.status === 'failed').length;
              const pct = orch.tasks.length ? Math.round((completed / orch.tasks.length) * 100) : 0;
              const resumable = orch.status !== 'running' && completed < orch.tasks.length;
              return (
                <Link key={orch.id} to={`/orchestration/${orch.id}`} className="list-row">
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <StatusBadge status={orch.status} />
                      <span className="strong ellipsis">{orch.name}</span>
                    </div>
                    {orch.objective && <div className="muted small ellipsis">{truncate(orch.objective, 160)}</div>}
                    <div className="meter-track meter-thin">
                      <div className={`meter-fill ${failed ? 'is-bad' : ''}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="meta">
                      <span>{t('orchestration.completed', { done: completed, total: orch.tasks.length })}</span>
                      {stopped > 0 && <span className="text-warn">{t('orchestration.notRun', { count: stopped })}</span>}
                      {failed > 0 && <span className="text-bad">{t('orchestration.failed', { count: failed })}</span>}
                      {orch.engine === 'workflow' && <Tag tone="info">workflow</Tag>}
                      {resumable && <Tag tone="active">{t('orchestration.resumable')}</Tag>}
                      <span>{formatCost(orch.costUsd)}</span>
                      <span>{t('orchestration.concurrencyValue', { n: orch.concurrency })}</span>
                    </div>
                  </div>
                  <span className="muted small nowrap">{timeAgo(orch.createdAt)}</span>
                </Link>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}
