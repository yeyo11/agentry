import type { ChatWorkflow, Orchestration, ResumeOrchestrationRequest } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BookmarkPlus, ChevronRight, Combine, ExternalLink, FolderGit2, GitMerge, GitPullRequest, MessageSquare, Play, Radio, RotateCw, Rocket, Save, Square, Trash2, Waypoints } from 'lucide-react';
import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiRequestError, keys, useOrchestration } from '../api';
import { AnimatedNumber } from '../components/AnimatedNumber';
import { CodeBlock } from '../components/CodeBlock';
import { Collapsible, Menu, Switch, type MenuEntry } from '../components/controls';
import { useConfirm } from '../components/Dialog';
import { ICON, ICON_SM } from '../components/icons';
import { BoardStatusBadge, StageHead, TaskCard, TaskRow, WaitingNotice } from '../components/OrchestrationBoard';
import { SaveTemplateDialog } from '../components/OrchestrationTemplates';
import { RelaunchPanel } from '../components/RelaunchPanel';
import { Stepper, type StepItem } from '../components/Stepper';
import { useToast } from '../components/Toast';
import { RichText } from '../components/Transcript';
import { FailedByChecksNotice, VerificationCard } from '../components/VerificationCard';
import { WorkflowCard as WorkflowRunCard } from '../components/WorkflowCard';
import { IntegrationChanges, TaskWork } from '../components/observe/Work';
import { Card, Empty, ErrorBox, Field, Loading, Segmented, StatusBadge, usePageTitle } from '../components/ui';
import { formatCost, formatDateTime, formatNumber, shortPath } from '../lib/format';
import { elapsedSince, formatElapsed } from '../lib/live';
import { NARROW, useMediaQuery } from '../lib/media';
import { useClockTick } from '../lib/motion';
import { costSplit } from '../lib/orchestration-board';
import { followedStep, layerTasks, orchestrationSteps, type OrchestrationStep } from '../lib/orchestration-steps';
import { canRelaunch, pullRequestHeld, rerunBlockedByPullRequest } from '../lib/orchestration-v2';

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
  const prHeld = pullRequestHeld(orch);

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
              ) : prHeld ? null : (
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
          {prHeld && !integration.pullRequestUrl && <p className="muted small">{tv('verification.pullRequestHeld')}</p>}
          {integration.status === 'resolving' && <p className="muted small">{t('config:detail.resolving')}</p>}
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

/**
 * Resuming keeps completed work but relaunches the rest with whatever settings the graph has, so a
 * graph that stopped for lack of permissions or by editing the wrapper's own checkout would stop the
 * same way again. This offers to correct those first, with the settings that avoid both already on.
 */
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

/** Three lines of the objective, the rest a click away: it is context, and the progress is what the page is opened for. */
function Objective({ text }: { text: string }) {
  const { t } = useTranslation('orchestrationDetail');
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  return (
    <section className="orch-objective" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="section-label">
        {t('objective')}
      </h2>
      <div id={id} ref={ref} className={`prose orch-objective-text ${open ? '' : 'is-clamped'}`.trim()}>
        {text}
      </div>
      {(overflows || open) && (
        <button type="button" className="link-btn small" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
          {open ? t('showLess') : t('showMore')}
        </button>
      )}
    </section>
  );
}

/** The run of the workflow engine, from its chat: what gives the steps of a workflow orchestration their phases. */
function useWorkflowRun(orch: Orchestration | undefined): ChatWorkflow | null {
  const runId = orch?.engine === 'workflow' ? (orch.workflow?.runId ?? null) : null;
  const { data } = useQuery({
    queryKey: ['orchestrations', orch?.id, 'workflow-run', runId],
    queryFn: () => api.chat(runId ?? '', false, { limit: 1 }),
    enabled: runId !== null,
    // The chat's own events refresh its page, not this read of it
    refetchInterval: orch?.status === 'running' ? 5000 : false,
  });
  const workflows = data?.chat.children.workflows ?? [];
  return workflows.find((w) => w.id === orch?.workflow?.workflowRunId) ?? workflows.at(-1) ?? null;
}

/** What a step is called, on the stepper and over its panel. */
function useStepLabel(): (step: OrchestrationStep) => string {
  const { t } = useTranslation(['config', 'orchestrationV2']);
  return (step) => {
    switch (step.kind) {
      case 'stage':
        return t('config:detail.stage', { n: step.index + 1 });
      case 'integration':
        return t('config:detail.integration');
      case 'verification':
        return t('orchestrationV2:verification.title');
      case 'synthesis':
        return t('config:detail.synthesis');
      case 'pull-request':
        return t('config:detail.pullRequest');
      case 'phase':
        return step.phase ?? t('config:orchestration.workflow');
      case 'workflow':
        return t('config:orchestration.workflow');
    }
  };
}

function stepMeta(step: OrchestrationStep, orch: Orchestration): string | undefined {
  switch (step.kind) {
    case 'stage':
      return `${step.completed}/${step.tasks.length}`;
    case 'phase':
      return `${step.agents.filter((a) => a.status === 'completed').length}/${step.agents.length}`;
    case 'integration':
      return orch.integration ? `${orch.integration.merged.length}/${orch.tasks.filter((t) => t.branch && t.status === 'completed').length}` : undefined;
    case 'verification': {
      const commands = orch.verification?.commands.filter((c) => !c.install) ?? [];
      return commands.length ? `${commands.filter((c) => c.status === 'passed' || c.status === 'fixed').length}/${commands.length}` : undefined;
    }
    default:
      return undefined;
  }
}

/** How far along a step in flight is, for its bar in the pipeline. */
function stepProgress(step: OrchestrationStep): number | undefined {
  switch (step.kind) {
    case 'stage':
      return step.tasks.length ? step.tasks.filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'skipped').length / step.tasks.length : undefined;
    case 'phase':
      return step.agents.length ? step.agents.filter((a) => a.status === 'completed').length / step.agents.length : undefined;
    default:
      return undefined;
  }
}

/** The task of a stage that takes the page's energy border: the running one that says what it is doing, else the first running one. */
function mostActive(orch: Orchestration, tasks: readonly Orchestration['tasks'][number][]): string | null {
  if (orch.status !== 'running') return null;
  const running = tasks.filter((t) => t.status === 'running');
  return (running.find((t) => t.activity) ?? running[0])?.id ?? null;
}

/** Said in place of a phase's card while that card has nothing to show yet. */
function StepNote({ children }: { children: ReactNode }) {
  return <p className="muted small step-note">{children}</p>;
}

function FinalResult({ orch }: { orch: Orchestration }) {
  const { t } = useTranslation(['orchestrationDetail', 'config']);
  if (!orch.finalResult) return null;
  return (
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
  );
}

/** What the selected step holds: a stage's tasks, or the card of the phase it stands for. */
function StepPanel({
  orch,
  step,
  workflow,
  inspected,
  onInspect,
  labelledBy,
}: {
  orch: Orchestration;
  step: OrchestrationStep;
  workflow: ChatWorkflow | null;
  inspected: string | null;
  onInspect: (taskId: string) => void;
  /** The heading over the panel, in the view bar */
  labelledBy: string;
}) {
  const { t } = useTranslation(['orchestrationDetail', 'orchestration', 'config', 'orchestrationV2']);
  const chatLink = (id: string | null | undefined) =>
    id ? (
      <Link to={`/chats/${id}`} className="meta-icon">
        <MessageSquare size={12} strokeWidth={1.75} aria-hidden /> {t('chat')}
      </Link>
    ) : null;

  let body: ReactNode;
  switch (step.kind) {
    case 'stage':
      body = (
        <>
          <ul className="task-rows">
            {step.tasks.map((task) => (
              <TaskRow
                key={task.id}
                orch={orch}
                task={task}
                energy={task.id === mostActive(orch, step.tasks)}
                inspected={inspected === task.id}
                onInspect={() => onInspect(task.id)}
              />
            ))}
          </ul>
          {rerunBlockedByPullRequest(orch) && <p className="muted small">{t('orchestrationV2:rerun.blockedByPullRequest')}</p>}
        </>
      );
      break;
    case 'integration':
      body = (
        <>
          <IntegrationCard orch={orch} />
          {!orch.integration && <StepNote>{step.state === 'skipped' ? t('steps.integrationNothing') : t('steps.integrationHeld')}</StepNote>}
        </>
      );
      break;
    case 'verification':
      body = orch.verification ? <VerificationCard orch={orch} /> : <StepNote>{step.state === 'skipped' ? t('steps.verificationSkipped') : t('steps.verificationHeld')}</StepNote>;
      break;
    case 'pull-request':
      body = (
        <>
          {orch.integration?.pullRequestUrl && (
            <p>
              <a className="btn btn-small" href={orch.integration.pullRequestUrl} target="_blank" rel="noreferrer">
                <ExternalLink {...ICON_SM} /> {t('steps.openPullRequest')}
              </a>
            </p>
          )}
          {orch.integration?.status === 'merged' ? <IntegrationCard orch={orch} /> : !orch.integration?.pullRequestUrl && <StepNote>{t('steps.pullRequestHeld')}</StepNote>}
        </>
      );
      break;
    case 'synthesis':
      body = orch.finalResult ? (
        <FinalResult orch={orch} />
      ) : (
        <div className="stack-tight">
          <StepNote>
            {step.state === 'current'
              ? t('steps.synthesisWriting')
              : step.state === 'failed'
                ? t('steps.synthesisNoReport')
                : step.state === 'skipped'
                  ? t('steps.synthesisSkipped')
                  : orch.status === 'waiting'
                    ? t('synthesisHeld')
                    : t('config:detail.synthesisHint')}
          </StepNote>
          <div className="meta">{chatLink(orch.synthesisRunId)}</div>
        </div>
      );
      break;
    case 'phase':
      body = (
        <>
          {workflow && orch.workflow?.runId && <WorkflowRunCard workflow={workflow} chatId={orch.workflow.runId} phase={step.phase} />}
          <WorkflowCard orch={orch} />
        </>
      );
      break;
    case 'workflow':
      body = (
        <>
          {workflow && orch.workflow?.runId && <WorkflowRunCard workflow={workflow} chatId={orch.workflow.runId} />}
          <WorkflowCard orch={orch} />
        </>
      );
      break;
  }

  return (
    <section className="step-panel" aria-labelledby={labelledBy}>
      {body}
    </section>
  );
}

/** Today's board, kept as the graph view: every stage side by side, scrolling sideways in its own box. */
function GraphView({ orch, inspected, onInspect }: { orch: Orchestration; inspected: string | null; onInspect: (taskId: string) => void }) {
  const { t } = useTranslation(['orchestrationDetail', 'config', 'orchestrationV2']);
  const boardId = useId();
  const layers = layerTasks(orch.tasks);
  const synthesis = orch.finalResult ? 'completed' : orch.status === 'running' ? 'pending' : orch.status === 'waiting' ? 'held' : 'skipped';
  return (
    <>
      {/* Scrolls sideways on a wide graph, so it is a focusable, named region: a keyboard can scroll it */}
      <section className="board" tabIndex={0} aria-labelledby={boardId}>
        <h2 id={boardId} className="sr-only">
          {t('taskBoard')}
        </h2>
        <ol className="board-track">
          {layers.map((layer, level) => (
            <li key={level} className="board-col">
              {level > 0 && (
                // The connector into a stage flows while that stage has a worker at it
                <span className={`board-link ${layer.some((t) => t.status === 'running') ? 'is-flowing' : ''}`} aria-hidden>
                  <ChevronRight size={12} strokeWidth={2} />
                </span>
              )}
              <StageHead title={level === 0 ? t('config:detail.firstStage') : t('config:detail.stage', { n: level + 1 })} tasks={layer} />
              {layer.map((task) => (
                <TaskCard key={task.id} orch={orch} task={task} inspected={inspected === task.id} onInspect={() => onInspect(task.id)} />
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
                <span className="board-task-fill" aria-hidden />
                <BoardStatusBadge status={synthesis} />
                <div className="small muted">{synthesis === 'held' ? t('synthesisHeld') : t('config:detail.synthesisHint')}</div>
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
      {rerunBlockedByPullRequest(orch) && <p className="muted small">{t('orchestrationV2:rerun.blockedByPullRequest')}</p>}
    </>
  );
}

type View = 'steps' | 'graph';

const costDigits = (usd: number) => (usd && usd < 0.01 ? 4 : 2);

/** The cost tile draws the figure big and its currency under it: "5,61" over "US$", "5.61" over "$". */
function costFigure(usd: number): string {
  const digits = costDigits(usd);
  return formatNumber(usd || 0, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function costCurrency(usd: number): string {
  return formatCost(usd).replace(costFigure(usd), '').trim();
}

/** The heading over the selected step: "Stage 2 · 4 tasks in parallel", or the name of the phase. */
function useStepTitle(): (step: OrchestrationStep) => string {
  const { t } = useTranslation('orchestrationDetail');
  const label = useStepLabel();
  return (step) => (step.kind === 'stage' ? `${label(step)} · ${t('stageTasks', { count: step.tasks.length })}` : label(step));
}

/** The worktree "View worktree" opens: the merged one once it exists, else the most active task's. */
function worktreeTarget(orch: Orchestration): { kind: 'integration' } | { kind: 'task'; id: string } | null {
  if (orch.integration?.worktree) return { kind: 'integration' };
  const withTree = orch.tasks.filter((t) => t.worktree);
  const running = withTree.filter((t) => t.status === 'running');
  const task = running.find((t) => t.activity) ?? running[0] ?? withTree.at(-1);
  return task ? { kind: 'task', id: task.id } : null;
}

export function OrchestrationDetail() {
  const { t } = useTranslation(['orchestrationDetail', 'orchestration', 'config', 'common', 'orchestrationV2']);
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
  const narrow = useMediaQuery(NARROW);
  const panelTitleId = useId();
  const [params, setParams] = useSearchParams();
  // The list's "Resume" lands here with `?resume`: resuming is a choice of settings, made on this page
  const [resuming, setResuming] = useState(() => params.has('resume'));
  const [relaunching, setRelaunching] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  // Every other parameter (`?detail=` above all) is kept: this page owns only its own
  const setParam = useCallback(
    (name: string, value: string | null) =>
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (value === null) next.delete(name);
          else next.set(name, value);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const closeResume = () => {
    setResuming(false);
    if (params.has('resume')) setParam('resume', null);
  };
  const resume = useMutation({
    mutationFn: (changes: ResumeOrchestrationRequest) => api.resumeOrchestration(id, changes),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.orchestration(id), next);
      closeResume();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteOrchestration(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.orchestrations });
      navigate('/orchestration');
    },
  });
  const running = orch?.status === 'running';
  // The clock only has to move while the graph does
  useClockTick(orch && !orch.endedAt ? 1000 : 3_600_000);
  const workflow = useWorkflowRun(orch);
  const stepLabel = useStepLabel();
  const stepTitle = useStepTitle();
  usePageTitle(orch ? t('config:detail.docTitle', { name: orch.name }) : undefined);

  if (isLoading) return <Loading />;
  if (!orch) {
    // A link to a graph that was deleted, or never was, is a state of its own and not a failed request
    const missing = !error || (error instanceof ApiRequestError && error.status === 404);
    if (!missing) return <ErrorBox error={error} />;
    return (
      <Empty
        illustration="not-found"
        size={narrow ? 'sm' : undefined}
        title={t('config:detail.notFound')}
        action={
          <Link to="/orchestration" className="btn btn-primary">
            <ArrowLeft {...ICON_SM} /> {t('config:detail.back')}
          </Link>
        }
      >
        {t('notFoundBody')}
      </Empty>
    );
  }

  const view: View = params.get('view') === 'graph' ? 'graph' : 'steps';
  // Which task's work is open under the board: in the address, so a link to it opens the same panel
  const inspectedTask = orch.tasks.find((task) => task.id === params.get('task')) ?? null;
  const inspect = (taskId: string) => setParam('task', inspectedTask?.id === taskId ? null : taskId);
  const { other } = costSplit(orch);
  // Workers die with the wrapper, so an interrupted graph can be picked up from where it stopped.
  const unfinished = orch.tasks.filter((t) => t.status !== 'completed').length;
  const live = running || orch.status === 'waiting';
  const done = orch.tasks.filter((t) => t.status === 'completed').length;
  const working = orch.tasks.filter((t) => t.status === 'running').length;

  const steps = orchestrationSteps(orch, workflow);
  const followed = followedStep(steps);
  // A step picked by hand stays put; without one the stepper follows the orchestration
  const pinned = steps.find((s) => s.id === params.get('step'));
  const selected = pinned ?? followed;
  const stepItems: StepItem[] = steps.map((step) => ({ id: step.id, label: stepLabel(step), state: step.state, meta: stepMeta(step, orch), progress: stepProgress(step) }));

  const tree = worktreeTarget(orch);
  const openWorktree = () => {
    if (!tree) return;
    if (tree.kind === 'integration') {
      setParam('view', null);
      setParam('step', 'integration');
    } else if (inspectedTask?.id !== tree.id) inspect(tree.id);
  };
  const stopEntry: MenuEntry = { id: 'stop', label: t('config:detail.stop'), icon: Square, destructive: true, disabled: stop.isPending, onSelect: () => stop.mutate() };
  const worktreeEntry: MenuEntry = { id: 'worktree', label: t('viewWorktree'), icon: FolderGit2, onSelect: openWorktree };

  // On a phone the header keeps the name: the rest of its actions go behind its `⋯`
  const menu: MenuEntry[] = live
    ? narrow
      ? [...(tree ? [worktreeEntry] : []), stopEntry]
      : []
    : [
        ...(narrow && tree ? [worktreeEntry] : []),
        ...(unfinished > 0 && !resuming ? [{ id: 'resume', label: t('config:detail.resume', { count: unfinished }), icon: Play, onSelect: () => setResuming(true) }] : []),
        { id: 'template', label: tv('templates.saveAs'), icon: BookmarkPlus, onSelect: () => setSavingTemplate(true) },
        { id: 'sep', separator: true as const },
        {
          id: 'delete',
          label: t('common:actions.delete'),
          icon: Trash2,
          destructive: true,
          disabled: remove.isPending,
          onSelect: () =>
            void confirm({
              title: t('deleteTitle', { name: orch.name }),
              body: t('config:detail.deleteBody'),
              confirmLabel: t('common:actions.delete'),
              danger: true,
            }).then((ok) => {
              if (ok) remove.mutate();
            }),
        },
      ];

  return (
    <>
      <div className="orch-hero glow-top">
        <header className="orch-summary">
          <Link to="/orchestration" className="icon-btn orch-back" aria-label={t('config:detail.back')}>
            <ArrowLeft {...ICON} />
          </Link>
          <div className="orch-title-block">
            <h1 className="orch-title">{orch.name}</h1>
            <BoardStatusBadge status={orch.status} />
          </div>
          <div className="orch-actions">
            {!narrow && tree && (
              <button type="button" className="btn" onClick={openWorktree}>
                <FolderGit2 {...ICON_SM} /> {t('viewWorktree')}
              </button>
            )}
            {/* Waiting is stoppable but nothing else: resuming or deleting would throw away the decision it waits for */}
            {live ? (
              !narrow && (
                <button className="btn btn-danger" disabled={stop.isPending} onClick={() => stop.mutate()}>
                  <Square {...ICON_SM} /> {t('config:detail.stop')}
                </button>
              )
            ) : (
              canRelaunch(orch) && (
                <button className="btn btn-primary" disabled={relaunching} onClick={() => setRelaunching(true)}>
                  <Rocket {...ICON_SM} /> {tv('relaunch.button')}
                </button>
              )
            )}
            {menu.length > 0 && <Menu entries={menu} label={t('moreActions')} align="end" />}
          </div>
        </header>

        <div className="orch-overview">
          <section className="card orch-brief" aria-label={orch.objective ? undefined : t('settingsLabel')}>
            {orch.objective && <Objective text={orch.objective} />}
            <div className="orch-settings">
              <span className="badge">{orch.model ?? t('config:detail.defaultModel')}</span>
              <span className="badge">{orch.permissionMode}</span>
              <span className="badge">{t('config:orchestration.concurrencyValue', { n: orch.concurrency })}</span>
              {orch.engine === 'workflow' ? (
                <span className="badge">{t('config:detail.workflowEngine')}</span>
              ) : (
                orch.worktree && <span className="badge">{t('config:detail.worktreePerTask')}</span>
              )}
              <span className="badge">{t('config:detail.created', { date: formatDateTime(orch.createdAt) })}</span>
              {orch.templateId && <span className="badge">{tv('origin.fromTemplate')}</span>}
            </div>
            <div className="orch-brief-foot small">
              <span className="mono muted" title={orch.cwd}>
                {shortPath(orch.cwd)}
              </span>
              {orch.relaunchedFrom && <Link to={`/orchestration/${orch.relaunchedFrom}`}>{tv('origin.relaunchedFrom')}</Link>}
            </div>
          </section>
          <dl className="orch-kpis">
            <div className="card orch-kpi">
              <dt className="section-label">{t('kpi.tasks')}</dt>
              <dd className="orch-kpi-value">
                {done}
                <span className="orch-kpi-of">/{orch.tasks.length}</span>
              </dd>
            </div>
            <div className="card orch-kpi">
              <dt className="section-label">{t('kpi.time')}</dt>
              <dd className="orch-kpi-value mono orch-clock">{formatElapsed(elapsedSince(orch.createdAt, orch.endedAt ? Date.parse(orch.endedAt) : Date.now()))}</dd>
            </div>
            <div className="card orch-kpi grad-border" title={other > 0 ? t('costOnNoTask', { cost: formatCost(other) }) : undefined}>
              <dt className="section-label">{t('costLabel')}</dt>
              <dd className="orch-kpi-value">
                <AnimatedNumber value={orch.costUsd} format={costFigure} className="grad-text" />
                <span className="orch-kpi-unit">{costCurrency(orch.costUsd)}</span>
              </dd>
            </div>
            <div className="card orch-kpi orch-kpi-parallel">
              <dt className="section-label">{t('kpi.parallel')}</dt>
              <dd className="orch-kpi-value">
                {working}
                <span className="orch-kpi-of">/{orch.concurrency}</span>
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <ErrorBox error={error ?? stop.error ?? resume.error ?? remove.error} />
      <WaitingNotice orch={orch} />
      <FailedByChecksNotice orch={orch} />
      {resuming && <ResumePanel orch={orch} unfinished={unfinished} pending={resume.isPending} onResume={(changes) => resume.mutate(changes)} onCancel={closeResume} />}
      {relaunching && <RelaunchPanel orch={orch} onCancel={() => setRelaunching(false)} />}
      {savingTemplate && <SaveTemplateDialog fromOrchestration={orch.id} defaultName={orch.name} onClose={() => setSavingTemplate(false)} />}

      {view === 'steps' && (
        <div className="orch-steps">
          <Stepper
            variant="pipeline"
            steps={stepItems}
            label={t('stepsLabel')}
            selected={selected?.id}
            // Picking the step it would follow anyway goes back to following
            onSelect={(step) => setParam('step', step === followed?.id ? null : step)}
          />
        </div>
      )}

      <div className="orch-view-bar">
        <h2 id={panelTitleId} className="orch-panel-title">
          {view === 'graph' ? t('viewGraph') : selected ? stepTitle(selected) : t('stepsLabel')}
        </h2>
        {view === 'steps' && pinned && pinned.id !== followed?.id && (
          <button type="button" className="btn btn-small back-to-live" onClick={() => setParam('step', null)}>
            <Radio {...ICON_SM} /> {live ? t('backToLive') : t('backToLatest')}
          </button>
        )}
        <Segmented<View>
          label={t('viewLabel')}
          value={view}
          onChange={(next) => setParam('view', next === 'graph' ? 'graph' : null)}
          options={[
            { value: 'steps', label: t('viewSteps') },
            { value: 'graph', label: t('viewGraph') },
          ]}
        />
      </div>

      {view === 'steps' ? (
        selected && <StepPanel orch={orch} step={selected} workflow={workflow} inspected={inspectedTask?.id ?? null} onInspect={inspect} labelledBy={panelTitleId} />
      ) : (
        <>
          <GraphView orch={orch} inspected={inspectedTask?.id ?? null} onInspect={inspect} />
          <VerificationCard orch={orch} />
          {orch.engine === 'workflow' ? <WorkflowCard orch={orch} /> : <IntegrationCard orch={orch} />}
          <FinalResult orch={orch} />
        </>
      )}

      {inspectedTask && <TaskWork orch={orch} task={inspectedTask} onClose={() => setParam('task', null)} />}
    </>
  );
}
