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
import { ListToolbar, type ListToolbarTab } from '../components/ListToolbar';
import { Empty, ErrorBox, PageHeader, Skeleton, StatusBadge, Tag } from '../components/ui';
import { formatDateTime, formatDuration, timeAgo, toMs } from '../lib/format';
import { matchesText, scheduleFields, scheduleView, type ScheduleView } from '../lib/lists';
import '../insights.css';

/** The recurring chats and orchestrations, with the timetable of each said in words and what each run produced. */
export function Schedules() {
  const { t } = useTranslation(['schedules', 'common']);
  const schedules = useSchedules();
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ScheduleView>('all');
  const all = schedules.data ?? [];
  const found = all.filter((schedule) => matchesText(search, scheduleFields(schedule)));
  const shown = found.filter((schedule) => view === 'all' || scheduleView(schedule) === view);
  const tabs: Array<ListToolbarTab<ScheduleView>> = [
    { id: 'all', label: t('list.all'), count: found.length },
    { id: 'on', label: t('list.on'), count: found.filter((s) => s.enabled).length },
    { id: 'off', label: t('list.off'), count: found.filter((s) => !s.enabled).length },
  ];

  return (
    <>
      <PageHeader
        title={t('page.title')}
        subtitle={t('page.subtitle')}
        actions={
          <Link to="/schedules/new" className="btn btn-primary">
            <Plus {...ICON_SM} /> {t('page.new')}
          </Link>
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
            <Link to="/schedules/new" className="btn btn-primary">
              <Plus {...ICON_SM} /> {t('page.new')}
            </Link>
          }
        >
          {t('page.emptyBody')}
        </Empty>
      ) : (
        <div className="schedules">
          <ListToolbar
            search={{ value: search, onChange: setSearch, placeholder: t('list.searchPlaceholder'), label: t('list.searchLabel') }}
            tabs={{ value: view, options: tabs, onChange: setView, label: t('list.show') }}
          />
          {shown.length === 0 ? (
            <Empty icon={CalendarClock} title={t('list.noneMatch')}>
              {t('list.noneMatchBody')}
            </Empty>
          ) : (
            <ul className="lrows">
              {shown.map((schedule) => (
                <ScheduleCard key={schedule.id} schedule={schedule} />
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

function ScheduleCard({ schedule }: { schedule: Schedule }) {
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
    <li className={`lrow schedule-card ${schedule.enabled ? 'is-ok' : 'is-muted'}`}>
      <div className="lrow-head">
        <div className="lrow-main">
          <span className="lrow-title">
            <span className="break">{schedule.name}</span>
            <Tag>{t(`card.kind.${schedule.target.kind}`)}</Tag>
            {!schedule.enabled && <Tag tone="muted">{t('card.off')}</Tag>}
            {schedule.overlap !== 'parallel' && <Tag>{t(`card.overlap.${schedule.overlap}`)}</Tag>}
          </span>
          <span className="lrow-sub schedule-when">
            <code className="mono">{schedule.cron}</code>
            {schedule.timezone && <span className="mono">{schedule.timezone}</span>}
            {words.data?.valid && <span>{words.data.description}</span>}
            <span>
              {schedule.enabled
                ? next !== null
                  ? t('card.next', { date: formatDateTime(schedule.nextRunAt), in: t('common:time.in', { duration: formatDuration(Math.max(0, next - Date.now())) }) })
                  : t('card.neverAgain')
                : t('card.pausedNote')}
            </span>
            <span>{last ? t('card.last', { ago: timeAgo(last) }) : t('card.neverRan')}</span>
          </span>
        </div>
        <span className="lrow-actions">
          <Switch checked={schedule.enabled} onChange={(enabled) => toggle.mutate(enabled)} disabled={toggle.isPending}>
            {t('card.enabledLabel')}
          </Switch>
          <Tooltip content={t('card.runNowHint')}>
            <button type="button" className="btn btn-small" disabled={runNow.isPending} onClick={() => runNow.mutate()} aria-label={t('card.runNowNamed', { name: schedule.name })}>
              <Play {...ICON_SM} /> {t('card.runNow')}
            </button>
          </Tooltip>
          <Tooltip content={t('card.edit')}>
            <Link to={`/schedules/${schedule.id}/edit`} className="btn btn-small" aria-label={t('card.editNamed', { name: schedule.name })}>
              <Pencil {...ICON_SM} />
            </Link>
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
      </div>
      <Collapsible title={t('card.history')} open={historyOpen} onOpenChange={setHistoryOpen}>
        <RunHistory runs={runs.data} loading={runs.isPending} error={runs.error} />
      </Collapsible>
    </li>
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
