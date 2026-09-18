import type { RunSummary } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Square, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, keys } from '../api';
import { durationBetween, formatCost, shortPath, timeAgo, truncate } from '../lib/format';
import { ICON_SM } from './icons';
import { ErrorBox, StatusBadge } from './ui';

export const isRunLive = (run: RunSummary) => ['starting', 'busy', 'idle'].includes(run.status);

export function RunCard({ run, compact = false }: { run: RunSummary; compact?: boolean }) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.runs });
  const stop = useMutation({ mutationFn: () => api.stopRun(run.id), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: () => api.deleteRun(run.id), onSuccess: invalidate });
  const live = isRunLive(run);
  const runningSubagents = run.subagents.filter((s) => s.status === 'running').length;
  const runningTasks = run.backgroundTasks.filter((t) => t.status === 'running').length;

  return (
    <div className={`row-card ${live ? 'is-live' : ''} ${run.status === 'busy' ? 'is-busy' : ''}`}>
      <div className="row-card-main">
        <div className="row-card-title">
          <StatusBadge status={run.status} />
          <Link to={`/runs/${run.id}`} className="strong">
            {run.name}
          </Link>
          {run.orchestrationId && (
            <Link to={`/orchestration/${run.orchestrationId}`} className="badge badge-info">
              orchestration
            </Link>
          )}
          {run.account && (
            <Link to="/accounts" className="badge badge-info" title="Pinned to a claude-swap account">
              {run.account}
            </Link>
          )}
          {runningSubagents > 0 && <span className="badge badge-active">{runningSubagents} subagents</span>}
          {runningTasks > 0 && <span className="badge badge-active">{runningTasks} bg tasks</span>}
        </div>
        <div className="meta">
          <span title={run.cwd}>{shortPath(run.cwd)}</span>
          <span>{run.model ?? 'default model'}</span>
          <span>{run.turns} turns</span>
          <span>{formatCost(run.costUsd)}</span>
          <span>{live ? `up ${durationBetween(run.createdAt, null)}` : `ended ${timeAgo(run.endedAt)}`}</span>
          {run.pid && <span>pid {run.pid}</span>}
        </div>
        {!compact && (
          <div className="row-card-text">
            {run.error ? (
              <span className="text-bad">{truncate(run.error, 300)}</span>
            ) : (
              truncate(run.lastText ?? run.prompt, 300)
            )}
          </div>
        )}
        <ErrorBox error={stop.error ?? remove.error} />
      </div>
      <div className="row-card-actions">
        <Link to={`/runs/${run.id}`} className="btn btn-small">
          Open <ArrowUpRight {...ICON_SM} />
        </Link>
        {live ? (
          <button className="btn btn-small btn-danger" disabled={stop.isPending} onClick={() => stop.mutate()}>
            <Square {...ICON_SM} /> Stop
          </button>
        ) : (
          <button className="btn btn-small" disabled={remove.isPending} onClick={() => remove.mutate()}>
            <Trash2 {...ICON_SM} /> Remove
          </button>
        )}
      </div>
    </div>
  );
}
