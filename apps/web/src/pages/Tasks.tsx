import type { BackgroundTask } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useTasks } from '../api';
import { Card, Empty, ErrorBox, Loading, PageHeader, StatusBadge, Tag } from '../components/ui';
import { durationBetween, timeAgo } from '../lib/format';

/** What the command printed, fetched only when someone asks: outputs can be long. */
function TaskOutput({ task }: { task: BackgroundTask }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['task-output', task.sessionId, task.id],
    queryFn: () => api.taskOutput(task.sessionId ?? '', task.id),
    // A running command keeps writing; a finished one will not change
    refetchInterval: task.status === 'running' ? 3000 : false,
  });
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <>
      {data?.truncated && <div className="muted small">Showing the end of {Math.round((data.bytes ?? 0) / 1024)} KiB of output.</div>}
      <pre className="task-output">{data?.output.trim() || '(no output)'}</pre>
    </>
  );
}

export function Tasks() {
  const { data, error, isLoading } = useTasks();
  const [open, setOpen] = useState<string | null>(null);
  const tasks = [...(data ?? [])].sort(
    (a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt.localeCompare(a.startedAt),
  );
  const running = tasks.filter((t) => t.status === 'running').length;
  const key = (t: BackgroundTask) => `${t.runId || t.sessionId}:${t.id}`;

  return (
    <>
      <PageHeader title="Background tasks" subtitle={`${running} running · ${tasks.length} total across runs and CLI sessions`} />
      <ErrorBox error={error} />
      <Card>
        {isLoading ? (
          <Loading />
        ) : tasks.length === 0 ? (
          <Empty title="No background tasks">
            Shell commands sent to the background — by a run, or by a session started from a terminal — appear here.
            Agents are listed under Agents.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Command</th>
                  <th>Started by</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <Fragment key={key(task)}>
                    <tr>
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
                              <Tag tone="muted">by you</Tag>
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
                      <td className="nowrap">
                        {task.runId ? (
                          <Link to={`/runs/${task.runId}`}>{task.runName}</Link>
                        ) : (
                          <Link to={`/sessions/${task.sessionId ?? ''}`}>{task.runName || 'CLI session'}</Link>
                        )}
                      </td>
                      <td className="nowrap">{timeAgo(task.startedAt)}</td>
                      <td className="nowrap">{durationBetween(task.startedAt, task.endedAt)}</td>
                      <td className="nowrap">
                        {task.sessionId && (
                          <button
                            type="button"
                            className="btn btn-small"
                            aria-expanded={open === key(task)}
                            onClick={() => setOpen(open === key(task) ? null : key(task))}
                          >
                            {open === key(task) ? 'Hide output' : 'Output'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {open === key(task) && (
                      <tr>
                        <td colSpan={6}>
                          <TaskOutput task={task} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
