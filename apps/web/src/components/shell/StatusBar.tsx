import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { ICON } from '../icons';
import { formatCost } from '../../lib/format';
import type { UsageWindowReading } from '../../lib/shell-live';
import { useUsageNow } from '../../lib/usage-now';
import { StatusDot, usageTone, type DotTone } from '../motion';
import { Spinner } from '../Spinner';
import { Tooltip } from '../controls/Tooltip';

type Now = ReturnType<typeof useUsageNow>;

export interface Connection {
  tone: DotTone;
  /** The feed is open and the CLI is ready: the dot pings */
  live: boolean;
  healthy: boolean;
  /** What is wrong, or the CLI when nothing is */
  title: string;
  /** The account when all is well, what to do when it is not */
  detail: string;
  /** What the status bar says in its few characters */
  short: string;
}

/**
 * The wrapper's connection in words: the API, the event feed, the CLI and its login. The status bar
 * says it in a few characters and the phone's More sheet in two lines; both lead to the account
 * settings, where each of these is fixed.
 */
export function useConnection(overview: Now['overview'], feedOpen: boolean): Connection {
  const { t } = useTranslation('components');
  const auth = overview.data?.system.auth;
  const cli = overview.data?.system.cli;
  const healthy = cli?.installed === true && auth?.loggedIn === true;
  const feedDown = !feedOpen && overview.data !== undefined;
  const tone: DotTone = overview.isError ? 'bad' : healthy && !feedDown ? 'ok' : 'warn';
  const title = overview.isError
    ? t('shell.apiUnreachable')
    : !overview.data
      ? t('shell.connecting')
      : healthy
        ? t('shell.claudeCode', { version: cli?.version ?? '' })
        : !cli?.installed
          ? t('shell.cliNotDetected')
          : t('shell.notLoggedIn');
  const account = [auth?.subscriptionType ?? auth?.authMethod, auth?.email].filter(Boolean).join(' · ') || t('shell.loggedIn');
  const detail = healthy
    ? feedDown
      ? t('shell.liveUpdatesPaused')
      : account
    : overview.isError
      ? t('shell.checkWrapper')
      : !overview.data
        ? ''
        : !cli?.installed
          ? t('shell.installCli')
          : t('shell.addCredential');
  // Healthy, the account is what a person looks for; otherwise the problem is
  const short = healthy ? (feedDown ? t('shell.liveUpdatesPaused') : (auth?.email ?? account)) : title;
  return { tone, live: healthy && !feedDown, healthy, title, detail, short };
}

/** "5h ▬▬── 45%": a thin bar in the threshold colour, and the figure beside it. */
function WindowBar({ label, reading }: { label: string; reading: UsageWindowReading | null }) {
  const { t } = useTranslation('shell');
  if (!reading) return null;
  const tone = usageTone(reading.percent);
  return (
    <span className="statusbar-item statusbar-window" role="group" aria-label={t('statusbar.window', { window: label, percent: reading.percent })}>
      <span aria-hidden>{label}</span>
      <span className="meter-track meter-thin statusbar-meter" aria-hidden>
        <span className={`meter-fill ${tone === 'neutral' ? '' : `is-${tone}`}`.trim()} style={{ width: `${reading.percent}%` }} />
      </span>
      <span className={tone === 'neutral' ? undefined : `statusbar-${tone}`} aria-hidden>
        {reading.percent}%
      </span>
    </span>
  );
}

/** One limit of the account card: its name and figure over a thin bar in the threshold colour. */
function LimitMeter({ label, reading }: { label: string; reading: UsageWindowReading | null }) {
  if (!reading) return null;
  const tone = usageTone(reading.percent);
  // Inside a link, so the words are read as part of its name: "5h 45%"
  return (
    <span className="more-account-limit">
      <span className="more-account-limit-head">
        <span>{label}</span>
        <span className={tone === 'neutral' ? undefined : `statusbar-${tone}`}>{reading.percent}%</span>
      </span>
      <span className="meter-track meter-thin" aria-hidden>
        <span className={`meter-fill ${tone === 'neutral' ? '' : `is-${tone}`}`.trim()} style={{ width: `${reading.percent}%` }} />
      </span>
    </span>
  );
}

/**
 * The phone's More sheet opens on this: who is signed in, on what, and how much of the limits is
 * used. It is what the desktop's status bar says, as a card, and leads to the accounts.
 */
export function AccountCard({ now, connection }: { now: Now; connection: Connection }) {
  const { t } = useTranslation('shell');
  const auth = now.overview.data?.system.auth;
  const cli = now.overview.data?.system.cli;
  const name = connection.healthy ? (auth?.email ?? connection.title) : connection.title;
  const meta = connection.healthy
    ? [auth?.subscriptionType ?? auth?.authMethod, cli?.version ? t('account.cli', { version: cli.version }) : null].filter(Boolean).join(' · ')
    : connection.detail;
  return (
    <NavLink to="/accounts" className="card grad-border glow-top more-account" title={t('account.card')}>
      <span className="more-account-head">
        <span className="more-account-avatar" aria-hidden>
          {(auth?.email ?? '·').charAt(0).toUpperCase()}
        </span>
        <span className="more-account-text">
          <span className="more-account-name ellipsis">{name}</span>
          {meta && (
            <span className="more-account-meta ellipsis">
              <StatusDot tone={connection.tone} live={connection.live} />
              {meta}
            </span>
          )}
        </span>
        <ChevronRight {...ICON} className="more-cell-chevron" />
      </span>
      {(now.fiveHour || now.sevenDay) && (
        <span className="more-account-limits">
          <LimitMeter label={t('statusbar.fiveHour')} reading={now.fiveHour} />
          <LimitMeter label={t('statusbar.sevenDay')} reading={now.sevenDay} />
        </span>
      )}
    </NavLink>
  );
}

/**
 * The desktop's bottom strip, as in an IDE: the connection and the account on the left with how
 * much of its limits is used, and on the right what is running, what today cost and the CLI. It
 * took over the sidebar footer's job. Text and dots only: it sits beside every page.
 */
export function StatusBar({ now, connection, agents }: { now: Now; connection: Connection; agents: number }) {
  const { t } = useTranslation(['shell', 'components']);
  const cli = now.overview.data?.system.cli;
  return (
    <footer className="statusbar" aria-label={t('statusbar.label')}>
      <Tooltip content={[connection.title, connection.detail].filter(Boolean).join(' · ')} side="top">
        <NavLink to="/settings?tab=account" className="statusbar-item statusbar-conn">
          <StatusDot tone={connection.tone} live={connection.live} />
          <span className="ellipsis">{connection.short}</span>
        </NavLink>
      </Tooltip>
      <WindowBar label={t('statusbar.fiveHour')} reading={now.fiveHour} />
      <WindowBar label={t('statusbar.sevenDay')} reading={now.sevenDay} />
      <span className="statusbar-spacer" />
      {agents > 0 && (
        <NavLink to="/chats?state=working" className="statusbar-item statusbar-live">
          <Spinner />
          {t('statusbar.running', { count: agents })}
        </NavLink>
      )}
      {now.todayCost !== undefined && (
        <NavLink to="/usage" className="statusbar-item">
          {now.todayCost === null ? t('statusbar.todayNone') : t('statusbar.today', { cost: formatCost(now.todayCost) })}
        </NavLink>
      )}
      {cli?.installed && cli.version && <span className="statusbar-item">{t('components:shell.claudeCode', { version: cli.version })}</span>}
    </footer>
  );
}
