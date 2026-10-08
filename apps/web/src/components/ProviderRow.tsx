import type { ProviderStatus } from '@agentry/shared';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  actionsFor,
  CLAUDE_CODE_ID,
  providerLink,
  SIGN_IN_SETTINGS_PATH,
  STATE_TONE,
  stateLabelKey,
  type ProviderAction,
} from '../lib/provider-state';
import { ProgramMark } from '@agentry/ui/components/BrandMark';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { Tag } from '@agentry/ui/components/ui';

export interface ProviderRowProps {
  status: ProviderStatus;
  isDefault?: boolean;
  /** Off in the settings: shown as such, and no remedy is offered for what is not being checked */
  enabled?: boolean;
  /** A detection is running for it: the state is replaced by a note until the answer comes */
  checking?: boolean;
  /** `row` is the desktop grid, `cell` the stacked phone card */
  variant?: 'row' | 'cell';
  /** The first-run list only reads what was found: no handle and no switch */
  compact?: boolean;
  /** The drag handle (desktop) */
  leading?: ReactNode;
  /** The enable switch */
  trailing?: ReactNode;
  /** The provider's usage limit, under its reason */
  limit?: ReactNode;
  onRetry?: () => void;
  /** Opens the binary override; without it "Choose binary" is not offered */
  onChooseBinary?: () => void;
  /**
   * Opens the sign-in panel (components/setup) under the row or in a Sheet. Without it, Sign in is
   * the vendor's page, or Settings → Account for Claude Code.
   */
  onSignIn?: () => void;
  /** A panel is open under the row (the sign-in or the binary): the row joins it */
  open?: boolean;
  /** Sign out, for a row that is signed in and whose vendor documents a way out */
  signOut?: ReactNode;
  /** Sign in where the state alone gives no such action (`no-probe` with no key kept) */
  offerSignIn?: boolean;
}

/** The plain-words reason under the state: a code the detector gave, or what ready means. */
export function useProviderReason(status: ProviderStatus, enabled = true): string {
  const { t } = useTranslation('providers');
  if (!enabled) return t('reason.disabled');
  if (status.state === 'ready') return t('readyReason');
  // A detector that gave no code still leaves the state's own word to say
  if (status.reason === null) return t(stateLabelKey(status.state));
  return t(`reason.${status.reason}`, {
    version: status.version ? `v${status.version}` : '',
    range: status.compatibleRange,
    label: status.label,
    home: status.configHome ?? '',
  });
}

function versionLine(status: ProviderStatus): string {
  const shows = status.state === 'degraded' || status.state === 'incompatible';
  return [status.version ? `v${status.version}` : null, shows && status.compatibleRange ? status.compatibleRange : null, status.binaryPath ?? status.configHome]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/**
 * One provider: its mark and name, the account, the version and path in mono, the state as a badge
 * with its word, the reason in plain words, and the remedy the state asks for. Colour is the tone of
 * the state and always beside a word. The switch, the handle and the binary editor belong to the
 * page that lists it, which hands them in.
 */
export function ProviderRow({
  status,
  isDefault = false,
  enabled = true,
  checking = false,
  variant = 'row',
  compact = false,
  leading,
  trailing,
  limit,
  onRetry,
  onChooseBinary,
  onSignIn,
  open = false,
  signOut,
  offerSignIn = false,
}: ProviderRowProps) {
  const { t } = useTranslation('providers');
  const reason = useProviderReason(status, enabled);
  const shown = enabled ? status.state : 'disabled';
  const account = status.account ?? t('row.noAccount');
  const meta = versionLine(status);

  const identity = (
    <div className="prov-id">
      <span className="prov-name">
        {status.label}
        {isDefault && <span className="badge badge-project"><span className="badge-text">{t('row.default')}</span></span>}
      </span>
      {variant === 'row' && <span className="prov-account">{account}</span>}
      {meta && <span className="prov-meta ellipsis" title={meta}>{meta}</span>}
    </div>
  );

  const state = checking ? (
    <div className="prov-state" role="status">
      <span className="prov-checking">
        <Spinner />
        {t('row.checking')}
      </span>
    </div>
  ) : (
    <div className="prov-state">
      <Tag tone={STATE_TONE[shown]}>{t(stateLabelKey(shown))}</Tag>
      <p className="prov-reason">{reason}</p>
      {enabled && limit}
    </div>
  );

  const stateActions = checking || !enabled ? [] : actionsFor(status.state, status.reason);
  const actions: ProviderAction[] =
    offerSignIn && !checking && enabled && !stateActions.some((a) => a.kind === 'sign-in') ? [{ kind: 'sign-in', primary: true }, ...stateActions] : stateActions;
  const buttons = actions.map((action) => (
    <ActionButton key={action.kind} action={action} status={status} open={open} onRetry={onRetry} onChooseBinary={onChooseBinary} onSignIn={onSignIn} />
  ));
  if (signOut && !checking && enabled) buttons.push(<Fragment key="sign-out">{signOut}</Fragment>);

  if (variant === 'cell') {
    return (
      <div className="prov-cell" data-provider={status.id} data-state={shown}>
        <div className="prov-cell-head">
          <ProgramMark id={status.id} label={status.label} />
          {identity}
          {trailing}
        </div>
        {state}
        {buttons.some(Boolean) && <div className="prov-actions">{buttons}</div>}
      </div>
    );
  }
  return (
    <div className={`prov-row${compact ? ' compact' : ''}${open ? ' open' : ''}`} data-provider={status.id} data-state={shown}>
      {!compact && (leading ?? <span />)}
      <ProgramMark id={status.id} label={status.label} />
      {identity}
      {state}
      <div className="prov-actions">{buttons}</div>
      {!compact && (trailing ?? <span />)}
    </div>
  );
}

const cls = (action: ProviderAction) => (action.primary ? 'btn' : 'btn prov-quiet');

function ActionButton({
  action,
  status,
  open,
  onRetry,
  onChooseBinary,
  onSignIn,
}: {
  action: ProviderAction;
  status: ProviderStatus;
  open: boolean;
  onRetry: ProviderRowProps['onRetry'];
  onChooseBinary: ProviderRowProps['onChooseBinary'];
  onSignIn: ProviderRowProps['onSignIn'];
}) {
  const { t } = useTranslation('providers');
  const { t: tSetup } = useTranslation('setup');
  const external = (href: string, label: string) => (
    <a className={cls(action)} href={href} target="_blank" rel="noopener noreferrer" data-action={action.kind}>
      {label}
      <ExternalLink {...ICON_SM} />
      <span className="sr-only"> ({t('row.opensNewTab')})</span>
    </a>
  );
  switch (action.kind) {
    case 'sign-in': {
      // The panel signs in inside Agentry, with nothing that opens elsewhere; without one, Claude
      // Code goes to Settings → Account and the others to their vendor's page
      if (onSignIn) {
        return (
          <button
            type="button"
            className={cls(action)}
            data-action="sign-in"
            aria-pressed={open}
            aria-label={tSetup('row.signInAria', { label: status.label })}
            onClick={onSignIn}
          >
            {t('row.signIn')}
          </button>
        );
      }
      if (status.id === CLAUDE_CODE_ID) {
        return (
          <Link className={cls(action)} to={SIGN_IN_SETTINGS_PATH} data-action="sign-in">
            {t('row.signIn')}
          </Link>
        );
      }
      const href = providerLink(status.id, 'sign-in');
      return href ? external(href, t('row.signIn')) : null;
    }
    case 'install':
    case 'update': {
      const href = providerLink(status.id, 'install');
      return href ? external(href, t(action.kind === 'install' ? 'row.install' : 'row.update')) : null;
    }
    case 'choose-binary':
      return onChooseBinary ? (
        <button type="button" className={cls(action)} data-action="choose-binary" onClick={onChooseBinary}>
          {t('row.chooseBinary')}
        </button>
      ) : null;
    case 'retry':
      return onRetry ? (
        <button type="button" className={cls(action)} data-action="retry" onClick={onRetry}>
          <RefreshCw {...ICON_SM} />
          {t('row.retry')}
        </button>
      ) : null;
  }
}
