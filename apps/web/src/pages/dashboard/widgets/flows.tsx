import type { FlowRun } from '@agentry/shared';
import { Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useFlow, useFlowRuns, useFlowWaiting } from '../../../api';
import { ICON } from '@agentry/ui/components/icons';
import { StatusDot } from '@agentry/ui/components/motion';
import { Spinner } from '@agentry/ui/components/Spinner';
import { Skeleton } from '@agentry/ui/components/ui';
import { formatNumber } from '@agentry/ui/lib/format';
import { elapsedSince, formatElapsed } from '@agentry/ui/lib/live';
import { useClockTick } from '@agentry/ui/lib/motion';
import { columnMeta, taskPath } from '../../../lib/work-items';
import { runStep, teamSearch } from '../../team/model';
import { useRoleName } from '../../team/RoleAvatar';
import { configCount } from '../layout';
import { flowRows, type FlowRow } from '../model';
import type { WidgetProps } from '../registry';
import { WidgetCard } from '../WidgetCard';

/** How many rows a size shows; a layout's `limit` overrides it. */
const ROWS = { s: 3, m: 5, l: 7, full: 9 } as const;

const FLOW_PATH = `/${teamSearch(new URLSearchParams(), { section: 'flow' })}`;

function RunClock({ since }: { since: string }) {
  useClockTick(1000);
  return <span className="mono small muted">{formatElapsed(elapsedSince(since))}</span>;
}

function RunLine({ run, row }: { run: FlowRun; row: 'running' | 'queued' | 'ended' }) {
  const { t } = useTranslation(['home', 'team']);
  const roleName = useRoleName();
  const step = runStep(run);
  const live = row === 'running';
  const returned = run.outcome === 'rejected';
  const what = live ? `${roleName(run.role)} · ${t(`team:step.${step}.doing`)}` : `${roleName(run.role)} · ${t(`team:run.badge.${row === 'queued' ? 'queued' : (run.outcome ?? 'cancelled')}`)}`;
  return (
    <Link to={run.item ? taskPath(run.item.key) : FLOW_PATH} className={`flow-row widget-link ${live ? 'live-rail' : ''}`.trim()}>
      {live ? <Spinner variant="ring" /> : <StatusDot tone={row === 'queued' ? 'muted' : returned ? 'warn' : 'bad'} />}
      <span className="flow-what">
        <span className="small ellipsis flow-title">{run.item ? `${run.item.key} · ${run.item.title}` : t('home:widgets.flows.gone')}</span>
        <span className="small muted mono ellipsis">{what}</span>
      </span>
      {live && run.startedAt ? (
        <RunClock since={run.startedAt} />
      ) : row === 'ended' ? (
        <span className={`badge ${returned ? 'badge-warn' : 'badge-bad'}`}>{t(returned ? 'home:widgets.flows.returned' : 'home:widgets.flows.failed')}</span>
      ) : null}
    </Link>
  );
}

function Line({ row }: { row: FlowRow }) {
  const { t } = useTranslation(['home', 'tasks']);
  const roleName = useRoleName();
  if (row.kind !== 'waiting') return <RunLine run={row.run} row={row.kind} />;
  const { column, role, count } = row.column;
  return (
    <Link to={FLOW_PATH} className="flow-row widget-link">
      <StatusDot tone="idle" />
      <span className="flow-what">
        <span className="small ellipsis flow-title">{t('home:widgets.flows.waitingIn', { count, n: formatNumber(count), column: t(`tasks:${columnMeta(column).label}`) })}</span>
        <span className="small muted mono ellipsis">{roleName(role)}</span>
      </span>
      <span className="badge badge-idle">{t('home:widgets.flows.waitsForYou')}</span>
    </Link>
  );
}

/**
 * What the project's flow is doing: the runs going now, the ones queued, the columns with cards
 * waiting, and the latest runs that came back or failed. It exists only while the Team and Board
 * modules are on; with the flow switched off it says so and keeps whatever it can still show.
 */
export function FlowsWidget({ project, size, config, title, id }: WidgetProps) {
  const { t } = useTranslation('home');
  const on = !!project && project.modules.includes('team') && project.modules.includes('board');
  const projectId = on ? project.id : null;
  const flow = useFlow(projectId);
  const waiting = useFlowWaiting(projectId);
  const runs = useFlowRuns(projectId, { limit: 10 });
  if (!project || !on) return null;
  const limit = configCount(config, 'limit', ROWS[size]);
  const rows = flowRows(flow.data, waiting.data, runs.data?.pages[0]?.runs ?? [], limit);
  const loading = flow.isLoading || waiting.isLoading || runs.isLoading;
  const enabled = flow.data?.enabled ?? false;
  return (
    <WidgetCard
      id={id}
      title={title}
      icon={<Workflow {...ICON} className="widget-icon" />}
      aside={flow.data && <span className={`badge ${enabled ? 'badge-ok' : ''}`.trim()}>{t(enabled ? 'widgets.flows.on' : 'widgets.flows.off')}</span>}
      actions={
        <Link to={FLOW_PATH} className="link-more">
          {t('widgets.flows.open')}
        </Link>
      }
    >
      {loading ? (
        <Skeleton rows={3} height={14} />
      ) : rows.length === 0 ? (
        <p className="muted small">{t(enabled ? 'widgets.flows.quiet' : 'widgets.flows.emptyOff')}</p>
      ) : (
        <ul className="widget-rows">
          {rows.map((row) => (
            <li key={row.kind === 'waiting' ? `waiting:${row.column.column}` : `${row.kind}:${row.run.id}`}>
              <Line row={row} />
            </li>
          ))}
        </ul>
      )}
      {flow.data && (
        <div className="widget-foot">
          <span>{t('widgets.flows.atOnce', { count: flow.data.maxParallel, n: formatNumber(flow.data.maxParallel) })}</span>
          <span className="grow" />
          <span>{t('widgets.flows.queued', { count: flow.data.queued.length, n: formatNumber(flow.data.queued.length) })}</span>
        </div>
      )}
    </WidgetCard>
  );
}
