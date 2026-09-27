import type { AuthMode, TunnelState, TunnelStatus } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../api';
import { Switch } from '../../components/controls';
import { useConfirm } from '../../components/Dialog';
import { ICON } from '../../components/icons';
import { QrCode } from '../../components/QrCode';
import { useToast } from '../../components/Toast';
import { Card, CopyButton, Empty, ErrorBox, Skeleton, Tag } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { localized } from '../../lib/server-strings';

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
 * Settings → Remote access: a public HTTPS address for this Agentry through localhost.run, over the
 * machine's own ssh. The status comes whole with every `tunnel.changed` (lib/events.ts), so the
 * page follows the tunnel through its states without polling.
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

  const start = useMutation({ mutationFn: api.startTunnel, onSuccess: onStatus, onError: (err) => toast.error(t('remote.startFailed'), err) });
  const stop = useMutation({ mutationFn: api.stopTunnel, onSuccess: onStatus, onError: (err) => toast.error(t('remote.stopFailed'), err) });
  const settings = useMutation({
    mutationFn: api.updateTunnelSettings,
    onSuccess: onStatus,
    onError: (err) => toast.error(t('remote.saveFailed'), err),
  });

  async function close() {
    // Closing the tunnel this page came through leaves it talking to an address that is gone
    if (reachedThrough(status.url, window.location.host)) {
      const ok = await confirm({ title: t('remote.stopConfirm.title'), body: t('remote.stopConfirm.body'), confirmLabel: t('remote.stop') });
      if (!ok) return;
    }
    stop.mutate();
  }

  return (
    <>
      <TunnelPanel
        status={status}
        authMode={authMode}
        pending={start.isPending || stop.isPending}
        onStart={() => start.mutate()}
        onStop={() => void close()}
      />
      {status.sshAvailable && status.enabled && (
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
 * state. The start button is the zone's one primary action; while the guard is open it is replaced
 * by the reason and the way to Security, and without ssh by how to install it.
 */
export function TunnelPanel({
  status,
  authMode,
  pending = false,
  onStart,
  onStop,
}: {
  status: TunnelStatus;
  authMode: AuthMode;
  pending?: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation('config');
  const { state } = status;
  const guarded = authMode !== 'none';

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

  if (!status.sshAvailable) {
    return (
      <Card title={t('remote.title')} actions={<Tag tone="warn">{t('remote.sshMissing.tag')}</Tag>}>
        <Empty
          illustration="cli-missing"
          tone="warn"
          size="sm"
          title={t('remote.sshMissing.title')}
          action={
            guarded ? (
              <button type="button" className="btn btn-primary" disabled={pending} onClick={onStart}>
                {t('remote.retry')}
              </button>
            ) : undefined
          }
        >
          {t('remote.sshMissing.body', { package: 'openssh-client' })}
        </Empty>
      </Card>
    );
  }

  return (
    <Card title={t('remote.title')} actions={<Tag tone={TUNNEL_TONE[state]}>{t(`remote.states.${state}`)}</Tag>}>
      <p className="small muted">{t('remote.intro')}</p>

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
          <p className="small muted">{t('remote.caveat')}</p>
        </div>
      )}
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
