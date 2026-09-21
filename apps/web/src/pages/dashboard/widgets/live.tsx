import type { ChatSummary, Orchestration } from '@agentry/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  CircleAlert,
  FolderGit2,
  GitMerge,
  Hourglass,
  KeyRound,
  MessageCircleQuestion,
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
import { ProgressBar } from '../../../components/ProgressBar';
import { Stepper } from '../../../components/Stepper';
import { Empty, Skeleton, StatusBadge } from '../../../components/ui';
import { detailHref } from '../../../lib/detail';
import { formatCost, formatDuration, formatNumber, timeAgo, timeUntil, truncate } from '../../../lib/format';
import { inProject } from '../../../lib/project-scope';
import { configCount } from '../layout';
import { liveByProject, orchestrationStages, orchestrationsToShow, scheduleCwd, taskCounts, upcomingSchedules, waitingFor } from '../model';
import type { WidgetProps } from '../registry';
import { WidgetCard } from '../WidgetCard';

/** A command running this long in the background is worth a look; there is no baseline to compare it with yet. */
const HUNG_TASK_MS = 15 * 60_000;

const chatHref = (chat: Pick<ChatSummary, 'id'>) => `/chats/${encodeURIComponent(chat.id)}`;
const orchestrationHref = (o: Pick<Orchestration, 'id'>) => `/orchestration/${encodeURIComponent(o.id)}`;

function Loading() {
  return <Skeleton rows={3} height={16} />;
}

/** A chat's context and what it has spent: the numbers that tell one about to compact from one that is fine. */
function ChatNumbers({ chat }: { chat: ChatSummary }) {
  const { t } = useTranslation('home');
  const percent = chat.context?.window ? Math.round((chat.context.used / chat.context.window) * 100) : null;
  return (
    <>
      {percent !== null && <span>{t('activity.context', { percent })}</span>}
      <span>{chat.cost.usd === null ? t('activity.costUnavailable') : formatCost(chat.cost.usd)}</span>
    </>
  );
}

// ---------- Now ----------

interface AttentionRow {
  key: string;
  icon: LucideIcon;
  /** What is waiting: the icon and this text say it, colour only reinforces */
  what: ReactNode;
  detail?: ReactNode;
  to: string;
  action: string;
}

/**
 * Everything that needs a person, with its action on the row, then every chat at work with what it
 * is doing right now. `project` scopes all of it except the account's own health, which belongs to
 * nobody in particular.
 */
export function NowWidget({ project, title, id }: WidgetProps) {
  const { t } = useTranslation(['home', 'common']);
  const scope = project?.id;
  const overview = useOverview();
  const orchestrations = useOrchestrations();
  // A worker of an orchestration stopped for a permission waits for a person like any other chat
  const waitingChats = useChats({ project: scope, state: 'waiting', origin: ['agentry', 'external', 'orchestration'] });
  const workingChats = useChats({ project: scope, state: 'working' });
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: api.tasks, refetchInterval: 30_000 });
  const waiting = waitingChats.data ?? [];
  const permissions = useQueries({
    queries: waiting.map((chat) => ({ queryKey: keys.chatPermissions(chat.id), queryFn: () => api.chatPermissions(chat.id) })),
  });

  const scoped = (orchestrations.data ?? []).filter((o) => !project || inProject(project, o.cwd));
  const system = overview.data?.system;
  const rows: AttentionRow[] = [];
  if (system && !system.cli.installed) {
    rows.push({
      key: 'cli',
      icon: CircleAlert,
      what: t('activity.cliMissing'),
      detail: system.cli.error ?? t('activity.cliMissingHint'),
      to: '/settings?tab=account',
      action: t('activity.openSettings'),
    });
  } else if (system && !system.auth.loggedIn) {
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
          <strong>{chat.title}</strong> {more > 0 ? `${words} ${t('activity.more', { n: more })}` : words}
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
          values={{ duration: formatDuration(running), title: task.chat.title }}
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
  const aside =
    working.length + rows.length > 0 ? (
      <span className="mono small muted">
        {[
          working.length > 0 ? t('activity.working', { n: formatNumber(working.length) }) : null,
          rows.length > 0 ? t('widgets.now.needYou', { count: rows.length, n: formatNumber(rows.length) }) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    ) : undefined;

  return (
    <WidgetCard id={id} title={title} aside={aside} className={`now-widget ${rows.length > 0 ? 'has-attention' : ''}`}>
      {loading ? (
        <Loading />
      ) : rows.length === 0 && working.length === 0 ? (
        <Empty
          title={t('activity.nothing')}
          action={
            <Link to={project ? `/chats/new?cwd=${encodeURIComponent(project.path)}` : '/chats/new'} className="btn btn-primary">
              {t('activity.startChat')}
            </Link>
          }
        >
          {t('activity.nothingHint')}
        </Empty>
      ) : (
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
          {working.length > 0 && (
            <ul className="now-list" aria-label={t('activity.rightNow')}>
              {working.map((chat) => (
                <li key={chat.id} className="now-row live-rail">
                  <div className="now-main">
                    <div className="now-title">
                      <StatusBadge status={chat.state} />
                      <Link to={chatHref(chat)} className="strong ellipsis">
                        {chat.title}
                      </Link>
                    </div>
                    {chat.activity ? (
                      <ActivityTicker activity={chat.activity} className="now-ticker" />
                    ) : (
                      <span className="small muted ellipsis">{chat.firstPrompt ?? t('widgets.now.noActivity')}</span>
                    )}
                  </div>
                  <div className="meta mono now-meta">
                    {!project && <span>{chat.project?.name ?? t('activity.noProject')}</span>}
                    {chat.worktree?.branch && <span>{chat.worktree.branch}</span>}
                    <ChatNumbers chat={chat} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </WidgetCard>
  );
}

// ---------- Orchestrations ----------

function OrchestrationItem({ orchestration: o }: { orchestration: Orchestration }) {
  const { t } = useTranslation('home');
  const stages = orchestrationStages(o);
  const runningTask = o.tasks.find((task) => task.status === 'running' && task.activity);
  const live = o.status === 'running';
  return (
    <li className={`orch-item ${live ? 'live-rail' : ''}`.trim()}>
      <div className="orch-item-head">
        <StatusBadge status={o.status} />
        <Link to={orchestrationHref(o)} className="strong ellipsis">
          {o.name}
        </Link>
        <span className="mono small muted nowrap orch-item-cost">{formatCost(o.costUsd)}</span>
      </div>
      <ProgressBar counts={taskCounts(o.tasks)} unit={t('widgets.orchestrations.tasks')} />
      {stages.length > 1 && (
        <Stepper
          compact
          label={t('widgets.orchestrations.stages', { name: o.name })}
          steps={stages.map((stage) => ({
            id: String(stage.index),
            state: stage.state,
            label: t('widgets.orchestrations.stage', { n: stage.index + 1, done: stage.done, total: stage.tasks.length }),
          }))}
        />
      )}
      {runningTask ? (
        <div className="orch-item-now small">
          <span className="mono muted ellipsis orch-item-task">{runningTask.name}</span>
          <ActivityTicker activity={runningTask.activity} />
        </div>
      ) : (
        <div className="small muted">{live ? t('widgets.orchestrations.started', { when: timeAgo(o.createdAt) }) : t('widgets.orchestrations.ended', { when: timeAgo(o.endedAt ?? o.createdAt) })}</div>
      )}
    </li>
  );
}

/** What runs now, stage by stage; when nothing does, how the latest one ended. */
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
      aside={running > 0 ? <span className="mono small muted">{t('widgets.orchestrations.running', { n: formatNumber(running) })}</span> : undefined}
      actions={
        <Link to="/orchestration" className="link-more">
          {t('widgets.orchestrations.all')}
        </Link>
      }
    >
      {orchestrations.isLoading ? (
        <Loading />
      ) : shown.length === 0 ? (
        <p className="muted small">{t('widgets.orchestrations.none')}</p>
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
      actions={
        <Link to={project ? `/chats?project=${encodeURIComponent(project.id)}` : '/chats'} className="link-more">
          {t('activity.allChats')}
        </Link>
      }
    >
      {idle.isLoading ? (
        <Loading />
      ) : chats.length === 0 ? (
        <p className="muted small">{t('widgets.pickUp.none')}</p>
      ) : (
        <div className="list">
          {chats.map((chat) => (
            <Link key={chat.id} to={chatHref(chat)} className="list-row">
              <div className="list-row-main">
                <div className="list-row-title">
                  <span className="strong ellipsis">{chat.title}</span>
                </div>
                <div className="meta mono">
                  {!project && <span>{chat.project?.name ?? t('activity.noProject')}</span>}
                  {chat.worktree?.branch && <span>{chat.worktree.branch}</span>}
                  <ChatNumbers chat={chat} />
                </div>
              </div>
              <span className="muted small nowrap">{timeAgo(chat.updatedAt)}</span>
            </Link>
          ))}
        </div>
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
  return (
    <WidgetCard
      id={id}
      title={title}
      actions={
        <Link to="/schedules" className="link-more">
          {t('widgets.schedules.all')}
        </Link>
      }
    >
      {schedules.isLoading ? (
        <Loading />
      ) : upcoming.length === 0 ? (
        <p className="muted small">{t('widgets.schedules.none')}</p>
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
  const waiting = useChats({ state: 'waiting', origin: ['agentry', 'external', 'orchestration'] });
  const live = liveByProject([...(working.data ?? []), ...(waiting.data ?? [])]);
  const list = [...(projects.data ?? [])].sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  return (
    <WidgetCard
      id={id}
      title={title}
      aside={list.length > 0 ? <span className="mono small muted">{formatNumber(list.length)}</span> : undefined}
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
        <ul className="widget-rows">
          {list.map((p) => {
            const counts = live.get(p.id);
            return (
              <li key={p.id} className={`widget-row ${counts?.working ? 'live-rail' : ''}`.trim()}>
                <Link to={`/?project=${encodeURIComponent(p.id)}`} className="strong ellipsis">
                  {p.name}
                </Link>
                <span className="meta mono small">
                  {counts?.working ? <span className="project-live">{t('activity.working', { n: formatNumber(counts.working) })}</span> : null}
                  {counts?.waiting ? <span className="project-waiting">{t('widgets.projects.waiting', { n: formatNumber(counts.waiting) })}</span> : null}
                  <span className="nowrap">{p.lastActivity ? timeAgo(p.lastActivity) : t('widgets.projects.never')}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetCard>
  );
}
