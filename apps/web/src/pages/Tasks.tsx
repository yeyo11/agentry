import type { BackgroundTask } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Location } from '../components/Location';
import { useTasks } from '../api';
import { Card, Empty, ErrorBox, Loading, PageHeader, StatusBadge, Tag } from '../components/ui';
import { useDetailPanel } from '../lib/detail';
import { durationBetween, timeAgo } from '../lib/format';

export function Tasks() {
  const { t } = useTranslation('work');
  const { data, error, isLoading } = useTasks();
  const { open } = useDetailPanel();
  const tasks = [...(data ?? [])].sort(
    (a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt.localeCompare(a.startedAt),
  );
  const running = tasks.filter((task) => task.status === 'running').length;
  const key = (task: BackgroundTask) => `${task.runId || task.sessionId}:${task.id}`;

  return (
    <>
      <PageHeader title={t('tasks.title')} subtitle={t('tasks.subtitle', { running, total: tasks.length })} />
      <ErrorBox error={error} />
      <Card>
        {isLoading ? (
          <Loading />
        ) : tasks.length === 0 ? (
          <Empty title={t('tasks.empty')}>{t('tasks.emptyHint')}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('shared.column.status')}</th>
                  <th>{t('tasks.command')}</th>
                  <th>{t('shared.column.location')}</th>
                  <th>{t('shared.column.startedBy')}</th>
                  <th>{t('shared.column.started')}</th>
                  <th>{t('shared.column.duration')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={key(task)}>
                    <td>
                      <StatusBadge status={task.status} />
                    </td>
                    <td className="task-command">
                      <div>
                        {task.description || '—'}
                        {/* Sent to the background from the terminal, not decided by the model */}
                        {task.backgroundedByUser && (
                          <>
                            {' '}
                            <Tag tone="muted">{t('tasks.byYou')}</Tag>
                          </>
                        )}
                        {/* Launched by a subagent, so the main agent's own transcript never mentions it */}
                        {task.fromSubagent && (
                          <>
                            {' '}
                            <Tag tone="info">{t('shared.fromSubagent')}</Tag>
                          </>
                        )}
                      </div>
                      {task.command && task.command !== task.description && (
                        <div className="mono small muted ellipsis" title={task.command}>
                          {task.command}
                        </div>
                      )}
                      {task.summary && <div className="muted small">{task.summary}</div>}
                    </td>
                    <td className="cell-clip">
                      <Location location={task.location} />
                    </td>
                    <td className="cell-clip">
                      {task.runId ? (
                        <Link to={`/runs/${task.runId}`}>{task.runName}</Link>
                      ) : (
                        <Link to={`/sessions/${task.sessionId ?? ''}`}>{task.runName || t('shared.cliSession')}</Link>
                      )}
                    </td>
                    <td className="nowrap">{timeAgo(task.startedAt)}</td>
                    <td className="nowrap">{durationBetween(task.startedAt, task.endedAt)}</td>
                    <td className="nowrap">
                      {task.sessionId && (
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => open({ kind: 'task', sessionId: task.sessionId ?? '', taskId: task.id })}
                        >
                          {t('tasks.output')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
