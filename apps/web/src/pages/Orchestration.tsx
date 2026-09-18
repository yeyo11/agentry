import { Plus } from 'lucide-react';
import type { OrchestrationSpec, OrchestrationTaskSpec, PermissionMode } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, keys, useOrchestrations, useProjects } from '../api';
import { Card, Empty, ErrorBox, Field, Loading, ModelDatalist, PageHeader, PERMISSION_MODES, Segmented, StatusBadge } from '../components/ui';
import { formatCost, timeAgo, truncate } from '../lib/format';

type Mode = 'auto' | 'manual';

const emptyTask = (index: number): OrchestrationTaskSpec => ({
  id: `task-${index}`,
  name: '',
  prompt: '',
  dependsOn: [],
});

function validate(name: string, tasks: OrchestrationTaskSpec[]): string | null {
  if (!name.trim()) return 'Give the orchestration a name.';
  if (tasks.length === 0) return 'Add at least one task.';
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.id.trim()) return 'Every task needs an id.';
    if (ids.has(task.id)) return `Duplicate task id "${task.id}".`;
    ids.add(task.id);
    if (!task.prompt.trim()) return `Task "${task.id}" has no prompt.`;
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!ids.has(dep)) return `Task "${task.id}" depends on unknown task "${dep}".`;
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
  const deps = task.dependsOn ?? [];
  return (
    <div className="task-editor">
      <div className="form-grid form-grid-3">
        <Field label="Id">
          <input value={task.id} onChange={(e) => onChange({ id: e.target.value.replace(/\s+/g, '-') })} />
        </Field>
        <Field label="Name">
          <input value={task.name} placeholder="Short label" onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        <Field label="Model (optional)">
          <input
            list="orch-model-options"
            value={task.model ?? ''}
            placeholder="inherit"
            onChange={(e) => onChange({ model: e.target.value || undefined })}
          />
        </Field>
      </div>
      <Field label="Prompt">
        <textarea rows={3} value={task.prompt} onChange={(e) => onChange({ prompt: e.target.value })} />
      </Field>
      <div className="task-editor-foot">
        <div className="chips">
          <span className="field-label">Depends on</span>
          {others.length === 0 && <span className="muted small">no other tasks</span>}
          {others.map((id) => (
            <label key={id} className={`chip ${deps.includes(id) ? 'chip-on' : ''}`}>
              <input
                type="checkbox"
                checked={deps.includes(id)}
                onChange={(e) =>
                  onChange({ dependsOn: e.target.checked ? [...deps, id] : deps.filter((d) => d !== id) })
                }
              />
              {id}
            </label>
          ))}
        </div>
        <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>
          Remove task
        </button>
      </div>
    </div>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
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
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [tasks, setTasks] = useState<OrchestrationTaskSpec[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  // The planner is a run like any other: it is started, then watched. Holding an HTTP request
  // open for the couple of minutes it takes is what used to lose the plan on a dropped connection.
  const [plannerRunId, setPlannerRunId] = useState<string | null>(null);
  const [appliedRunId, setAppliedRunId] = useState<string | null>(null);

  const applyDraft = (draft: OrchestrationSpec) => {
    setTasks(draft.tasks.map((t) => ({ ...t, dependsOn: t.dependsOn ?? [] })));
    if (draft.name) setName(draft.name);
    if (draft.objective && !objective.trim()) setObjective(draft.objective);
    if (draft.cwd && !cwd.trim()) setCwd(draft.cwd);
    if (draft.concurrency) setConcurrency(draft.concurrency);
    if (draft.synthesize != null) setSynthesize(draft.synthesize);
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

  const plannerRun = useQuery({
    queryKey: ['run', plannerRunId],
    queryFn: () => api.run(plannerRunId ?? ''),
    enabled: plannerRunId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status && ['completed', 'failed', 'stopped'].includes(status) ? false : 2000;
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
      const next = prev.map((t, i) => (i === index ? { ...t, ...patch } : t));
      // Keep dependency references in sync when an id is renamed.
      if (patch.id !== undefined && patch.id !== current.id) {
        return next.map((t) => ({ ...t, dependsOn: (t.dependsOn ?? []).map((d) => (d === current.id ? patch.id! : d)) }));
      }
      return next;
    });
  };

  const removeTask = (index: number) => {
    setTasks((prev) => {
      const removed = prev[index]?.id;
      return prev
        .filter((_, i) => i !== index)
        .map((t) => ({ ...t, dependsOn: (t.dependsOn ?? []).filter((d) => d !== removed) }));
    });
  };

  const launch = () => {
    const problem = validate(name, tasks);
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
      tasks: tasks.map((t) => ({
        ...t,
        id: t.id.trim(),
        name: t.name.trim() || t.id.trim(),
        prompt: t.prompt.trim(),
        dependsOn: t.dependsOn?.length ? t.dependsOn : undefined,
      })),
    });
  };

  return (
    <Card
      title="New orchestration"
      actions={
        <Segmented
          label="Creation mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'auto', label: 'Auto-plan' },
            { value: 'manual', label: 'Manual' },
          ]}
        />
      }
    >
      <ModelDatalist id="orch-model-options" />
      <datalist id="orch-cwd-options">
        {(projects.data ?? []).filter((p) => p.exists).map((p) => (
          <option key={p.id} value={p.path} />
        ))}
      </datalist>
      <div className="form">
        <Field
          label="Objective"
          hint={mode === 'auto' ? 'A planner agent splits this into tasks you can edit before launching.' : 'Optional; passed to the final synthesis agent.'}
        >
          <textarea rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} />
        </Field>
        <div className="form-grid form-grid-3">
          <Field label="Working directory">
            <input list="orch-cwd-options" placeholder="wrapper workspace" value={cwd} onChange={(e) => setCwd(e.target.value)} />
          </Field>
          <Field label="Model">
            <input list="orch-model-options" placeholder="default" value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
          {mode === 'auto' && (
            <Field label="Max tasks">
              <input type="number" min={1} max={12} value={maxTasks} onChange={(e) => setMaxTasks(Number(e.target.value) || 1)} />
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
              {planning ? 'Planning…' : tasks.length ? 'Re-plan' : 'Generate plan'}
            </button>
            {planning && <span className="spinner" />}
            {plannerRunId && (
              <span className="muted small">
                {planning ? (
                  <>
                    {plannerRun.data?.run.turns ? `${plannerRun.data.run.turns} turns · ` : ''}
                    planner running —{' '}
                  </>
                ) : plannerStatus === 'failed' || plannerStatus === 'stopped' ? (
                  <>planner {plannerStatus} — </>
                ) : (
                  <>plan ready — </>
                )}
                <Link to={`/runs/${plannerRunId}`}>watch the agent</Link>
                {draft.isPending && ' · loading the plan…'}
              </span>
            )}
          </div>
        )}
        {/* The plan is stored server-side, so leaving this page never loses it. */}
        {plannerRunId && !planning && plannerStatus !== 'completed' && (
          <p className="muted small">
            The planner {plannerStatus ?? 'ended'} without a plan. Its output is on the run page; you can re-plan or
            write the tasks by hand.
          </p>
        )}
        <ErrorBox error={plan.error} title="Could not start the planner" />
        <ErrorBox error={draft.error} title="Could not load the plan" />

        {mode === 'auto' && (drafts.data?.length ?? 0) > 0 && (
          <div className="stack-sm">
            <hr />
            <div className="muted small">Plans already generated — load one instead of paying for a new run.</div>
            <ul className="list">
              {(drafts.data ?? []).slice(0, 5).map((d) => (
                <li key={d.runId} className="list-row small">
                  <span className="strong ellipsis">{d.name}</span>
                  <span className="muted ellipsis">{d.objective ?? ''}</span>
                  <span className="muted nowrap">
                    {d.taskCount} task{d.taskCount === 1 ? '' : 's'} · {timeAgo(d.createdAt)}
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
                    Load
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
              <Field label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Refactor auth module" />
              </Field>
              <Field label="Concurrency" hint="Agents in parallel">
                <input type="number" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value) || 1)} />
              </Field>
              <Field label="Permission mode">
                <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode | '')}>
                  <option value="">Default</option>
                  {PERMISSION_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <label className="check">
              <input type="checkbox" checked={synthesize} onChange={(e) => setSynthesize(e.target.checked)} /> Run a final
              agent that synthesizes all task results
            </label>

            <div className="card-head">
              <h2>Tasks ({tasks.length})</h2>
              <button type="button" className="btn btn-small" onClick={() => setTasks((prev) => [...prev, emptyTask(prev.length + 1)])}>
                <Plus size={14} strokeWidth={2} aria-hidden />
                Add task
              </button>
            </div>
            {tasks.length === 0 && <Empty title="No tasks yet">Add tasks and wire their dependencies.</Empty>}
            <div className="stack">
              {tasks.map((task, i) => (
                <TaskEditor
                  key={i}
                  task={task}
                  others={tasks.filter((_, j) => j !== i).map((t) => t.id).filter(Boolean)}
                  onChange={(patch) => updateTask(i, patch)}
                  onRemove={() => removeTask(i)}
                />
              ))}
            </div>
            {localError && <div className="alert alert-warn">{localError}</div>}
            <ErrorBox error={create.error} title="Could not launch" />
            <div className="form-actions">
              <button type="button" className="btn btn-primary" disabled={create.isPending} onClick={launch}>
                {create.isPending ? 'Launching…' : `Launch ${tasks.length} task${tasks.length === 1 ? '' : 's'}`}
              </button>
              <button type="button" className="btn" onClick={onDone}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

export function Orchestration() {
  const { data, error, isLoading } = useOrchestrations();
  const [creating, setCreating] = useState(false);
  const list = data ?? [];

  return (
    <>
      <PageHeader
        title="Orchestration"
        subtitle="Split an objective into tasks and run them as parallel agents with dependencies"
        actions={
          !creating && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={14} strokeWidth={2} aria-hidden />
              New orchestration
            </button>
          )
        }
      />
      {creating && <CreateForm onDone={() => setCreating(false)} />}
      <ErrorBox error={error} />
      <Card title={`Orchestrations (${list.length})`}>
        {isLoading ? (
          <Loading />
        ) : list.length === 0 ? (
          <Empty title="No orchestrations yet" />
        ) : (
          <div className="list">
            {list.map((orch) => {
              const done = orch.tasks.filter((t) => ['completed', 'failed', 'skipped', 'stopped'].includes(t.status)).length;
              const failed = orch.tasks.filter((t) => t.status === 'failed').length;
              const pct = orch.tasks.length ? Math.round((done / orch.tasks.length) * 100) : 0;
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
                      <span>
                        {done}/{orch.tasks.length} tasks
                      </span>
                      {failed > 0 && <span className="text-bad">{failed} failed</span>}
                      <span>{formatCost(orch.costUsd)}</span>
                      <span>concurrency {orch.concurrency}</span>
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
