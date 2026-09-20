import { Plus } from 'lucide-react';
import type { OrchestrationEngine, OrchestrationSpec, OrchestrationTaskSpec, PermissionMode } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, keys, useOrchestrations, useProjects } from '../api';
import { Combobox, NumberInput, Select, Switch } from '../components/controls';
import { BoardStatusBadge } from '../components/OrchestrationBoard';
import { Card, Empty, ErrorBox, Field, Loading, MODEL_OPTIONS, PageHeader, PERMISSION_MODES, Segmented, Tag } from '../components/ui';
import { useFallbackInterval } from '../lib/feed';
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
          <Combobox
            aria-label="Model"
            value={task.model ?? ''}
            placeholder="inherit"
            onChange={(model) => onChange({ model: model || undefined })}
            options={MODEL_OPTIONS}
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
  const [maxAttempts, setMaxAttempts] = useState(2);
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
    setTasks(draft.tasks.map((t) => ({ ...t, dependsOn: t.dependsOn ?? [] })));
    if (draft.name) setName(draft.name);
    if (draft.objective && !objective.trim()) setObjective(draft.objective);
    if (draft.cwd && !cwd.trim()) setCwd(draft.cwd);
    if (draft.concurrency) setConcurrency(draft.concurrency);
    if (draft.maxAttempts) setMaxAttempts(draft.maxAttempts);
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
      // A workflow has no retries of its own to configure
      ...(engine === 'graph' ? { maxAttempts } : {}),
      synthesize,
      engine,
      ...(engineReason ? { engineReason } : {}),
      // A workflow runs every task in the project directory
      worktree: engine === 'workflow' ? false : worktree,
      allowedTools: allowedTools
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      permissionPrompts: askPermissions ? ('host' as const) : ('none' as const),
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
      <div className="form">
        <Field
          label="Objective"
          hint={mode === 'auto' ? 'A planner agent splits this into tasks you can edit before launching.' : 'Optional; passed to the final synthesis agent.'}
        >
          <textarea rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} />
        </Field>
        <div className="form-grid form-grid-3">
          <Field label="Working directory">
            <Combobox
              aria-label="Working directory"
              placeholder="wrapper workspace"
              value={cwd}
              onChange={setCwd}
              options={(projects.data ?? []).filter((p) => p.exists).map((p) => ({ value: p.path, label: p.name, hint: p.path }))}
            />
          </Field>
          <Field label="Model">
            <Combobox aria-label="Model" placeholder="default" value={model} onChange={setModel} options={MODEL_OPTIONS} />
          </Field>
          {mode === 'auto' && (
            <Field label="Max tasks">
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
                <NumberInput min={1} max={8} value={concurrency} onChange={(v) => setConcurrency(v || 1)} />
              </Field>
              {engine === 'graph' && (
                <Field label="Attempts per task" hint="A failed task is retried in its own chat until it has had this many; then you decide">
                  <NumberInput min={1} max={10} value={maxAttempts} onChange={(v) => setMaxAttempts(v || 1)} />
                </Field>
              )}
              <Field label="Permission mode">
                <Select<PermissionMode | ''>
                  value={permissionMode}
                  onChange={setPermissionMode}
                  options={[{ value: '', label: 'Default' }, ...PERMISSION_MODES.map((m) => ({ value: m, label: m }))]}
                />
              </Field>
            </div>
            <Field label="Engine" hint={engineReason ? `Planner: ${engineReason}` : undefined}>
              <Segmented<OrchestrationEngine>
                label="Engine"
                value={engine}
                onChange={setEngine}
                options={[
                  { value: 'graph', label: 'Graph', title: 'One process per task, each able to get its own worktree and branch' },
                  { value: 'workflow', label: 'Workflow', title: 'Every task a subagent of one Claude Code session' },
                ]}
              />
            </Field>
            <p className="muted small">
              {engine === 'graph'
                ? 'Every task runs as its own Claude Code process and can get its own worktree and branch, merged into one at the end. The choice for tasks that change code.'
                : "Every task runs as a subagent of one Claude Code session, through a workflow script generated from these tasks: cheaper, and a resume replays what had finished from Claude Code's cache. All of them work in the project directory, with no worktrees: for tasks that read, analyse or review."}
            </p>
            <Switch checked={synthesize} onChange={setSynthesize}>
              Run a final agent that synthesizes all task results
            </Switch>
            {engine === 'graph' && (
              <Switch checked={worktree} onChange={setWorktree}>
                Give each task its own git worktree and branch
              </Switch>
            )}
            <Switch checked={askPermissions} onChange={setAskPermissions}>
              Ask me when a worker needs permission
            </Switch>
            <p className="muted small">
              Prompts appear on the worker's run page for you to allow or deny. Without this a worker has nobody to ask,
              so anything not listed below is denied automatically.
            </p>
            <Field
              label="Tools workers may use"
              hint="A worker has nobody to ask, so the CLI denies anything not pre-authorised here. Leave empty to rely on the permission mode alone."
            >
              <input value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} placeholder="Bash,Read,Write,Edit" />
            </Field>
            {engine === 'graph' && worktree && (
              <p className="muted small">
                Workers then never write over each other, and never edit the checkout Agentry is running from — an
                orchestration that edits this repo restarts the wrapper and kills itself. Needs the directory to be a git
                repository.
              </p>
            )}

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
              // Progress is completed work only: counting stopped tasks as done drew a full bar and
              // "5/5" over a graph that had finished two tasks and been interrupted.
              const completed = orch.tasks.filter((t) => t.status === 'completed').length;
              const stopped = orch.tasks.filter((t) => t.status === 'stopped').length;
              const skipped = orch.tasks.filter((t) => t.status === 'skipped').length;
              const blocked = orch.tasks.filter((t) => t.status === 'blocked').length;
              const failed = orch.tasks.filter((t) => t.status === 'failed').length;
              const pct = orch.tasks.length ? Math.round((completed / orch.tasks.length) * 100) : 0;
              // A waiting graph is not resumed: its failed tasks are decided on, one by one, on its board
              const resumable = orch.status !== 'running' && orch.status !== 'waiting' && completed < orch.tasks.length;
              return (
                <Link key={orch.id} to={`/orchestration/${orch.id}`} className="list-row">
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <BoardStatusBadge status={orch.status} />
                      <span className="strong ellipsis">{orch.name}</span>
                    </div>
                    {orch.objective && <div className="muted small ellipsis">{truncate(orch.objective, 160)}</div>}
                    <div className="meter-track meter-thin">
                      <div className={`meter-fill ${failed ? 'is-bad' : ''}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="meta">
                      <span>
                        {completed}/{orch.tasks.length} completed
                      </span>
                      {stopped > 0 && <span className="text-warn">{stopped} not run</span>}
                      {failed > 0 && <span className="text-bad">{failed} failed</span>}
                      {blocked > 0 && <span className="text-warn">{blocked} blocked, waiting for a decision</span>}
                      {skipped > 0 && <span className="muted">{skipped} skipped</span>}
                      {orch.engine === 'workflow' && <Tag tone="info">workflow</Tag>}
                      {resumable && <Tag tone="active">can be resumed</Tag>}
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
