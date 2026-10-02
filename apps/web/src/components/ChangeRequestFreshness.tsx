import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { api, keys } from '../api';
import { BACKUP_POLL_MINUTES, freshnessLine, isHealthy, lastHeardAt, liveRegistration, spanWords } from '../lib/webhooks';

/** How often the seconds in the sentence are rewritten: the text renews, nothing counts down. */
const RENEW_MS = 5_000;
/** The pacer and the deliveries move the row's clock on the server; a read of it keeps up with both. */
const REREAD_MS = 15_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, RENEW_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * How fresh a change request is, in words (DSWebhooks): "Instant" only while the repository's hook is
 * healthy, otherwise when it was last read and when it is read next. A webhook only makes Agentry read
 * sooner; it changes nothing, and the line says so. Nothing moves except the spinner of a read in flight.
 *
 * `changeRequestId` is the pull request row's id. `onRefresh` is the person's "read it now"; a page whose
 * request has no such route leaves it out and the line has no button.
 */
export function ChangeRequestFreshness({
  changeRequestId,
  projectId,
  host,
  hostLabel,
  onRefresh,
}: {
  changeRequestId: string;
  projectId: string | null | undefined;
  host: string;
  hostLabel: string;
  onRefresh?: () => Promise<unknown>;
}) {
  const { t } = useTranslation('workItem');
  const queryClient = useQueryClient();
  const now = useNow();
  const request = useQuery({
    queryKey: keys.changeRequest(changeRequestId),
    queryFn: ({ signal }) => api.changeRequest(changeRequestId, { signal }),
    refetchInterval: REREAD_MS,
  });
  // GitLab's webhook is not built yet: its line is always the periodic read, so it asks for nothing
  const hooks = useQuery({
    queryKey: keys.projectWebhooks(projectId ?? ''),
    queryFn: ({ signal }) => api.projectWebhooks(projectId ?? '', { signal }),
    enabled: !!projectId && host === 'github',
  });
  const reading = useMutation({
    mutationFn: async () => {
      await onRefresh?.();
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.changeRequest(changeRequestId) }),
  });

  const registration = host === 'github' ? liveRegistration(hooks.data?.registrations) : null;
  const healthy = !!registration && isHealthy(registration, now);
  const line = freshnessLine(request.data?.freshness, healthy, now);
  if (!line) return null;

  const span = (ms: number): string => {
    const { unit, value } = spanWords(ms);
    return t(`freshness.span.${unit}`, { value });
  };
  const time = { t: <span className="fresh-t" /> };
  const ago = line.sinceMs === null ? '' : span(line.sinceMs);
  const next = line.untilMs === null ? '' : span(line.untilMs);
  const heard = registration ? lastHeardAt(registration) : null;
  const heardAgo = heard ? span(Math.max(0, now - Date.parse(heard))) : '';
  // A registered hook that is not healthy: say it is silent and fall back to the normal pace
  const silent = !!registration && !healthy && line.kind === 'checked';

  let state: ReactNode = null;
  let main: ReactNode;
  let why: ReactNode = null;
  if (reading.isPending) {
    state = <Spinner />;
    main = t('freshness.reading', { host: hostLabel });
    why = line.sinceMs === null ? null : <Trans t={t} i18nKey="freshness.previous" values={{ ago }} components={time} />;
  } else if (line.kind === 'instant') {
    state = (
      <span className="badge badge-ok">
        <Check size={11} strokeWidth={2} aria-hidden />
        {t('freshness.instant')}
      </span>
    );
    main = <Trans t={t} i18nKey="freshness.byWebhook" values={{ ago: heard ? heardAgo : ago }} components={time} />;
    why = (
      <Trans
        t={t}
        i18nKey={line.untilMs === null ? 'freshness.onlySooner' : 'freshness.backup'}
        values={{ host: hostLabel, every: t('freshness.span.min', { value: BACKUP_POLL_MINUTES }), next }}
        components={time}
      />
    );
  } else if (line.kind === 'unchecked') {
    main = t('freshness.unchecked', { host: hostLabel });
  } else if (line.kind === 'paused') {
    state = <span className="badge badge-warn">{t('freshness.pausedBadge')}</span>;
    main = <Trans t={t} i18nKey="freshness.paused" values={{ host: hostLabel, ago }} components={time} />;
    why = t('freshness.pausedWhy');
  } else if (silent) {
    state = <span className="badge badge-warn">{t('freshness.silentBadge')}</span>;
    main = <Trans t={t} i18nKey={heard ? 'freshness.silent' : 'freshness.silentNever'} values={{ since: heardAgo, ago, next }} components={time} />;
    why = (
      <>
        {t('freshness.silentWhy', { host: hostLabel })} <Link to="/settings?tab=integrations">{t('freshness.seeWebhooks')}</Link>
      </>
    );
  } else {
    main = <Trans t={t} i18nKey="freshness.checked" values={{ ago, next }} components={time} />;
  }

  return (
    <div className="fresh" data-fresh={reading.isPending ? 'reading' : silent ? 'silent' : line.kind}>
      {state && <span className="fresh-state">{state}</span>}
      <span className="fresh-text">
        <span>{main}</span>
        {why && <span className="fresh-why">{why}</span>}
      </span>
      {onRefresh && (
        <button type="button" className="btn btn-small" disabled={reading.isPending} aria-busy={reading.isPending || undefined} onClick={() => reading.mutate()}>
          <RefreshCw {...ICON_SM} />
          {t('freshness.refresh')}
        </button>
      )}
    </div>
  );
}
