import type { RunSummary } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Square, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../api';
import { durationBetween, formatCost, timeAgo, truncate } from '../lib/format';
import { Location } from './Location';
import { Tooltip } from './controls/Tooltip';
import { ICON_SM } from './icons';
import { ErrorBox, StatusBadge } from './ui';

export const isRunLive = (run: RunSummary) => ['starting', 'busy', 'idle'].includes(run.status);

export function RunCard({ run, compact = false }: { run: RunSummary; compact?: boolean }) {
  const { t } = useTranslation('components');
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
              {t('runCard.orchestration')}
            </Link>
          )}
          {run.account && (
            <Tooltip content={t('runCard.pinnedAccount')}>
              <Link to="/accounts" className="badge badge-info">
                {run.account}
              </Link>
            </Tooltip>
          )}
          {(run.pendingPrompts ?? 0) > 0 && (
            <Link to={`/runs/${run.id}`} className="badge badge-warn">
              {t('runCard.waitingForYou')}
            </Link>
          )}
          {runningSubagents > 0 && <span className="badge badge-active">{t('runCard.subagents', { count: runningSubagents })}</span>}
          {runningTasks > 0 && <span className="badge badge-active">{t('runCard.bgTasks', { count: runningTasks })}</span>}
        </div>
        <div className="meta">
          <Location location={run.location} fallback={run.cwd} />
          <span>{run.model ?? t('runCard.defaultModel')}</span>
          <span>{t('runCard.turns', { count: run.turns })}</span>
          <span>{formatCost(run.costUsd)}</span>
          <span>{live ? t('runCard.up', { duration: durationBetween(run.createdAt, null) }) : t('runCard.ended', { time: timeAgo(run.endedAt) })}</span>
          {run.pid && <span>{t('runCard.pid', { pid: run.pid })}</span>}
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
          {t('runCard.open')} <ArrowUpRight {...ICON_SM} />
        </Link>
        {live ? (
          <button className="btn btn-small btn-danger" disabled={stop.isPending} onClick={() => stop.mutate()}>
            <Square {...ICON_SM} /> {t('runCard.stop')}
          </button>
        ) : (
          <button className="btn btn-small" disabled={remove.isPending} onClick={() => remove.mutate()}>
            <Trash2 {...ICON_SM} /> {t('runCard.remove')}
          </button>
        )}
      </div>
    </div>
  );
}
