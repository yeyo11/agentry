import type { FlowRun, Project, WorkItem, WorkItemStatus } from '@agentry/shared';
import { Check, CornerDownLeft, Workflow } from 'lucide-react';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useFlow, useProjectSettings, useTeam } from '../../../api';
import { ICON_SM } from '../../../components/icons';
import { flowOf } from '../../team/model';
import { PersonMark } from '../../team/parts';
import { RoleAvatar, useRoleName } from '../../team/RoleAvatar';
import { useMoveWorkItem } from './useMoveWorkItem';

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
  /** The role that verifies, for "QA passed it" */
  verifier: string | null;
}

const BoardTeamContext = createContext<BoardTeam | null>(null);

export const useBoardTeam = (): BoardTeam | null => useContext(BoardTeamContext);

/** Reads the team, the flow and its runs for one project; null when there is no team to show. */
export function useBoardTeamData(project: Project | null): BoardTeam | null {
  const on = Boolean(project?.modules.includes('team'));
  const id = on && project ? project.id : null;
  const settings = useProjectSettings(id).data;
  const team = useTeam(id).data;
  const flow = useFlow(id).data;
  return useMemo(() => {
    if (!id || !settings) return null;
    const config = flowOf(settings, team?.members ?? []);
    const running = new Map((flow?.running ?? []).map((run) => [run.itemId, run]));
    return {
      flowOn: config.enabled,
      columns: config.enabled ? config.columns : {},
      maxBounces: config.maxBounces,
      running,
      verifier: config.columns.in_review ?? null,
    };
  }, [id, settings, team, flow]);
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

/** The role on a card's live line: which member is at work on it. */
export function useRunRole(item: Pick<WorkItem, 'id' | 'activeLink'>): string | null {
  const team = useBoardTeam();
  return team?.running.get(item.id)?.role ?? item.activeLink?.teamRole ?? null;
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
    <span className="workitem-fact bounce-mark" title={said}>
      <CornerDownLeft size={12} strokeWidth={1.75} aria-hidden />
      <span aria-hidden>{t('card.bounce', { n: count, max })}</span>
      <span className="sr-only">{said}</span>
    </span>
  );
}

/**
 * What an item waits for from the person, in the idle colour with its word: verification passed and
 * it asks for the move to Done (with that move as the action), or it used every bounce.
 */
export function WaitingNote({ item }: { item: Pick<WorkItem, 'id' | 'key' | 'waiting' | 'bounces' | 'status'> }) {
  const { t } = useTranslation('team');
  const team = useBoardTeam();
  const roleName = useRoleName();
  const move = useMoveWorkItem();
  if (!item.waiting || item.status === 'done') return null;
  const verifier = team?.verifier ? roleName(team.verifier) : null;
  if (item.waiting === 'bounces')
    return (
      <div className="workitem-waiting">
        <span className="badge badge-idle">{t('card.waitsForYou')}</span>
        <span className="workitem-waiting-text">
          {verifier ? t('card.sentBack', { role: verifier, count: item.bounces ?? 0 }) : t('card.sentBackAnon', { count: item.bounces ?? 0 })}
        </span>
      </div>
    );
  return (
    <div className="workitem-waiting is-approval">
      <span className="workitem-waiting-line">
        <span className="badge badge-idle">{t('card.waits')}</span>
        <span className="workitem-waiting-text">{verifier ? t('card.passed', { role: verifier }) : t('card.passedAnon')}</span>
      </span>
      <button
        type="button"
        className="btn btn-small workitem-approve"
        disabled={move.isPending}
        onClick={(event) => {
          // The card around it opens the item; this button only approves
          event.stopPropagation();
          move.mutate({ item, drop: { status: 'done', index: 0 }, column: [] });
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Check {...ICON_SM} />
        {t('card.approve')}
      </button>
    </div>
  );
}
