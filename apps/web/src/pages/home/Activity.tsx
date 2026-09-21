import type { ChatSummary, Orchestration, PermissionRequest, Project } from '@agentry/shared';
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
import { api, keys, useChats, useOrchestrations, useOverview, useUsage } from '../../api';
import { ICON_SM } from '../../components/icons';
import { ProgressRing } from '../../components/motion';
import { ProjectExportCard } from '../../components/ProjectExport';
import { Card, Empty, Skeleton, StatusBadge, Tag } from '../../components/ui';
import { detailHref } from '../../lib/detail';
import { formatCost, formatDuration, formatNumber, timeAgo, timeUntil, truncate } from '../../lib/format';
import { inProject } from '../../lib/project-scope';

/** A command running this long in the background is worth a look; there is no baseline to compare it with yet. */
const HUNG_TASK_MS = 15 * 60_000;

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

interface InboxRow {
  key: string;
  icon: LucideIcon;
  /** What is waiting: the icon and this text say it, colour only reinforces */
  what: ReactNode;
  detail?: ReactNode;
  to: string;
  action: string;
}

function InboxItem({ row }: { row: InboxRow }) {
  const Icon = row.icon;
  return (
    <li className="inbox-row">
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
}

/** What a chat stopped for, described so the component words it in the active language. */
interface WaitingReason {
  kind: 'generic' | 'plan' | 'question' | 'tool';
  tool: string;
  /** Requests beyond the first one */
  more: number;
  detail: string | null;
}

function waitingFor(requests: readonly PermissionRequest[] | undefined): WaitingReason {
  const first = requests?.[0];
  if (!first) return { kind: 'generic', tool: '', more: 0, detail: null };
  const more = requests && requests.length > 1 ? requests.length - 1 : 0;
  const command = typeof first.input.command === 'string' ? first.input.command : null;
  const detail = truncate(first.description ?? command ?? '', 140) || null;
  if (first.toolName === 'ExitPlanMode') return { kind: 'plan', tool: first.toolName, more, detail };
  if (first.toolName === 'AskUserQuestion' || first.requiresUserInteraction) return { kind: 'question', tool: first.toolName, more, detail };
  return { kind: 'tool', tool: first.toolName, more, detail };
}

const contextPercent = (chat: ChatSummary): number | null =>
  chat.context?.window ? Math.round((chat.context.used / chat.context.window) * 100) : null;

/** A chat's context and what it has spent: the numbers that tell one about to compact from one that is fine. */
function ChatNumbers({ chat }: { chat: ChatSummary }) {
  const { t } = useTranslation('home');
  const percent = contextPercent(chat);
  return (
    <>
      {percent !== null && <span title={t('activity.contextInUse')}>{t('activity.context', { percent })}</span>}
      <span>{chat.cost.usd === null ? t('activity.costUnavailable') : formatCost(chat.cost.usd)}</span>
    </>
  );
}

function ChatRow({ chat, showProject }: { chat: ChatSummary; showProject: boolean }) {
  const { t } = useTranslation('home');
  return (
    <Link to={`/chats/${encodeURIComponent(chat.id)}`} className="list-row">
      <div className="list-row-main">
        <div className="list-row-title">
          <StatusBadge status={chat.state} />
          <span className="strong ellipsis" title={chat.title}>{chat.title}</span>
        </div>
        <div className="meta">
          {showProject && <span>{chat.project?.name ?? t('activity.noProject')}</span>}
          {chat.worktree?.branch && <span className="mono">{chat.worktree.branch}</span>}
          <ChatNumbers chat={chat} />
        </div>
      </div>
      <span className="muted small nowrap">{timeAgo(chat.updatedAt)}</span>
    </Link>
  );
}

/** The attention block: everything that needs a person, with its action on the row. Absent when nothing does. */
function WaitingBlock({ rows }: { rows: InboxRow[] }) {
  const { t } = useTranslation('home');
  if (rows.length === 0) return null;
  return (
    <section className="card inbox" aria-labelledby="inbox-title">
      <div className="card-head">
        <h2 id="inbox-title">{t('activity.waitingForYou')}</h2>
        <Tag tone="bad">{rows.length}</Tag>
      </div>
      <ul className="inbox-list">
        {rows.map((row) => (
          <InboxItem key={row.key} row={row} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The inbox: what waits for a person, then what runs now, what the day cost, and where to pick up.
 * `project` scopes all of it except the account's own health, which belongs to nobody in particular.
 */
export function Activity({ project }: { project: Project | null }) {
  const { t } = useTranslation(['home', 'common', 'work']);
  const scope = project?.id;
  const overview = useOverview();
  const orchestrations = useOrchestrations();
  // A worker of an orchestration stopped for a permission waits for a person like any other chat
  const waitingChats = useChats({ project: scope, state: 'waiting', origin: ['agentry', 'external', 'orchestration'] });
  const workingChats = useChats({ project: scope, state: 'working' });
  const idleChats = useChats({ project: scope, state: 'idle', limit: 8 });
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: api.tasks, refetchInterval: 30_000 });
  const today = dayOf(new Date());
  const usage = useUsage({ from: today, to: today });

  const waiting = waitingChats.data ?? [];
  const permissions = useQueries({
    queries: waiting.map((chat) => ({ queryKey: keys.chatPermissions(chat.id), queryFn: () => api.chatPermissions(chat.id) })),
  });

  const progress = (orchestration: Orchestration): string => {
    const done = orchestration.tasks.filter((task) => task.status === 'completed' || task.status === 'skipped').length;
    return t('activity.progress', { done, total: orchestration.tasks.length });
  };

  const inScope = (dir: string) => !project || inProject(project, dir);
  const scoped = (orchestrations.data ?? []).filter((o) => inScope(o.cwd));
  const system = overview.data?.system;

  const rows: InboxRow[] = [];
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
    const isQuestion = kind === 'question';
    const words = t(`activity.waiting.${kind}`, { tool });
    rows.push({
      key: `chat:${chat.id}`,
      icon: isQuestion ? MessageCircleQuestion : ShieldQuestion,
      what: (
        <>
          <strong>{chat.title}</strong> {more > 0 ? `${words} ${t('activity.more', { n: more })}` : words}
        </>
      ),
      detail,
      to: `/chats/${encodeURIComponent(chat.id)}`,
      action: t('activity.answer'),
    });
  });
  for (const o of scoped.filter((x) => x.status === 'waiting')) {
    const blocked = o.tasks.filter((t) => t.status === 'blocked');
    rows.push({
      key: `blocked:${o.id}`,
      icon: Hourglass,
      what: (
        <>
          <strong>{o.name}</strong>: {t('activity.tasksBlocked', { count: blocked.length, n: formatNumber(blocked.length) })}
        </>
      ),
      detail: blocked.map((t) => `${t.name}${t.error ? `: ${truncate(t.error, 80)}` : ''}`).join(' · '),
      to: `/orchestration/${encodeURIComponent(o.id)}`,
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
        <>
          <Trans
            t={t}
            i18nKey={status === 'conflicted' ? 'activity.mergeConflict' : 'activity.integrationFailed'}
            values={{ branch: o.integration?.branch ?? o.name }}
            components={{ strong: <strong /> }}
          />
        </>
      ),
      detail: o.integration?.conflicts.flatMap((c) => c.paths).slice(0, 3).join(', ') || o.integration?.error,
      to: `/orchestration/${encodeURIComponent(o.id)}`,
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
        <>
          <Trans
            t={t}
            i18nKey="activity.hungCommand"
            values={{ duration: formatDuration(running), title: task.chat.title }}
            components={{ strong: <strong /> }}
          />
        </>
      ),
      detail: task.command ?? task.description,
      to: detailHref({ kind: 'task', chatId: task.chat.id, taskId: task.id }, `/chats/${encodeURIComponent(task.chat.id)}`),
      action: t('common:actions.open'),
    });
  }

  const working = workingChats.data ?? [];
  const running = scoped.filter((o) => o.status === 'running');
  const idle = idleChats.data ?? [];

  const usageRow = project ? usage.data?.projects.find((p) => p.project?.id === project.id) : usage.data?.total;
  const spentModels = (usageRow?.tokens ?? []).filter((m) => m.total > 0);
  const windows = Object.entries(overview.data?.rateLimit?.windows ?? {});

  const loading = overview.isLoading || waitingChats.isLoading || workingChats.isLoading || idleChats.isLoading;
  if (loading) {
    return (
      <div className="card">
        <Skeleton rows={4} height={18} />
      </div>
    );
  }

  const nothing = rows.length === 0 && working.length === 0 && running.length === 0 && idle.length === 0;
  const noProjects = overview.data?.counts.projects === 0;

  return (
    <>
      <WaitingBlock rows={rows} />

      {noProjects && !project && (
        <div className="alert" role="note">
          <FolderGit2 {...ICON_SM} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('activity.noProjectYet')}</strong>
            <div>
              <Trans t={t} i18nKey="activity.noProjectYetHint" components={{ anchor: <Link to="/projects" /> }} />
            </div>
          </div>
        </div>
      )}

      {nothing && rows.length === 0 && (
        <Empty title={t('activity.nothing')} action={<Link to="/chats/new" className="btn btn-primary">{t('activity.startChat')}</Link>}>
          {t('activity.nothingHint')}
        </Empty>
      )}

      {(working.length > 0 || running.length > 0) && (
        <Card
          title={
            <>
              {t('activity.rightNow')}{' '}
              <span className="muted small">
                · {t('activity.working', { n: formatNumber(working.length) })}
                {running.length ? ` · ${t('activity.orchestrations', { count: running.length, n: formatNumber(running.length) })}` : ''}
              </span>
            </>
          }
        >
          <div className="list">
            {working.map((chat) => (
              <ChatRow key={chat.id} chat={chat} showProject={!project} />
            ))}
            {running.map((o) => (
              <Link key={o.id} to={`/orchestration/${encodeURIComponent(o.id)}`} className="list-row">
                <div className="list-row-main">
                  <div className="list-row-title">
                    <StatusBadge status="running" />
                    <span className="strong ellipsis">{o.name}</span>
                  </div>
                  <div className="meta">
                    <span>{progress(o)}</span>
                    <span>{formatCost(o.costUsd)}</span>
                  </div>
                </div>
                <span className="muted small nowrap">{timeAgo(o.createdAt)}</span>
              </Link>
            ))}
          </div>
        </Card>
      )}

      <Card title={t('activity.today')}>
        {usage.isLoading ? (
          <Skeleton rows={2} height={16} />
        ) : spentModels.length === 0 ? (
          <div className="muted">{t('activity.nothingSpent')}</div>
        ) : (
          <>
            <div className="meta small">
              <span>{usageRow?.costUsd === null || usageRow === undefined ? t('activity.costUnavailable') : t('activity.spent', { cost: formatCost(usageRow.costUsd) })}</span>
              {usageRow && usageRow.chatsWithoutCost > 0 && (
                <span className="muted">
                  {t('activity.chatsWithoutCost', { count: usageRow.chatsWithoutCost, n: formatNumber(usageRow.chatsWithoutCost) })}
                </span>
              )}
            </div>
            <div className="table-wrap" role="region" aria-label={t('activity.tokensToday')} tabIndex={0}>
            <table className="table today-table">
              <thead>
                <tr>
                  <th scope="col">{t('work:shared.model')}</th>
                  <th scope="col" className="num">{t('activity.input')}</th>
                  <th scope="col" className="num">{t('activity.output')}</th>
                  <th scope="col" className="num">{t('activity.cache')}</th>
                </tr>
              </thead>
              <tbody>
                {spentModels.map((m) => (
                  <tr key={m.model ?? 'unknown'}>
                    <th scope="row" className="mono">{m.model ?? t('activity.unknownModel')}</th>
                    <td className="num">{formatNumber(m.input)}</td>
                    <td className="num">{formatNumber(m.output)}</td>
                    <td className="num">{formatNumber(m.cacheRead + m.cacheCreation)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </>
        )}
        {windows.length > 0 && (
          <div className="gauges today-limits" role="group" aria-label={t('activity.usageLimits')}>
            {windows.map(([name, win]) => {
              const pct = Math.min(100, Math.round(win.utilization * 100));
              return (
                <div key={name} className="gauge">
                  <ProgressRing value={pct / 100} size={56} stroke={6} tone={pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'accent'}>
                    <span className="gauge-value">{pct}%</span>
                  </ProgressRing>
                  <div className="gauge-text">
                    <span className="gauge-name">{t('activity.limit', { name: name.replace(/_/g, ' ') })}</span>
                    <span className="muted small">{t('activity.resets', { when: timeUntil(win.resetsAt) })}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {idle.length > 0 && (
        <Card title={t('activity.pickUp')} actions={<Link to={project ? `/chats?project=${encodeURIComponent(project.id)}` : '/chats'} className="link-more">{t('activity.allChats')}</Link>}>
          <div className="list">
            {idle.map((chat) => (
              <ChatRow key={chat.id} chat={chat} showProject={!project} />
            ))}
          </div>
        </Card>
      )}

      {project && <ProjectExportCard project={project} />}
    </>
  );
}
