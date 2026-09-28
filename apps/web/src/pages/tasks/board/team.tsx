import type { FlowRun, Project, WorkItem, WorkItemStatus } from '@agentry/shared';
import { CornerDownLeft, Workflow } from 'lucide-react';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useFlow, useFlowRuns, useProjectSettings, useTeam } from '../../../api';
import { ICON_SM } from '../../../components/icons';
import { lastEndedRuns, type StripRuns } from '../../../lib/work-items';
import { flowOf } from '../../team/model';
import { PersonMark } from '../../team/parts';
import { RoleAvatar, useRoleName } from '../../team/RoleAvatar';

/**
 * What a board worked by a team shows beyond its cards: the role that answers for each column, the
 * flow run on each card, and the bounce limit. Only for one project with its Team module on; the
 * All projects board and a project without a team draw the plain board.
 */
export interface BoardTeam {
  flowOn: boolean;
  /** The role per column while the flow is on; empty while it is off */
  columns: Partial<Record<WorkItemStatus, string>>;
  maxBounces: number;
  /** The run working on each item now, by item id */
  running: ReadonlyMap<string, FlowRun>;
  /** The run waiting for a place on each item, by item id */
  queued: ReadonlyMap<string, FlowRun>;
  /** The newest failed or rejected run of each item, for a strip that says why */
  ended: ReadonlyMap<string, FlowRun>;
  /** How many runs may work at once, and how many wait: the flow's state in words on a phone */
  maxParallel: number;
  queuedCount: number;
  /** The role that verifies, for "QA passed it" */
  verifier: string | null;
}

const BoardTeamContext = createContext<BoardTeam | null>(null);

export const useBoardTeam = (): BoardTeam | null => useContext(BoardTeamContext);

/** A card's failure or QA's words come from the latest runs that did not pass; one page is plenty for a board. */
const ENDED_QUERY = { status: ['failed' as const, 'rejected' as const], limit: 50 };

/** Reads the team, the flow and its runs for one project; null when there is no team to show. */
export function useBoardTeamData(project: Project | null): BoardTeam | null {
  const on = Boolean(project?.modules.includes('team'));
  const id = on && project ? project.id : null;
  const settings = useProjectSettings(id).data;
  const team = useTeam(id).data;
  const flow = useFlow(id).data;
  const endedPages = useFlowRuns(id, ENDED_QUERY).data;
  return useMemo(() => {
    if (!id || !settings) return null;
    const config = flowOf(settings, team?.members ?? []);
    const running = new Map((flow?.running ?? []).map((run) => [run.itemId, run]));
    const queued = new Map<string, FlowRun>();
    // The first in line for each item: the one that starts next
    for (const run of flow?.queued ?? []) if (!queued.has(run.itemId)) queued.set(run.itemId, run);
    return {
      flowOn: config.enabled,
      columns: config.enabled ? config.columns : {},
      maxBounces: config.maxBounces,
      running,
      queued,
      ended: lastEndedRuns(endedPages?.pages[0]?.runs ?? []),
      maxParallel: flow?.maxParallel ?? 0,
      queuedCount: flow?.queued.length ?? 0,
      verifier: config.columns.in_review ?? null,
    };
  }, [id, settings, team, flow, endedPages]);
}

/** The runs a card's strip reads, from the board's team; none on a board without one. */
export function useStripRuns(): StripRuns {
  const team = useBoardTeam();
  return team ?? {};
}

export function BoardTeamProvider({ value, children }: { value: BoardTeam | null; children: ReactNode }) {
  return <BoardTeamContext.Provider value={value}>{children}</BoardTeamContext.Provider>;
}

/** The toolbar's way to the flow, with its state in a word: the board is where its effects show. */
export function FlowButton({ team, projectId }: { team: BoardTeam; projectId: string }) {
  const { t } = useTranslation('team');
  return (
    <Link to={`/?${new URLSearchParams({ project: projectId, view: 'team', section: 'flow' }).toString()}`} className="btn board-flow-btn">
      <Workflow {...ICON_SM} />
      {t('flow.auto')}
      <span className="badge badge-muted">{team.flowOn ? t('flow.enabled') : t('flow.disabled')}</span>
    </Link>
  );
}

/**
 * The flow's state on a phone, one row under the views (MobileTableroEquipo): how many runs go at
 * once and how many wait, and whether it is on. The whole row leads to the flow.
 */
export function PhoneFlowRow({ team, projectId }: { team: BoardTeam; projectId: string }) {
  const { t } = useTranslation(['team', 'tasks']);
  return (
    <Link to={`/?${new URLSearchParams({ project: projectId, view: 'team', section: 'flow' }).toString()}`} className="card board-flow-row">
      <Workflow {...ICON_SM} />
      <span className="board-flow-row-text">
        {t('flow.auto')}
        {team.flowOn && <span className="board-flow-row-figures"> · {t('tasks:flowRow', { parallel: team.maxParallel, queued: team.queuedCount })}</span>}
      </span>
      <span className="badge badge-muted">{team.flowOn ? t('flow.enabled') : t('flow.disabled')}</span>
    </Link>
  );
}

/** Who acts when a card enters this column: its role, or, on Done, the person who approves. */
export function ColumnRole({ status, named = false }: { status: WorkItemStatus; named?: boolean }) {
  const { t } = useTranslation('team');
  const team = useBoardTeam();
  const roleName = useRoleName();
  if (!team?.flowOn) return null;
  if (status === 'done') return <PersonMark size={22} />;
  const role = team.columns[status];
  if (!role) return null;
  return (
    <span className="board-column-role" title={t('board.columnRole', { role: roleName(role) })}>
      <RoleAvatar role={role} size="sm" label={t('board.columnRole', { role: roleName(role) })} />
      {named && <span className="board-column-role-name">{roleName(role)}</span>}
    </span>
  );
}

/** "rebote 1 de 3": QA sent it back; neutral while it has bounces left. */
export function BounceFact({ item }: { item: Pick<WorkItem, 'bounces'> }) {
  const { t } = useTranslation('team');
  const team = useBoardTeam();
  const count = item.bounces ?? 0;
  if (count === 0) return null;
  const max = team?.maxBounces ?? count;
  const said = t('card.bounceTitle', { count, max });
  return (
    <span className="workitem-fact bounce" title={said}>
      <CornerDownLeft size={12} strokeWidth={1.75} aria-hidden />
      <span aria-hidden>{t('card.bounce', { n: count, max })}</span>
      <span className="sr-only">{said}</span>
    </span>
  );
}
