import type { Schedule, ScheduleRun, ScheduleRunStatus } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useScheduleRuns, useSchedules } from '../api';
import { Collapsible, Switch, Tooltip } from '../components/controls';
import { useConfirm } from '../components/Dialog';
import { ICON_SM } from '../components/icons';
import { useToast } from '../components/Toast';
import { Card, Empty, ErrorBox, PageHeader, Skeleton, StatusBadge, Tag } from '../components/ui';
import { formatDateTime, formatDuration, timeAgo, toMs } from '../lib/format';
import { useProjectScope } from '../lib/project-scope';
import { ScheduleForm } from './schedules/ScheduleForm';
import '../insights.css';

/** The recurring chats and orchestrations, with the timetable of each said in words and what each run produced. */
export function Schedules() {
  const { t } = useTranslation(['schedules', 'common']);
  const { project } = useProjectScope();
  const schedules = useSchedules();
  // `undefined`: closed; `null`: a new one; a schedule: that one
  const [editing, setEditing] = useState<Schedule | null | undefined>(undefined);

  return (
    <>
      <PageHeader
        title={t('page.title')}
        subtitle={t('page.subtitle')}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setEditing(null)}>
            <Plus {...ICON_SM} /> {t('page.new')}
          </button>
        }
      />
      <div className="alert alert-note" role="note">
        <CalendarClock size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
        <div className="alert-body">
          <strong>{t('page.missedTitle')}</strong>
          <div>{t('page.missedBody')}</div>
        </div>
      </div>
      <ErrorBox error={schedules.error} />
      {schedules.isPending ? (
        <Skeleton rows={3} height={64} />
      ) : (schedules.data ?? []).length === 0 ? (
        <Empty
          icon={CalendarClock}
          title={t('page.emptyTitle')}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setEditing(null)}>
              <Plus {...ICON_SM} /> {t('page.new')}
            </button>
          }
        >
          {t('page.emptyBody')}
        </Empty>
      ) : (
        <div className="stack schedules">
          {(schedules.data ?? []).map((schedule) => (
            <ScheduleCard key={schedule.id} schedule={schedule} onEdit={() => setEditing(schedule)} />
          ))}
        </div>
      )}
      {editing !== undefined && (
        <ScheduleForm schedule={editing ?? undefined} defaultCwd={project?.exists ? project.path : undefined} onClose={() => setEditing(undefined)} />
      )}
    </>
  );
}

function ScheduleCard({ schedule, onEdit }: { schedule: Schedule; onEdit: () => void }) {
  const { t } = useTranslation(['schedules', 'common']);
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);
  const runs = useScheduleRuns(schedule.id, historyOpen);
  const words = useQuery({
    queryKey: keys.schedulePreview(schedule.cron, schedule.timezone),
    queryFn: () => api.schedulePreview(schedule.cron, schedule.timezone, 5),
    staleTime: 5 * 60_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.schedules });
  };
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.setScheduleEnabled(schedule.id, enabled),
    onSuccess: (updated) => {
      toast.success(updated.enabled ? t('card.enabled', { name: schedule.name }) : t('card.disabled', { name: schedule.name }));
      refresh();
    },
    onError: (err) => toast.error(t('card.toggleFailed'), err),
  });
  const runNow = useMutation({
    mutationFn: () => api.runScheduleNow(schedule.id),
    onSuccess: (run) => {
      if (run.status === 'failed') toast.error(t('card.runFailed'), run.error);
      else toast.success(t('card.runStarted', { name: schedule.name }));
      refresh();
    },
    onError: (err) => toast.error(t('card.runFailed'), err),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSchedule(schedule.id),
    onSuccess: () => {
      toast.success(t('card.deleted', { name: schedule.name }));
      refresh();
    },
    onError: (err) => toast.error(t('card.deleteFailed'), err),
  });

  const next = toMs(schedule.nextRunAt);
  const last = schedule.lastRunAt;

  return (
    <Card
      className="schedule-card"
      title={
        <span className="meta">
          <span className="strong break">{schedule.name}</span>
          <Tag>{t(`card.kind.${schedule.target.kind}`)}</Tag>
          {!schedule.enabled && <Tag tone="muted">{t('card.off')}</Tag>}
          {schedule.overlap !== 'parallel' && <Tag>{t(`card.overlap.${schedule.overlap}`)}</Tag>}
        </span>
      }
      actions={
        <span className="toolbar">
          <Switch checked={schedule.enabled} onChange={(enabled) => toggle.mutate(enabled)} disabled={toggle.isPending}>
            {t('card.enabledLabel')}
          </Switch>
          <Tooltip content={t('card.runNowHint')}>
            <button type="button" className="btn btn-small" disabled={runNow.isPending} onClick={() => runNow.mutate()} aria-label={t('card.runNowNamed', { name: schedule.name })}>
              <Play {...ICON_SM} /> {t('card.runNow')}
            </button>
          </Tooltip>
          <Tooltip content={t('card.edit')}>
            <button type="button" className="btn btn-small" onClick={onEdit} aria-label={t('card.editNamed', { name: schedule.name })}>
              <Pencil {...ICON_SM} />
            </button>
          </Tooltip>
          <Tooltip content={t('card.delete')}>
            <button
              type="button"
              className="btn btn-small btn-danger"
              disabled={remove.isPending}
              aria-label={t('card.deleteNamed', { name: schedule.name })}
              onClick={() =>
                void confirm({
                  title: t('card.deleteTitle', { name: schedule.name }),
                  body: t('card.deleteBody'),
                  confirmLabel: t('common:actions.delete'),
                  danger: true,
                }).then((ok) => ok && remove.mutate())
              }
            >
              <Trash2 {...ICON_SM} />
            </button>
          </Tooltip>
        </span>
      }
    >
      <div className="stack-tight">
        <div className="schedule-when">
          <code className="mono">{schedule.cron}</code>
          {schedule.timezone && <span className="muted small">{schedule.timezone}</span>}
          <span>{words.data?.valid ? words.data.description : ''}</span>
        </div>
        <div className="meta small muted">
          <span>
            {schedule.enabled
              ? next !== null
                ? t('card.next', { date: formatDateTime(schedule.nextRunAt), in: t('common:time.in', { duration: formatDuration(Math.max(0, next - Date.now())) }) })
                : t('card.neverAgain')
              : t('card.pausedNote')}
          </span>
          <span>{last ? t('card.last', { ago: timeAgo(last) }) : t('card.neverRan')}</span>
        </div>
        <Collapsible title={t('card.history')} open={historyOpen} onOpenChange={setHistoryOpen}>
          <RunHistory runs={runs.data} loading={runs.isPending} error={runs.error} />
        </Collapsible>
      </div>
    </Card>
  );
}

function RunHistory({ runs, loading, error }: { runs: ScheduleRun[] | undefined; loading: boolean; error: unknown }) {
  const { t } = useTranslation(['schedules', 'common']);
  if (error) return <ErrorBox error={error} />;
  if (loading) return <Skeleton rows={2} height={16} />;
  if (!runs || runs.length === 0) return <p className="muted small">{t('history.empty')}</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t('history.when')}</th>
            <th scope="col">{t('history.result')}</th>
            <th scope="col">{t('history.slot')}</th>
            <th scope="col">{t('history.produced')}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>{formatDateTime(run.at)}</td>
              <td>
                <RunStatus status={run.status} />
              </td>
              <td>{run.slot ? formatDateTime(run.slot) : <span className="muted">{t('history.byHand')}</span>}</td>
              <td className="break">
                {run.chatId ? (
                  <Link to={`/chats/${run.chatId}`}>{t('history.openChat')}</Link>
                ) : run.orchestrationId ? (
                  <Link to={`/orchestration/${run.orchestrationId}`}>{t('history.openOrchestration')}</Link>
                ) : run.error ? (
                  <span>{run.error}</span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `overlapped` and `queued` are the overlap policy at work, not a failure, so neither reads as one. */
function RunStatus({ status }: { status: ScheduleRunStatus }) {
  const { t } = useTranslation('schedules');
  switch (status) {
    case 'started':
      return <Tag tone="ok">{t('history.started')}</Tag>;
    case 'overlapped':
      return <Tag tone="muted">{t('history.overlapped')}</Tag>;
    case 'queued':
      return <Tag tone="info">{t('history.queued')}</Tag>;
    default:
      return <StatusBadge status={status} />;
  }
}
