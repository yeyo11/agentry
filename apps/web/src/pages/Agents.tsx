import { Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useActive, useRuns, useSubagents } from '../api';
import { isRunLive, RunCard } from '../components/RunCard';
import { Card, Empty, ErrorBox, Loading, PageHeader, StatusBadge, Tag } from '../components/ui';
import { durationBetween, shortPath, timeAgo } from '../lib/format';

export function Agents() {
  const runs = useRuns();
  const subagents = useSubagents();
  const active = useActive();
  // Processes the CLI still lists but nobody is working in: they show, they just do not count
  const liveCli = (active.data ?? []).filter((s) => s.live);

  const all = runs.data ?? [];
  const live = all.filter(isRunLive);
  const ended = all.filter((r) => !isRunLive(r));
  const subs = [...(subagents.data ?? [])].sort(
    (a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt.localeCompare(a.startedAt),
  );
  const runningSubs = subs.filter((s) => s.status === 'running').length;

  return (
    <>
      <PageHeader
        title="Agents in progress"
        subtitle={`${live.length} live runs · ${runningSubs} running subagents · ${liveCli.length} live CLI sessions`}
        actions={
          <Link to="/runs/new" className="btn btn-primary">
            <Plus size={14} strokeWidth={2} aria-hidden />
            New run
          </Link>
        }
      />
      <ErrorBox error={runs.error ?? subagents.error ?? active.error} />

      <Card title={`Agentry runs — live (${live.length})`}>
        {runs.isLoading ? (
          <Loading />
        ) : live.length === 0 ? (
          <Empty title="No live runs">Runs started through the API or this UI show up here.</Empty>
        ) : (
          <div className="stack">
            {live.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </Card>

      <Card title={`Subagents (${subs.length})`}>
        {subs.length === 0 ? (
          <Empty title="No subagents">Subagents spawned by runs (Task/Agent tool) are tracked here.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th>Parent run</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((sub) => (
                  <tr key={`${sub.runId}:${sub.toolUseId}`}>
                    <td>
                      <StatusBadge status={sub.status} />
                    </td>
                    <td className="nowrap">{sub.subagentType}</td>
                    <td>{sub.description || '—'}</td>
                    <td className="nowrap">
                      <Link to={`/runs/${sub.runId}`}>{sub.runName}</Link>
                    </td>
                    <td className="nowrap">{durationBetween(sub.startedAt, sub.endedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Live CLI sessions (${liveCli.length})`}>
        {active.isLoading ? (
          <Loading />
        ) : (active.data ?? []).length === 0 ? (
          <Empty title="No live CLI sessions">Reported by `claude agents --json`.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Directory</th>
                  <th>PID</th>
                  <th>Started</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(active.data ?? []).map((s) => (
                  <tr key={`${s.pid}:${s.sessionId}`} className={s.live ? '' : 'muted'}>
                    <td>
                      <StatusBadge status={s.state === 'done' ? 'done' : s.status} />
                    </td>
                    <td>
                      {s.name || s.sessionId.slice(0, 8)}
                      {!s.live && (
                        <Tag tone="muted">{s.state === 'done' ? 'finished' : 'spare'}</Tag>
                      )}
                    </td>
                    <td>{s.kind}</td>
                    <td className="mono" title={s.cwd}>
                      {shortPath(s.cwd, 44)}
                    </td>
                    <td>{s.pid}</td>
                    <td className="nowrap">{timeAgo(s.startedAt)}</td>
                    <td className="nowrap">
                      {s.runId ? <Link to={`/runs/${s.runId}`}>run</Link> : <Link to={`/sessions/${s.sessionId}`}>session</Link>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {ended.length > 0 && (
        <Card title={`Ended runs (${ended.length})`}>
          <div className="stack">
            {ended.map((run) => (
              <RunCard key={run.id} run={run} compact />
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
