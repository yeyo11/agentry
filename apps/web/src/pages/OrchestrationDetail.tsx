import type { Orchestration, OrchestrationTaskState, ResumeOrchestrationRequest } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BookmarkPlus, ChevronRight, Combine, ExternalLink, GitMerge, GitPullRequest, MessageSquare, Play, RotateCw, Rocket, Save, Square, Target, Trash2, Waypoints } from 'lucide-react';
import { useId, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, keys, useOrchestration } from '../api';
import { Collapsible, Switch } from '../components/controls';
import { useConfirm } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { ICON, ICON_SM } from '../components/icons';
import { BoardStatusBadge, StageHead, TaskCard, WaitingNotice } from '../components/OrchestrationBoard';
import { SaveTemplateDialog } from '../components/OrchestrationTemplates';
import { RelaunchPanel } from '../components/RelaunchPanel';
import { VerificationCard } from '../components/VerificationCard';
import { CodeBlock } from '../components/CodeBlock';
import { IntegrationChanges, TaskWork } from '../components/observe/Work';
import { RichText } from '../components/Transcript';
import { Card, ErrorBox, Field, Loading, PageHeader, StatusBadge } from '../components/ui';
import { durationBetween, formatCost, formatDateTime, shortPath } from '../lib/format';
import { costSplit } from '../lib/orchestration-board';
import { canRelaunch, rerunBlockedByPullRequest } from '../lib/orchestration-v2';

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

/**
 * The one branch a worktree graph delivers. Built by itself when the graph finishes; this shows
 * where it stands and offers the steps that stay a person's call: publishing it, and cleaning up.
 */
function IntegrationCard({ orch }: { orch: Orchestration }) {
  const { t } = useTranslation(['orchestrationDetail', 'config', 'common', 'observe']);
  const { t: tv } = useTranslation('orchestrationV2');
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
      if (res.url) toast.success(t('config:detail.prOpened'), res.url);
      else toast.info(t('config:detail.pushed', { branch: res.branch }), res.detail);
      void refresh();
    },
  });
  const prune = useMutation({
    mutationFn: () => api.pruneOrchestrationWorktrees(orch.id),
    onSuccess: ({ results }) => {
      const kept = results.filter((r) => !r.removed);
      if (kept.length) toast.info(t('config:detail.worktreesKept', { count: kept.length }), kept.map((k) => `${k.task}: ${k.detail}`).join('\n'));
      else toast.success(t('config:detail.worktreesRemoved'), t('config:detail.branchesKept'));
      void refresh();
    },
  });

  const branches = orch.tasks.filter((t) => t.branch && t.status === 'completed').length;
  // While the graph runs or waits for a decision the integration is held: it is built from what is left when it finishes
  const held = orch.status === 'running' || orch.status === 'waiting';
  if (!integration && (held || branches === 0)) return null;
  const busy = integration && ['merging', 'resolving'].includes(integration.status);
  const idle = !held && !busy;
  const hasWorktrees = orch.tasks.some((t) => t.worktree) || Boolean(integration?.worktree);
  // The branch is offered once the checks have said what they found, not while they still run
  const checking = orch.verification?.status === 'running' || orch.verification?.status === 'pending';

  return (
    <Card
      title={
        <span className="title-icon">
          <GitMerge {...ICON_SM} /> {t('config:detail.integration')}
        </span>
      }
      actions={
        idle && (
          <>
            {integration?.status === 'merged' &&
              (integration.pullRequestUrl ? (
                <a className="btn btn-small" href={integration.pullRequestUrl} target="_blank" rel="noreferrer">
                  <ExternalLink {...ICON_SM} /> {t('config:detail.pullRequest')}
                </a>
              ) : (
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  disabled={publish.isPending || checking}
                  onClick={() =>
                    void confirm({
                      title: t('config:detail.pushTitle', { branch: integration.branch }),
                      body: t('config:detail.pushBody'),
                      confirmLabel: t('config:detail.pushConfirm'),
                    }).then((ok) => {
                      if (ok) publish.mutate();
                    })
                  }
                >
                  <GitPullRequest {...ICON_SM} /> {publish.isPending ? t('config:detail.pushing') : t('config:detail.push')}
                </button>
              ))}
            {integration?.status !== 'merged' && (
              <button type="button" className="btn btn-small" disabled={integrate.isPending} onClick={() => integrate.mutate()}>
                <RotateCw {...ICON_SM} /> {integration ? t('config:detail.integrateAgain') : t('config:detail.integrate')}
              </button>
            )}
            {hasWorktrees && integration?.status === 'merged' && (
              <button
                type="button"
                className="btn btn-small"
                disabled={prune.isPending}
                onClick={() =>
                  void confirm({
                    title: t('config:detail.pruneTitle'),
                    body: t('config:detail.pruneBody'),
                    confirmLabel: t('common:actions.remove'),
                  }).then((ok) => {
                    if (ok) prune.mutate();
                  })
                }
              >
                <Trash2 {...ICON_SM} /> {t('config:detail.prune')}
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
            <span>{t('config:detail.merged', { merged: integration.merged.length, count: branches })}</span>
            {integration.integratorRunId && <Link to={`/chats/${integration.integratorRunId}`}>{t('integratorChat')}</Link>}
          </div>
          {checking && <p className="muted small">{tv('verification.holdsPush')}</p>}
          {integration.status === 'resolving' && (
            <p className="muted small">{t('config:detail.resolving')}</p>
          )}
          {integration.conflicts.length > 0 && (
            <ul className="small">
              {integration.conflicts.map((c) => (
                <li key={c.taskId}>
                  <Trans
                    t={t}
                    i18nKey="config:detail.conflict"
                    values={{ task: c.taskId, paths: c.paths.join(', ') }}
                    components={{ mono: <span className="mono" /> }}
                  />
                </li>
              ))}
            </ul>
          )}
          {integration.error && <div className="alert alert-warn small">{integration.error}</div>}
          {integration.worktree && (
            <Collapsible className="fold" title={t('observe:changes.integrationTitle')}>
              <IntegrationChanges orch={orch} />
            </Collapsible>
          )}
        </>
      ) : (
        <p className="muted small">{t('config:detail.legacy', { count: branches })}</p>
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
  const { t } = useTranslation(['orchestrationDetail', 'config', 'common']);
  const toast = useToast();
  const [name, setName] = useState('');
  const script = useQuery({ queryKey: ['orchestrations', orch.id, 'workflow'], queryFn: () => api.orchestrationWorkflow(orch.id) });
  const save = useMutation({
    mutationFn: (overwrite: boolean) => api.saveOrchestrationWorkflow(orch.id, { ...(name.trim() ? { name: name.trim() } : {}), overwrite }),
    onSuccess: (saved) => toast.success(t('config:detail.savedAs', { name: saved.name }), saved.path),
  });
  return (
    <Card
      title={
        <span className="title-icon">
          <Waypoints {...ICON_SM} /> {t('config:orchestration.workflow')}
        </span>
      }
      actions={
        orch.workflow?.runId ? (
          <Link to={`/chats/${orch.workflow.runId}`} className="btn btn-small">
            <ExternalLink {...ICON_SM} /> {t('config:detail.openRun')}
          </Link>
        ) : undefined
      }
    >
      <p className="muted small">
        {t('config:detail.workflowIntro')}
        {orch.workflow?.workflowRunId ? t('config:detail.workflowRun', { id: orch.workflow.workflowRunId }) : ''}
      </p>
      {orch.engineReason && <p className="small">{t('config:orchestration.plannerReason', { reason: orch.engineReason })}</p>}
      <Collapsible className="fold" title={<span className="tool-name">{t('config:detail.script')}</span>}>
        {script.data ? <CodeBlock code={script.data.script} lang="js" /> : <ErrorBox error={script.error} />}
      </Collapsible>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(false);
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('config:detail.workflowNamePlaceholder')} aria-label={t('config:detail.workflowName')} />
        <button type="submit" className="btn btn-small" disabled={save.isPending}>
          <Save {...ICON_SM} /> {t('config:detail.saveWorkflow')}
        </button>
      </form>
      <p className="muted small">{t('config:detail.saveWorkflowHint')}</p>
      {save.error && (
        <div className="stack-tight">
          <ErrorBox error={save.error} />
          {String((save.error as Error).message).includes('already exists') && (
            <button type="button" className="btn btn-small btn-danger" onClick={() => save.mutate(true)}>
              {t('config:detail.replace')}
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
  const { t } = useTranslation(['orchestrationDetail', 'config', 'common']);
  const [worktree, setWorktree] = useState(true);
  const [askPermissions, setAskPermissions] = useState(true);
  const [tools, setTools] = useState(orch.allowedTools.length ? orch.allowedTools.join(',') : SAFE_TOOLS);
  const workflow = orch.engine === 'workflow';
  // A workflow runs in the project directory by design: only its prompts can have stopped it
  const risky = (!workflow && !orch.worktree) || orch.permissionPrompts !== 'host';

  return (
    <Card title={t('config:detail.resumeUnfinished', { count: unfinished })}>
      <p className="muted small">
        {t('config:detail.kept', { count: orch.tasks.length - unfinished })}
        {workflow ? t('config:detail.keptWorkflow') : ''}
      </p>
      {risky && (
        <p className="alert alert-warn small">
          {!workflow && !orch.worktree
            ? orch.permissionPrompts !== 'host'
              ? t('config:detail.risky.both')
              : t('config:detail.risky.worktree')
            : t('config:detail.risky.prompts')}
        </p>
      )}
      {!workflow && (
        <Switch checked={worktree} onChange={setWorktree}>
          {t('config:orchestration.worktree')}
        </Switch>
      )}
      <Switch checked={askPermissions} onChange={setAskPermissions}>
        {t('config:orchestration.askPermissions')}
      </Switch>
      <Field label={t('config:orchestration.tools')} hint={t('config:detail.toolsHint')}>
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
                .map((t) => t.trim())
                .filter(Boolean),
            })
          }
        >
          <Play {...ICON_SM} /> {pending ? t('config:detail.resuming') : t('config:detail.resume', { count: unfinished })}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          {t('common:actions.cancel')}
        </button>
      </div>
    </Card>
  );
}

export function OrchestrationDetail() {
  const { t } = useTranslation(['orchestrationDetail', 'config', 'common']);
  const { t: tv } = useTranslation('orchestrationV2');
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const { data: orch, error, isLoading } = useOrchestration(id);
  const stop = useMutation({
    mutationFn: () => api.stopOrchestration(id),
    onSuccess: (next) => queryClient.setQueryData(keys.orchestration(id), next),
  });
  const navigate = useNavigate();
  const confirm = useConfirm();
  const boardId = useId();
  const [params, setParams] = useSearchParams();
  const [resuming, setResuming] = useState(false);
  const [relaunching, setRelaunching] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
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
  if (!orch) return <ErrorBox error={error ?? new Error(t('config:detail.notFound'))} />;

  const layers = layerTasks(orch.tasks);
  // Which task's work is open under the board: in the address, so a link to it opens the same panel
  const inspected = orch.tasks.find((task) => task.id === params.get('task')) ?? null;
  const inspect = (taskId: string | null) => setParams(taskId ? { task: taskId } : {}, { replace: true });
  const { other } = costSplit(orch);
  // Workers die with the wrapper, so an interrupted graph can be picked up from where it stopped.
  const unfinished = orch.tasks.filter((t) => t.status !== 'completed').length;
  const synthesis = orch.finalResult ? 'completed' : orch.status === 'running' ? 'pending' : orch.status === 'waiting' ? 'held' : 'skipped';
  const counts = orch.tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        docTitle={t('config:detail.docTitle', { name: orch.name })}
        title={
          <>
            <Link to="/orchestration" className="title-back" aria-label={t('config:detail.back')}>
              <ArrowLeft {...ICON} />
            </Link>
            {orch.name}
          </>
        }
        subtitle={
          <span className="meta">
            <BoardStatusBadge status={orch.status} />
            <span title={orch.cwd}>{shortPath(orch.cwd)}</span>
            <span>{orch.model ?? t('config:detail.defaultModel')}</span>
            <span>{orch.permissionMode}</span>
            <span>{t('config:orchestration.concurrencyValue', { n: orch.concurrency })}</span>
            {orch.engine === 'workflow' ? <span>{t('config:detail.workflowEngine')}</span> : orch.worktree && <span>{t('config:detail.worktreePerTask')}</span>}
            <span title={other > 0 ? t('costOnNoTask', { cost: formatCost(other) }) : undefined}>
              {t('config:detail.total', { cost: formatCost(orch.costUsd) })}
            </span>
            <span>{durationBetween(orch.createdAt, orch.endedAt)}</span>
            <span>{t('config:detail.created', { date: formatDateTime(orch.createdAt) })}</span>
            {orch.relaunchedFrom && (
              <Link to={`/orchestration/${orch.relaunchedFrom}`}>{tv('origin.relaunchedFrom')}</Link>
            )}
            {orch.templateId && <span>{tv('origin.fromTemplate')}</span>}
          </span>
        }
        actions={
          // Waiting is stoppable but nothing else: resuming or deleting would throw away the decision it waits for
          orch.status === 'running' || orch.status === 'waiting' ? (
            <button className="btn btn-danger" disabled={stop.isPending} onClick={() => stop.mutate()}>
              <Square {...ICON_SM} /> {t('config:detail.stop')}
            </button>
          ) : (
            <>
              {unfinished > 0 && !resuming && (
                <button className="btn btn-primary" onClick={() => setResuming(true)}>
                  <Play {...ICON_SM} /> {t('config:detail.resume', { count: unfinished })}
                </button>
              )}
              {canRelaunch(orch) && !relaunching && (
                <button className="btn" onClick={() => setRelaunching(true)}>
                  <Rocket {...ICON_SM} /> {tv('relaunch.button')}
                </button>
              )}
              <button className="btn" onClick={() => setSavingTemplate(true)}>
                <BookmarkPlus {...ICON_SM} /> {tv('templates.saveAs')}
              </button>
              <button
                className="btn btn-danger"
                disabled={remove.isPending}
                onClick={() =>
                  void confirm({
                    title: t('deleteTitle', { name: orch.name }),
                    body: t('config:detail.deleteBody'),
                    confirmLabel: t('common:actions.delete'),
                    danger: true,
                  }).then((ok) => {
                    if (ok) remove.mutate();
                  })
                }
              >
                <Trash2 {...ICON_SM} /> {t('common:actions.delete')}
              </button>
            </>
          )
        }
      />
      <ErrorBox error={error ?? stop.error ?? resume.error ?? remove.error} />
      <WaitingNotice orch={orch} />
      {resuming && (
        <ResumePanel
          orch={orch}
          unfinished={unfinished}
          pending={resume.isPending}
          onResume={(changes) => resume.mutate(changes)}
          onCancel={() => setResuming(false)}
        />
      )}

      {relaunching && <RelaunchPanel orch={orch} onCancel={() => setRelaunching(false)} />}
      {savingTemplate && <SaveTemplateDialog fromOrchestration={orch.id} defaultName={orch.name} onClose={() => setSavingTemplate(false)} />}

      {orch.objective && (
        <Card
          title={
            <span className="title-icon">
              <Target {...ICON_SM} /> {t('config:orchestration.objective')}
            </span>
          }
        >
          <div className="prose">{orch.objective}</div>
        </Card>
      )}

      <div className="meta">
        {Object.entries(counts).map(([status, n]) => (
          <span key={status}>
            <BoardStatusBadge status={status as OrchestrationTaskState['status']} /> <span className="count">{n}</span>
          </span>
        ))}
      </div>

      {/* Scrolls sideways on a wide graph, so it is a focusable, named region: a keyboard can scroll it */}
      <section className="board" tabIndex={0} aria-labelledby={boardId}>
        <h2 id={boardId} className="sr-only">
          {t('taskBoard')}
        </h2>
        <ol className="board-track">
          {layers.map((layer, level) => (
            <li key={level} className="board-col">
              {level > 0 && (
                <span className={`board-link ${layer.some((t) => t.status === 'running') ? 'is-flowing' : ''}`} aria-hidden>
                  <ChevronRight size={12} strokeWidth={2} />
                </span>
              )}
              <StageHead title={level === 0 ? t('config:detail.firstStage') : t('config:detail.stage', { n: level + 1 })} tasks={layer} />
              {layer.map((task) => (
                <TaskCard key={task.id} orch={orch} task={task} inspected={inspected?.id === task.id} onInspect={() => inspect(inspected?.id === task.id ? null : task.id)} />
              ))}
            </li>
          ))}
          {orch.synthesize && (
            <li className="board-col">
              <span className="board-link" aria-hidden>
                <ChevronRight size={12} strokeWidth={2} />
              </span>
              <div className="board-col-head">
                <Combine {...ICON_SM} />
                <h3 className="board-col-title">{t('config:detail.synthesis')}</h3>
              </div>
              <article className={`board-task status-${synthesis}`} aria-label={t('config:detail.synthesis')}>
                <BoardStatusBadge status={synthesis} />
                <div className="small muted">
                  {synthesis === 'held' ? t('synthesisHeld') : t('config:detail.synthesisHint')}
                </div>
                {orch.synthesisRunId && (
                  <div className="meta">
                    <Link to={`/chats/${orch.synthesisRunId}`} className="meta-icon">
                      <MessageSquare size={12} strokeWidth={1.75} aria-hidden /> {t('chat')}
                    </Link>
                  </div>
                )}
              </article>
            </li>
          )}
        </ol>
      </section>

      {inspected && <TaskWork orch={orch} task={inspected} onClose={() => inspect(null)} />}

      {rerunBlockedByPullRequest(orch) && <p className="muted small">{tv('rerun.blockedByPullRequest')}</p>}

      <VerificationCard orch={orch} />
      {orch.engine === 'workflow' ? <WorkflowCard orch={orch} /> : <IntegrationCard orch={orch} />}

      {orch.finalResult && (
        <Card
          title={t('config:detail.finalResult')}
          actions={
            // The report is a conversation: asking it to change or finish something continues it
            orch.synthesisRunId && (
              <Link className="btn btn-small" to={`/chats/${orch.synthesisRunId}`}>
                <MessageSquare {...ICON_SM} /> {t('config:detail.continue')}
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
