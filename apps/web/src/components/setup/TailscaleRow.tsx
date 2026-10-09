import type { SetupTailscaleSummary } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { ProgramMark } from '@agentry/ui/components/BrandMark';
import { Tag } from '@agentry/ui/components/ui';
import { tailscaleActions, tailscaleSignedIn, tailscaleTone } from '../../lib/setup';
import { SignInPanel, SignInSheet } from './SignInPanel';
import { SignOutButton } from './SignOutButton';

const LABEL = 'Tailscale';

/** The plain-words reason under the state: what the row can do, or why it only shows the state */
function reasonKey(summary: SetupTailscaleSummary): 'signedIn' | 'loggedOut' | 'stopped' | 'daemonDown' | 'machine' | 'missing' {
  if (!summary.managed) return summary.state === 'missing' ? 'missing' : tailscaleSignedIn(summary.state) ? 'signedIn' : 'machine';
  if (tailscaleSignedIn(summary.state) && summary.state !== 'stopped') return 'signedIn';
  if (summary.state === 'stopped' || summary.state === 'loggedOut') return summary.state;
  return 'daemonDown';
}

/**
 * Tailscale as one more row of the setup (the Access step): the network Remote access goes through.
 * Where Agentry runs the daemon (the Docker image) the row signs it in with the shared panel, by a
 * link or an auth key, and out; a machine's own Tailscale is the person's, so the row only says how
 * it stands. Laid out like the other rows of the assistant, with the panel under it on a desktop and
 * in a Sheet on a phone.
 */
export function TailscaleRow({ summary, phone, open, onToggle }: { summary: SetupTailscaleSummary; phone: boolean; open: boolean; onToggle: (open: boolean) => void }) {
  const { t } = useTranslation(['setup', 'config', 'providers']);
  const { signIn, signOut } = tailscaleActions(summary);
  const { state: now } = summary;
  const word = now === 'ready' ? t('providers:state.ready') : t(`config:remote.tailscale.tags.${now}`);
  const meta = summary.host && tailscaleSignedIn(summary.state) ? t('setup:remote.node', { host: summary.host }) : t('setup:remote.meta');

  const identity = (
    <div className="prov-id">
      <span className="prov-name">{t('setup:remote.name')}</span>
      <span className="prov-meta ellipsis">{meta}</span>
    </div>
  );
  const state = (
    <div className="prov-state">
      <Tag tone={tailscaleTone(summary.state)}>{word}</Tag>
      <p className="prov-reason">{t(`setup:remote.reason.${reasonKey(summary)}`)}</p>
    </div>
  );
  const actions = (
    <div className="prov-actions">
      {signIn && (
        <button type="button" className="btn" data-action="sign-in" aria-pressed={open} aria-label={t('setup:row.signInAria', { label: LABEL })} onClick={() => onToggle(!open)}>
          {t('setup:row.signIn')}
        </button>
      )}
      {signOut && <SignOutButton tool="tailscale" label={LABEL} />}
    </div>
  );

  if (phone) {
    return (
      <>
        <div className="prov-cell" data-tool="tailscale" data-state={summary.state}>
          <div className="prov-cell-head">
            <ProgramMark id="tailscale" label={LABEL} />
            {identity}
          </div>
          {state}
          {(signIn || signOut) && actions}
        </div>
        {open && signIn && <SignInSheet tool="tailscale" label={LABEL} onClose={() => onToggle(false)} />}
      </>
    );
  }
  return (
    <>
      <div className={`prov-row compact${open ? ' open' : ''}`} data-tool="tailscale" data-state={summary.state}>
        <ProgramMark id="tailscale" label={LABEL} />
        {identity}
        {state}
        {actions}
      </div>
      {open && signIn && <SignInPanel tool="tailscale" label={LABEL} onClose={() => onToggle(false)} />}
    </>
  );
}
