import type { ChatSummary, Orchestration } from '@agentry/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  CalendarClock,
  ChevronRight,
  CircleAlert,
  FolderGit2,
  GitMerge,
  Hourglass,
  KeyRound,
  MessageCircle,
  MessageCircleQuestion,
  Plus,
  ShieldQuestion,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useChats, useOrchestrations, useOverview, useProjects, useSchedules } from '../../../api';
import { ActivityTicker } from '../../../components/ActivityTicker';
import { ICON_SM } from '../../../components/icons';
import { ProgressRing, StatusDot, usageTone } from '../../../components/motion';
import { Empty, Skeleton, StatusBadge } from '../../../components/ui';
import { displayTitle } from '../../../lib/chat-model';
import { detailHref } from '../../../lib/detail';
import { formatCost, formatDuration, formatNumber, timeAgo, timeUntil, truncate } from '../../../lib/format';
import { formatElapsed } from '../../../lib/live';
import { useClockTick } from '../../../lib/motion';
import { inProject } from '../../../lib/project-scope';
import type { ProgressStatus } from '../../../lib/progress';
import { configCount } from '../layout';
import {
  initials,
  liveByProject,
  orchestrationStages,
  orchestrationsToShow,
  scheduleCwd,
  taskCounts,
  taskSegments,
  upcomingSchedules,
  waitingFor,
} from '../model';
import { NEW_ORCHESTRATION_PATH, WAITING_ORIGINS } from '../pulse';
import type { WidgetProps } from '../registry';
import { WidgetCard } from '../WidgetCard';

/** A command running this long in the background is worth a look; there is no baseline to compare it with yet. */
const HUNG_TASK_MS = 15 * 60_000;

const chatHref = (chat: Pick<ChatSummary, 'id'>) => `/chats/${encodeURIComponent(chat.id)}`;
const orchestrationHref = (o: Pick<Orchestration, 'id'>) => `/orchestration/${encodeURIComponent(o.id)}`;

function Loading() {
  return <Skeleton rows={3} height={16} />;
}

const contextPercent = (chat: ChatSummary) => (chat.context?.window ? Math.round((chat.context.used / chat.context.window) * 100) : null);

/** How full a chat's context is, as a small ring: neutral until it nears the point it compacts. */
function ContextRing({ chat }: { chat: ChatSummary }) {
  const { t } = useTranslation('home');
  const percent = contextPercent(chat);
  if (percent === null) return null;
  return (
    <span className="home-ring" role="img" aria-label={t('activity.context', { percent })}>
      <ProgressRing value={percent / 100} size={28} stroke={3} tone={usageTone(percent)}>
        <span aria-hidden>{percent}%</span>
      </ProgressRing>
    </span>
  );
}

/** Two letters on a tile: what an orchestration or a project is, at a glance. */
export function InitialsBadge({ name, tone = 'accent' }: { name: string; tone?: 'accent' | 'idle' | 'live' | 'neutral' }) {
  return (
    <span className={`initials-badge is-${tone}`} aria-hidden>
      {initials(name)}
    </span>
  );
}

// ---------- In progress ----------

interface AttentionRow {
  key: string;
  icon: LucideIcon;
  /** What is waiting: the icon and this text say it, colour only reinforces */
  what: ReactNode;
  detail?: ReactNode;
  to: string;
  action: string;
}

/** An orchestration's tasks, one segment each: done, on, and still ahead. */
function TaskSegments({ orchestration: o }: { orchestration: Orchestration }) {
  const { t } = useTranslation('home');
  const counts = taskCounts(o.tasks);
  const segments = taskSegments(o.tasks);
  return (
    <span
      className="segbar"
      role="img"
      aria-label={t('widgets.orchestrations.progress', { done: counts.done ?? 0, total: o.tasks.length, running: counts.running ?? 0 })}
    >
      {segments.map((status: ProgressStatus, index) => (
        <i key={index} className={`is-${status}`} />
      ))}
    </span>
  );
}

function ElapsedBadge({ ms }: { ms: number }) {
  return <span className="badge mono orch-item-elapsed">{Number.isFinite(ms) ? formatElapsed(ms) : '—'}</span>;
}

/** How long it has been going, ticking every second while it does. */
function LiveElapsed({ from }: { from: string }) {
  useClockTick(1000);
  return <ElapsedBadge ms={Date.now() - Date.parse(from)} />;
}

function Elapsed({ from, to }: { from: string; to: string | null }) {
  return to ? <ElapsedBadge ms={Date.parse(to) - Date.parse(from)} /> : <LiveElapsed from={from} />;
}

/**
 * One orchestration as it goes: who it is, what it cost and how long it has run, a segment per task,
 * the counts in words, and the command its running task is on right now.
 */
function OrchestrationItem({ orchestration: o }: { orchestration: Orchestration }) {
  const { t } = useTranslation('home');
  const stages = orchestrationStages(o);
  const counts = taskCounts(o.tasks);
  const runningTask = o.tasks.find((task) => task.status === 'running' && task.activity);
  const live = o.status === 'running';
  const current = stages.findIndex((stage) => stage.state === 'current' || stage.state === 'waiting');
  const meta = [t('widgets.orchestrations.kind'), o.model, o.concurrency > 1 ? t('widgets.orchestrations.parallel', { n: o.concurrency }) : null].filter(Boolean).join(' · ');
  return (
    <li className={`orch-item ${live ? 'live-rail' : ''}`.trim()}>
      <div className="orch-item-head">
        <InitialsBadge name={o.name} tone={live ? 'accent' : 'idle'} />
        <span className="orch-item-name">
          <Link to={orchestrationHref(o)} className="strong ellipsis">
            {o.name}
          </Link>
          <span className="mono faint ellipsis">{meta}</span>
        </span>
        {!live && <StatusBadge status={o.status} />}
        <span className="mono tnum orch-item-cost">{formatCost(o.costUsd)}</span>
        <Elapsed from={o.createdAt} to={o.endedAt} />
      </div>
      <TaskSegments orchestration={o} />
      <div className="orch-item-counts">
        <span>
          <span className="dot dot-ok" aria-hidden />
          {t('widgets.orchestrations.done', { count: counts.done ?? 0, n: counts.done ?? 0 })}
        </span>
        {(counts.running ?? 0) > 0 && (
          <span>
            <span className="dot dot-live" aria-hidden />
            {t('widgets.orchestrations.running', { n: counts.running ?? 0 })}
          </span>
        )}
        {(counts.failed ?? 0) > 0 && (
          <span>
            <span className="dot dot-bad" aria-hidden />
            {t('widgets.orchestrations.failed', { count: counts.failed ?? 0, n: counts.failed ?? 0 })}
          </span>
        )}
        {(counts.pending ?? 0) > 0 && (
          <span className="faint">
            <span className="dot" aria-hidden />
            {t('widgets.orchestrations.pending', { count: counts.pending ?? 0, n: counts.pending ?? 0 })}
          </span>
        )}
        {stages.length > 1 && (
          <span className="mono faint orch-item-stage">
            {t('widgets.orchestrations.stageOf', { n: (current === -1 ? stages.length - 1 : current) + 1, total: stages.length })}
          </span>
        )}
      </div>
      {runningTask ? (
        <div className="run-line">
          <ActivityTicker activity={runningTask.activity} className="run-line-ticker" />
          <span className="mono faint ellipsis run-line-task">{runningTask.name}</span>
        </div>
      ) : !live ? (
        <div className="small muted">
          {o.status === 'waiting' ? t('widgets.orchestrations.started', { when: timeAgo(o.createdAt) }) : t('widgets.orchestrations.ended', { when: timeAgo(o.endedAt ?? o.createdAt) })}
        </div>
      ) : null}
    </li>
  );
}

/** A chat at work: what it is about, what it is doing this second, and how full its context is. */
function WorkingChat({ chat, showProject }: { chat: ChatSummary; showProject: boolean }) {
  const { t } = useTranslation('home');
  return (
    <li className="now-row live-rail">
      <span className="initials-badge is-live" aria-hidden>
        <MessageCircle {...ICON_SM} />
      </span>
      <div className="now-main">
        <Link to={chatHref(chat)} className="strong ellipsis now-title">
          {displayTitle(chat)}
        </Link>
        {chat.activity ? (
          <ActivityTicker activity={chat.activity} className="now-ticker" />
        ) : (
          <span className="small muted ellipsis">{t('widgets.now.noActivity')}</span>
        )}
      </div>
      <span className="meta mono now-meta">
        {showProject && <span>{chat.project?.name ?? t('activity.noProject')}</span>}
        {chat.worktree?.branch && <span>{chat.worktree.branch}</span>}
        <span>{chat.cost.usd === null ? t('activity.costUnavailable') : formatCost(chat.cost.usd)}</span>
      </span>
      <ContextRing chat={chat} />
    </li>
  );
}

/**
 * "In progress": everything that needs a person, with its action on the row, then each live
 * orchestration and each chat at work, with what it is doing right now. The page's one energy
 * border goes here while anything runs. With nothing to show it folds to a short welcome, so it
 * never pushes anything down. `project` scopes all of it except the account's own health.
 */
export function NowWidget({ project, title, id }: WidgetProps) {
  const { t } = useTranslation(['home', 'common']);
  const scope = project?.id;
  const overview = useOverview();
  const orchestrations = useOrchestrations();
  // A worker of an orchestration stopped for a permission waits for a person like any other chat
  const waitingChats = useChats({ project: scope, state: 'waiting', origin: [...WAITING_ORIGINS] });
  const workingChats = useChats({ project: scope, state: 'working' });
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: api.tasks, refetchInterval: 30_000 });
  const waiting = waitingChats.data ?? [];
  const permissions = useQueries({
    queries: waiting.map((chat) => ({ queryKey: keys.chatPermissions(chat.id), queryFn: () => api.chatPermissions(chat.id) })),
  });

  const scoped = (orchestrations.data ?? []).filter((o) => !project || inProject(project, o.cwd));
  const liveOrchestrations = orchestrationsToShow(scoped, 20).filter((o) => o.status === 'running' || o.status === 'waiting');
  const system = overview.data?.system;
  const rows: AttentionRow[] = [];
  // The CLI's own trouble, kept apart: when it is all there is to say, it is the whole card
  const setup: 'cli' | 'auth' | null = system && !system.cli.installed ? 'cli' : system && !system.auth.loggedIn ? 'auth' : null;
  if (setup === 'cli' && system) {
    rows.push({
      key: 'cli',
      icon: CircleAlert,
      what: t('activity.cliMissing'),
      detail: system.cli.error ?? t('activity.cliMissingHint'),
      to: '/settings?tab=account',
      action: t('activity.openSettings'),
    });
  } else if (setup === 'auth' && system) {
    rows.push({
      key: 'auth',
      icon: KeyRound,
      what: t('activity.notLoggedIn'),
      detail: system.auth.error ?? t('activity.noCredentials'),
      to: '/settings?tab=account',
      action: t('activity.addCredential'),
    });
  }
  waiting.forEach((chat, i) => {
    const { kind, tool, more, detail } = waitingFor(permissions[i]?.data);
    const words = t(`activity.waiting.${kind}`, { tool });
    rows.push({
      key: `chat:${chat.id}`,
      icon: kind === 'question' ? MessageCircleQuestion : ShieldQuestion,
      what: (
        <>
          <strong>{displayTitle(chat)}</strong> {more > 0 ? `${words} ${t('activity.more', { n: more })}` : words}
        </>
      ),
      detail,
      to: chatHref(chat),
      action: t('activity.answer'),
    });
  });
  for (const o of scoped.filter((x) => x.status === 'waiting')) {
    const blocked = o.tasks.filter((task) => task.status === 'blocked');
    rows.push({
      key: `blocked:${o.id}`,
      icon: Hourglass,
      what: (
        <>
          <strong>{o.name}</strong>: {t('activity.tasksBlocked', { count: blocked.length, n: formatNumber(blocked.length) })}
        </>
      ),
      detail: blocked.map((task) => `${task.name}${task.error ? `: ${truncate(task.error, 80)}` : ''}`).join(' · '),
      to: orchestrationHref(o),
      action: t('activity.decide'),
    });
  }
  for (const o of scoped) {
    const status = o.integration?.status;
    if (status !== 'conflicted' && status !== 'failed') continue;
    rows.push({
      key: `merge:${o.id}`,
      icon: GitMerge,
      what: (
        <Trans
          t={t}
          i18nKey={status === 'conflicted' ? 'activity.mergeConflict' : 'activity.integrationFailed'}
          values={{ branch: o.integration?.branch ?? o.name }}
          components={{ strong: <strong /> }}
        />
      ),
      detail: o.integration?.conflicts.flatMap((c) => c.paths).slice(0, 3).join(', ') || o.integration?.error,
      to: orchestrationHref(o),
      action: t('common:actions.open'),
    });
  }
  for (const task of tasks.data ?? []) {
    if (task.status !== 'running' || (project && task.chat.project?.id !== project.id)) continue;
    const running = Date.now() - new Date(task.startedAt).getTime();
    if (running < HUNG_TASK_MS) continue;
    rows.push({
      key: `task:${task.chat.id}:${task.id}`,
      icon: Timer,
      what: (
        <Trans
          t={t}
          i18nKey="activity.hungCommand"
          values={{ duration: formatDuration(running), title: displayTitle(task.chat) }}
          components={{ strong: <strong /> }}
        />
      ),
      detail: task.command ?? task.description,
      to: detailHref({ kind: 'task', chatId: task.chat.id, taskId: task.id }, chatHref(task.chat)),
      action: t('common:actions.open'),
    });
  }

  const working = workingChats.data ?? [];
  const loading = overview.isLoading || waitingChats.isLoading || workingChats.isLoading;
  const running = working.length + liveOrchestrations.filter((o) => o.status === 'running').length;
  const unreachable = overview.isError && !overview.data;
  const newChat = project ? `/chats/new?cwd=${encodeURIComponent(project.path)}` : '/chats/new';
  const onlySetup = setup !== null && rows.length === 1 && working.length === 0 && liveOrchestrations.length === 0;
  const empty = rows.length === 0 && working.length === 0 && liveOrchestrations.length === 0;

  const aside =
    running > 0 ? (
      <span className="badge badge-active">
        <StatusDot tone="active" live />
        {t('widgets.now.live')}
      </span>
    ) : rows.length > 0 && !onlySetup ? (
      <span className="mono small muted">{t('widgets.now.needYou', { count: rows.length, n: formatNumber(rows.length) })}</span>
    ) : undefined;

  let body: ReactNode;
  if (loading) body = <Loading />;
  else if (unreachable)
    body = (
      <Empty
        illustration="offline"
        tone="bad"
        size="sm"
        title={t('widgets.now.offline')}
        action={
          <button type="button" className="btn" onClick={() => void overview.refetch()}>
            {t('widgets.now.retry')}
          </button>
        }
      >
        {t('widgets.now.offlineHint')}
      </Empty>
    );
  else if (onlySetup && system)
    body = (
      <Empty
        illustration={setup === 'cli' ? 'cli-missing' : 'signed-out'}
        tone="warn"
        size="sm"
        title={setup === 'cli' ? t('activity.cliMissing') : t('activity.notLoggedIn')}
        action={
          <Link to="/settings?tab=account" className="btn btn-primary">
            {setup === 'cli' ? t('activity.openSettings') : t('activity.addCredential')}
          </Link>
        }
      >
        {setup === 'cli' ? (system.cli.error ?? t('activity.cliMissingHint')) : (system.auth.error ?? t('activity.noCredentials'))}
      </Empty>
    );
  else if (empty)
    body = (
      <Empty
        illustration="welcome"
        size="sm"
        title={t('activity.nothing')}
        action={
          <>
            <Link to={newChat} className="btn btn-primary">
              {t('activity.startChat')}
            </Link>
            <Link to={NEW_ORCHESTRATION_PATH} className="btn">
              {t('hero.newOrchestration')}
            </Link>
          </>
        }
      >
        {t('activity.nothingHint')}
      </Empty>
    );
  else
    body = (
      <>
        {rows.length > 0 && (
          <ul className="inbox-list attention-list" aria-label={t('activity.waitingForYou')}>
            {rows.map((row) => {
              const Icon = row.icon;
              return (
                <li key={row.key} className="inbox-row">
                  <span className="inbox-icon" aria-hidden>
                    <Icon {...ICON_SM} />
                  </span>
                  <div className="inbox-main">
                    <div className="inbox-what">{row.what}</div>
                    {row.detail && <div className="small muted ellipsis">{row.detail}</div>}
                  </div>
                  <Link to={row.to} className="btn btn-small btn-primary">
                    {row.action}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {liveOrchestrations.length > 0 && (
          <ul className="orch-items" aria-label={t('widgets.orchestrations.title')}>
            {liveOrchestrations.map((o) => (
              <OrchestrationItem key={o.id} orchestration={o} />
            ))}
          </ul>
        )}
        {working.length > 0 && (
          <ul className="now-list" aria-label={t('activity.rightNow')}>
            {working.map((chat) => (
              <WorkingChat key={chat.id} chat={chat} showProject={!project} />
            ))}
          </ul>
        )}
      </>
    );

  return (
    <WidgetCard
      id={id}
      title={title}
      aside={aside}
      actions={
        <Link to="/orchestration" className="link-more">
          {t('widgets.now.all')}
          <ChevronRight {...ICON_SM} />
        </Link>
      }
      className={['now-widget', running > 0 ? 'live-energy' : '', rows.length > 0 && !onlySetup ? 'has-attention' : '', empty || onlySetup || unreachable ? 'is-quiet' : '']
        .filter(Boolean)
        .join(' ')}
    >
      {body}
    </WidgetCard>
  );
}

// ---------- Orchestrations ----------

/** What runs now, task by task; when nothing does, how the latest one ended. Only in a stored layout: Home's own shows them in "In progress". */
export function OrchestrationsWidget({ project, title, id, config }: WidgetProps) {
  const { t } = useTranslation('home');
  const orchestrations = useOrchestrations();
  const scoped = (orchestrations.data ?? []).filter((o) => !project || inProject(project, o.cwd));
  const shown = orchestrationsToShow(scoped, configCount(config, 'limit', project ? 2 : 3));
  const running = scoped.filter((o) => o.status === 'running').length;
  return (
    <WidgetCard
      id={id}
      title={title}
      className="rows-widget"
      aside={running > 0 ? <span className="mono small muted">{t('widgets.orchestrations.running', { n: formatNumber(running) })}</span> : undefined}
      actions={
        <Link to="/orchestration" className="link-more">
          {t('widgets.orchestrations.all')}
          <ChevronRight {...ICON_SM} />
        </Link>
      }
    >
      {orchestrations.isLoading ? (
        <Loading />
      ) : shown.length === 0 ? (
        <p className="muted small widget-note">{t('widgets.orchestrations.none')}</p>
      ) : (
        <ul className="orch-items">
          {shown.map((o) => (
            <OrchestrationItem key={o.id} orchestration={o} />
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

// ---------- Pick up again ----------

/** The chats nobody is running, most recent first: where to carry on. */
export function PickUpWidget({ project, title, id, config }: WidgetProps) {
  const { t } = useTranslation('home');
  const idle = useChats({ project: project?.id, state: 'idle', limit: configCount(config, 'limit', 6) });
  const chats = idle.data ?? [];
  return (
    <WidgetCard
      id={id}
      title={title}
      className="rows-widget"
      actions={
        <Link to={project ? `/chats?project=${encodeURIComponent(project.id)}` : '/chats'} className="link-more">
          {t('activity.allChats')}
          <ChevronRight {...ICON_SM} />
        </Link>
      }
    >
      {idle.isLoading ? (
        <Loading />
      ) : chats.length === 0 ? (
        <p className="muted small widget-note">{t('widgets.pickUp.none')}</p>
      ) : (
        <ul className="home-rows">
          {chats.map((chat) => {
            const outcome = chat.execution?.outcome;
            const troubled = outcome === 'failed' || outcome === 'interrupted';
            const percent = contextPercent(chat);
            const cost = chat.cost.usd === null ? t('activity.costUnavailable') : formatCost(chat.cost.usd);
            return (
              <li key={chat.id}>
                <Link to={chatHref(chat)} className="home-row pick-row">
                  <span className={`dot ${troubled ? 'dot-bad' : 'dot-idle'}`} aria-hidden />
                  <span className="pick-main">
                    <span className="pick-title ellipsis">{displayTitle(chat)}</span>
                    <span className="pick-phone mono faint ellipsis">{[percent !== null ? `${percent}%` : null, cost, timeAgo(chat.updatedAt)].filter(Boolean).join(' · ')}</span>
                  </span>
                  {troubled && outcome ? <span className="badge badge-bad">{t(`widgets.pickUp.${outcome}`)}</span> : !project && <span className="mono faint nowrap pick-project">{chat.project?.name ?? t('activity.noProject')}</span>}
                  <span className="pick-wide">
                    <ContextRing chat={chat} />
                  </span>
                  <span className="mono tnum pick-wide pick-cost">{cost}</span>
                  <span className="faint small nowrap pick-wide pick-when">{timeAgo(chat.updatedAt)}</span>
                  <ChevronRight {...ICON_SM} className="pick-chevron" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetCard>
  );
}

// ---------- Upcoming schedules ----------

/** The schedules that fire next; in a project, those that start something in it. */
export function SchedulesWidget({ project, title, id, config }: WidgetProps) {
  const { t } = useTranslation('home');
  const schedules = useSchedules();
  const upcoming = upcomingSchedules(
    schedules.data ?? [],
    (s) => {
      if (!project) return true;
      const cwd = scheduleCwd(s);
      return cwd !== undefined && inProject(project, cwd);
    },
    configCount(config, 'limit', 4),
  );
  const none = !schedules.isLoading && upcoming.length === 0;
  return (
    <WidgetCard
      id={id}
      title={title}
      icon={<CalendarClock {...ICON_SM} className="faint" />}
      className={none ? 'schedules-widget is-none' : 'schedules-widget'}
      actions={
        none ? undefined : (
          <Link to="/schedules" className="link-more">
            {t('widgets.schedules.all')}
          </Link>
        )
      }
    >
      {schedules.isLoading ? (
        <Loading />
      ) : none ? (
        <>
          <p className="small muted widget-note">{t('widgets.schedules.none')}</p>
          <Link to="/schedules/new" className="btn btn-small schedules-create">
            <Plus {...ICON_SM} />
            {t('widgets.schedules.create')}
          </Link>
        </>
      ) : (
        <ul className="widget-rows">
          {upcoming.map((s) => (
            <li key={s.id} className="widget-row">
              <span className="ellipsis">{s.name}</span>
              <time className="mono small muted nowrap" dateTime={s.nextRunAt}>
                {timeUntil(Date.parse(s.nextRunAt) / 1000)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

// ---------- Projects ----------

/** Every project with what is live in it now and when it was last active. */
export function ProjectsWidget({ title, id }: WidgetProps) {
  const { t } = useTranslation('home');
  const projects = useProjects();
  const working = useChats({ state: 'working' });
  const waiting = useChats({ state: 'waiting', origin: [...WAITING_ORIGINS] });
  const live = liveByProject([...(working.data ?? []), ...(waiting.data ?? [])]);
  const list = [...(projects.data ?? [])].sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  return (
    <WidgetCard
      id={id}
      title={title}
      aside={list.length > 0 ? <span className="mono small faint">{formatNumber(list.length)}</span> : undefined}
      actions={
        <Link to="/projects" className="link-more">
          {t('widgets.projects.all')}
        </Link>
      }
    >
      {projects.isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        <div className="alert" role="note">
          <FolderGit2 {...ICON_SM} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('activity.noProjectYet')}</strong>
            <div>
              <Trans t={t} i18nKey="activity.noProjectYetHint" components={{ anchor: <Link to="/projects" /> }} />
            </div>
          </div>
        </div>
      ) : (
        <ul className="home-rows">
          {list.map((p) => {
            const counts = live.get(p.id);
            return (
              <li key={p.id}>
                <Link to={`/?project=${encodeURIComponent(p.id)}`} className="home-row project-row">
                  <InitialsBadge name={p.name} tone={counts?.working ? 'accent' : 'neutral'} />
                  <span className="strong ellipsis project-row-name">{p.name}</span>
                  {counts?.waiting ? <span className="project-waiting small">{t('widgets.projects.waiting', { n: formatNumber(counts.waiting) })}</span> : null}
                  {counts?.working ? <StatusDot tone="active" live title={t('activity.working', { n: formatNumber(counts.working) })} /> : null}
                  <span className="faint small nowrap">{counts?.working ? t('widgets.projects.now') : p.lastActivity ? timeAgo(p.lastActivity) : t('widgets.projects.never')}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetCard>
  );
}
