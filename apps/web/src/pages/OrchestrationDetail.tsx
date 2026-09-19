import type { Orchestration, OrchestrationTaskState, ResumeOrchestrationRequest } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, Combine, CornerDownRight, ExternalLink, GitMerge, GitPullRequest, MessageSquare, Play, RotateCw, Save, Square, Target, Trash2, Waypoints } from 'lucide-react';
import { useState } from 'react';
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
          <CornerDownRight size={12} strokeWidth={1.75} aria-hidden /> after {task.dependsOn?.join(', ')}
        </div>
      )}
      <Collapsible className="fold" title="Prompt">
        <div className="prose small">{task.prompt}</div>
      </Collapsible>
      {task.error && <div className="alert alert-bad small">{task.error}</div>}
      {task.result && (
        <Collapsible className="fold" title="Result">
          <RichText text={task.result} />
        </Collapsible>
      )}
      <div className="meta">
        {task.runId && <Link to={`/runs/${task.runId}`}>run</Link>}
        {task.sessionId && <Link to={`/sessions/${task.sessionId}`}>session</Link>}
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
      if (res.url) toast.success('Pull request opened', res.url);
      else toast.info(`Pushed ${res.branch}`, res.detail);
      void refresh();
    },
  });
  const prune = useMutation({
    mutationFn: () => api.pruneOrchestrationWorktrees(orch.id),
    onSuccess: ({ results }) => {
      const kept = results.filter((r) => !r.removed);
      if (kept.length) toast.info(`${kept.length} worktree(s) kept`, kept.map((k) => `${k.task}: ${k.detail}`).join('\n'));
      else toast.success('Worktrees removed', 'Every branch is kept.');
      void refresh();
    },
  });

  const branches = orch.tasks.filter((t) => t.branch && t.status === 'completed').length;
  if (!integration && (orch.status === 'running' || branches === 0)) return null;
  const busy = integration && ['merging', 'resolving'].includes(integration.status);
  const idle = orch.status !== 'running' && !busy;
  const hasWorktrees = orch.tasks.some((t) => t.worktree) || Boolean(integration?.worktree);

  return (
    <Card
      title={
        <span className="title-icon">
          <GitMerge {...ICON_SM} /> Integration
        </span>
      }
      actions={
        idle && (
          <>
            {integration?.status === 'merged' &&
              (integration.pullRequestUrl ? (
                <a className="btn btn-small" href={integration.pullRequestUrl} target="_blank" rel="noreferrer">
                  <ExternalLink {...ICON_SM} /> Pull request
                </a>
              ) : (
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  disabled={publish.isPending}
                  onClick={() =>
                    void confirm({
                      title: `Push ${integration.branch}?`,
                      body: 'The branch is pushed to origin and a pull request is opened for it with gh.',
                      confirmLabel: 'Push and open',
                    }).then((ok) => {
                      if (ok) publish.mutate();
                    })
                  }
                >
                  <GitPullRequest {...ICON_SM} /> {publish.isPending ? 'Pushing…' : 'Push & open PR'}
                </button>
              ))}
            {integration?.status !== 'merged' && (
              <button type="button" className="btn btn-small" disabled={integrate.isPending} onClick={() => integrate.mutate()}>
                <RotateCw {...ICON_SM} /> {integration ? 'Integrate again' : 'Integrate branches'}
              </button>
            )}
            {hasWorktrees && integration?.status === 'merged' && (
              <button
                type="button"
                className="btn btn-small"
                disabled={prune.isPending}
                onClick={() =>
                  void confirm({
                    title: 'Remove the worktrees?',
                    body: 'Their directories go; every branch, the integrated one included, is kept.',
                    confirmLabel: 'Remove',
                  }).then((ok) => {
                    if (ok) prune.mutate();
                  })
                }
              >
                <Trash2 {...ICON_SM} /> Remove worktrees
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
            <span>
              {integration.merged.length}/{branches} task branch{branches === 1 ? '' : 'es'} merged
            </span>
            {integration.integratorRunId && <Link to={`/runs/${integration.integratorRunId}`}>integrator run</Link>}
          </div>
          {integration.status === 'resolving' && (
            <p className="muted small">Some branches conflicted; an integrator agent is merging them.</p>
          )}
          {integration.conflicts.length > 0 && (
            <ul className="small">
              {integration.conflicts.map((c) => (
                <li key={c.taskId}>
                  <span className="mono">{c.taskId}</span> conflicted in <span className="mono">{c.paths.join(', ')}</span>
                </li>
              ))}
            </ul>
          )}
          {integration.error && <div className="alert alert-warn small">{integration.error}</div>}
        </>
      ) : (
        <p className="muted small">
          This graph finished before orchestrations merged their own work. Its {branches} task branch{branches === 1 ? '' : 'es'} can
          be integrated into one now; anything left uncommitted in a worktree is committed first.
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
  const toast = useToast();
  const [name, setName] = useState('');
  const script = useQuery({ queryKey: ['orchestrations', orch.id, 'workflow'], queryFn: () => api.orchestrationWorkflow(orch.id) });
  const save = useMutation({
    mutationFn: (overwrite: boolean) => api.saveOrchestrationWorkflow(orch.id, { ...(name.trim() ? { name: name.trim() } : {}), overwrite }),
    onSuccess: (saved) => toast.success(`Saved as ${saved.name}`, saved.path),
  });
  return (
    <Card
      title={
        <span className="title-icon">
          <Waypoints {...ICON_SM} /> Workflow
        </span>
      }
      actions={
        orch.workflow?.runId ? (
          <Link to={`/runs/${orch.workflow.runId}`} className="btn btn-small">
            <ExternalLink {...ICON_SM} /> Open run
          </Link>
        ) : undefined
      }
    >
      <p className="muted small">
        Every task runs as a subagent of one Claude Code session, driven by a script generated from this graph.
        {orch.workflow?.workflowRunId ? ` Claude Code run ${orch.workflow.workflowRunId}: a resume replays what had finished from its cache.` : ''}
      </p>
      {orch.engineReason && <p className="small">Planner: {orch.engineReason}</p>}
      <Collapsible className="fold" title={<span className="tool-name">Script</span>}>
        {script.data ? <CodeBlock code={script.data.script} lang="js" /> : <ErrorBox error={script.error} />}
      </Collapsible>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(false);
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (defaults to agentry-…)" aria-label="Workflow name" />
        <button type="submit" className="btn btn-small" disabled={save.isPending}>
          <Save {...ICON_SM} /> Save as project workflow
        </button>
      </form>
      <p className="muted small">Copies it into the project&apos;s .claude/workflows/, where Claude Code runs it by name.</p>
      {save.error && (
        <div className="stack-tight">
          <ErrorBox error={save.error} />
          {String((save.error as Error).message).includes('already exists') && (
            <button type="button" className="btn btn-small btn-danger" onClick={() => save.mutate(true)}>
              Replace it
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
  const [worktree, setWorktree] = useState(true);
  const [askPermissions, setAskPermissions] = useState(true);
  const [tools, setTools] = useState(orch.allowedTools.length ? orch.allowedTools.join(',') : SAFE_TOOLS);
  const workflow = orch.engine === 'workflow';
  // A workflow runs in the project directory by design: only its prompts can have stopped it
  const risky = (!workflow && !orch.worktree) || orch.permissionPrompts !== 'host';

  return (
    <Card title={`Resume ${unfinished} unfinished task${unfinished === 1 ? '' : 's'}`}>
      <p className="muted small">
        The {orch.tasks.length - unfinished} completed task{orch.tasks.length - unfinished === 1 ? '' : 's'} and{' '}
        {orch.tasks.length - unfinished === 1 ? 'its' : 'their'} results are kept.
        {workflow ? " It resumes in the same session, where Claude Code replays what had finished from its cache." : ''}
      </p>
      {risky && (
        <p className="alert alert-warn small">
          This graph was started {!workflow && !orch.worktree ? 'without worktrees' : ''}
          {!workflow && !orch.worktree && orch.permissionPrompts !== 'host' ? ' and ' : ''}
          {orch.permissionPrompts !== 'host' ? 'with nobody to answer its permission prompts' : ''} — which is likely what
          stopped it. Resuming with the settings below avoids both.
        </p>
      )}
      {!workflow && (
        <Switch checked={worktree} onChange={setWorktree}>
          Give each task its own git worktree and branch
        </Switch>
      )}
      <Switch checked={askPermissions} onChange={setAskPermissions}>
        Ask me when a worker needs permission
      </Switch>
      <Field label="Tools workers may use" hint="Pre-authorised: used without asking.">
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
          <Play {...ICON_SM} /> {pending ? 'Resuming…' : `Resume ${unfinished} task${unfinished === 1 ? '' : 's'}`}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </Card>
  );
}

export function OrchestrationDetail() {
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
  if (!orch) return <ErrorBox error={error ?? new Error('Orchestration not found')} />;

  const layers = layerTasks(orch.tasks);
  // Workers die with the wrapper, so an interrupted graph can be picked up from where it stopped.
  const unfinished = orch.tasks.filter((t) => t.status !== 'completed').length;
  const counts = orch.tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        docTitle={`${orch.name} · orchestration`}
        title={
          <>
            <Link to="/orchestration" className="title-back" aria-label="Back to orchestrations">
              <ArrowLeft {...ICON} />
            </Link>
            {orch.name}
          </>
        }
        subtitle={
          <span className="meta">
            <StatusBadge status={orch.status} />
            <span title={orch.cwd}>{shortPath(orch.cwd)}</span>
            <span>{orch.model ?? 'default model'}</span>
            <span>{orch.permissionMode}</span>
            <span>concurrency {orch.concurrency}</span>
            {orch.engine === 'workflow' ? <span>workflow engine</span> : orch.worktree && <span>worktree per task</span>}
            <span>total {formatCost(orch.costUsd)}</span>
            <span>{durationBetween(orch.createdAt, orch.endedAt)}</span>
            <span>created {formatDateTime(orch.createdAt)}</span>
          </span>
        }
        actions={
          orch.status === 'running' ? (
            <button className="btn btn-danger" disabled={stop.isPending} onClick={() => stop.mutate()}>
              <Square {...ICON_SM} /> Stop orchestration
            </button>
          ) : (
            <>
              {unfinished > 0 && !resuming && (
                <button className="btn btn-primary" onClick={() => setResuming(true)}>
                  <Play {...ICON_SM} /> Resume {unfinished} task{unfinished === 1 ? '' : 's'}
                </button>
              )}
              <button
                className="btn btn-danger"
                disabled={remove.isPending}
                onClick={() =>
                  void confirm({
                    title: `Delete ${orch.name}?`,
                    body: 'Its record and its worktrees are removed. Branches are kept, so anything committed there survives.',
                    confirmLabel: 'Delete',
                    danger: true,
                  }).then((ok) => {
                    if (ok) remove.mutate();
                  })
                }
              >
                <Trash2 {...ICON_SM} /> Delete
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
              <Target {...ICON_SM} /> Objective
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
              <span className={`board-link ${layer.some((t) => t.status === 'running') ? 'is-flowing' : ''}`} aria-hidden>
                <ChevronRight size={12} strokeWidth={2} />
              </span>
            )}
            <StageHead title={level === 0 ? 'Stage 1 · no dependencies' : `Stage ${level + 1}`} tasks={layer} />
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
              <span className="board-col-title">Synthesis</span>
            </div>
            <div className={`board-task status-${orch.finalResult ? 'completed' : orch.status === 'running' ? 'pending' : 'skipped'}`}>
              <StatusBadge status={orch.finalResult ? 'completed' : orch.status === 'running' ? 'pending' : 'skipped'} />
              <div className="small muted">Final agent that reports on everything the tasks did.</div>
              {orch.synthesisRunId && (
                <div className="meta">
                  <Link to={`/runs/${orch.synthesisRunId}`}>run</Link>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {orch.engine === 'workflow' ? <WorkflowCard orch={orch} /> : <IntegrationCard orch={orch} />}

      {orch.finalResult && (
        <Card
          title="Final result"
          actions={
            // The report is a conversation: asking it to change or finish something continues it
            orch.synthesisRunId && (
              <Link className="btn btn-small" to={`/runs/${orch.synthesisRunId}`}>
                <MessageSquare {...ICON_SM} /> Continue the conversation
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
