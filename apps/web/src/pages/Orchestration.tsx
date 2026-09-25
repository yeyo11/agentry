import { ArrowLeft, Ban, CircleCheck, CircleX, CirclePause, LayoutTemplate, Play, Plus, Square, Zap } from 'lucide-react';
import type { Orchestration as OrchestrationRecord, OrchestrationEngine, OrchestrationSpec, OrchestrationTemplate, OrchestrationTaskSpec, PermissionMode, TaskLimits } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, keys, useOrchestrations, useProjects } from '../api';
import { ActivityTicker } from '../components/ActivityTicker';
import { Collapsible, Combobox, NumberInput, Select, Switch } from '../components/controls';
import { DefaultLimits, VerificationFields } from '../components/GraphExtras';
import { ListToolbar } from '../components/ListToolbar';
import { BoardStatusBadge } from '../components/OrchestrationBoard';
import { SaveTemplateDialog, TemplatesList } from '../components/OrchestrationTemplates';
import { ProgressBar } from '../components/ProgressBar';
import { removeTaskAt, renameTask, TaskEditor, validateGraph } from '../components/TaskEditor';
import { Card, Empty, ErrorBox, Field, Loading, ModelCombobox, PageHeader, PERMISSION_MODES, Segmented, Tag } from '../components/ui';
import { useFallbackInterval } from '../lib/feed';
import { formatCost, timeAgo } from '../lib/format';
import { NARROW, useMediaQuery } from '../lib/media';
import { layerTasks, liveTask, orchestrationProgress } from '../lib/orchestration-steps';
import { cleanTask, draftOfVerification, verificationOf, type VerificationDraft } from '../lib/orchestration-v2';

type Mode = 'auto' | 'manual';

const emptyTask = (index: number): OrchestrationTaskSpec => ({
  id: `task-${index}`,
  name: '',
  prompt: '',
  dependsOn: [],
});

/** The planner's outcome as the sentence needs it; anything that is not a failure of some kind reads as "ended". */
function plannerOutcome(status: string | undefined): 'failed' | 'stopped' | 'interrupted' | 'ended' {
  return status === 'failed' || status === 'stopped' || status === 'interrupted' ? status : 'ended';
}

/**
 * `template` is a saved graph the form starts from: it is already there to edit, so the form opens
 * in manual mode with the tasks listed instead of asking for a plan, and saving updates the template.
 */
function CreateForm({ onDone, template }: { onDone: () => void; template?: OrchestrationTemplate }) {
  const seed = template?.spec;
  const { t } = useTranslation(['orchestration', 'config', 'common']);
  const { t: tv } = useTranslation('orchestrationV2');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useProjects(false);
  const narrow = useMediaQuery(NARROW);
  const [mode, setMode] = useState<Mode>(seed ? 'manual' : 'auto');
  const [name, setName] = useState(seed?.name ?? '');
  const [objective, setObjective] = useState(seed?.objective ?? '');
  const [cwd, setCwd] = useState(seed?.cwd ?? '');
  const [model, setModel] = useState(seed?.model ?? '');
  const [maxTasks, setMaxTasks] = useState(5);
  const [concurrency, setConcurrency] = useState(seed?.concurrency ?? 3);
  const [maxAttempts, setMaxAttempts] = useState(seed?.maxAttempts ?? 2);
  const [synthesize, setSynthesize] = useState(seed?.synthesize ?? true);
  const [worktree, setWorktree] = useState(seed?.worktree ?? true);
  const [engine, setEngine] = useState<OrchestrationEngine>(seed?.engine ?? 'graph');
  const [engineReason, setEngineReason] = useState<string | null>(seed?.engineReason ?? null);
  const [allowedTools, setAllowedTools] = useState(seed?.allowedTools?.join(',') ?? 'Bash,Read,Write,Edit,Glob,Grep');
  const [askPermissions, setAskPermissions] = useState(seed?.permissionPrompts === 'host');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>(seed?.permissionMode ?? '');
  const [limits, setLimits] = useState<TaskLimits | undefined>(seed?.limits);
  const [verification, setVerification] = useState<VerificationDraft>(draftOfVerification(seed?.verification));
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [tasks, setTasks] = useState<OrchestrationTaskSpec[]>(() => seed?.tasks.map((t) => ({ ...t, dependsOn: t.dependsOn ?? [] })) ?? []);
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
    // A plan carries neither; keep what was typed rather than clearing it
    if (draft.limits) setLimits(draft.limits);
    if (draft.verification) setVerification(draftOfVerification(draft.verification));
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
    queryKey: ['planner-executions', plannerRunId],
    queryFn: () => api.chatExecutions(plannerRunId ?? ''),
    enabled: plannerRunId !== null,
    refetchInterval: (query) => (query.state.data?.at(-1)?.outcome ? false : fallback),
  });
  const plannerExecution = plannerRun.data?.at(-1);
  // No outcome yet means the planner is still working
  const plannerStatus = plannerExecution?.outcome ?? undefined;
  const plannerEndedAs = plannerStatus === 'failed' || plannerStatus === 'stopped' || plannerStatus === 'interrupted' ? plannerStatus : null;
  const plannerEnded = plannerEndedAs !== null;
  const planning = plannerRunId !== null && appliedRunId !== plannerRunId && !plannerEnded;

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

  const updateTask = (index: number, patch: Partial<OrchestrationTaskSpec>) => setTasks((prev) => renameTask(prev, index, patch));
  const removeTask = (index: number) => setTasks((prev) => removeTaskAt(prev, index));

  // The graph as the form holds it, for launching and for saving as a template alike
  const specOfForm = (): OrchestrationSpec => ({
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
    ...(limits ? { limits } : {}),
    ...(verificationOf(verification) ? { verification: verificationOf(verification) } : {}),
    tasks: tasks.map(cleanTask),
  });

  const launch = () => {
    const problem = validateGraph(name, tasks);
    setLocalError(problem);
    if (problem) return;
    create.mutate(specOfForm());
  };

  const saveTemplate = () => {
    const problem = validateGraph(name, tasks);
    setLocalError(problem);
    if (!problem) setSavingTemplate(true);
  };

  return (
    <Card
      title={t('config:orchestration.new')}
      actions={
        <Segmented
          label={t('config:orchestration.creationMode')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'auto', label: t('config:orchestration.autoPlan') },
            { value: 'manual', label: t('config:orchestration.manual') },
          ]}
        />
      }
    >
      <div className="form">
        {template && (
          <p className="small strong" role="status">
            {tv('templates.editing', { name: template.name })}
          </p>
        )}
        <Field
          label={t('config:orchestration.objective')}
          hint={mode === 'auto' ? t('config:orchestration.objectiveAutoHint') : t('config:orchestration.objectiveManualHint')}
        >
          <textarea rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} />
        </Field>
        <div className="form-grid form-grid-3">
          <Field label={t('config:orchestration.cwd')}>
            <Combobox
              aria-label={t('config:orchestration.cwd')}
              placeholder={t('config:orchestration.cwdPlaceholder')}
              value={cwd}
              onChange={setCwd}
              options={(projects.data ?? []).filter((p) => p.exists).map((p) => ({ value: p.path, label: p.name, hint: p.path }))}
            />
          </Field>
          <Field label={t('taskEditor.model')}>
            <ModelCombobox aria-label={t('taskEditor.model')} placeholder={t('defaultPlaceholder')} value={model} onChange={setModel} />
          </Field>
          {mode === 'auto' && (
            <Field label={t('config:orchestration.maxTasks')}>
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
              {planning ? t('config:orchestration.planning') : tasks.length ? t('config:orchestration.replan') : t('config:orchestration.generate')}
            </button>
            {planning && <span className="spinner" aria-hidden />}
            {plannerRunId && (
              <span className="muted small" role="status">
                {planning ? (
                  <>
                    {plannerExecution?.turns ? t('config:orchestration.turns', { count: plannerExecution.turns }) : ''}
                    {t('config:orchestration.plannerRunning')}{' '}
                  </>
                ) : plannerEndedAs ? (
                  <>
                    {t(`plannerEnded.${plannerEndedAs}`)}{' '}
                  </>
                ) : (
                  <>
                    {t('config:orchestration.planReady')}{' '}
                  </>
                )}
                <Link to={`/chats/${plannerRunId}`}>{t('config:orchestration.watchAgent')}</Link>
                {draft.isPending && t('config:orchestration.loadingPlan')}
              </span>
            )}
          </div>
        )}
        {/* The plan is stored server-side, so leaving this page never loses it. */}
        {plannerRunId && !planning && plannerStatus !== 'completed' && (
          <p className="muted small" role="status">
            {t('noPlan', { outcome: t(`plannerOutcome.${plannerOutcome(plannerStatus)}`) })}
          </p>
        )}
        <ErrorBox error={plan.error} title={t('config:orchestration.planStartFailed')} />
        <ErrorBox error={draft.error} title={t('config:orchestration.planLoadFailed')} />

        {mode === 'auto' && (drafts.data?.length ?? 0) > 0 && (
          <div className="stack-sm">
            <hr />
            <div className="muted small">{t('config:orchestration.drafts')}</div>
            <ul className="list">
              {(drafts.data ?? []).slice(0, 5).map((d) => (
                <li key={d.runId} className="list-row list-row-flow small">
                  <span className="strong break">{d.name}</span>
                  <span className="muted break">{d.objective ?? ''}</span>
                  <span className="muted nowrap">
                    {t('config:orchestration.taskCount', { count: d.taskCount })} · {timeAgo(d.createdAt)}
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
                    {t('config:orchestration.load')}
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
              <Field label={t('taskEditor.name')}>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('config:orchestration.namePlaceholder')} />
              </Field>
              <Field label={t('config:orchestration.concurrency')} hint={t('config:orchestration.concurrencyHint')}>
                <NumberInput min={1} max={8} value={concurrency} onChange={(v) => setConcurrency(v || 1)} />
              </Field>
              {engine === 'graph' && (
                <Field label={t('attemptsPerTask')} hint={t('attemptsHint')}>
                  <NumberInput min={1} max={10} value={maxAttempts} onChange={(v) => setMaxAttempts(v || 1)} />
                </Field>
              )}
            </div>
            {/* On a phone the form is one long column: what most launches leave as it is folds away */}
            <Collapsible className="fold orch-advanced" defaultOpen={!narrow} title={t('list.advanced')}>
              <div className="form">
                <Field label={t('config:orchestration.permissionMode')}>
                  <Select<PermissionMode | ''>
                    value={permissionMode}
                    onChange={setPermissionMode}
                    options={[{ value: '', label: t('config:orchestration.default') }, ...PERMISSION_MODES.map((m) => ({ value: m, label: m }))]}
                  />
                </Field>
                <Field label={t('config:orchestration.engine')} hint={engineReason ? t('config:orchestration.plannerReason', { reason: engineReason }) : undefined}>
                  <Segmented<OrchestrationEngine>
                    label={t('config:orchestration.engine')}
                    value={engine}
                    onChange={setEngine}
                    options={[
                      { value: 'graph', label: t('config:orchestration.graph'), title: t('config:orchestration.graphTitle') },
                      { value: 'workflow', label: t('config:orchestration.workflow'), title: t('config:orchestration.workflowTitle') },
                    ]}
                  />
                </Field>
                <p className="muted small">
                  {engine === 'graph' ? t('config:orchestration.graphHint') : t('config:orchestration.workflowHint')}
                </p>
                <Switch checked={synthesize} onChange={setSynthesize}>
                  {t('config:orchestration.synthesize')}
                </Switch>
                {engine === 'graph' && (
                  <Switch checked={worktree} onChange={setWorktree}>
                    {t('config:orchestration.worktree')}
                  </Switch>
                )}
                <Switch checked={askPermissions} onChange={setAskPermissions}>
                  {t('config:orchestration.askPermissions')}
                </Switch>
                <p className="muted small">
                  {t('config:orchestration.askPermissionsHint')}
                </p>
                <Field
                  label={t('config:orchestration.tools')}
                  hint={t('config:orchestration.toolsHint')}
                >
                  <input value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} placeholder="Bash,Read,Write,Edit" />
                </Field>
                {engine === 'graph' && worktree && (
                  <p className="muted small">
                    {t('config:orchestration.worktreeHint')}
                  </p>
                )}
                <DefaultLimits value={limits} onChange={setLimits} />
                {engine === 'graph' && worktree && <VerificationFields value={verification} onChange={setVerification} />}
              </div>
            </Collapsible>

            <div className="card-head">
              <h3>{t('config:orchestration.tasks', { count: tasks.length })}</h3>
              <button type="button" className="btn btn-small" onClick={() => setTasks((prev) => [...prev, emptyTask(prev.length + 1)])}>
                <Plus size={14} strokeWidth={2} aria-hidden />
                {t('config:orchestration.addTask')}
              </button>
            </div>
            {tasks.length === 0 && <Empty title={t('config:orchestration.noTasks')}>{t('config:orchestration.noTasksHint')}</Empty>}
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
            {localError && (
              <div className="alert alert-warn" role="alert">
                {localError}
              </div>
            )}
            <ErrorBox error={create.error} title={t('config:orchestration.launchFailed')} />
            <div className="form-actions">
              <button type="button" className="btn btn-primary" disabled={create.isPending} onClick={launch}>
                {create.isPending ? t('config:orchestration.launching') : t('config:orchestration.launch', { count: tasks.length })}
              </button>
              <button type="button" className="btn" disabled={create.isPending} onClick={saveTemplate}>
                {tv('templates.saveAs')}
              </button>
              <button type="button" className="btn" onClick={onDone}>
                {t('common:actions.cancel')}
              </button>
            </div>
            {savingTemplate && <SaveTemplateDialog spec={specOfForm()} existing={template} onClose={() => setSavingTemplate(false)} />}
          </>
        )}
      </div>
    </Card>
  );
}

type PageTab = 'orchestrations' | 'templates';
type StatusTab = 'all' | 'live' | 'completed' | 'failed' | 'stopped';
type Sort = 'recent' | 'oldest' | 'cost' | 'name';

const STATUS_TABS: readonly StatusTab[] = ['all', 'live', 'completed', 'failed', 'stopped'];
const SORTS: readonly Sort[] = ['recent', 'oldest', 'cost', 'name'];

function inTab(orch: OrchestrationRecord, tab: StatusTab): boolean {
  switch (tab) {
    case 'all':
      return true;
    // Waiting is live too: nothing runs, but it is not over and a person is asked for something
    case 'live':
      return orch.status === 'running' || orch.status === 'waiting';
    default:
      return orch.status === tab;
  }
}

function matches(orch: OrchestrationRecord, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [orch.name, orch.objective ?? '', ...orch.tasks.flatMap((t) => [t.id, t.name])].some((text) => text.toLowerCase().includes(needle));
}

const SORTERS: Record<Sort, (a: OrchestrationRecord, b: OrchestrationRecord) => number> = {
  recent: (a, b) => b.createdAt.localeCompare(a.createdAt),
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
  cost: (a, b) => b.costUsd - a.costUsd,
  name: (a, b) => a.name.localeCompare(b.name),
};

/** "stage 3 · web-chats-tools: Editing src/…" — where a running graph is, in the one line a card has for it. */
function LiveLine({ orch }: { orch: OrchestrationRecord }) {
  const { t } = useTranslation(['orchestration', 'primitives']);
  const live = liveTask(orch);
  if (!live) return null;
  return (
    <div className="orch-row-live small">
      <span className="orch-row-where mono">{t('list.where', { stage: live.stage, task: live.task.name || live.task.id })}</span>
      {live.task.activity ? (
        <ActivityTicker activity={live.task.activity} className="orch-row-ticker" />
      ) : (
        <span className="shimmer">{t('primitives:activity.thinking')}</span>
      )}
    </div>
  );
}

/** "SC" for spanish-copy: the first letters of the first two words of the name, or its first two letters. */
function initials(name: string): string {
  const words = name.split(/[\s_\-./:]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : (words[0] ?? name).slice(0, 2);
  return letters.toUpperCase() || '·';
}

/** The tone of a card's initials follows its state, so a column of cards reads at a glance. */
const INITIALS_TONE: Record<OrchestrationRecord['status'], string> = {
  running: 'accent',
  waiting: 'idle',
  completed: 'ok',
  failed: 'bad',
  stopped: 'warn',
};

/** The stage a graph is at: the first one not every task of which is done. */
function currentStage(orch: OrchestrationRecord): { at: number; of: number } {
  const layers = layerTasks(orch.tasks);
  const index = layers.findIndex((layer) => layer.some((t) => t.status !== 'completed' && t.status !== 'skipped'));
  return { at: index === -1 ? layers.length : index + 1, of: layers.length };
}

function OrchestrationCard({ orch, energy }: { orch: OrchestrationRecord; energy: boolean }) {
  const { t } = useTranslation(['orchestration', 'config']);
  const { t: tv } = useTranslation('orchestrationV2');
  const navigate = useNavigate();
  // Progress is completed work only: counting stopped tasks as done drew a full bar and
  // "5/5" over a graph that had finished two tasks and been interrupted.
  const completed = orch.tasks.filter((t) => t.status === 'completed').length;
  const stopped = orch.tasks.filter((t) => t.status === 'stopped' || t.status === 'pending').length;
  const interrupted = orch.tasks.filter((t) => t.status === 'interrupted').length;
  const skipped = orch.tasks.filter((t) => t.status === 'skipped').length;
  const blocked = orch.tasks.filter((t) => t.status === 'blocked').length;
  const failed = orch.tasks.filter((t) => t.status === 'failed').length;
  const running = orch.status === 'running';
  // A waiting graph is not resumed: its failed tasks are decided on, one by one, on its board
  const resumable = !running && orch.status !== 'waiting' && completed < orch.tasks.length;
  const stage = currentStage(orch);
  const href = `/orchestration/${orch.id}`;
  // The first failed task's stage, so "See failures" opens on it
  const failedStage = layerTasks(orch.tasks).findIndex((layer) => layer.some((t) => t.status === 'failed'));
  const live = energy ? 'live-energy' : running ? 'live-rail' : '';
  const tone = resumable ? 'is-stopped' : orch.status === 'waiting' ? 'is-waiting' : '';

  return (
    <li className={`card orch-card ${live} ${tone}`.replace(/\s+/g, ' ').trim()}>
      <div className="orch-card-head">
        <span className={`orch-initials is-${INITIALS_TONE[orch.status]}`} aria-hidden>
          {initials(orch.name)}
        </span>
        <div className="orch-card-title">
          {/* The name is the card's link; its box covers the card, so the whole card opens the graph */}
          <Link to={href} className="orch-card-link strong">
            {orch.name}
          </Link>
          <span className="orch-card-meta mono">
            {[orch.model, t('list.parallel', { n: orch.concurrency }), timeAgo(orch.createdAt)].filter(Boolean).join(' · ')}
          </span>
        </div>
        <BoardStatusBadge status={orch.status} />
      </div>
      {running ? <LiveLine orch={orch} /> : orch.objective && <p className="orch-card-objective">{orch.objective}</p>}
      <ProgressBar variant="segments" counts={orchestrationProgress(orch.tasks)} unit={t('board.tasksUnit')} className="orch-row-progress" />
      <div className="orch-card-foot">
        {resumable ? (
          <span className="orch-card-counts">
            <span className="text-ok meta-icon">
              <CircleCheck size={12} strokeWidth={2} aria-hidden />
              {t('list.done', { count: completed })}
            </span>
            {failed > 0 && (
              <span className="text-bad meta-icon">
                <CircleX size={12} strokeWidth={2} aria-hidden />
                {t('config:orchestration.failed', { count: failed })}
              </span>
            )}
            {interrupted > 0 && (
              <span className="text-warn meta-icon">
                <Zap size={12} strokeWidth={2} aria-hidden />
                {t('interruptedByRestart', { count: interrupted })}
              </span>
            )}
            {stopped > 0 && (
              <span className="muted meta-icon">
                <Square size={12} strokeWidth={2} aria-hidden />
                {t('config:orchestration.notRun', { count: stopped })}
              </span>
            )}
            {blocked > 0 && (
              <span className="text-warn meta-icon">
                <CirclePause size={12} strokeWidth={2} aria-hidden />
                {t('blockedWaiting', { count: blocked })}
              </span>
            )}
            {skipped > 0 && (
              <span className="muted meta-icon">
                <Ban size={12} strokeWidth={2} aria-hidden />
                {t('skipped', { count: skipped })}
              </span>
            )}
          </span>
        ) : (
          <span className="orch-card-facts mono">
            <span>{t('list.tasksDone', { done: completed, total: orch.tasks.length })}</span>
            {running && stage.of > 1 && <span>{t('list.stageOf', { at: stage.at, of: stage.of })}</span>}
            {blocked > 0 && <span className="text-warn">{t('blockedWaiting', { count: blocked })}</span>}
          </span>
        )}
        <span className="orch-card-tags">
          {orch.engine === 'workflow' && <Tag tone="info">{t('workflowTag')}</Tag>}
          {orch.relaunchedFrom && <Tag tone="muted">{tv('origin.relaunched')}</Tag>}
          {orch.templateId && <Tag tone="muted">{tv('origin.fromTemplate')}</Tag>}
        </span>
        <span className="orch-card-cost mono">{formatCost(orch.costUsd)}</span>
      </div>
      {resumable && (
        <div className="orch-card-actions">
          {failed > 0 && (
            <Link to={failedStage === -1 ? href : `${href}?step=stage-${failedStage + 1}`} className="btn btn-small">
              {t('list.seeFailures')}
            </Link>
          )}
          <button type="button" className="btn btn-small btn-primary" onClick={() => navigate(`${href}?resume=1`)}>
            <Play size={14} strokeWidth={2} aria-hidden />
            {t('list.resume')}
          </button>
        </div>
      )}
    </li>
  );
}

export function Orchestration() {
  const { t } = useTranslation(['orchestration', 'config']);
  const { data, error, isLoading } = useOrchestrations();
  const templates = useQuery({ queryKey: keys.orchestrationTemplates, queryFn: api.orchestrationTemplates });
  const [params, setParams] = useSearchParams();
  // `?new` opens the form, so the top bar's "New ▾" menu, the palette or a link can start one here
  const [creating, setCreating] = useState(() => params.has('new'));
  // A template opened for editing: the form starts from its graph instead of an empty one. The
  // counter is the form's key, so opening a second template replaces the first instead of keeping its state.
  const [editing, setEditing] = useState<{ template: OrchestrationTemplate; n: number } | undefined>();
  const list = data ?? [];
  // The list's state is in the address, so a filtered view can be linked to and survives Back
  const setParam = (changes: Record<string, string | null>) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [name, value] of Object.entries(changes)) {
          if (value === null || value === '') next.delete(name);
          else next.set(name, value);
        }
        return next;
      },
      { replace: true },
    );
  const closeForm = () => {
    setCreating(false);
    setEditing(undefined);
    if (params.has('new')) setParam({ new: null });
  };
  useEffect(() => {
    if (params.has('new')) setCreating(true);
  }, [params]);

  const tab: PageTab = params.get('tab') === 'templates' ? 'templates' : 'orchestrations';
  // One primary per zone: while the empty state offers New orchestration, the header's copy steps back
  const emptyList = !isLoading && list.length === 0 && tab === 'orchestrations';
  const status: StatusTab = STATUS_TABS.find((s) => s === params.get('status')) ?? 'all';
  const sort: Sort = SORTS.find((s) => s === params.get('sort')) ?? 'recent';
  const query = params.get('q') ?? '';
  const searched = list.filter((orch) => matches(orch, query.trim()));
  const shown = searched.filter((orch) => inTab(orch, status)).sort(SORTERS[sort]);
  // One energy border a screen: the first running card has it, the others take the live rail
  const energyId = shown.find((orch) => orch.status === 'running')?.id;
  const narrow = useMediaQuery(NARROW);
  const templatesTitleId = useId();
  const openTemplates = () => setParam({ tab: 'templates' });
  const closeTemplates = () => setParam({ tab: null });
  const templateCount = templates.data?.length;

  return (
    <>
      <PageHeader
        title={t('list.title')}
        subtitle={t('config:orchestration.subtitle')}
        actions={
          <>
            {/* Templates are a view of the page reached from its header, as the reference draws them: pressed while open */}
            <button type="button" className="btn orch-templates-btn" aria-pressed={tab === 'templates'} onClick={tab === 'templates' ? closeTemplates : openTemplates}>
              {t('list.templates')}
              {templateCount !== undefined && <span className="count">{templateCount}</span>}
            </button>
            {!creating && (
              <button type="button" className={`btn ${emptyList ? '' : 'btn-primary'} page-action-fab`} onClick={() => setCreating(true)}>
                <Plus size={14} strokeWidth={2} aria-hidden />
                {t('config:orchestration.new')}
              </button>
            )}
          </>
        }
      />
      {creating && <CreateForm key={editing?.n ?? 'blank'} template={editing?.template} onDone={closeForm} />}
      <div className="stack">
        {tab === 'templates' ? (
          <section className="stack" aria-labelledby={templatesTitleId}>
            <div className="orch-view-bar">
              <h2 id={templatesTitleId} className="orch-panel-title">
                {t('list.templates')}
              </h2>
              <button type="button" className="btn btn-small" onClick={closeTemplates}>
                <ArrowLeft size={14} strokeWidth={2} aria-hidden />
                {t('config:detail.back')}
              </button>
            </div>
            <TemplatesList
              onEdit={(template) => {
                setEditing((prev) => ({ template, n: (prev?.n ?? 0) + 1 }));
                setCreating(true);
              }}
            />
          </section>
        ) : (
          <>
            <ListToolbar<StatusTab>
              tabs={{
                value: status,
                label: t('list.statusLabel'),
                onChange: (next) => setParam({ status: next === 'all' ? null : next }),
                options: STATUS_TABS.map((id) => ({ id, label: t(`list.status.${id}`), count: searched.filter((orch) => inTab(orch, id)).length })),
              }}
              search={{ value: query, onChange: (value) => setParam({ q: value }), placeholder: t('list.searchPlaceholder'), label: t('list.searchLabel') }}
              sort={{
                value: sort,
                label: t('list.sortLabel'),
                onChange: (next) => setParam({ sort: next === 'recent' ? null : next }),
                options: SORTS.map((value) => ({ value, label: t(`list.sort.${value}`) })),
              }}
            />
            <ErrorBox error={error} />
            {isLoading ? (
              <Loading />
            ) : list.length === 0 ? (
              <Empty
                illustration="orchestrations"
                size={narrow ? 'sm' : undefined}
                title={t('config:orchestration.none')}
                action={
                  <>
                    <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                      <Plus size={14} strokeWidth={2} aria-hidden />
                      {t('config:orchestration.new')}
                    </button>
                    <button type="button" className="btn" onClick={openTemplates}>
                      <LayoutTemplate size={14} strokeWidth={2} aria-hidden />
                      {t('list.templates')}
                    </button>
                  </>
                }
              >
                {t('list.emptyBody')}
              </Empty>
            ) : shown.length === 0 ? (
              <Empty
                illustration="no-results"
                size={narrow ? 'sm' : undefined}
                title={t('list.noMatch')}
                action={
                  <button type="button" className="btn" onClick={() => setParam({ q: null, status: null })}>
                    {t('list.showAll')}
                  </button>
                }
              >
                {t('list.noMatchBody')}
              </Empty>
            ) : (
              <ul className="orch-grid orch-list">
                {shown.map((orch) => (
                  <OrchestrationCard key={orch.id} orch={orch} energy={orch.id === energyId} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}
