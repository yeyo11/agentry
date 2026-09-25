import type { Project } from '@agentry/shared';
import { useChats, useOrchestrations, useOverview, useUsage } from '../../api';
import { inProject } from '../../lib/project-scope';
import { limitSummary, type LimitSummary } from './model';

const pad = (n: number) => String(n).padStart(2, '0');

/** Today as the Usage API names a day, in the browser's own time zone. */
export const localDay = (d: Date = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Where "New orchestration" opens its dialog; the palette's own constant says the same, but its
 * module brings the palette's stylesheet, which the unit tests of this folder cannot load.
 */
export const NEW_ORCHESTRATION_PATH = '/orchestration?new=1';

/** The chats that wait for a person, workers of an orchestration included. */
export const WAITING_ORIGINS = ['agentry', 'external', 'orchestration'] as const;

export interface HomePulse {
  loading: boolean;
  /** The API did not answer: nothing here can be said about the live state */
  unreachable: boolean;
  /** Agents at work: working chats plus the running tasks of running orchestrations */
  agents: number;
  chatsWorking: number;
  orchestrationsRunning: number;
  /** Chats waiting for a person, plus orchestrations holding for a decision */
  waiting: number;
  /** Today's spend; `null` while unknown or when no chat reports it */
  spentToday: number | null;
  chatsWithoutCost: number;
  limits: LimitSummary;
}

/**
 * The figures the Home hero and its KPI strip say, in one place. Every query here is the very one
 * a widget of the page (or the shell) already makes, with the same key, so the cache answers them
 * together and nothing is fetched twice.
 */
export function useHomePulse(project: Project | null): HomePulse {
  const scope = project?.id;
  const overview = useOverview();
  const orchestrations = useOrchestrations();
  const working = useChats({ project: scope, state: 'working' });
  const waiting = useChats({ project: scope, state: 'waiting', origin: [...WAITING_ORIGINS] });
  const today = localDay();
  const usage = useUsage({ from: today, to: today });

  const scoped = (orchestrations.data ?? []).filter((o) => !project || inProject(project, o.cwd));
  const running = scoped.filter((o) => o.status === 'running');
  const runningTasks = running.reduce((n, o) => n + o.tasks.filter((task) => task.status === 'running').length, 0);
  const chatsWorking = working.data?.length ?? 0;
  const row = project ? usage.data?.projects.find((p) => p.project?.id === project.id) : usage.data?.total;

  return {
    loading: overview.isLoading || orchestrations.isLoading || working.isLoading || waiting.isLoading,
    unreachable: overview.isError && !overview.data,
    agents: chatsWorking + runningTasks,
    chatsWorking,
    orchestrationsRunning: running.length,
    waiting: (waiting.data?.length ?? 0) + scoped.filter((o) => o.status === 'waiting').length,
    // A project with no row today has spent nothing yet; a missing answer is not zero
    spentToday: usage.data ? (row ? row.costUsd : 0) : null,
    chatsWithoutCost: row?.chatsWithoutCost ?? 0,
    limits: limitSummary(overview.data),
  };
}
