import type { AuthMode, TailscaleReadiness, TunnelState, TunnelStatus } from '@agentry/shared';
import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../api';
import { Switch } from '@agentry/ui/components/controls';
import { useConfirm } from '@agentry/ui/components/Dialog';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { QrCode } from '../../components/QrCode';
import { useToast } from '@agentry/ui/components/Toast';
import { Card, CopyButton, Empty, ErrorBox, Skeleton, Tag } from '@agentry/ui/components/ui';
import { timeAgo } from '@agentry/ui/lib/format';
import { localized } from '../../lib/server-strings';
import { tailscaleActions } from '../../lib/setup';
import { SignInPanel } from '../../components/setup/SignInPanel';
import { SignOutButton } from '../../components/setup/SignOutButton';

/** Where Tailscale is downloaded, and where a tailnet turns MagicDNS and HTTPS certificates on. */
export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
export const TAILSCALE_DNS_ADMIN_URL = 'https://login.tailscale.com/admin/dns';

/** The state as a colour, always beside its word: ok is open, warn is on its way or leaving, idle waits for the person. */
export const TUNNEL_TONE: Record<TunnelState, 'ok' | 'warn' | 'bad' | 'idle'> = {
  active: 'ok',
  starting: 'warn',
  verifying: 'warn',
  stopping: 'warn',
  failed: 'bad',
  stopped: 'idle',
};

/** Whether the tunnel is open or on its way: what a Stop button can act on. */
export const tunnelBusy = (state: TunnelState) => state === 'starting' || state === 'verifying' || state === 'active';

/** Whether this page itself arrived through the tunnel, so closing it would cut the page off. */
export function reachedThrough(url: string | null, host: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}

/**
 * Settings → Remote access: this Agentry on the person's tailnet, through `tailscale serve`. The
 * status comes whole with every `tunnel.changed` (lib/events.ts), so the page follows the tunnel
 * through its states without polling; reading it again also asks the CLI again, which is how a
 * `tailscale up` run in a terminal shows up.
 */
export function RemoteAccessTab() {
  const tunnel = useQuery({ queryKey: keys.tunnel, queryFn: api.tunnel });
  const auth = useQuery({ queryKey: keys.securityAuth, queryFn: api.securityAuth });
  const status = tunnel.data;

  return (
    <>
      <ErrorBox error={tunnel.error ?? auth.error} />
      {(tunnel.isLoading || auth.isLoading) && (
        <Card>
          <Skeleton rows={5} />
        </Card>
      )}
      {status && auth.data && <TunnelCard status={status} authMode={auth.data.mode} />}
    </>
  );
}

function TunnelCard({ status, authMode }: { status: TunnelStatus; authMode: AuthMode }) {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const onStatus = (next: TunnelStatus) => queryClient.setQueryData(keys.tunnel, next);
  const checking = useIsFetching({ queryKey: keys.tunnel }) > 0;

  // Set once this page has closed the tunnel it came through: its address is gone, so nothing it
  // could fetch from here on would answer, and a failure is the expected end rather than an error
  const [closedHere, setClosedHere] = useState(false);
  const start = useMutation({ mutationFn: api.startTunnel, onSuccess: onStatus, onError: (err) => toast.error(t('remote.startFailed'), err) });
  const stop = useMutation({
    // `here` rides along as the mutation's variable so both outcomes know where the request came from
    mutationFn: (_here: boolean) => api.stopTunnel(),
    onSuccess: (next, here) => (here ? setClosedHere(true) : onStatus(next)),
    onError: (err, here) => (here ? setClosedHere(true) : toast.error(t('remote.stopFailed'), err)),
  });
  const settings = useMutation({
    mutationFn: api.updateTunnelSettings,
    onSuccess: onStatus,
    onError: (err) => toast.error(t('remote.saveFailed'), err),
  });

  async function close() {
    // Closing the tunnel this page came through leaves it talking to an address that is gone
    const here = reachedThrough(status.url, window.location.host);
    if (here) {
      const ok = await confirm({ title: t('remote.stopConfirm.title'), body: t('remote.stopConfirm.body'), confirmLabel: t('remote.stop') });
      if (!ok) return;
    }
    stop.mutate(here);
  }

  if (closedHere) return <TunnelPanel status={status} authMode={authMode} closedHere onStart={() => {}} onStop={() => {}} />;

  return (
    <>
      <TunnelPanel
        status={status}
        authMode={authMode}
        pending={start.isPending || stop.isPending}
        checking={checking}
        onStart={() => start.mutate()}
        onStop={() => void close()}
        onRecheck={() => void queryClient.invalidateQueries({ queryKey: keys.tunnel })}
      />
      {status.enabled && status.tailscale.state === 'ready' && (
        <Card title={t('remote.startWith.title')}>
          <Switch
            checked={status.settings.startWithAgentry}
            disabled={settings.isPending}
            onChange={(startWithAgentry) => settings.mutate({ startWithAgentry })}
          >
            {t('remote.startWith.label')}
          </Switch>
          <p className="small muted">{t('remote.startWith.hint')}</p>
        </Card>
      )}
      <p className="small muted">{t('remote.footnote')}</p>
    </>
  );
}

/**
 * What the tunnel card shows for a status, kept apart from the queries so a test can draw every
 * state. Nothing about the tunnel is offered until Tailscale is ready: before that, the card says
 * what is missing and what the person runs or turns on, because Agentry never signs in to or
 * configures Tailscale itself. Once ready, the start button is the zone's one primary action;
 * while the guard is open it is replaced by the reason and the way to Security.
 */
export function TunnelPanel({
  status,
  authMode,
  pending = false,
  checking = false,
  closedHere = false,
  onStart,
  onStop,
  onRecheck = () => {},
}: {
  status: TunnelStatus;
  authMode: AuthMode;
  pending?: boolean;
  /** The status is being read again, which also asks the CLI again */
  checking?: boolean;
  /** This page closed the tunnel it came through, and nothing behind its address answers any more */
  closedHere?: boolean;
  onStart: () => void;
  onStop: () => void;
  onRecheck?: () => void;
}) {
  const { t } = useTranslation('config');
  const { state } = status;
  const guarded = authMode !== 'none';

  if (closedHere) {
    return (
      <Card title={t('remote.title')} actions={<Tag tone={TUNNEL_TONE.stopped}>{t('remote.states.stopped')}</Tag>}>
        <div data-testid="tunnel-closed-here">
          <Empty illustration="offline" size="sm" title={t('remote.closedHere.title')}>
            {t('remote.closedHere.body')}
          </Empty>
        </div>
      </Card>
    );
  }

  // Off by the deploy (AGENTRY_TUNNEL, off in the image): only whoever runs Agentry can change that,
  // so a start button would only ever answer 409
  if (!status.enabled) {
    return (
      <Card title={t('remote.title')} actions={<Tag tone="warn">{t('remote.disabled.tag')}</Tag>}>
        <p className="small muted">{t('remote.intro')}</p>
        <div className="alert alert-warn" role="status" data-testid="tunnel-disabled">
          <ShieldAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('remote.disabled.title')}</strong>
            <div className="small">{t('remote.disabled.body', { variable: 'AGENTRY_TUNNEL=on' })}</div>
          </div>
        </div>
      </Card>
    );
  }

  if (status.tailscale.state !== 'ready') return <TailscaleNotReady readiness={status.tailscale} managed={status.managed} checking={checking} onRecheck={onRecheck} />;

  return (
    <Card title={t('remote.title')} actions={<Tag tone={TUNNEL_TONE[state]}>{t(`remote.states.${state}`)}</Tag>}>
      <p className="small muted">{t('remote.intro')}</p>
      {status.tailscale.host && (
        <div className="tunnel-node">
          <p className="small muted" data-testid="tunnel-node">
            {t('remote.node')} <span className="mono">{status.tailscale.host}</span>
          </p>
          {/* Only the Tailscale Agentry runs is Agentry's to sign out; closing the tunnel comes first, on the server */}
          {status.managed && <SignOutButton tool="tailscale" label="Tailscale" small />}
        </div>
      )}

      {state === 'active' && status.url && <TunnelAddress url={status.url} since={status.since} />}

      {(state === 'starting' || state === 'verifying' || state === 'stopping') && (
        <p className="small" role="status" data-testid="tunnel-progress">
          {t(`remote.progress.${state}`)}
        </p>
      )}

      {state === 'failed' && status.reason && (
        <div className="alert alert-bad" role="alert">
          <TriangleAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('remote.failedTitle')}</strong>
            <div className="small">{localized(status.reason)}</div>
          </div>
        </div>
      )}

      {!guarded ? (
        <div className="alert alert-warn" role="status" data-testid="tunnel-auth-required">
          <ShieldAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('remote.authRequired.title')}</strong>
            <div className="small">{t('remote.authRequired.body')}</div>
            <div className="form-actions">
              <Link className="btn btn-small" to="/settings?tab=security">
                {t('remote.authRequired.action')}
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="tunnel-actions">
          {tunnelBusy(state) ? (
            <button type="button" className="btn" disabled={pending} onClick={onStop} data-testid="tunnel-stop">
              {t('remote.stop')}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={pending || state === 'stopping'} onClick={onStart} data-testid="tunnel-start">
              {state === 'failed' ? t('remote.retry') : t('remote.start')}
            </button>
          )}
          <p className="small muted">{t('remote.caveat', { port: status.port })}</p>
        </div>
      )}
    </Card>
  );
}

/**
 * Tailscale is not there or not ready. Not installed is the one state with an illustration, since
 * the whole section depends on it; the others say what is missing in the server's words (by code),
 * and what the person can do about it: a command to run, or the admin page to open. Where Agentry
 * runs the daemon itself (`managed`, the Docker image) there is no terminal to run anything in, so
 * a signed-out node is signed in here instead, with the shared panel.
 */
function TailscaleNotReady({ readiness, managed, checking, onRecheck }: { readiness: TailscaleReadiness; managed: boolean; checking: boolean; onRecheck: () => void }) {
  const { t } = useTranslation('config');
  const recheck = (
    <button type="button" className="btn" disabled={checking} onClick={onRecheck} data-testid="tunnel-recheck">
      {t('remote.tailscale.recheck')}
    </button>
  );

  if (readiness.state === 'missing') {
    return (
      <Card title={t('remote.title')} actions={<Tag tone="warn">{t('remote.tailscale.tags.missing')}</Tag>}>
        <div data-testid="tunnel-tailscale-missing">
          <Empty
            illustration="cli-missing"
            tone="warn"
            size="sm"
            title={t('remote.tailscale.missing.title')}
            action={
              <div className="form-actions">
                <a className="btn btn-primary" href={TAILSCALE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                  {t('remote.tailscale.missing.install')}
                  <ExternalLink {...ICON_SM} />
                </a>
                {recheck}
              </div>
            }
          >
            {t('remote.tailscale.missing.body')}
          </Empty>
        </div>
      </Card>
    );
  }

  const { state } = readiness;
  if (state === 'ready') return null;
  if (managed && (state === 'loggedOut' || state === 'stopped')) return <ManagedSignIn readiness={readiness} checking={checking} onRecheck={onRecheck} />;
  // Only the command that is the same everywhere Tailscale runs; how tailscaled is started is the system's
  const command = !managed && (state === 'loggedOut' || state === 'stopped') ? 'tailscale up' : null;
  const { signOut } = tailscaleActions({ enabled: true, managed, state });
  const link =
    state === 'httpsDisabled'
      ? { href: TAILSCALE_DNS_ADMIN_URL, label: t('remote.tailscale.openDns') }
      : state === 'unsupported'
        ? { href: TAILSCALE_DOWNLOAD_URL, label: t('remote.tailscale.update') }
        : null;
  return (
    <Card title={t('remote.title')} actions={<Tag tone="warn">{t(`remote.tailscale.tags.${state}`)}</Tag>}>
      <p className="small muted">{t('remote.intro')}</p>
      <div className="alert alert-warn" role="status" data-testid={`tunnel-tailscale-${state}`}>
        <TriangleAlert {...ICON} className="alert-icon" />
        <div className="alert-body">
          <strong>{t(`remote.tailscale.titles.${state}`)}</strong>
          {readiness.reason && <div className="small">{localized(readiness.reason)}</div>}
          {command && (
            <div className="small">
              {t('remote.tailscale.runThis')} <code className="mono">{command}</code>
            </div>
          )}
          {managed && state === 'daemonDown' && <div className="small">{t('remote.tailscale.managed.daemonDown')}</div>}
          <div className="form-actions">
            {link && (
              <a className="btn btn-small" href={link.href} target="_blank" rel="noreferrer">
                {link.label}
                <ExternalLink {...ICON_SM} />
              </a>
            )}
            {recheck}
            {signOut && <SignOutButton tool="tailscale" label="Tailscale" small />}
          </div>
        </div>
      </div>
      {readiness.version && <p className="small muted">{t('remote.tailscale.version', { version: readiness.version })}</p>}
    </Card>
  );
}

/**
 * The Tailscale Agentry runs is signed out: the card says so and offers Sign in, which opens the
 * shared panel inside it (a link to open on any device, or an auth key). It never asks for a link on
 * its own: a visit to the tab is not a sign-in.
 */
function ManagedSignIn({ readiness, checking, onRecheck }: { readiness: TailscaleReadiness; checking: boolean; onRecheck: () => void }) {
  const { t } = useTranslation('config');
  const [open, setOpen] = useState(false);
  const state = readiness.state === 'stopped' ? 'stopped' : 'loggedOut';
  return (
    <Card title={t('remote.title')} actions={<Tag tone="warn">{t(`remote.tailscale.tags.${state}`)}</Tag>}>
      <p className="small muted">{t('remote.intro')}</p>
      <div className="alert alert-warn" role="status" data-testid={`tunnel-tailscale-${state}`}>
        <TriangleAlert {...ICON} className="alert-icon" />
        <div className="alert-body">
          <strong>{t('remote.tailscale.managed.title')}</strong>
          <div className="small">{t('remote.tailscale.managed.body')}</div>
          {!open && (
            <div className="form-actions">
              <button type="button" className="btn btn-primary btn-small" data-testid="tunnel-sign-in" onClick={() => setOpen(true)}>
                {t('remote.tailscale.managed.signIn')}
              </button>
              <button type="button" className="btn btn-small" disabled={checking} onClick={onRecheck} data-testid="tunnel-recheck">
                {t('remote.tailscale.recheck')}
              </button>
            </div>
          )}
        </div>
      </div>
      {open && <SignInPanel tool="tailscale" label="Tailscale" layout="card" closable onClose={() => setOpen(false)} />}
      {readiness.version && <p className="small muted">{t('remote.tailscale.version', { version: readiness.version })}</p>}
    </Card>
  );
}

/** The live address: what the screen is about while the tunnel is open, so it takes the gradient border. */
function TunnelAddress({ url, since }: { url: string; since: string | null }) {
  const { t } = useTranslation('config');
  return (
    <div className="tunnel-address grad-border" data-testid="tunnel-address">
      <div className="tunnel-address-text">
        <span className="section-label">{t('remote.address.label')}</span>
        <div className="tunnel-address-url">
          <a className="mono break" href={url} target="_blank" rel="noreferrer" data-testid="tunnel-url">
            {url}
          </a>
          <CopyButton text={url} label={t('remote.address.copy')} />
        </div>
        {since && <span className="small muted">{t('remote.address.since', { time: timeAgo(since) })}</span>}
        <span className="small muted">{t('remote.address.scan')}</span>
      </div>
      <QrCode text={url} label={t('remote.address.qr', { url })} />
    </div>
  );
}
