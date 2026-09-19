import type { Orchestration, OrchestrationTaskState, ResumeOrchestrationRequest } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, Combine, CornerDownRight, ExternalLink, GitMerge, GitPullRequest, MessageSquare, Play, RotateCw, Save, Square, Target, Trash2, Waypoints } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, keys, useOrchestration } from '../api';
import { Collapsible, Switch } from '../components/controls';
import { useConfirm } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { ICON, ICON_SM } from '../components/icons';
import { motion, ProgressRing, useReducedMotion } from '../components/motion';
import { CodeBlock } from '../components/CodeBlock';
import { RichText } from '../components/Transcript';
import { Card, ErrorBox, Field, Loading, PageHeader, StatusBadge } from '../components/ui';
import { durationBetween, formatCost, formatDateTime, shortPath } from '../lib/format';

/** Groups tasks into columns by topological level (longest dependency chain). Cycles are tolerated. */
function layerTasks(tasks: OrchestrationTaskState[]): OrchestrationTaskState[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (id: string): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
    const level = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(levelOf));
    visiting.delete(id);
    levels.set(id, level);
    return level;
  };
  const layers: OrchestrationTaskState[][] = [];
  for (const task of tasks) {
    const level = levelOf(task.id);
    (layers[level] ??= []).push(task);
  }
  return Array.from(layers, (layer) => layer ?? []);
}

const DONE = new Set(['completed', 'failed', 'skipped', 'stopped']);

function StageHead({ title, tasks }: { title: string; tasks: OrchestrationTaskState[] }) {
  const done = tasks.filter((t) => DONE.has(t.status)).length;
  const failed = tasks.some((t) => t.status === 'failed');
  const value = tasks.length === 0 ? 0 : done / tasks.length;
  return (
    <div className="board-col-head">
      <ProgressRing value={value} size={26} stroke={3.5} tone={failed ? 'bad' : value === 1 ? 'ok' : 'accent'} />
      <span className="board-col-title">{title}</span>
      <span className="count">
        {done}/{tasks.length}
      </span>
    </div>
  );
}

function TaskCard({ task }: { task: OrchestrationTaskState }) {
  const { t } = useTranslation('config');
  const reduced = useReducedMotion();
  return (
    // Keyed on status so a task visibly settles into its new state when it changes
    <motion.div
      key={task.status}
      className={`board-task status-${task.status}`}
      initial={reduced ? false : { opacity: 0.4, scale: 0.98 }}
      animate={{ opacity: task.status === 'skipped' ? 0.6 : 1, scale: 1 }}
      transition={{ duration: 0.3 }}
    >
      <div className="side-item-head">
        <StatusBadge status={task.status} />
        <span className="muted small">{task.startedAt ? durationBetween(task.startedAt, task.endedAt) : ''}</span>
      </div>
      <div className="strong">{task.name || task.id}</div>
      <div className="mono small muted">{task.id}</div>
      {(task.dependsOn?.length ?? 0) > 0 && (
        <div className="small muted meta-icon">
          <CornerDownRight size={12} strokeWidth={1.75} aria-hidden /> {t('detail.after', { deps: task.dependsOn?.join(', ') })}
        </div>
      )}
      <Collapsible className="fold" title={t('orchestration.prompt')}>
        <div className="prose small">{task.prompt}</div>
      </Collapsible>
      {task.error && <div className="alert alert-bad small">{task.error}</div>}
      {task.result && (
        <Collapsible className="fold" title={t('detail.result')}>
          <RichText text={task.result} />
        </Collapsible>
      )}
      <div className="meta">
        {task.runId && <Link to={`/runs/${task.runId}`}>{t('detail.run')}</Link>}
        {task.sessionId && <Link to={`/sessions/${task.sessionId}`}>{t('detail.session')}</Link>}
        {task.model && <span>{task.model}</span>}
        {task.costUsd > 0 && <span>{formatCost(task.costUsd)}</span>}
        {/* The branch is how the work is found afterwards, so it is worth the space */}
        {task.branch && (
          <span className="mono" title={task.worktree ?? undefined}>
            {task.branch}
          </span>
        )}
      </div>
    </motion.div>
  );
}

/**
 * The one branch a worktree graph delivers. Built by itself when the graph finishes; this shows
 * where it stands and offers the steps that stay a person's call: publishing it, and cleaning up.
 */
function IntegrationCard({ orch }: { orch: Orchestration }) {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const integration = orch.integration ?? null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.orchestration(orch.id) });
  const integrate = useMutation({
    mutationFn: () => api.integrateOrchestration(orch.id),
    onSuccess: (next) => queryClient.setQueryData(keys.orchestration(orch.id), next),
  });
  const publish = useMutation({
    mutationFn: () => api.orchestrationPullRequest(orch.id),
    onSuccess: (res) => {
      if (res.url) toast.success(t('detail.prOpened'), res.url);
      else toast.info(t('detail.pushed', { branch: res.branch }), res.detail);
      void refresh();
    },
  });
  const prune = useMutation({
    mutationFn: () => api.pruneOrchestrationWorktrees(orch.id),
    onSuccess: ({ results }) => {
      const kept = results.filter((r) => !r.removed);
      if (kept.length) toast.info(t('detail.worktreesKept', { count: kept.length }), kept.map((k) => `${k.task}: ${k.detail}`).join('\n'));
      else toast.success(t('detail.worktreesRemoved'), t('detail.branchesKept'));
      void refresh();
    },
  });

  const branches = orch.tasks.filter((task) => task.branch && task.status === 'completed').length;
  if (!integration && (orch.status === 'running' || branches === 0)) return null;
  const busy = integration && ['merging', 'resolving'].includes(integration.status);
  const idle = orch.status !== 'running' && !busy;
  const hasWorktrees = orch.tasks.some((task) => task.worktree) || Boolean(integration?.worktree);

  return (
    <Card
      title={
        <span className="title-icon">
          <GitMerge {...ICON_SM} /> {t('detail.integration')}
        </span>
      }
      actions={
        idle && (
          <>
            {integration?.status === 'merged' &&
              (integration.pullRequestUrl ? (
                <a className="btn btn-small" href={integration.pullRequestUrl} target="_blank" rel="noreferrer">
                  <ExternalLink {...ICON_SM} /> {t('detail.pullRequest')}
                </a>
              ) : (
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  disabled={publish.isPending}
                  onClick={() =>
                    void confirm({
                      title: t('detail.pushTitle', { branch: integration.branch }),
                      body: t('detail.pushBody'),
                      confirmLabel: t('detail.pushConfirm'),
                    }).then((ok) => {
                      if (ok) publish.mutate();
                    })
                  }
                >
                  <GitPullRequest {...ICON_SM} /> {publish.isPending ? t('detail.pushing') : t('detail.push')}
                </button>
              ))}
            {integration?.status !== 'merged' && (
              <button type="button" className="btn btn-small" disabled={integrate.isPending} onClick={() => integrate.mutate()}>
                <RotateCw {...ICON_SM} /> {integration ? t('detail.integrateAgain') : t('detail.integrate')}
              </button>
            )}
            {hasWorktrees && integration?.status === 'merged' && (
              <button
                type="button"
                className="btn btn-small"
                disabled={prune.isPending}
                onClick={() =>
                  void confirm({
                    title: t('detail.pruneTitle'),
                    body: t('detail.pruneBody'),
                    confirmLabel: t('shared.remove'),
                  }).then((ok) => {
                    if (ok) prune.mutate();
                  })
                }
              >
                <Trash2 {...ICON_SM} /> {t('detail.prune')}
              </button>
            )}
          </>
        )
      }
    >
      {integration ? (
        <>
          <div className="meta">
            <StatusBadge status={integration.status} />
            <span className="mono" title={integration.worktree ?? undefined}>
              {integration.branch}
            </span>
            {integration.commit && <span className="mono">{integration.commit.slice(0, 8)}</span>}
            <span>{t('detail.merged', { merged: integration.merged.length, count: branches })}</span>
            {integration.integratorRunId && <Link to={`/runs/${integration.integratorRunId}`}>{t('detail.integratorRun')}</Link>}
          </div>
          {integration.status === 'resolving' && (
            <p className="muted small">{t('detail.resolving')}</p>
          )}
          {integration.conflicts.length > 0 && (
            <ul className="small">
              {integration.conflicts.map((c) => (
                <li key={c.taskId}>
                  <Trans
                    t={t}
                    i18nKey="detail.conflict"
                    values={{ task: c.taskId, paths: c.paths.join(', ') }}
                    components={{ mono: <span className="mono" /> }}
                  />
                </li>
              ))}
            </ul>
          )}
          {integration.error && <div className="alert alert-warn small">{integration.error}</div>}
        </>
      ) : (
        <p className="muted small">
          {t('detail.legacy', { count: branches })}
        </p>
      )}
      <ErrorBox error={integrate.error ?? publish.error ?? prune.error} />
    </Card>
  );
}

const SAFE_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep';

/**
 * Resuming keeps completed work but relaunches the rest with whatever settings the graph has, so a
 * graph that stopped for lack of permissions or by editing the wrapper's own checkout would stop the
 * same way again. This offers to correct those first, with the settings that avoid both already on.
 */
/**
 * A graph on the workflow engine: the one run that runs it, and the script generated from it, which
 * can be kept as a workflow of the project and run from then on by name.
 */
function WorkflowCard({ orch }: { orch: Orchestration }) {
  const { t } = useTranslation('config');
  const toast = useToast();
  const [name, setName] = useState('');
  const script = useQuery({ queryKey: ['orchestrations', orch.id, 'workflow'], queryFn: () => api.orchestrationWorkflow(orch.id) });
  const save = useMutation({
    mutationFn: (overwrite: boolean) => api.saveOrchestrationWorkflow(orch.id, { ...(name.trim() ? { name: name.trim() } : {}), overwrite }),
    onSuccess: (saved) => toast.success(t('detail.savedAs', { name: saved.name }), saved.path),
  });
  return (
    <Card
      title={
        <span className="title-icon">
          <Waypoints {...ICON_SM} /> {t('orchestration.workflow')}
        </span>
      }
      actions={
        orch.workflow?.runId ? (
          <Link to={`/runs/${orch.workflow.runId}`} className="btn btn-small">
            <ExternalLink {...ICON_SM} /> {t('detail.openRun')}
          </Link>
        ) : undefined
      }
    >
      <p className="muted small">
        {t('detail.workflowIntro')}
        {orch.workflow?.workflowRunId ? t('detail.workflowRun', { id: orch.workflow.workflowRunId }) : ''}
      </p>
      {orch.engineReason && <p className="small">{t('orchestration.plannerReason', { reason: orch.engineReason })}</p>}
      <Collapsible className="fold" title={<span className="tool-name">{t('detail.script')}</span>}>
        {script.data ? <CodeBlock code={script.data.script} lang="js" /> : <ErrorBox error={script.error} />}
      </Collapsible>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(false);
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('detail.workflowNamePlaceholder')}
          aria-label={t('detail.workflowName')}
        />
        <button type="submit" className="btn btn-small" disabled={save.isPending}>
          <Save {...ICON_SM} /> {t('detail.saveWorkflow')}
        </button>
      </form>
      <p className="muted small">{t('detail.saveWorkflowHint')}</p>
      {save.error && (
        <div className="stack-tight">
          <ErrorBox error={save.error} />
          {String((save.error as Error).message).includes('already exists') && (
            <button type="button" className="btn btn-small btn-danger" onClick={() => save.mutate(true)}>
              {t('detail.replace')}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

function ResumePanel({
  orch,
  unfinished,
  pending,
  onResume,
  onCancel,
}: {
  orch: Orchestration;
  unfinished: number;
  pending: boolean;
  onResume: (changes: ResumeOrchestrationRequest) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('config');
  const [worktree, setWorktree] = useState(true);
  const [askPermissions, setAskPermissions] = useState(true);
  const [tools, setTools] = useState(orch.allowedTools.length ? orch.allowedTools.join(',') : SAFE_TOOLS);
  const workflow = orch.engine === 'workflow';
  // A workflow runs in the project directory by design: only its prompts can have stopped it
  const risky = (!workflow && !orch.worktree) || orch.permissionPrompts !== 'host';

  return (
    <Card title={t('detail.resumeUnfinished', { count: unfinished })}>
      <p className="muted small">
        {t('detail.kept', { count: orch.tasks.length - unfinished })}
        {workflow ? t('detail.keptWorkflow') : ''}
      </p>
      {risky && (
        <p className="alert alert-warn small">
          {!workflow && !orch.worktree
            ? orch.permissionPrompts !== 'host'
              ? t('detail.risky.both')
              : t('detail.risky.worktree')
            : t('detail.risky.prompts')}
        </p>
      )}
      {!workflow && (
        <Switch checked={worktree} onChange={setWorktree}>
          {t('orchestration.worktree')}
        </Switch>
      )}
      <Switch checked={askPermissions} onChange={setAskPermissions}>
        {t('orchestration.askPermissions')}
      </Switch>
      <Field label={t('orchestration.tools')} hint={t('detail.toolsHint')}>
        <input value={tools} onChange={(e) => setTools(e.target.value)} placeholder={SAFE_TOOLS} />
      </Field>
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending}
          onClick={() =>
            onResume({
              ...(workflow ? {} : { worktree }),
              permissionPrompts: askPermissions ? 'host' : 'none',
              allowedTools: tools
                .split(',')
                .map((tool) => tool.trim())
                .filter(Boolean),
            })
          }
        >
          <Play {...ICON_SM} /> {pending ? t('detail.resuming') : t('detail.resume', { count: unfinished })}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          {t('shared.cancel')}
        </button>
      </div>
    </Card>
  );
}

export function OrchestrationDetail() {
  const { t } = useTranslation('config');
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const { data: orch, error, isLoading } = useOrchestration(id);
  const stop = useMutation({
    mutationFn: () => api.stopOrchestration(id),
    onSuccess: (next) => queryClient.setQueryData(keys.orchestration(id), next),
  });
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [resuming, setResuming] = useState(false);
  const resume = useMutation({
    mutationFn: (changes: ResumeOrchestrationRequest) => api.resumeOrchestration(id, changes),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.orchestration(id), next);
      setResuming(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteOrchestration(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.orchestrations });
      navigate('/orchestration');
    },
  });

  if (isLoading) return <Loading />;
  if (!orch) return <ErrorBox error={error ?? new Error(t('detail.notFound'))} />;

  const layers = layerTasks(orch.tasks);
  // Workers die with the wrapper, so an interrupted graph can be picked up from where it stopped.
  const unfinished = orch.tasks.filter((task) => task.status !== 'completed').length;
  const counts = orch.tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        docTitle={t('detail.docTitle', { name: orch.name })}
        title={
          <>
            <Link to="/orchestration" className="title-back" aria-label={t('detail.back')}>
              <ArrowLeft {...ICON} />
            </Link>
            {orch.name}
          </>
        }
        subtitle={
          <span className="meta">
            <StatusBadge status={orch.status} />
            <span title={orch.cwd}>{shortPath(orch.cwd)}</span>
            <span>{orch.model ?? t('detail.defaultModel')}</span>
            <span>{orch.permissionMode}</span>
            <span>{t('orchestration.concurrencyValue', { n: orch.concurrency })}</span>
            {orch.engine === 'workflow' ? <span>{t('detail.workflowEngine')}</span> : orch.worktree && <span>{t('detail.worktreePerTask')}</span>}
            <span>{t('detail.total', { cost: formatCost(orch.costUsd) })}</span>
            <span>{durationBetween(orch.createdAt, orch.endedAt)}</span>
            <span>{t('detail.created', { date: formatDateTime(orch.createdAt) })}</span>
          </span>
        }
        actions={
          orch.status === 'running' ? (
            <button className="btn btn-danger" disabled={stop.isPending} onClick={() => stop.mutate()}>
              <Square {...ICON_SM} /> {t('detail.stop')}
            </button>
          ) : (
            <>
              {unfinished > 0 && !resuming && (
                <button className="btn btn-primary" onClick={() => setResuming(true)}>
                  <Play {...ICON_SM} /> {t('detail.resume', { count: unfinished })}
                </button>
              )}
              <button
                className="btn btn-danger"
                disabled={remove.isPending}
                onClick={() =>
                  void confirm({
                    title: t('files.deleteTitle', { path: orch.name }),
                    body: t('detail.deleteBody'),
                    confirmLabel: t('shared.delete'),
                    danger: true,
                  }).then((ok) => {
                    if (ok) remove.mutate();
                  })
                }
              >
                <Trash2 {...ICON_SM} /> {t('shared.delete')}
              </button>
            </>
          )
        }
      />
      <ErrorBox error={error ?? stop.error ?? resume.error ?? remove.error} />
      {resuming && (
        <ResumePanel
          orch={orch}
          unfinished={unfinished}
          pending={resume.isPending}
          onResume={(changes) => resume.mutate(changes)}
          onCancel={() => setResuming(false)}
        />
      )}

      {orch.objective && (
        <Card
          title={
            <span className="title-icon">
              <Target {...ICON_SM} /> {t('orchestration.objective')}
            </span>
          }
        >
          <div className="prose">{orch.objective}</div>
        </Card>
      )}

      <div className="meta">
        {Object.entries(counts).map(([status, n]) => (
          <span key={status}>
            <StatusBadge status={status} /> <span className="count">{n}</span>
          </span>
        ))}
      </div>

      <div className="board">
        {layers.map((layer, level) => (
          <div key={level} className="board-col">
            {level > 0 && (
              <span className={`board-link ${layer.some((task) => task.status === 'running') ? 'is-flowing' : ''}`} aria-hidden>
                <ChevronRight size={12} strokeWidth={2} />
              </span>
            )}
            <StageHead title={level === 0 ? t('detail.firstStage') : t('detail.stage', { n: level + 1 })} tasks={layer} />
            {layer.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </div>
        ))}
        {orch.synthesize && (
          <div className="board-col">
            <span className={`board-link ${orch.status === 'running' && !orch.finalResult ? '' : ''}`} aria-hidden>
              <ChevronRight size={12} strokeWidth={2} />
            </span>
            <div className="board-col-head">
              <Combine {...ICON_SM} />
              <span className="board-col-title">{t('detail.synthesis')}</span>
            </div>
            <div className={`board-task status-${orch.finalResult ? 'completed' : orch.status === 'running' ? 'pending' : 'skipped'}`}>
              <StatusBadge status={orch.finalResult ? 'completed' : orch.status === 'running' ? 'pending' : 'skipped'} />
              <div className="small muted">{t('detail.synthesisHint')}</div>
              {orch.synthesisRunId && (
                <div className="meta">
                  <Link to={`/runs/${orch.synthesisRunId}`}>{t('detail.run')}</Link>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {orch.engine === 'workflow' ? <WorkflowCard orch={orch} /> : <IntegrationCard orch={orch} />}

      {orch.finalResult && (
        <Card
          title={t('detail.finalResult')}
          actions={
            // The report is a conversation: asking it to change or finish something continues it
            orch.synthesisRunId && (
              <Link className="btn btn-small" to={`/runs/${orch.synthesisRunId}`}>
                <MessageSquare {...ICON_SM} /> {t('detail.continue')}
              </Link>
            )
          }
        >
          <RichText text={orch.finalResult} />
        </Card>
      )}
    </>
  );
}
