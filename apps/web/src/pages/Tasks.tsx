import { Link } from 'react-router-dom';
import { useTasks } from '../api';
import { Card, Empty, ErrorBox, Loading, PageHeader, StatusBadge } from '../components/ui';
import { durationBetween, timeAgo } from '../lib/format';

export function Tasks() {
  const { data, error, isLoading } = useTasks();
  const tasks = [...(data ?? [])].sort(
    (a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt.localeCompare(a.startedAt),
  );
  const running = tasks.filter((t) => t.status === 'running').length;

  return (
    <>
      <PageHeader title="Background tasks" subtitle={`${running} running · ${tasks.length} total across wrapper runs`} />
      <ErrorBox error={error} />
      <Card>
        {isLoading ? (
          <Loading />
        ) : tasks.length === 0 ? (
          <Empty title="No background tasks">
            Background shells and agents started by runs (e.g. Bash with run_in_background) appear here.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>ID</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th>Run</th>
                  <th>Started</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={`${task.runId}:${task.id}`}>
                    <td>
                      <StatusBadge status={task.status} />
                    </td>
                    <td className="mono">{task.id}</td>
                    <td className="nowrap">{task.type}</td>
                    <td>
                      <div className="mono">{task.description || '—'}</div>
                      {task.summary && <div className="muted small">{task.summary}</div>}
                    </td>
                    <td className="nowrap">
                      <Link to={`/runs/${task.runId}`}>{task.runName}</Link>
                    </td>
                    <td className="nowrap">{timeAgo(task.startedAt)}</td>
                    <td className="nowrap">{durationBetween(task.startedAt, task.endedAt)}</td>
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
