import type { AgentryReleaseInfo } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, Info, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Dialog } from '../../components/Dialog';
import { ICON, ICON_SM } from '../../components/icons';
import { Card, CopyButton, ErrorBox, Skeleton, Tag } from '../../components/ui';
import type { DesktopUpdatesBridge } from '../../lib/desktop';
import { formatDate, timeAgo } from '../../lib/format';
import {
  DOCKER_UPDATE_COMMAND,
  parseInstallAnswer,
  parseUpdateState,
  SOURCE_UPDATE_COMMAND,
  updateRoute,
  type DesktopUpdateState,
  type LiveWork,
  type UpdateHow,
} from '../../lib/updates';

/**
 * Which Agentry this is and whether a newer release is out, with the way to take it that fits this
 * install. Reading is free: GitHub is only asked by the button and once a day by the server.
 */
export function UpdatesCard() {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const { data: info, error, isLoading } = useQuery({ queryKey: keys.release, queryFn: () => api.release() });
  const check = useMutation({
    mutationFn: api.checkRelease,
    onSuccess: (fresh) => queryClient.setQueryData(keys.release, fresh),
  });
  const bridge = typeof window !== 'undefined' ? window.agentryDesktop?.updates : undefined;
  const route = info && updateRoute({ distribution: info.distribution, desktopUpdates: Boolean(bridge), hostname: window.location.hostname });

  return (
    <Card title={t('updates.title')}>
      <div className="stack" data-testid="updates-card">
        <ErrorBox error={error} />
        {isLoading && <Skeleton rows={3} />}
        {info && (
          <dl className="kv">
            <dt>{t('updates.version')}</dt>
            <dd>{info.current}</dd>
            <dt>{t('updates.latest')}</dt>
            <dd>
              {info.latest ?? t('updates.never')}
              {info.publishedAt && <span className="muted"> · {t('updates.published', { date: formatDate(info.publishedAt) })}</span>}{' '}
              {info.latest &&
                (info.updateAvailable ? (
                  <Tag tone="warn">{t('updates.available', { latest: info.latest })}</Tag>
                ) : (
                  <Tag tone="ok">{t('updates.upToDate')}</Tag>
                ))}
              {info.url && (
                <>
                  {' '}
                  <a href={info.url} target="_blank" rel="noopener noreferrer" className="meta-icon">
                    {t('updates.notes')} <ExternalLink {...ICON_SM} />
                  </a>
                </>
              )}
            </dd>
          </dl>
        )}

        {info && route?.kind === 'desktop' && bridge && <DesktopUpdate bridge={bridge} info={info} />}
        {info?.updateAvailable && route?.kind === 'steps' && <UpdateSteps how={route.how} remote={route.remote} />}

        <div className="form-actions">
          <button className="btn" disabled={check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? t('updates.checking') : t('updates.check')}
          </button>
          {/* Always rendered so a screen reader is told when the answer lands */}
          <span className="small muted" role="status">
            {info?.checkedAt && t('updates.checked', { when: timeAgo(info.checkedAt) })}
          </span>
        </div>
        <ErrorBox title={t('updates.checkFailed')} error={check.error ?? (info?.error ? new Error(info.error) : null)} />
        <p className="small muted">{t('updates.note')}</p>
      </div>
    </Card>
  );
}

/** The command to run, with a button that copies it */
function Command({ command }: { command: string }) {
  const { t } = useTranslation('config');
  return (
    <div className="update-command">
      <code className="mono">{command}</code>
      <CopyButton text={command} label={t('updates.copyCommand')} />
    </div>
  );
}

/** Everywhere but the desktop window: what to run, and who runs it */
function UpdateSteps({ how, remote }: { how: UpdateHow; remote: boolean }) {
  const { t } = useTranslation('config');
  return (
    <div className="stack" data-testid={`update-steps-${how}`}>
      {remote && (
        <p className="alert small">
          <Info className="alert-icon" {...ICON_SM} />
          <span className="alert-body">{t('updates.remote', { host: window.location.host })}</span>
        </p>
      )}
      {how === 'docker' && (
        <>
          <p className="small">{t('updates.docker')}</p>
          <Command command={DOCKER_UPDATE_COMMAND} />
        </>
      )}
      {how === 'source' && (
        <>
          <p className="small">{t('updates.source')}</p>
          <Command command={SOURCE_UPDATE_COMMAND} />
        </>
      )}
      {how === 'desktop-app' && <p className="small">{remote ? t('updates.desktopAppRemote') : t('updates.desktopApp')}</p>}
    </div>
  );
}

/** The shell's updater state, kept current through its events */
function useDesktopUpdateState(bridge: DesktopUpdatesBridge): DesktopUpdateState | null {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    let alive = true;
    const unsubscribe = bridge.onState((raw) => {
      const next = parseUpdateState(raw);
      if (next) setState(next);
    });
    void bridge.state().then((raw) => {
      const next = parseUpdateState(raw);
      if (alive && next) setState((current) => current ?? next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);
  return state;
}

/** "2 chats are working, 1 orchestration is running": what a restart now would stop */
function useLiveSentence(): (live: LiveWork) => string {
  const { t } = useTranslation('config');
  return (live) =>
    [
      live.working ? t('updates.live.working', { count: live.working }) : null,
      live.waiting ? t('updates.live.waiting', { count: live.waiting }) : null,
      live.running ? t('updates.live.running', { count: live.running }) : null,
    ]
      .filter(Boolean)
      .join(', ');
}

/** The desktop window: download with its progress, then a restart that asks first when work is live */
function DesktopUpdate({ bridge, info }: { bridge: DesktopUpdatesBridge; info: AgentryReleaseInfo }) {
  const { t } = useTranslation('config');
  const state = useDesktopUpdateState(bridge);
  const liveSentence = useLiveSentence();
  const [busy, setBusy] = useState<{ version: string; live: LiveWork } | null>(null);
  const [scheduled, setScheduled] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const download = useMutation({ mutationFn: () => bridge.download(), onError: setFailure });
  const install = useMutation({
    mutationFn: async (options: { whenIdle?: boolean; force?: boolean }) => parseInstallAnswer(await bridge.install(options)),
    onSuccess: (answer) => {
      setBusy(null);
      if (answer?.status === 'busy') setBusy({ version: answer.version, live: answer.live });
      else if (answer?.status === 'scheduled') setScheduled(answer.version);
    },
    onError: (err) => {
      setBusy(null);
      setFailure(err);
    },
  });

  if (!state) return null;
  // Nothing to say while there is nothing newer and the shell is not in the middle of something
  const inFlight = state.status === 'downloading' || state.status === 'ready' || state.status === 'available';
  if (!info.updateAvailable && !inFlight) return null;

  return (
    <div className="stack" data-testid="update-desktop">
      {state.status === 'unsupported' && (
        <p className="alert alert-warn small" role="status">
          <Info className="alert-icon" {...ICON_SM} />
          <span className="alert-body">
            {state.message}{' '}
            {info.url && (
              <a href={info.url} target="_blank" rel="noopener noreferrer">
                {t('updates.desktopManual')}
              </a>
            )}
          </span>
        </p>
      )}

      {(state.status === 'idle' || state.status === 'available' || state.status === 'error') && (
        <div>
          <button type="button" className="btn btn-primary" disabled={download.isPending} onClick={() => download.mutate()}>
            <Download {...ICON} /> {t('updates.download', { version: state.status === 'available' ? state.version : info.latest })}
          </button>
        </div>
      )}
      {state.status === 'error' && <ErrorBox title={t('updates.desktopFailed')} error={new Error(state.message || t('updates.desktopFailed'))} />}

      {state.status === 'checking' && (
        <p className="small muted" role="status">
          {t('updates.looking')}
        </p>
      )}

      {state.status === 'downloading' && (
        <div className="stack">
          <p className="small" role="status">
            {t('updates.downloading', { version: state.version, percent: state.percent })}
          </p>
          <span
            className="progress"
            role="progressbar"
            aria-label={t('updates.downloadProgress', { version: state.version })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={state.percent}
          >
            <span className="progress-seg is-running" style={{ width: `${state.percent}%` }} aria-hidden />
          </span>
        </div>
      )}

      {state.status === 'ready' &&
        (scheduled === state.version ? (
          <p className="small" role="status">
            {t('updates.scheduled', { version: state.version })}
          </p>
        ) : (
          <div>
            <button type="button" className="btn btn-primary" disabled={install.isPending} onClick={() => install.mutate({})}>
              <RotateCw {...ICON} /> {t('updates.restart', { version: state.version })}
            </button>
          </div>
        ))}
      <ErrorBox title={t('updates.desktopFailed')} error={failure} />

      {busy && (
        <Dialog
          title={t('updates.busyTitle', { version: busy.version })}
          onClose={() => setBusy(null)}
          width={460}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setBusy(null)}>
                {t('updates.cancel')}
              </button>
              <button type="button" className="btn" data-autofocus disabled={install.isPending} onClick={() => install.mutate({ whenIdle: true })}>
                {t('updates.whenQuit')}
              </button>
              <button type="button" className="btn btn-danger-solid" disabled={install.isPending} onClick={() => install.mutate({ force: true })}>
                {t('updates.restartNow')}
              </button>
            </>
          }
        >
          <p>{t('updates.busyBody', { live: liveSentence(busy.live) })}</p>
        </Dialog>
      )}
    </div>
  );
}
