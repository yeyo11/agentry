import type { ProviderLimit } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { api, keys } from '../../api';
import { ICON } from '@agentry/ui/components/icons';
import { formatCost } from '@agentry/ui/lib/format';
import { cardProvider, limitReading } from '../../lib/shell-live';
import { useLimitWindowName } from '../../lib/limit-words';
import { PROVIDERS_SETTINGS_PATH, useEnabledProviders } from '../../lib/provider-status';
import { resetWhen } from '../../lib/reset-when';
import { useUsageNow } from '../../lib/usage-now';
import { limitRows } from '../../pages/config/providers/rotation';
import { StatusDot, usageTone, type DotTone } from '@agentry/ui/components/motion';
import { ProviderMark } from '@agentry/ui/components/ProviderMark';
import { Spinner } from '@agentry/ui/components/Spinner';
import { Tooltip } from '@agentry/ui/components/controls/Tooltip';
import { ProviderDots } from './ProviderDots';

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

/** One window of the card: its name and figure over a thin bar in the threshold colour. */
function LimitMeter({ label, percent, exhausted }: { label: string; percent: number; exhausted: boolean }) {
  const tone = usageTone(percent, exhausted);
  // Inside a link, so the words are read as part of its name: "5 h 45%"
  return (
    <span className="more-account-limit">
      <span className="more-account-limit-head">
        <span>{label}</span>
        <span className={tone === 'neutral' ? undefined : `statusbar-${tone}`}>{percent}%</span>
      </span>
      <span className="meter-track meter-thin" aria-hidden>
        <span className={`meter-fill ${tone === 'neutral' ? '' : `is-${tone}`}`.trim()} style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}

/**
 * The phone's More sheet opens on this: the default provider, whether it works, and how much of its
 * limit is used. It is what the desktop's status bar says of that provider, as a card, and leads to
 * Settings → Providers. A provider that reports no limit shows none, and says so.
 */
export function ProviderCard({ now, connection }: { now: Now; connection: Connection }) {
  const { t } = useTranslation(['shell', 'providers']);
  const windowOf = useLimitWindowName();
  const { statuses } = useEnabledProviders();
  const defaultProvider = useQuery({ queryKey: keys.providerSettings, queryFn: () => api.providerSettings() }).data?.defaultProvider;
  const status = statuses ? cardProvider(statuses, defaultProvider) : null;
  // Before the providers are read, or with none enabled, the card still says whether the CLI works
  if (!status)
    return (
      <NavLink to={PROVIDERS_SETTINGS_PATH} className="card grad-border glow-top more-account" title={t('shell:account.card')}>
        <span className="more-account-head">
          <span className="more-account-text">
            <span className="more-account-name ellipsis">{statuses ? t('shell:account.none') : connection.title}</span>
            {connection.detail && !statuses && <span className="more-account-meta ellipsis">{connection.detail}</span>}
          </span>
          <ChevronRight {...ICON} className="more-cell-chevron" />
        </span>
      </NavLink>
    );
  const limit: ProviderLimit | null | undefined = now.limits.find((l) => l.provider === status.id) ?? status.limit;
  const reading = limitReading(limit);
  const rows = limit && reading ? limitRows(limit).filter((row) => row.name === '5h' || row.name === '7d' || row.name === limit.window).slice(0, 2) : [];
  const ready = status.state === 'ready';
  const tone: DotTone = reading?.state === 'exhausted' ? 'bad' : reading?.state === 'near' ? 'warn' : ready ? 'ok' : 'warn';
  const word = reading?.state === 'exhausted' ? t('shell:statusbar.limit.exhausted') : reading?.state === 'near' ? t('shell:statusbar.limit.near') : ready ? [t('providers:state.ready'), status.version ? t('shell:account.version', { version: status.version }) : null].filter(Boolean).join(' · ') : t(`providers:state.${status.state}`);
  const note = reading?.state === 'exhausted' && reading.resetsAt ? t('shell:statusbar.limit.resumes', { when: resetWhen(reading.resetsAt) }) : null;
  // A reading that is not there says why a bar is missing, in words
  const missing = rows.length === 0 ? (limit?.state === 'unknown' ? t('shell:account.limitUnknown') : !status.capabilities.includes('rateLimitWindows') ? t('shell:account.limitNone') : null) : null;
  return (
    <NavLink to={PROVIDERS_SETTINGS_PATH} className="card grad-border glow-top more-account" title={t('shell:account.card')}>
      <span className="more-account-head">
        <span className="more-account-avatar" aria-hidden>
          <ProviderMark provider={status.id} label={status.label} decorative />
        </span>
        <span className="more-account-text">
          <span className="more-account-name ellipsis">{status.label}</span>
          <span className="more-account-meta ellipsis">
            <StatusDot tone={tone} live={ready && connection.live && !reading} />
            {[word, note].filter(Boolean).join(' · ')}
          </span>
        </span>
        <ChevronRight {...ICON} className="more-cell-chevron" />
      </span>
      {rows.length > 0 && (
        <span className="more-account-limits">
          {rows.map((row) => (
            <LimitMeter key={row.name} label={windowOf(row.name)} percent={row.percent} exhausted={reading?.state === 'exhausted' && row.name === limit?.window} />
          ))}
        </span>
      )}
      {missing && <span className="more-account-meta">{missing}</span>}
    </NavLink>
  );
}

/**
 * The desktop's bottom strip, as in an IDE: the connection on the left, and on the right what is
 * running, what today cost and one dot per provider with its limit. Text and dots only: it sits
 * beside every page.
 */
export function StatusBar({ now, connection, agents }: { now: Now; connection: Connection; agents: number }) {
  const { t } = useTranslation('shell');
  return (
    <footer className="statusbar" aria-label={t('statusbar.label')}>
      <Tooltip content={[connection.title, connection.detail].filter(Boolean).join(' · ')} side="top">
        <NavLink to="/settings?tab=account" className="statusbar-item statusbar-conn">
          <StatusDot tone={connection.tone} live={connection.live} />
          <span className="ellipsis">{connection.short}</span>
        </NavLink>
      </Tooltip>
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
      <ProviderDots limits={now.limits} />
    </footer>
  );
}
