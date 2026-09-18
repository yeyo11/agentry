import type { OrchestrationTaskState } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, Combine, CornerDownRight, Square, Target } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api, keys, useOrchestration } from '../api';
import { ICON, ICON_SM } from '../components/icons';
import { motion, ProgressRing, useReducedMotion } from '../components/motion';
import { RichText } from '../components/Transcript';
import { Card, ErrorBox, Loading, PageHeader, StatusBadge } from '../components/ui';
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
      <details className="fold">
        <summary>Prompt</summary>
        <div className="prose small">{task.prompt}</div>
      </details>
      {task.error && <div className="alert alert-bad small">{task.error}</div>}
      {task.result && (
        <details className="fold">
          <summary>Result</summary>
          <RichText text={task.result} />
        </details>
      )}
      <div className="meta">
        {task.runId && <Link to={`/runs/${task.runId}`}>run</Link>}
        {task.sessionId && <Link to={`/sessions/${task.sessionId}`}>session</Link>}
        {task.model && <span>{task.model}</span>}
        {task.costUsd > 0 && <span>{formatCost(task.costUsd)}</span>}
      </div>
    </motion.div>
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

  if (isLoading) return <Loading />;
  if (!orch) return <ErrorBox error={error ?? new Error('Orchestration not found')} />;

  const layers = layerTasks(orch.tasks);
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
            <span>total {formatCost(orch.costUsd)}</span>
            <span>{durationBetween(orch.createdAt, orch.endedAt)}</span>
            <span>created {formatDateTime(orch.createdAt)}</span>
          </span>
        }
        actions={
          orch.status === 'running' && (
            <button className="btn btn-danger" disabled={stop.isPending} onClick={() => stop.mutate()}>
              <Square {...ICON_SM} /> Stop orchestration
            </button>
          )
        }
      />
      <ErrorBox error={error ?? stop.error} />

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
              <div className="small muted">Final agent that merges every task result.</div>
            </div>
          </div>
        )}
      </div>

      {orch.finalResult && (
        <Card title="Final result">
          <RichText text={orch.finalResult} />
        </Card>
      )}
    </>
  );
}
