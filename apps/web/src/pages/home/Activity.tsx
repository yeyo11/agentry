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
import { Link } from 'react-router-dom';
import { api, keys, useChats, useOrchestrations, useOverview, useUsage } from '../../api';
import { ICON_SM } from '../../components/icons';
import { ProgressRing } from '../../components/motion';
import { Card, Empty, Skeleton, StatusBadge } from '../../components/ui';
import { detailHref } from '../../lib/detail';
import { formatCost, formatDuration, timeAgo, timeUntil, truncate } from '../../lib/format';
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

/** What a chat stopped for, in the words of the request that holds it. */
function waitingFor(requests: readonly PermissionRequest[] | undefined): { what: string; detail: string | null } {
  const first = requests?.[0];
  if (!first) return { what: 'is waiting for you', detail: null };
  const more = requests && requests.length > 1 ? ` (+${requests.length - 1} more)` : '';
  const command = typeof first.input.command === 'string' ? first.input.command : null;
  const detail = truncate(first.description ?? command ?? '', 140) || null;
  if (first.toolName === 'ExitPlanMode') return { what: `wants your approval of a plan${more}`, detail };
  if (first.toolName === 'AskUserQuestion' || first.requiresUserInteraction) return { what: `asks you a question${more}`, detail };
  return { what: `wants to use ${first.toolName}${more}`, detail };
}

const contextPercent = (chat: ChatSummary): number | null =>
  chat.context?.window ? Math.round((chat.context.used / chat.context.window) * 100) : null;

/** A chat's context and what it has spent: the numbers that tell one about to compact from one that is fine. */
function ChatNumbers({ chat }: { chat: ChatSummary }) {
  const percent = contextPercent(chat);
  return (
    <>
      {percent !== null && <span title="Context in use">{percent}% context</span>}
      <span>{chat.cost.usd === null ? 'cost not available' : formatCost(chat.cost.usd)}</span>
    </>
  );
}

function ChatRow({ chat, showProject }: { chat: ChatSummary; showProject: boolean }) {
  return (
    <Link to={`/chats/${encodeURIComponent(chat.id)}`} className="list-row">
      <div className="list-row-main">
        <div className="list-row-title">
          <StatusBadge status={chat.state} />
          <span className="strong ellipsis">{chat.title}</span>
        </div>
        <div className="meta">
          {showProject && <span>{chat.project?.name ?? 'no project'}</span>}
          {chat.worktree?.branch && <span className="mono">{chat.worktree.branch}</span>}
          <ChatNumbers chat={chat} />
        </div>
      </div>
      <span className="muted small nowrap">{timeAgo(chat.updatedAt)}</span>
    </Link>
  );
}

function progress(orchestration: Orchestration): string {
  const done = orchestration.tasks.filter((t) => t.status === 'completed' || t.status === 'skipped').length;
  return `${done}/${orchestration.tasks.length} tasks`;
}

/** The attention block: everything that needs a person, with its action on the row. Absent when nothing does. */
function Waiting({ rows }: { rows: InboxRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="card inbox" aria-labelledby="inbox-title">
      <div className="card-head">
        <h2 id="inbox-title">Waiting for you</h2>
        <span className="badge badge-bad">{rows.length}</span>
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

  const inScope = (dir: string) => !project || inProject(project, dir);
  const scoped = (orchestrations.data ?? []).filter((o) => inScope(o.cwd));
  const system = overview.data?.system;

  const rows: InboxRow[] = [];
  if (system && !system.cli.installed) {
    rows.push({
      key: 'cli',
      icon: CircleAlert,
      what: 'Claude Code CLI not detected',
      detail: system.cli.error ?? 'The `claude` binary is not available in PATH: install it or set CLAUDE_BIN.',
      to: '/settings?tab=account',
      action: 'Open settings',
    });
  } else if (system && !system.auth.loggedIn) {
    rows.push({
      key: 'auth',
      icon: KeyRound,
      what: 'Claude Code is not logged in',
      detail: system.auth.error ?? 'No valid credentials were found.',
      to: '/settings?tab=account',
      action: 'Add a credential',
    });
  }
  waiting.forEach((chat, i) => {
    const { what, detail } = waitingFor(permissions[i]?.data);
    const isQuestion = what.startsWith('asks');
    rows.push({
      key: `chat:${chat.id}`,
      icon: isQuestion ? MessageCircleQuestion : ShieldQuestion,
      what: (
        <>
          <strong>{chat.title}</strong> {what}
        </>
      ),
      detail,
      to: `/chats/${encodeURIComponent(chat.id)}`,
      action: 'Answer',
    });
  });
  for (const o of scoped.filter((x) => x.status === 'waiting')) {
    const blocked = o.tasks.filter((t) => t.status === 'blocked');
    rows.push({
      key: `blocked:${o.id}`,
      icon: Hourglass,
      what: (
        <>
          <strong>{o.name}</strong>: {blocked.length} task{blocked.length === 1 ? '' : 's'} blocked
        </>
      ),
      detail: blocked.map((t) => `${t.name}${t.error ? `: ${truncate(t.error, 80)}` : ''}`).join(' · '),
      to: `/orchestration/${encodeURIComponent(o.id)}`,
      action: 'Decide',
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
          {status === 'conflicted' ? 'Merge conflict' : 'Integration failed'} in <strong>{o.integration?.branch ?? o.name}</strong>
        </>
      ),
      detail: o.integration?.conflicts.flatMap((c) => c.paths).slice(0, 3).join(', ') || o.integration?.error,
      to: `/orchestration/${encodeURIComponent(o.id)}`,
      action: 'Open',
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
          A command has been running for {formatDuration(running)} in <strong>{task.chat.title}</strong>
        </>
      ),
      detail: task.command ?? task.description,
      to: detailHref({ kind: 'task', chatId: task.chat.id, taskId: task.id }, `/chats/${encodeURIComponent(task.chat.id)}`),
      action: 'Open',
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
      <Waiting rows={rows} />

      {noProjects && !project && (
        <div className="alert" role="note">
          <FolderGit2 {...ICON_SM} className="alert-icon" />
          <div className="alert-body">
            <strong>No project yet</strong>
            <div>
              A project is a directory you import, and everything under it — its chats, worktrees and settings — lives on its page.{' '}
              <Link to="/projects">Import your first project</Link>.
            </div>
          </div>
        </div>
      )}

      {nothing && rows.length === 0 && (
        <Empty title="Nothing is running and nothing is waiting" action={<Link to="/chats/new" className="btn btn-primary">Start a chat</Link>}>
          Chats you start, and what your orchestrations do, show up here.
        </Empty>
      )}

      {(working.length > 0 || running.length > 0) && (
        <Card
          title={
            <>
              Right now <span className="muted small">· {working.length} working{running.length ? ` · ${running.length} orchestration${running.length === 1 ? '' : 's'}` : ''}</span>
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

      <Card title="Today">
        {usage.isLoading ? (
          <Skeleton rows={2} height={16} />
        ) : spentModels.length === 0 ? (
          <div className="muted">Nothing spent yet today.</div>
        ) : (
          <>
            <div className="meta small">
              <span>{usageRow?.costUsd === null || usageRow === undefined ? 'cost not available' : `${formatCost(usageRow.costUsd)} spent`}</span>
              {usageRow && usageRow.chatsWithoutCost > 0 && (
                <span className="muted">
                  {usageRow.chatsWithoutCost} chat{usageRow.chatsWithoutCost === 1 ? '' : 's'} started from a terminal report no cost
                </span>
              )}
            </div>
            <table className="table today-table">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col" className="num">Input</th>
                  <th scope="col" className="num">Output</th>
                  <th scope="col" className="num">Cache</th>
                </tr>
              </thead>
              <tbody>
                {spentModels.map((m) => (
                  <tr key={m.model ?? 'unknown'}>
                    <th scope="row" className="mono">{m.model ?? 'unknown model'}</th>
                    <td className="num">{m.input.toLocaleString()}</td>
                    <td className="num">{m.output.toLocaleString()}</td>
                    <td className="num">{(m.cacheRead + m.cacheCreation).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {windows.length > 0 && (
          <div className="gauges today-limits" aria-label="Usage limits">
            {windows.map(([name, win]) => {
              const pct = Math.min(100, Math.round(win.utilization * 100));
              return (
                <div key={name} className="gauge">
                  <ProgressRing value={pct / 100} size={56} stroke={6} tone={pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'accent'}>
                    <span className="gauge-value">{pct}%</span>
                  </ProgressRing>
                  <div className="gauge-text">
                    <span className="gauge-name">{name.replace(/_/g, ' ')} limit</span>
                    <span className="muted small">resets {timeUntil(win.resetsAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {idle.length > 0 && (
        <Card title="Pick up again" actions={<Link to={project ? `/chats?project=${encodeURIComponent(project.id)}` : '/chats'} className="link-more">All chats</Link>}>
          <div className="list">
            {idle.map((chat) => (
              <ChatRow key={chat.id} chat={chat} showProject={!project} />
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
