import type { DecisionMode, DecisionPointInfo, DecisionPointSettings, DecisionPreview, DecisionProviderId, DecisionSettings } from '@agentry/shared';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { Collapsible, Sheet } from '@agentry/ui/components/controls';
import { Dialog } from '@agentry/ui/components/Dialog';
import { ErrorBox, Skeleton } from '@agentry/ui/components/ui';
import { formatBytes } from '@agentry/ui/lib/format';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { ConsentNotice, JEV_HOST } from './ConsentDialog';
import { consentProviders } from './model';

export interface BulkConsentItem {
  info: DecisionPointInfo;
  name: string;
  mode: Exclude<DecisionMode, 'off'>;
  /** What was consented to so far, so the new consent adds to it */
  consent: DecisionPointSettings['consent'];
}

/**
 * The one question before many points leave `off` (D12, in bulk): every point that has no consent
 * yet, each with what it decides, the size of what it sends and its exact state, folded. Agreeing
 * records a consent per point, for the provider they will run on, and then the modes are applied;
 * closing records nothing.
 */
export function BulkConsentDialog({
  items,
  provider,
  onClose,
  onGranted,
}: {
  items: BulkConsentItem[];
  provider: DecisionProviderId;
  onClose: () => void;
  /** Called once every consent is recorded */
  onGranted: () => void;
}) {
  const { t } = useTranslation('decisions');
  const queryClient = useQueryClient();
  const narrow = useMediaQuery(NARROW);
  // Never cached: consenting to a preview that is out of date would be consenting to something unseen
  const previews = useQueries({
    queries: items.map((item) => ({ queryKey: keys.decisionPreview(item.info.id), queryFn: () => api.decisionPreview(item.info.id), gcTime: 0, staleTime: 0 })),
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ready = previews.every((query) => query.data);
  const failed = previews.find((query) => query.error)?.error ?? null;
  const leaves = provider === 'jev';

  const agree = async () => {
    setPending(true);
    setError(null);
    try {
      // One after the other: each answer is the whole settings document, and the last one must hold every consent
      let latest: DecisionSettings | null = null;
      for (const [index, item] of items.entries()) {
        const version = previews[index]?.data?.stateVersion ?? item.info.stateVersion;
        latest = await api.putDecisionConsent(item.info.id, { granted: true, stateVersion: version, providers: consentProviders(item.info, item.consent, provider) });
      }
      if (latest) queryClient.setQueryData(keys.decisionSettings, latest);
      void queryClient.invalidateQueries({ queryKey: keys.decisionPoints });
      onGranted();
    } catch (caught) {
      // The ones recorded before the failure stay recorded: the settings are read again so the rows show them
      void queryClient.invalidateQueries({ queryKey: keys.decisionSettings });
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  const title = t('bulkConsent.title', { count: items.length });
  const body = <BulkConsentBody items={items} previews={previews.map((query) => query.data)} leaves={leaves} error={failed ?? error} />;

  const actions = (
    <>
      <button type="button" className="btn" disabled={pending} onClick={onClose}>
        {t('consent.cancel')}
      </button>
      <button type="button" className="btn btn-primary" data-autofocus disabled={!ready || pending} onClick={() => void agree()}>
        {pending ? t('consent.saving') : t('bulkConsent.agree')}
      </button>
    </>
  );

  if (narrow) {
    return (
      <Sheet open onOpenChange={(open) => !open && !pending && onClose()} title={title} footer={<div className="dp-consent-actions">{actions}</div>}>
        {body}
      </Sheet>
    );
  }
  return (
    <Dialog title={title} onClose={onClose} width={720} footer={actions}>
      {body}
    </Dialog>
  );
}

/** What the dialog says, apart from its shell: the points, their sizes and their folded states. */
export function BulkConsentBody({
  items,
  previews,
  leaves,
  error,
}: {
  items: BulkConsentItem[];
  /** The preview of each item, in order, while it has not arrived */
  previews: Array<DecisionPreview | undefined>;
  leaves: boolean;
  error: unknown;
}) {
  const { t } = useTranslation('decisions');
  const title = t('bulkConsent.title', { count: items.length });
  return (
    <div className="dp-consent-body">
      <ConsentNotice leaves={leaves} />
      <ErrorBox error={error} />
      <ul className="dp-bulk-list" aria-label={title}>
        {items.map((item, index) => {
          const data = previews[index];
          return (
            <li key={item.info.id} className="dp-bulk-item" data-point={item.info.id}>
              <Collapsible
                className="dp-bulk-fold"
                triggerClassName="dp-bulk-trigger-row"
                title={
                  <span className="dp-bulk-head">
                    <span className="dp-bulk-name">
                      <span>{item.name}</span>
                      <span className="dp-id">{item.info.id}</span>
                    </span>
                    <span className="dp-bulk-meta">
                      <span className="badge">{t(`points.modes.${item.mode}`)}</span>
                      <span className="mono">{data ? formatBytes(data.bytes) : '…'}</span>
                    </span>
                  </span>
                }
              >
                {data ? (
                  <div className="dp-bulk-preview">
                    <span className="form-hint">{data.source === 'last' ? t('consent.stateLast') : t('consent.stateBuilt')}</span>
                    <pre className="dp-preview" tabIndex={0} aria-label={t('consent.stateLabel')}>
                      {JSON.stringify(data.state, null, 2)}
                    </pre>
                    <span className="mono dp-bulk-version">v{data.stateVersion}</span>
                  </div>
                ) : (
                  <Skeleton rows={2} />
                )}
              </Collapsible>
            </li>
          );
        })}
      </ul>
      <div className="dp-facts">
        <span className="dp-fact">
          <span>{t('consent.goesTo')}</span>
          <span>{leaves ? t('consent.goesToJev', { host: JEV_HOST }) : t('consent.goesToCli')}</span>
        </span>
        <span className="dp-fact">
          <span>{t('consent.size')}</span>
          <span>{previews.every(Boolean) ? formatBytes(previews.reduce((sum, data) => sum + (data?.bytes ?? 0), 0)) : '…'}</span>
        </span>
      </div>
      <span className="form-hint">{t('consent.withdraw')}</span>
    </div>
  );
}
