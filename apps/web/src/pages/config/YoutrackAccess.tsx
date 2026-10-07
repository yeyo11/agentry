import type { TrackerStatus } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { ErrorBox, Skeleton } from '@agentry/ui/components/ui';

/** What the row says about a YouTrack that is not ready, for the toast after a save. */
export type TrackerReasonText = (status: TrackerStatus, host: string) => string;

/**
 * The address and permanent token Agentry hands `youtrack-app` (code hosts decision 3). The token
 * is write-only: the field never shows the saved one, and left empty it keeps it. "Check and save"
 * waits for the server to probe the instance, so the person learns at once whether it took the
 * token. On desktop it opens under the row; on a phone it fills a sheet.
 */
export function YoutrackAccess({ onDone, reasonOf, sheet = false }: { onDone: () => void; reasonOf: TrackerReasonText; sheet?: boolean }) {
  const { t } = useTranslation('integrations');
  const toast = useToast();
  const queryClient = useQueryClient();
  const saved = useQuery({ queryKey: keys.youtrackCredentials, queryFn: ({ signal }) => api.youtrackCredentials({ signal }) });
  const [host, setHost] = useState<string | null>(null);
  const [token, setToken] = useState('');

  const afterChange = async (): Promise<TrackerStatus | null> => {
    void queryClient.invalidateQueries({ queryKey: keys.youtrackCredentials });
    const fresh = await api.trackers();
    queryClient.setQueryData(keys.trackers, fresh);
    return fresh.find((s) => s.id === 'youtrack') ?? null;
  };

  const save = useMutation({
    mutationFn: async () => {
      const typed = token.trim();
      await api.putYoutrackCredentials({ host: (host ?? saved.data?.host ?? '').trim(), ...(typed ? { token: typed } : {}) });
      return afterChange();
    },
    onSuccess: (status) => {
      setToken('');
      if (status?.state === 'ready') {
        toast.success(t('tracker.credentials.connected', { user: status.user ?? '' }));
        onDone();
      } else if (status) {
        toast.error(t('tracker.credentials.savedNotReady', { reason: reasonOf(status, (host ?? saved.data?.host ?? '').trim()) }));
      }
    },
  });
  const forget = useMutation({
    mutationFn: async () => {
      await api.deleteYoutrackCredentials();
      return afterChange();
    },
    onSuccess: () => {
      toast.success(t('tracker.credentials.forgotten'));
      onDone();
    },
    onError: (err) => toast.error(t('tracker.credentials.failed'), err),
  });

  if (saved.isLoading) return <Skeleton rows={2} height={18} />;
  if (!saved.data) return <ErrorBox error={saved.error} title={t('tracker.credentials.loadFailed')} />;

  const address = host ?? saved.data.host ?? '';
  const busy = save.isPending || forget.isPending;
  const canSave = address.trim() !== '' && (saved.data.tokenSet || token.trim() !== '');
  const title = t('tracker.credentials.title');

  const fields = (
    <>
      <label className="field field-mono">
        <span className="field-label">{t('tracker.credentials.host')}</span>
        <input
          className="mono"
          type="url"
          inputMode="url"
          value={address}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder="https://acme.youtrack.cloud"
          onChange={(event) => setHost(event.target.value)}
        />
      </label>
      <span className="form-hint">{t('tracker.credentials.hostHint')}</span>
      <label className="field field-mono">
        <span className="field-label">{t('tracker.credentials.token')}</span>
        <input
          className="mono"
          type="password"
          value={token}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder={saved.data.tokenSet ? t('tracker.credentials.tokenSaved') : 'perm-…'}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      <span className="form-hint">
        {t('tracker.credentials.tokenHint')} {t(saved.data.encrypted ? 'tracker.credentials.encrypted' : 'tracker.credentials.plain')}
      </span>
      <ErrorBox error={save.error} title={t('tracker.credentials.failed')} />
    </>
  );
  const submit = (
    <button type="button" className={sheet ? 'btn btn-primary' : 'btn'} disabled={busy || !canSave} onClick={() => save.mutate()}>
      {save.isPending && <Spinner />}
      {t('tracker.credentials.save')}
    </button>
  );
  const forgetButton = saved.data.host !== null && (
    <button type="button" className="btn btn-danger" disabled={busy} onClick={() => forget.mutate()}>
      {t('tracker.credentials.forget')}
    </button>
  );

  if (sheet) {
    return (
      <div className="prov-sheet-body">
        {fields}
        <div className="prov-sheet-actions">
          {submit}
          <div className="prov-sheet-row">{forgetButton}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="prov-bin host-bin" role="group" aria-label={title}>
      <span className="section-label">{title}</span>
      {fields}
      <div className="prov-bin-actions">
        {submit}
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          {t('bin.cancel')}
        </button>
        <span className="grow" />
        {forgetButton}
      </div>
    </div>
  );
}
