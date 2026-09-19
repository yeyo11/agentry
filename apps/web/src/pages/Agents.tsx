import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useActive, useRuns, useSubagents } from '../api';
import { Location } from '../components/Location';
import { isRunLive, RunCard } from '../components/RunCard';
import { Card, Empty, ErrorBox, Loading, PageHeader, StatusBadge, Tag } from '../components/ui';
import { useDetailPanel } from '../lib/detail';
import { durationBetween, timeAgo } from '../lib/format';

export function Agents() {
  const { t } = useTranslation('work');
  const runs = useRuns();
  const subagents = useSubagents();
  const active = useActive();
  const { open } = useDetailPanel();
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
        title={t('agents.title')}
        subtitle={[
          t('agents.liveRuns', { count: live.length }),
          t('agents.runningSubagents', { count: runningSubs }),
          t('agents.liveCliSessions', { count: liveCli.length }),
        ].join(' · ')}
        actions={
          <Link to="/runs/new" className="btn btn-primary">
            <Plus size={14} strokeWidth={2} aria-hidden />
            {t('agents.newRun')}
          </Link>
        }
      />
      <ErrorBox error={runs.error ?? subagents.error ?? active.error} />

      <Card title={t('agents.liveCard', { n: live.length })}>
        {runs.isLoading ? (
          <Loading />
        ) : live.length === 0 ? (
          <Empty title={t('agents.noLiveRuns')}>{t('agents.noLiveRunsHint')}</Empty>
        ) : (
          <div className="stack">
            {live.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </Card>

      <Card title={t('agents.subagentsCard', { n: subs.length })}>
        {subs.length === 0 ? (
          <Empty title={t('agents.noSubagents')}>{t('agents.noSubagentsHint')}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('shared.column.status')}</th>
                  <th>{t('agents.type')}</th>
                  <th>{t('agents.description')}</th>
                  <th>{t('shared.column.location')}</th>
                  <th>{t('shared.column.startedBy')}</th>
                  <th>{t('shared.column.duration')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {subs.map((sub) => (
                  <tr key={`${sub.runId || sub.sessionId}:${sub.toolUseId || sub.agentId}`}>
                    <td>
                      <StatusBadge status={sub.status} />
                    </td>
                    <td className="nowrap">
                      {sub.subagentType}
                      {sub.background && (
                        <>
                          {' '}
                          <Tag tone="muted">{t('shared.background')}</Tag>
                        </>
                      )}
                    </td>
                    <td>{sub.description || '—'}</td>
                    <td className="cell-clip">
                      <Location location={sub.location} />
                    </td>
                    <td className="cell-clip">
                      {/* A CLI session's agents have no run: they belong to the session */}
                      {sub.runId ? (
                        <Link to={`/runs/${sub.runId}`}>{sub.runName}</Link>
                      ) : (
                        <Link to={`/sessions/${sub.sessionId ?? ''}`}>{sub.runName || t('shared.cliSession')}</Link>
                      )}
                    </td>
                    <td className="nowrap">{durationBetween(sub.startedAt, sub.endedAt)}</td>
                    <td className="nowrap">
                      {sub.sessionId && sub.agentId && (
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => open({ kind: 'subagent', sessionId: sub.sessionId ?? '', agentId: sub.agentId ?? '' })}
                        >
                          {t('agents.details')}
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

      <Card title={t('agents.cliCard', { n: liveCli.length })}>
        {active.isLoading ? (
          <Loading />
        ) : (active.data ?? []).length === 0 ? (
          <Empty title={t('agents.noCli')}>{t('agents.noCliHint')}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('shared.column.status')}</th>
                  <th>{t('agents.name')}</th>
                  <th>{t('agents.kind')}</th>
                  <th>{t('shared.column.location')}</th>
                  <th>{t('agents.pid')}</th>
                  <th>{t('shared.column.started')}</th>
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
                        <Tag tone="muted">{s.state === 'done' ? t('agents.finished') : t('agents.spare')}</Tag>
                      )}
                    </td>
                    <td>{s.kind}</td>
                    <td className="cell-clip">
                      <Location location={s.location} fallback={s.cwd} />
                    </td>
                    <td>{s.pid}</td>
                    <td className="nowrap">{timeAgo(s.startedAt)}</td>
                    <td className="nowrap">
                      {s.runId ? (
                        <Link to={`/runs/${s.runId}`}>{t('agents.runLink')}</Link>
                      ) : (
                        <Link to={`/sessions/${s.sessionId}`}>{t('agents.sessionLink')}</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {ended.length > 0 && (
        <Card title={t('agents.endedCard', { n: ended.length })}>
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
