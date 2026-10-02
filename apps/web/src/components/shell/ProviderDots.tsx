import type { ProviderLimit, ProviderStatus } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { PROVIDERS_SETTINGS_PATH, useEnabledProviders } from '../../lib/provider-status';
import { STATE_TONE, stateLabelKey } from '../../lib/provider-state';
import { useProviderReason } from '../ProviderRow';
import { timeAgo } from '@agentry/ui/lib/format';
import { limitReading } from '../../lib/shell-live';
import { resetWhen } from '../../lib/reset-when';
import { Tooltip } from '@agentry/ui/components/controls/Tooltip';
import { StatusDot, usageTone, type DotTone } from '@agentry/ui/components/motion';
import { Spinner } from '@agentry/ui/components/Spinner';

/**
 * "Claude Code 2.1.282 ▬▬ 45 %" when it works; "Claude Code · limit ▬▬ 72 %" near its limit;
 * "Codex · limit reached resets 14:05" at it; "Copilot · signed out" when it needs a person. The
 * limit is always said in a word beside its colour, and a provider that reports none shows no bar.
 */
function ProviderDot({ status, limit }: { status: ProviderStatus; limit: ProviderLimit | null | undefined }) {
  const { t } = useTranslation('providers');
  const { t: ts } = useTranslation('shell');
  const reason = useProviderReason(status);
  const reading = limitReading(limit);
  const hot = reading !== null && reading.state !== 'ok';
  // A provider degraded only by its limit is working: the limit says it, not "degraded"
  const limitOnly = hot && (status.state === 'ready' || status.reason === 'limit-reached' || status.reason === 'limit-near');
  const tone: DotTone = limitOnly ? (reading.state === 'exhausted' ? 'bad' : 'warn') : STATE_TONE[status.state];
  const ok = status.state === 'ready';
  const word = t(stateLabelKey(status.state)).toLowerCase();
  const limitWord = reading ? (reading.state === 'exhausted' ? ts('statusbar.limit.exhausted') : ts('statusbar.limit.near')) : '';
  const text = limitOnly ? `${status.label} · ${limitWord}` : ok ? [status.label, status.version].filter(Boolean).join(' ') : `${status.label} · ${word}`;
  const barTone = reading?.percent == null ? 'neutral' : usageTone(reading.percent, reading.state === 'exhausted');
  const showBar = reading !== null && reading.percent !== null && reading.state !== 'exhausted';
  const where = [status.version ? t('statusbar.version', { version: status.version }) : null, status.binaryPath ?? status.configHome]
    .filter(Boolean)
    .join(' · ');
  const windowName = reading?.window ?? '';
  const tip = (
    <span className="statusbar-tip">
      <span>{`${status.label} · ${limitOnly ? limitWord : word}`}</span>
      {where && <span className="mono">{where}</span>}
      {!ok && !limitOnly && <span className="mono">{reason}</span>}
      {reading && (
        <span className="mono">
          {[
            reading.percent !== null ? ts('statusbar.limit.tipWindow', { window: windowName, percent: reading.percent }) : windowName,
            reading.resetsAt ? ts('statusbar.limit.tipReset', { when: resetWhen(reading.resetsAt) }) : null,
            limit ? ts('statusbar.limit.tipAge', { age: timeAgo(limit.observedAt) }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      )}
      {!reading && limit?.state === 'unknown' && <span className="mono">{ts('statusbar.limit.unknown')}</span>}
      {!limit && !status.capabilities.includes('rateLimitWindows') && status.state === 'ready' && <span className="mono">{ts('statusbar.limit.none', { provider: status.label })}</span>}
    </span>
  );
  return (
    <Tooltip content={tip} side="top">
      <NavLink
        to={PROVIDERS_SETTINGS_PATH}
        className={`statusbar-item ${tone === 'warn' ? 'statusbar-warn' : tone === 'bad' ? 'statusbar-bad' : ''}`.trim()}
        aria-label={`${status.label}: ${limitOnly ? limitWord : word}${reading?.percent != null ? `, ${reading.percent} %` : ''}`}
      >
        <StatusDot tone={tone} />
        <span className="ellipsis">{text}</span>
        {showBar && reading.percent !== null && (
          <>
            <span className="meter-track meter-thin statusbar-meter" aria-hidden>
              <span className={`meter-fill ${barTone === 'neutral' ? '' : `is-${barTone}`}`.trim()} style={{ width: `${reading.percent}%` }} />
            </span>
            <span aria-hidden>{reading.percent} %</span>
          </>
        )}
        {reading?.state === 'exhausted' && reading.resetsAt && <span className="statusbar-age">{ts('statusbar.limit.resumes', { when: resetWhen(reading.resetsAt) })}</span>}
      </NavLink>
    </Tooltip>
  );
}

/**
 * One dot per enabled provider at the right of the status bar. With none found, or while the first
 * reading runs, a single note stands in for them, so the strip never shows a blank. `limits` are the
 * overview's readings, fresher than the ones the statuses carry.
 */
export function ProviderDots({ limits = [] }: { limits?: readonly ProviderLimit[] }) {
  const { t } = useTranslation('providers');
  const { statuses, loading } = useEnabledProviders();
  if (loading)
    return (
      <span className="statusbar-item">
        <Spinner />
        {t('statusbar.checking')}
      </span>
    );
  if (!statuses) return null;
  const present = statuses.filter((s) => s.state !== 'not-installed');
  if (present.length === 0)
    return (
      <NavLink to={PROVIDERS_SETTINGS_PATH} className="statusbar-item">
        <StatusDot tone="idle" />
        {t('statusbar.none')}
      </NavLink>
    );
  return (
    <>
      {present.map((s) => (
        <ProviderDot key={s.id} status={s} limit={limits.find((l) => l.provider === s.id) ?? s.limit} />
      ))}
    </>
  );
}
