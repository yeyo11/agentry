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
import { Trans, useTranslation } from 'react-i18next';
import type { SessionSummary } from '@agentry/shared';
import { Link } from 'react-router-dom';
import { useOverview, useProjects } from '../api';
import { ICON, ICON_SM } from '../components/icons';
import { CountUp, ProgressRing, Stagger, StatusDot } from '../components/motion';
import { isRunLive, RunCard } from '../components/RunCard';
import { isTemporarySession, originOf } from '../components/SessionOrigin';
import { Card, Empty, ErrorBox, PageHeader, Skeleton, StatusBadge } from '../components/ui';
import { formatDuration, shortPath, timeAgo, timeUntil } from '../lib/format';

const TOKEN_SOURCE_LABEL = {
  'wrapper-oauth-token': 'dashboard.tokenSource.wrapperOauthToken',
  'wrapper-api-key': 'dashboard.tokenSource.wrapperApiKey',
  'env-oauth-token': 'dashboard.tokenSource.envOauthToken',
  'env-api-key': 'dashboard.tokenSource.envApiKey',
  'credentials-file': 'dashboard.tokenSource.credentialsFile',
  cswap: 'dashboard.tokenSource.cswap',
  none: 'dashboard.tokenSource.none',
} as const;

const isTokenSource = (source: string): source is keyof typeof TOKEN_SOURCE_LABEL => source in TOKEN_SOURCE_LABEL;

export function SessionRow({ session, action }: { session: SessionSummary; action?: ReactNode }) {
  const { t } = useTranslation('work');
  const row = (
    <Link to={`/sessions/${session.id}`} className="list-row">
      <div className="list-row-main">
        <div className="list-row-title">
          {session.live && <StatusBadge status={session.live.status} title={t('shared.liveVia', { source: session.live.source })} />}
          <span className="strong ellipsis">{session.title}</span>
        </div>
        <div className="meta">
          <span title={session.projectPath}>{shortPath(session.projectPath || session.projectId, 40)}</span>
          <span>{t('shared.msgs', { count: session.messageCount })}</span>
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
  const { t } = useTranslation('work');
  const { data, error, isLoading } = useOverview();
  const projects = useProjects();

  if (isLoading) {
    return (
      <>
        <PageHeader title={t('dashboard.title')} subtitle={t('dashboard.connecting')} />
        <div className="card">
          <Skeleton rows={4} height={18} />
        </div>
      </>
    );
  }
  if (!data) return <ErrorBox error={error} title={t('dashboard.unreachable')} />;

  const { system, counts, rateLimit, accounts } = data;
  const { cli, auth } = system;
  const liveRuns = data.runs.filter((run) => isRunLive(run) && !run.internal);
  const projectsById = new Map((projects.data ?? []).map((p) => [p.id, p]));
  // Housekeeping and scratch sessions would only add noise here
  const recentSessions = data.recentSessions.filter((s) => originOf(s).kind !== 'internal' && !isTemporarySession(s, projectsById));
  const windows = Object.entries(rateLimit?.windows ?? {});

  const tiles: Array<{ label: string; value: number; to: string; icon: LucideIcon; live?: boolean }> = [
    { label: t('dashboard.tiles.activeRuns'), value: counts.activeRuns, to: '/agents', icon: Activity, live: true },
    { label: t('dashboard.tiles.subagents'), value: counts.subagents, to: '/agents', icon: Bot, live: true },
    { label: t('dashboard.tiles.liveCliSessions'), value: counts.activeCliSessions, to: '/agents', icon: SquareTerminal, live: true },
    { label: t('dashboard.tiles.backgroundTasks'), value: counts.backgroundTasks, to: '/tasks', icon: Timer, live: true },
    { label: t('dashboard.tiles.workflowsRunning'), value: counts.workflows ?? 0, to: '/workflows', icon: Waypoints, live: true },
    { label: t('dashboard.tiles.orchestrationsRunning'), value: counts.orchestrationsRunning, to: '/orchestration', icon: Workflow, live: true },
    { label: t('dashboard.tiles.projects'), value: counts.projects, to: '/projects', icon: FolderGit2 },
    { label: t('dashboard.tiles.sessions'), value: counts.sessions, to: '/sessions', icon: History },
  ];
  const healthy = cli.installed && auth.loggedIn;

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        subtitle={t('dashboard.subtitle', { version: system.version, uptime: formatDuration(system.uptimeSec * 1000) })}
      />
      <ErrorBox error={error} title={t('dashboard.refreshFailed')} />

      <section className={`hero ${healthy ? 'hero-ok' : 'hero-warn'}`} aria-label={t('dashboard.statusLabel')}>
        <div className="hero-main">
          <StatusDot tone={healthy ? 'ok' : cli.installed ? 'warn' : 'bad'} live={healthy} />
          <div className="hero-text">
            <div className="hero-title">
              {healthy ? t('dashboard.ready') : !cli.installed ? t('dashboard.cliNotDetected') : t('dashboard.notLoggedIn')}
            </div>
            <div className="hero-sub ellipsis">{[auth.email, auth.orgName].filter(Boolean).join(' · ') || system.configDir}</div>
          </div>
        </div>
        <div className="hero-pills">
          <span className="pill">
            <SquareTerminal {...ICON_SM} /> {t('shared.cliVersion', { version: cli.version ?? t('dashboard.cliMissing') })}
          </span>
          <span className="pill">
            <KeyRound {...ICON_SM} /> {auth.loggedIn ? (auth.authMethod ?? t('dashboard.loggedIn')) : t('dashboard.loggedOut')}
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
            <strong>{t('dashboard.cliAlertTitle')}</strong>
            <div>
              {cli.error ?? t('dashboard.cliAlertDefault')} {t('dashboard.cliAlertHint')}
            </div>
          </div>
        </div>
      )}
      {cli.installed && !auth.loggedIn && (
        <div className="alert alert-warn alert-big">
          <TriangleAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('dashboard.notLoggedIn')}</strong>
            <div>
              {auth.error ?? t('dashboard.loginAlertDefault')}{' '}
              <Trans t={t} i18nKey="dashboard.loginAlertHint" components={{ code: <code />, link: <Link to="/config?tab=account" /> }} />
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
          title={t('dashboard.environment')}
          actions={
            <Link to="/config?tab=account" className="link-more">
              {t('dashboard.account')} <ArrowRight {...ICON_SM} />
            </Link>
          }
        >
          <dl className="kv">
            <dt>{t('dashboard.binary')}</dt>
            <dd className="mono">{cli.path ?? '—'}</dd>
            <dt>{t('dashboard.credential')}</dt>
            <dd>{isTokenSource(auth.tokenSource) ? t(TOKEN_SOURCE_LABEL[auth.tokenSource]) : auth.tokenSource}</dd>
            <dt>{t('dashboard.configDir')}</dt>
            <dd className="mono">{system.configDir}</dd>
            <dt>{t('dashboard.workspace')}</dt>
            <dd className="mono">{system.workspaceDir}</dd>
          </dl>
        </Card>

        <Card
          title={t('dashboard.usageLimits')}
          actions={rateLimit && <span className="muted small">{t('dashboard.observed', { ago: timeAgo(rateLimit.observedAt) })}</span>}
        >
          {accounts?.active && (
            <div className="meta small">
              <Link to="/accounts">{accounts.active.alias ?? accounts.active.email}</Link>
              {accounts.active.headroomPct !== null && <span>{t('dashboard.quotaLeft', { pct: accounts.active.headroomPct })}</span>}
              <span className="muted">
                {t('dashboard.accountCount', { count: accounts.total })}
                {accounts.autoSwitchRunning ? ` · ${t('dashboard.autoRotationOn')}` : ''}
              </span>
            </div>
          )}
          {!rateLimit ? (
            <Empty icon={Gauge} title={t('dashboard.noUsage')}>
              {t('dashboard.noUsageHint')}
            </Empty>
          ) : (
            <div className="meters">
              <div className="meta">
                <span>{t('dashboard.status')}</span>
                <StatusBadge status={rateLimit.status} />
              </div>
              {windows.length === 0 && <div className="muted">{t('dashboard.noWindows')}</div>}
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
                        <span className="muted small">{t('dashboard.resets', { when: timeUntil(win.resetsAt) })}</span>
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
        <Card title={t('dashboard.liveRuns', { n: liveRuns.length })} actions={
            <Link to="/agents" className="link-more">
              {t('dashboard.allAgents')} <ArrowRight {...ICON_SM} />
            </Link>
          }>
          {liveRuns.length === 0 ? (
            <Empty icon={Activity} title={t('dashboard.noRuns')}>
              <Link to="/runs/new">{t('dashboard.startRun')}</Link>
            </Empty>
          ) : (
            <div className="stack">
              {liveRuns.map((run) => (
                <RunCard key={run.id} run={run} compact />
              ))}
            </div>
          )}
        </Card>
        <Card title={t('dashboard.recentSessions')} actions={
            <Link to="/sessions" className="link-more">
              {t('dashboard.allSessions')} <ArrowRight {...ICON_SM} />
            </Link>
          }>
          {recentSessions.length === 0 ? (
            <Empty icon={History} title={t('dashboard.noSessions')} />
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
