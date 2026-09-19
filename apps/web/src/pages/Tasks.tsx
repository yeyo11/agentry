import type { BackgroundTask } from '@agentry/shared';
import { Link } from 'react-router-dom';
import { Location } from '../components/Location';
import { useTasks } from '../api';
import { Card, Empty, ErrorBox, Loading, PageHeader, StatusBadge, Tag } from '../components/ui';
import { useDetailPanel } from '../lib/detail';
import { durationBetween, timeAgo } from '../lib/format';

export function Tasks() {
  const { data, error, isLoading } = useTasks();
  const { open } = useDetailPanel();
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
            Commands sent to the background — by a run, or by a session started from a terminal — appear here. Long
            commands that run in the foreground are not listed, even though the CLI reports them as tasks. Agents are listed
            under Agents, and workflows under Workflows.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Command</th>
                  <th>Location</th>
                  <th>Started by</th>
                  <th>Started</th>
                  <th>Duration</th>
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
                            <Tag tone="muted">by you</Tag>
                          </>
                        )}
                        {/* Launched by a subagent, so the main agent's own transcript never mentions it */}
                        {task.fromSubagent && (
                          <>
                            {' '}
                            <Tag tone="info">from subagent</Tag>
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
                          onClick={() => open({ kind: 'task', sessionId: task.sessionId ?? '', taskId: task.id })}
                        >
                          Output
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
