import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Bot,
  FolderGit2,
  Gauge,
  GitBranch,
  History,
  KeyRound,
  Radio,
  SquareTerminal,
  Timer,
  TriangleAlert,
  Waypoints,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { SessionSummary } from '@agentry/shared';
import { Link } from 'react-router-dom';
import { useOverview, useProjects } from '../api';
import { ICON, ICON_SM } from '../components/icons';
import { CountUp, ProgressRing, Stagger, StatusDot } from '../components/motion';
import { isRunLive, RunCard } from '../components/RunCard';
import { isTemporarySession, originOf } from '../components/SessionOrigin';
import { Card, Empty, ErrorBox, PageHeader, Skeleton, StatusBadge } from '../components/ui';
import { formatDuration, shortPath, timeAgo, timeUntil } from '../lib/format';

const TOKEN_SOURCE_LABEL: Record<string, string> = {
  'wrapper-oauth-token': 'OAuth token (configured here)',
  'wrapper-api-key': 'API key (configured here)',
  'env-oauth-token': 'CLAUDE_CODE_OAUTH_TOKEN (env)',
  'env-api-key': 'ANTHROPIC_API_KEY (env)',
  'credentials-file': 'credentials file',
  cswap: 'claude-swap (multi-account)',
  none: 'none',
};

export function SessionRow({ session, action }: { session: SessionSummary; action?: ReactNode }) {
  const row = (
    <Link to={`/sessions/${session.id}`} className="list-row">
      <div className="list-row-main">
        <div className="list-row-title">
          {session.live && <StatusBadge status={session.live.status} title={`live via ${session.live.source}`} />}
          <span className="strong ellipsis">{session.title}</span>
        </div>
        <div className="meta">
          <span title={session.projectPath}>{shortPath(session.projectPath || session.projectId, 40)}</span>
          <span>{session.messageCount} msgs</span>
          {session.model && <span>{session.model}</span>}
          {session.gitBranch && session.gitBranch !== 'HEAD' && (
            <span className="meta-icon">
              <GitBranch size={12} strokeWidth={1.75} aria-hidden /> {session.gitBranch}
            </span>
          )}
        </div>
      </div>
      <span className="muted small nowrap">{timeAgo(session.updatedAt)}</span>
    </Link>
  );
  if (!action) return row;
  return (
    <div className="list-row-wrap">
      {row}
      <div className="list-row-action">{action}</div>
    </div>
  );
}

export function Dashboard() {
  const { data, error, isLoading } = useOverview();
  const projects = useProjects();

  if (isLoading) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Connecting to the wrapper…" />
        <div className="card">
          <Skeleton rows={4} height={18} />
        </div>
      </>
    );
  }
  if (!data) return <ErrorBox error={error} title="Cannot reach the wrapper API" />;

  const { system, counts, rateLimit, accounts } = data;
  const { cli, auth } = system;
  const liveRuns = data.runs.filter((run) => isRunLive(run) && !run.internal);
  const projectsById = new Map((projects.data ?? []).map((p) => [p.id, p]));
  // Housekeeping and scratch sessions would only add noise here
  const recentSessions = data.recentSessions.filter((s) => originOf(s).kind !== 'internal' && !isTemporarySession(s, projectsById));
  const windows = Object.entries(rateLimit?.windows ?? {});

  const tiles: Array<{ label: string; value: number; to: string; icon: LucideIcon; live?: boolean }> = [
    { label: 'Active runs', value: counts.activeRuns, to: '/agents', icon: Activity, live: true },
    { label: 'Subagents', value: counts.subagents, to: '/agents', icon: Bot, live: true },
    { label: 'Live CLI sessions', value: counts.activeCliSessions, to: '/agents', icon: SquareTerminal, live: true },
    { label: 'Background tasks', value: counts.backgroundTasks, to: '/tasks', icon: Timer, live: true },
    { label: 'Workflows running', value: counts.workflows ?? 0, to: '/workflows', icon: Waypoints, live: true },
    { label: 'Orchestrations running', value: counts.orchestrationsRunning, to: '/orchestration', icon: Workflow, live: true },
    { label: 'Projects', value: counts.projects, to: '/projects', icon: FolderGit2 },
    { label: 'Sessions', value: counts.sessions, to: '/sessions', icon: History },
  ];
  const healthy = cli.installed && auth.loggedIn;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Agentry v${system.version} · up ${formatDuration(system.uptimeSec * 1000)}`}
      />
      <ErrorBox error={error} title="Last refresh failed" />

      <section className={`hero ${healthy ? 'hero-ok' : 'hero-warn'}`} aria-label="Status">
        <div className="hero-main">
          <StatusDot tone={healthy ? 'ok' : cli.installed ? 'warn' : 'bad'} live={healthy} />
          <div className="hero-text">
            <div className="hero-title">
              {healthy ? 'Claude Code is ready' : !cli.installed ? 'Claude Code CLI not detected' : 'Claude Code is not logged in'}
            </div>
            <div className="hero-sub ellipsis">{[auth.email, auth.orgName].filter(Boolean).join(' · ') || system.configDir}</div>
          </div>
        </div>
        <div className="hero-pills">
          <span className="pill">
            <SquareTerminal {...ICON_SM} /> CLI {cli.version ?? 'missing'}
          </span>
          <span className="pill">
            <KeyRound {...ICON_SM} /> {auth.loggedIn ? (auth.authMethod ?? 'logged in') : 'logged out'}
          </span>
          {auth.subscriptionType && (
            <span className="pill pill-accent">
              <BadgeCheck {...ICON_SM} /> {auth.subscriptionType}
            </span>
          )}
          <span className="pill">
            <Radio {...ICON_SM} /> {system.defaultPermissionMode}
          </span>
        </div>
      </section>

      {!cli.installed && (
        <div className="alert alert-bad alert-big">
          <TriangleAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>Claude Code CLI was not detected</strong>
            <div>{cli.error ?? 'The `claude` binary is not available in PATH.'} Install it in the container or set CLAUDE_BIN.</div>
          </div>
        </div>
      )}
      {cli.installed && !auth.loggedIn && (
        <div className="alert alert-warn alert-big">
          <TriangleAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>Claude Code is not logged in</strong>
            <div>
              {auth.error ?? 'No valid credentials were found.'} Run <code>claude setup-token</code> on your machine and
              pass the token to the container as <code>CLAUDE_CODE_OAUTH_TOKEN</code>, or add it in{' '}
              <Link to="/config?tab=account">Config → Account</Link>.
            </div>
          </div>
        </div>
      )}

      <Stagger className="tiles">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          const hot = tile.live === true && tile.value > 0;
          return (
            <Link key={tile.label} to={tile.to} className={`tile ${hot ? 'tile-hot' : ''}`}>
              <span className="tile-top">
                <span className="tile-icon">
                  <Icon {...ICON} />
                </span>
                {hot && <StatusDot tone="active" live />}
              </span>
              <CountUp className="tile-value" value={tile.value} />
              <span className="tile-label">{tile.label}</span>
            </Link>
          );
        })}
      </Stagger>

      <div className="grid-2">
        <Card
          title="Environment"
          actions={
            <Link to="/config?tab=account" className="link-more">
              Account <ArrowRight {...ICON_SM} />
            </Link>
          }
        >
          <dl className="kv">
            <dt>Binary</dt>
            <dd className="mono">{cli.path ?? '—'}</dd>
            <dt>Credential</dt>
            <dd>{TOKEN_SOURCE_LABEL[auth.tokenSource] ?? auth.tokenSource}</dd>
            <dt>Config dir</dt>
            <dd className="mono">{system.configDir}</dd>
            <dt>Workspace</dt>
            <dd className="mono">{system.workspaceDir}</dd>
          </dl>
        </Card>

        <Card
          title="Usage limits"
          actions={rateLimit && <span className="muted small">observed {timeAgo(rateLimit.observedAt)}</span>}
        >
          {accounts?.active && (
            <div className="meta small">
              <Link to="/accounts">{accounts.active.alias ?? accounts.active.email}</Link>
              {accounts.active.headroomPct !== null && <span>{accounts.active.headroomPct}% quota left</span>}
              <span className="muted">
                {accounts.total} account{accounts.total === 1 ? '' : 's'}
                {accounts.autoSwitchRunning ? ' · auto-rotation on' : ''}
              </span>
            </div>
          )}
          {!rateLimit ? (
            <Empty icon={Gauge} title="No usage data yet">
              Rate-limit windows appear after the first run.
            </Empty>
          ) : (
            <div className="meters">
              <div className="meta">
                <span>status</span>
                <StatusBadge status={rateLimit.status} />
              </div>
              {windows.length === 0 && <div className="muted">No windows reported.</div>}
              <div className="gauges">
                {windows.map(([name, win]) => {
                  const pct = Math.min(100, Math.round(win.utilization * 100));
                  return (
                    <div key={name} className="gauge">
                      <ProgressRing value={pct / 100} size={92} stroke={8} tone={pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'accent'}>
                        <span className="gauge-value">{pct}%</span>
                      </ProgressRing>
                      <div className="gauge-text">
                        <span className="gauge-name">{name.replace(/_/g, ' ')}</span>
                        <span className="muted small">resets {timeUntil(win.resetsAt)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="grid-2">
        <Card title={`Live runs (${liveRuns.length})`} actions={
            <Link to="/agents" className="link-more">
              All agents <ArrowRight {...ICON_SM} />
            </Link>
          }>
          {liveRuns.length === 0 ? (
            <Empty icon={Activity} title="No runs in progress">
              <Link to="/runs/new">Start a new run</Link>
            </Empty>
          ) : (
            <div className="stack">
              {liveRuns.map((run) => (
                <RunCard key={run.id} run={run} compact />
              ))}
            </div>
          )}
        </Card>
        <Card title="Recent sessions" actions={
            <Link to="/sessions" className="link-more">
              All sessions <ArrowRight {...ICON_SM} />
            </Link>
          }>
          {recentSessions.length === 0 ? (
            <Empty icon={History} title="No sessions yet" />
          ) : (
            <div className="list">
              {recentSessions.map((s) => (
                <SessionRow key={s.id} session={s} />
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
