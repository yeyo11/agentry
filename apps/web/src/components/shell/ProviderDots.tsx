import type { ProviderStatus } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { PROVIDERS_SETTINGS_PATH, useEnabledProviders } from '../../lib/provider-status';
import { STATE_TONE, stateLabelKey } from '../../lib/provider-state';
import { useProviderReason } from '../ProviderRow';
import { Tooltip } from '../controls/Tooltip';
import { StatusDot } from '../motion';
import { Spinner } from '../Spinner';

/** "Claude Code 2.1.282" when it works; "Copilot · signed out" when it needs a person. */
function ProviderDot({ status }: { status: ProviderStatus }) {
  const { t } = useTranslation('providers');
  const reason = useProviderReason(status);
  const tone = STATE_TONE[status.state];
  const ok = status.state === 'ready';
  const word = t(stateLabelKey(status.state)).toLowerCase();
  const text = ok ? [status.label, status.version].filter(Boolean).join(' ') : `${status.label} · ${word}`;
  const where = [status.version ? t('statusbar.version', { version: status.version }) : null, status.binaryPath ?? status.configHome]
    .filter(Boolean)
    .join(' · ');
  const tip = (
    <span className="statusbar-tip">
      <span>{`${status.label} · ${word}`}</span>
      {where && <span className="mono">{where}</span>}
      {!ok && <span className="mono">{reason}</span>}
    </span>
  );
  return (
    <Tooltip content={tip} side="top">
      <NavLink
        to={PROVIDERS_SETTINGS_PATH}
        className={`statusbar-item ${tone === 'warn' ? 'statusbar-warn' : tone === 'bad' ? 'statusbar-bad' : ''}`.trim()}
        aria-label={`${status.label}: ${word}`}
      >
        <StatusDot tone={tone} />
        <span className="ellipsis">{text}</span>
      </NavLink>
    </Tooltip>
  );
}

/**
 * One dot per enabled provider at the right of the status bar. With none found, or while the first
 * reading runs, a single note stands in for them, so the strip never shows a blank.
 */
export function ProviderDots() {
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
        <ProviderDot key={s.id} status={s} />
      ))}
    </>
  );
}
